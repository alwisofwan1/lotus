//! W1c — direct HTTP for NL **utility** calls (parse / dispatch-refine / dictation polish). These are
//! short, stateless completions the command bar otherwise pays a cold `claude --print` spawn for. A
//! direct API call is ~sub-second, so the "5-10s to the agent" tail shrinks.
//!
//! Provider-agnostic BYOK: the key + model live in `~/.lotus/nl-model.json` (0600) and pick either
//! OpenAI Chat Completions or Anthropic Messages — whichever the user configured. The key never enters
//! the renderer (reads come back redacted; the HTTP call runs here). If nothing is configured we fall
//! back to the model_registry's Anthropic key (legacy), then to `no_key`.
//!
//! **BYOK is the sole path once configured.** `no_key` is the ONLY code that lets the caller reach
//! another provider (the cold-CLI leg); every other failure is reported as-is so the command bar can
//! surface an actionable error instead of quietly shipping the same prompt to a second vendor. That
//! rule is what keeps a configured key meaningful for sensitive work: the prompt goes to exactly one
//! place, chosen by the user. Two consequences for this module:
//!
//!   * Errors must be classified precisely — a permanent 4xx (`bad_request`) can no longer hide behind
//!     `network`, because nothing downstream will paper over it.
//!   * The single transient retry is gone. It existed to beat the multi-second CLI fallback; with no
//!     fallback left to beat, retrying only delays the error the user needs to see.

use crate::error::{other, AppError};
use crate::model_registry::{self, ModelRegistry};
use crate::paths;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Wall-clock bound on one provider call. This is the AUTHORITATIVE deadline: the frontend transport
/// sets a strictly wider one so Rust always wins the race and the caller gets a classified
/// `nl_complete[timeout]` instead of abandoning a request that keeps running here. Sized for the job —
/// these are sub-second classification calls on a fast model, so 10s already means something is wrong.
const NL_HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_TOKENS: u32 = 1024;

// Anthropic
const ANTHROPIC_VERSION: &str = "2023-06-01";
const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const DEFAULT_ANTHROPIC_NL_MODEL: &str = "claude-haiku-4-5";

// OpenAI
const OPENAI_BASE: &str = "https://api.openai.com";
const DEFAULT_OPENAI_NL_MODEL: &str = "gpt-4o-mini";

// Gemini (Google Generative Language API)
const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com";
const DEFAULT_GEMINI_NL_MODEL: &str = "gemini-2.5-flash";

// ─── BYOK config store (~/.lotus/nl-model.json) ───────────────────────────────

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlModelConfig {
    /// "openai" | "anthropic" | "gemini" | "" (unset → fall back to model_registry / CLI).
    #[serde(default)]
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Model id override; defaults per provider when empty.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Base URL override (proxy / azure / openai-compat); defaults to the public host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

/// Hand-written so the key cannot leak through a stray `{:?}` — a derived `Debug` would print it in
/// full, and this struct passes through command handlers and error paths where a debug log is one edit
/// away. Redacting at the formatter makes that safe by construction rather than by vigilance.
impl std::fmt::Debug for NlModelConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NlModelConfig")
            .field("provider", &self.provider)
            .field(
                "api_key",
                &self.usable_key().map(|_| "<redacted>").unwrap_or("<unset>"),
            )
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .finish()
    }
}

/// What a read substitutes for a stored key, and the sentinel a save treats as "keep what's stored".
const REDACTED_KEY: &str = "***";

impl NlModelConfig {
    /// Copy with the key redacted (safe to send to the renderer).
    fn redacted(&self) -> Self {
        Self {
            api_key: self
                .api_key
                .as_deref()
                .filter(|k| !k.is_empty())
                .map(|_| REDACTED_KEY.to_string()),
            ..self.clone()
        }
    }
    fn usable_key(&self) -> Option<&str> {
        self.api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
    }
}

fn config_path() -> PathBuf {
    paths::lotus_state_dir().join("nl-model.json")
}

fn load_config(path: &Path) -> NlModelConfig {
    fs::read(path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<NlModelConfig>(&raw).ok())
        .unwrap_or_default()
}

fn save_config(path: &Path, cfg: &NlModelConfig) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_vec_pretty(cfg)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, &body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&tmp, perms)?;
    }
    fs::rename(tmp, path)
}

// ─── Provider kinds + URL/body/parse (pure, unit-tested) ──────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NlProviderKind {
    Anthropic,
    OpenAi,
    Gemini,
}

/// Parse a stored provider string. Only the supported kinds resolve.
pub fn provider_kind(provider: &str) -> Option<NlProviderKind> {
    match provider.trim().to_lowercase().as_str() {
        "anthropic" | "claude" => Some(NlProviderKind::Anthropic),
        "openai" | "gpt" | "codex" => Some(NlProviderKind::OpenAi),
        "gemini" | "google" => Some(NlProviderKind::Gemini),
        _ => None,
    }
}

pub fn build_messages_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() {
        ANTHROPIC_BASE
    } else {
        trimmed
    };
    format!("{base}/v1/messages")
}

/// Build the Anthropic Messages request body. When `schema` is provided, grammar-enforce the reply
/// via `output_config.format` (json_schema — GA on claude-haiku-4-5); the model can then only emit
/// JSON matching the schema, eliminating parse failures. Omitted → today's free-form behavior, so a
/// caller (or provider) without structured-output support is unaffected.
pub fn build_messages_body(
    model: &str,
    prompt: &str,
    schema: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [{ "role": "user", "content": prompt }],
    });
    if let Some(schema) = schema {
        body["output_config"] = serde_json::json!({
            "format": { "type": "json_schema", "schema": schema },
        });
    }
    body
}

/// Concatenate the `text` blocks of an Anthropic Messages response.
pub fn parse_messages_text(json: &serde_json::Value) -> Result<String, AppError> {
    let content = json
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| other("Anthropic NL: response has no content array"))?;
    let text: String = content
        .iter()
        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("");
    if text.trim().is_empty() {
        return Err(other("Anthropic NL: empty text in response"));
    }
    Ok(text)
}

/// The Chat Completions endpoint. A base already ending in `/v1` gets only `/chat/completions`
/// appended (openai-compat proxies), otherwise the full `/v1/chat/completions`.
pub fn build_openai_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() {
        OPENAI_BASE
    } else {
        trimmed
    };
    if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

/// Widen one property schema so it also accepts `null` — how OpenAI's strict dialect expresses "this
/// field is optional". Handles the three shapes the intent registry actually emits: a `anyOf` union
/// (append a null variant), an `enum` (admit null as a member), and a plain `type` (widen to a
/// `[t, "null"]` union). Anything else is returned untouched rather than guessed at.
fn widen_to_nullable(node: &serde_json::Value) -> serde_json::Value {
    let mut out = node.clone();
    let Some(map) = out.as_object_mut() else {
        return out;
    };
    if let Some(variants) = map.get_mut("anyOf").and_then(|v| v.as_array_mut()) {
        if !variants
            .iter()
            .any(|v| v.get("type").and_then(|t| t.as_str()) == Some("null"))
        {
            variants.push(serde_json::json!({ "type": "null" }));
        }
        return out;
    }
    if let Some(members) = map.get_mut("enum").and_then(|v| v.as_array_mut()) {
        if !members.iter().any(serde_json::Value::is_null) {
            members.push(serde_json::Value::Null);
        }
    }
    match map.get("type").cloned() {
        Some(serde_json::Value::String(t)) => {
            map.insert("type".into(), serde_json::json!([t, "null"]));
        }
        Some(serde_json::Value::Array(mut types)) => {
            if !types.iter().any(|v| v.as_str() == Some("null")) {
                types.push(serde_json::json!("null"));
                map.insert("type".into(), serde_json::Value::Array(types));
            }
        }
        _ => {}
    }
    out
}

/// Rewrite a JSON Schema into OpenAI's `strict: true` structured-output dialect **without changing
/// which values it accepts**.
///
/// The intent schema is generated once, provider-agnostically, from `INTENT_REGISTRY` (see
/// `canvas-nl-parse.ts`) and is perfectly valid JSON Schema. OpenAI's strict mode, however, demands
/// two extra things of every object node: `additionalProperties: false`, and a `required` array naming
/// *every* declared property. A genuinely optional field is therefore expressed by widening its type
/// to include `null` instead of leaving it out of `required` — the grammar still permits "no value",
/// and `parseNlIntents` already treats an explicit null as absent (its `str()` helper rejects
/// non-strings). `const` is also normalized to a one-member `enum`, the form strict mode documents.
///
/// Without this, the registry's optional fields (`spawn_agent.model`, the nested `draw_diagram.graph`,
/// …) produce a request OpenAI rejects with 400 — which is exactly what silently pushed every NL
/// command onto the cold-CLI leg. Kept here, in the OpenAI adapter, so the shared schema stays the
/// single semantic contract and each provider adapts it to its own dialect (Gemini's adapter
/// deliberately drops the schema for the same reason).
fn strictify_schema(node: &serde_json::Value) -> serde_json::Value {
    match node {
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(strictify_schema).collect())
        }
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (key, value) in map {
                let rewritten = match key.as_str() {
                    // Schema-bearing positions: recurse.
                    "items" | "anyOf" | "oneOf" | "allOf" => strictify_schema(value),
                    "properties" => match value {
                        serde_json::Value::Object(props) => serde_json::Value::Object(
                            props
                                .iter()
                                .map(|(name, sub)| (name.clone(), strictify_schema(sub)))
                                .collect(),
                        ),
                        other => strictify_schema(other),
                    },
                    // Literal payloads (`enum` members, `required` names, prose): copy verbatim so a
                    // string member is never mistaken for a nested schema.
                    _ => value.clone(),
                };
                out.insert(key.clone(), rewritten);
            }

            if let Some(single) = out.remove("const") {
                out.insert("enum".into(), serde_json::Value::Array(vec![single]));
            }

            if out.contains_key("properties") {
                let names: Vec<String> = out["properties"]
                    .as_object()
                    .map(|props| props.keys().cloned().collect())
                    .unwrap_or_default();
                let already_required: std::collections::HashSet<&str> = out
                    .get("required")
                    .and_then(|r| r.as_array())
                    .map(|names| names.iter().filter_map(|n| n.as_str()).collect())
                    .unwrap_or_default();
                let optional: Vec<String> = names
                    .iter()
                    .filter(|name| !already_required.contains(name.as_str()))
                    .cloned()
                    .collect();
                if let Some(props) = out.get_mut("properties").and_then(|p| p.as_object_mut()) {
                    for name in optional {
                        if let Some(sub) = props.get(&name) {
                            let widened = widen_to_nullable(sub);
                            props.insert(name, widened);
                        }
                    }
                }
                out.insert(
                    "required".into(),
                    serde_json::Value::Array(
                        names.into_iter().map(serde_json::Value::String).collect(),
                    ),
                );
                out.insert(
                    "additionalProperties".into(),
                    serde_json::Value::Bool(false),
                );
            } else if out.get("type").and_then(|t| t.as_str()) == Some("object") {
                // A property-less object is free-form, which strict mode also rejects. Pin it closed.
                out.insert("properties".into(), serde_json::json!({}));
                out.insert("required".into(), serde_json::json!([]));
                out.insert(
                    "additionalProperties".into(),
                    serde_json::Value::Bool(false),
                );
            }

            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Build the OpenAI-compatible Chat Completions body. When `schema` is provided, grammar-enforce the
/// reply via `response_format` (json_schema, strict) — the schema is first adapted to strict mode's
/// dialect by {@link strictify_schema}. Omitted → free-form.
pub fn build_openai_body(
    model: &str,
    prompt: &str,
    schema: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": [{ "role": "user", "content": prompt }],
    });
    if let Some(schema) = schema {
        body["response_format"] = serde_json::json!({
            "type": "json_schema",
            "json_schema": {
                "name": "nl_intents",
                "strict": true,
                "schema": strictify_schema(schema),
            },
        });
    }
    body
}

/// Extract the assistant message text from a Chat Completions response.
pub fn parse_openai_text(json: &serde_json::Value) -> Result<String, AppError> {
    let text = json
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if text.trim().is_empty() {
        return Err(other("OpenAI NL: empty content in response"));
    }
    Ok(text.to_string())
}

/// The Gemini generateContent endpoint. Gemini carries the model in the URL path (unlike OpenAI /
/// Anthropic which put it in the body), so this takes the model. A custom base (proxy) is honored.
pub fn build_gemini_url(base_url: &str, model: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let base = if trimmed.is_empty() {
        GEMINI_BASE
    } else {
        trimmed
    };
    format!("{base}/v1beta/models/{model}:generateContent")
}

/// Build the Gemini generateContent body. When a schema is requested we force JSON output via
/// `responseMimeType` but deliberately DON'T forward the caller's JSON-Schema as `responseSchema` —
/// Gemini's schema subset rejects `additionalProperties`/`anyOf`, so we let `parseNlIntents` parse the
/// free-form JSON (same as the CLI leg). The model is NOT in the body (it's in the URL).
pub fn build_gemini_body(prompt: &str, schema: Option<&serde_json::Value>) -> serde_json::Value {
    let mut generation_config = serde_json::json!({ "maxOutputTokens": MAX_TOKENS });
    if schema.is_some() {
        generation_config["responseMimeType"] = serde_json::json!("application/json");
    }
    serde_json::json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": generation_config,
    })
}

/// Concatenate the `text` parts of the first Gemini candidate's content.
pub fn parse_gemini_text(json: &serde_json::Value) -> Result<String, AppError> {
    let parts = json
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .ok_or_else(|| other("Gemini NL: response has no candidate content parts"))?;
    let text: String = parts
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("");
    if text.trim().is_empty() {
        return Err(other("Gemini NL: empty text in response"));
    }
    Ok(text)
}

// ─── Resolution + HTTP ────────────────────────────────────────────────────────

struct ResolvedNlModel {
    kind: NlProviderKind,
    base_url: String,
    api_key: String,
    model: String,
}

/// Resolve which provider/key/model to use: the dedicated BYOK config first, then the legacy
/// model_registry Anthropic key. `None` → no key configured → caller falls back to the CLI.
fn resolve(cfg: &NlModelConfig, registry: &ModelRegistry) -> Option<ResolvedNlModel> {
    if let (Some(kind), Some(key)) = (provider_kind(&cfg.provider), cfg.usable_key()) {
        let model = cfg
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty());
        return Some(ResolvedNlModel {
            kind,
            base_url: cfg.base_url.clone().unwrap_or_default(),
            api_key: key.to_string(),
            model: model
                .map(str::to_string)
                .unwrap_or_else(|| default_model(kind).to_string()),
        });
    }
    // Legacy: an Anthropic key on the model_registry (the original W1c source).
    registry.providers.iter().find_map(|p| {
        if !p.enabled {
            return None;
        }
        let is_anthropic = p.vendor.eq_ignore_ascii_case("anthropic") || p.id == "claude";
        if !is_anthropic {
            return None;
        }
        let key = p
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())?;
        Some(ResolvedNlModel {
            kind: NlProviderKind::Anthropic,
            base_url: p.base_url.clone().unwrap_or_default(),
            api_key: key.to_string(),
            model: DEFAULT_ANTHROPIC_NL_MODEL.to_string(),
        })
    })
}

fn default_model(kind: NlProviderKind) -> &'static str {
    match kind {
        NlProviderKind::Anthropic => DEFAULT_ANTHROPIC_NL_MODEL,
        NlProviderKind::OpenAi => DEFAULT_OPENAI_NL_MODEL,
        NlProviderKind::Gemini => DEFAULT_GEMINI_NL_MODEL,
    }
}

// ─── Error taxonomy ───────────────────────────────────────────────────────────
//
// Failures carry a stable machine-readable code — `nl_complete[<code>]: <detail>` — so the
// frontend transport can react per class instead of treating every rejection identically:
// `no_key` (BYOK not configured — the ONLY code that may reach the CLI leg), `auth` (bad BYOK key),
// `quota` (out of credits), `rate_limit` (throttled), `bad_request` (a request this provider will
// never accept — schema/model/param mismatch), `timeout` / `network` (transport), `bad_response`
// (provider contract drift). Everything except `no_key` is now terminal for the command bar, so the
// code has to be specific enough to write an actionable message from.

fn nl_error(code: &str, detail: impl std::fmt::Display) -> AppError {
    other(format!("nl_complete[{code}]: {detail}"))
}

/// The machine-readable suffix the frontend transport keys on (`nl_complete[<code>]`). Since BYOK is
/// the sole path, nothing downstream papers over a failure — the code IS the diagnosis, so each class
/// the user can act on differently gets its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ErrorClass {
    code: &'static str,
}

/// Classify a provider HTTP error from its status + body. Both OpenAI and Anthropic put a machine code
/// in `error.type`; OpenAI's out-of-credits case is `insufficient_quota` — returned as **429 but
/// permanent**, so it must be told apart from a genuine rate limit that clears on its own.
///
/// A non-auth 4xx is `bad_request`, NOT `network`: the provider understood us and refused, so the
/// request will never succeed unchanged (a schema strict-mode violation, an unknown model id, a bad
/// param). Filing that under `network` is what let a permanently-broken OpenAI request masquerade as a
/// transient blip and silently divert every command to the cold-CLI leg.
fn classify_http_error(status: u16, body: &str) -> ErrorClass {
    let error_type = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|j| {
            j.get("error")
                .and_then(|e| e.get("type"))
                .and_then(|t| t.as_str())
                .map(str::to_string)
        });
    match status {
        401 | 403 => ErrorClass { code: "auth" },
        429 if error_type.as_deref() == Some("insufficient_quota") => ErrorClass { code: "quota" },
        429 => ErrorClass { code: "rate_limit" },
        s if s >= 500 => ErrorClass { code: "network" },
        s if (400..500).contains(&s) => ErrorClass {
            code: "bad_request",
        },
        _ => ErrorClass { code: "network" },
    }
}

/// Parse a `Retry-After` header as delta-seconds (what OpenAI + Anthropic send). Fractional seconds are
/// honored; an HTTP-date form or garbage yields `None`. Negative/non-finite values are treated as
/// absent. No longer used to *block* — a throttled call fails immediately — but the value is worth
/// keeping because "try again in 20s" is the difference between an actionable error and a dead end.
fn parse_retry_after(value: Option<&str>) -> Option<Duration> {
    let secs: f64 = value?.trim().parse().ok()?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(secs))
}

fn code_for_transport_message(msg: &str) -> &'static str {
    let lower = msg.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        "timeout"
    } else {
        "network"
    }
}

/// A single send's failure — kept structured so `cmd_complete` can classify an HTTP status separately
/// from a transport error (socket/DNS/timeout) and write the right message for each.
enum SendErr {
    /// The provider answered with a non-2xx status; `body` drives classification and `retry_after`
    /// enriches the message for a throttled call.
    Http {
        status: u16,
        body: String,
        retry_after: Option<Duration>,
    },
    /// No usable HTTP response (connection/timeout). Carries the transport message for classification.
    Transport(String),
}

/// Build a fresh request for `resolved` and send `payload`. Reads `Retry-After` before draining the
/// error body (consuming the response for its body would otherwise drop the headers).
async fn send_once(
    client: &reqwest::Client,
    resolved: &ResolvedNlModel,
    payload: &[u8],
) -> Result<String, SendErr> {
    let request = match resolved.kind {
        NlProviderKind::Anthropic => client
            .post(build_messages_url(&resolved.base_url))
            .header("x-api-key", &resolved.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION),
        NlProviderKind::OpenAi => client
            .post(build_openai_url(&resolved.base_url))
            .bearer_auth(&resolved.api_key),
        NlProviderKind::Gemini => client
            .post(build_gemini_url(&resolved.base_url, &resolved.model))
            .header("x-goog-api-key", &resolved.api_key),
    };
    let mut response = request
        .header("content-type", "application/json")
        .timeout(NL_HTTP_TIMEOUT)
        .body(payload.to_vec())
        .send()
        .await
        .map_err(|e| {
            SendErr::Transport(if e.is_timeout() {
                "request timed out".into()
            } else {
                "request failed".into()
            })
        })?;
    let status = response.status();
    let retry_after = parse_retry_after(
        response
            .headers()
            .get("retry-after")
            .and_then(|h| h.to_str().ok()),
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        SendErr::Transport(if e.is_timeout() {
            "response timed out".into()
        } else {
            "read response failed".into()
        })
    })? {
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err(SendErr::Transport("response exceeds 1 MB".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = String::from_utf8(bytes)
        .map_err(|_| SendErr::Transport("invalid response encoding".into()))?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(SendErr::Http {
            status: status.as_u16(),
            body,
            retry_after,
        })
    }
}

/// Longest provider-supplied error message we forward. Enough for a schema/param complaint, short
/// enough that a pathological body can't flood the renderer.
const MAX_PROVIDER_DETAIL: usize = 300;

/// Pull the provider's human-readable complaint out of an error body (`error.message` on OpenAI,
/// Anthropic and Gemini alike), truncated.
///
/// Forwarding this is what makes a `bad_request` debuggable: OpenAI names the offending schema path,
/// and discarding it in favor of a bare "HTTP 400" is precisely why a permanently-rejected request
/// went unnoticed. It is the provider's own diagnostic text about our *request shape*, not an echo of
/// the user's prompt, so it is safe to surface.
fn provider_error_message(body: &str) -> Option<String> {
    let message = serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("error")?
        .get("message")?
        .as_str()?
        .trim()
        .to_string();
    if message.is_empty() {
        return None;
    }
    Some(match message.char_indices().nth(MAX_PROVIDER_DETAIL) {
        Some((cut, _)) => format!("{}…", &message[..cut]),
        None => message,
    })
}

/// Map a `SendErr` to the frontend's coded error. HTTP → the classified code, with the provider's own
/// message appended when it offered one (and the `Retry-After` hint for a throttled call, since that
/// turns "rate limited" into something the user can act on); transport → timeout/network.
fn send_err_to_app(err: &SendErr) -> AppError {
    match err {
        SendErr::Http {
            status,
            body,
            retry_after,
        } => {
            let class = classify_http_error(*status, body);
            let mut detail = format!("HTTP {status}");
            if let Some(message) = provider_error_message(body) {
                detail.push_str(&format!(" — {message}"));
            }
            if class.code == "rate_limit" {
                if let Some(wait) = retry_after {
                    detail.push_str(&format!(" (retry after {}s)", wait.as_secs().max(1)));
                }
            }
            nl_error(class.code, detail)
        }
        SendErr::Transport(msg) => nl_error(code_for_transport_message(msg), msg.clone()),
    }
}

/// One NL utility completion over direct HTTP, sent to exactly one provider and attempted exactly once.
///
/// `Err(nl_complete[no_key])` means BYOK is not configured — the only case in which the caller may
/// reach a different provider. Every other `Err` is terminal: the prompt has already gone to the user's
/// chosen provider, so re-sending it elsewhere would both contradict that choice and duplicate the
/// disclosure. The HTTP model is authoritative from the BYOK config — callers don't pass one (a
/// frontend model id could contradict the configured provider, so the old ignored param was removed).
pub async fn cmd_complete(
    client: &reqwest::Client,
    prompt: String,
    schema: Option<serde_json::Value>,
) -> Result<String, AppError> {
    let cfg = load_config(&config_path());
    let registry = model_registry::read();
    let resolved = resolve(&cfg, &registry)
        .ok_or_else(|| nl_error("no_key", "no BYOK NL model configured"))?;

    let schema_ref = schema.as_ref();
    let body = match resolved.kind {
        NlProviderKind::Anthropic => build_messages_body(&resolved.model, &prompt, schema_ref),
        NlProviderKind::OpenAi => build_openai_body(&resolved.model, &prompt, schema_ref),
        NlProviderKind::Gemini => build_gemini_body(&prompt, schema_ref),
    };
    let payload = serde_json::to_vec(&body)
        .map_err(|e| nl_error("bad_response", format!("encode failed: {e}")))?;

    // Exactly one attempt. The previous bounded retry existed to beat the multi-second cold-CLI
    // fallback; with BYOK as the sole path there is no fallback left to beat, so a retry would only
    // delay the error the user has to act on. A throttled call reports its Retry-After instead.
    let raw = send_once(client, &resolved, &payload)
        .await
        .map_err(|e| send_err_to_app(&e))?;
    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| nl_error("bad_response", format!("bad response JSON: {e}")))?;

    match resolved.kind {
        NlProviderKind::Anthropic => parse_messages_text(&json),
        NlProviderKind::OpenAi => parse_openai_text(&json),
        NlProviderKind::Gemini => parse_gemini_text(&json),
    }
    .map_err(|e| nl_error("bad_response", e))
}

// ─── Config commands (renderer-facing; key redacted on read) ──────────────────

pub fn cmd_get_config() -> NlModelConfig {
    load_config(&config_path()).redacted()
}

/// Persist the NL model config at `path`. An empty/absent api_key clears the key. The redaction
/// sentinel "***" is treated as "keep the stored key" so a save from a redacted read never destroys it —
/// reads are redacted, so a Settings round-trip (read → edit the model → save) hands "***" straight
/// back, and taking it literally would silently overwrite the real key with three asterisks.
fn set_config_at(path: &Path, mut incoming: NlModelConfig) -> Result<(), AppError> {
    if incoming.api_key.as_deref() == Some(REDACTED_KEY) {
        incoming.api_key = load_config(path).api_key;
    }
    save_config(path, &incoming).map_err(|e| other(e.to_string()))
}

/// Persist the NL model config to its canonical location.
pub fn cmd_set_config(incoming: NlModelConfig) -> Result<(), AppError> {
    set_config_at(&config_path(), incoming)
}

#[cfg(test)]
#[path = "nl_model_http_tests.rs"]
mod http_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nl_errors_carry_a_machine_readable_code() {
        // The frontend transport classifies failures by this exact shape — a wrong BYOK key
        // (auth) must be distinguishable from a network blip so it can warn instead of
        // silently degrading to the slow CLI forever.
        let e = nl_error("auth", "HTTP 401");
        assert_eq!(e.to_string(), "nl_complete[auth]: HTTP 401");
    }

    #[test]
    fn classify_http_error_separates_every_actionable_class() {
        // 401/403 → a bad/blocked key.
        assert_eq!(classify_http_error(401, ""), ErrorClass { code: "auth" });
        assert_eq!(classify_http_error(403, "{}"), ErrorClass { code: "auth" });
        // OpenAI returns 429 for BOTH out-of-credits and a plain rate limit — the body `error.type` is
        // the only way to tell them apart, and they need different advice (top up vs wait).
        let quota = r#"{"error":{"type":"insufficient_quota","code":"insufficient_quota"}}"#;
        assert_eq!(
            classify_http_error(429, quota),
            ErrorClass { code: "quota" }
        );
        let rl = r#"{"error":{"type":"rate_limit_exceeded"}}"#;
        assert_eq!(
            classify_http_error(429, rl),
            ErrorClass { code: "rate_limit" }
        );
        assert_eq!(
            classify_http_error(429, ""),
            ErrorClass { code: "rate_limit" }
        );
        // 5xx = the provider broke, not us → network.
        assert_eq!(classify_http_error(503, ""), ErrorClass { code: "network" });
        // A non-auth 4xx is a request WE built wrong and must never look transient — this is the
        // regression that let a strict-schema 400 masquerade as a network blip and silently divert
        // every NL command to the cold-CLI leg.
        assert_eq!(
            classify_http_error(400, ""),
            ErrorClass {
                code: "bad_request"
            }
        );
        assert_eq!(
            classify_http_error(404, ""),
            ErrorClass {
                code: "bad_request"
            }
        );
        assert_eq!(
            classify_http_error(422, ""),
            ErrorClass {
                code: "bad_request"
            }
        );
    }

    #[test]
    fn send_err_forwards_the_providers_own_complaint() {
        // Discarding this message is why a permanently-rejected request went unnoticed: the frontend
        // only ever saw "HTTP 400". OpenAI names the offending schema path here.
        let body = r#"{"error":{"type":"invalid_request_error","message":"Invalid schema for response_format 'nl_intents': In context=('properties','intents'), 'required' is required to be supplied and to be an array including every key in properties."}}"#;
        let err = send_err_to_app(&SendErr::Http {
            status: 400,
            body: body.to_string(),
            retry_after: None,
        });
        let text = err.to_string();
        assert!(
            text.starts_with("nl_complete[bad_request]: HTTP 400 — "),
            "{text}"
        );
        assert!(
            text.contains("Invalid schema for response_format"),
            "{text}"
        );
    }

    #[test]
    fn send_err_surfaces_the_retry_after_hint_for_a_throttled_call() {
        // Nothing retries for the user any more, so the wait has to reach them as advice.
        let err = send_err_to_app(&SendErr::Http {
            status: 429,
            body: r#"{"error":{"type":"rate_limit_exceeded","message":"Rate limit reached"}}"#
                .to_string(),
            retry_after: Some(Duration::from_secs(20)),
        });
        let text = err.to_string();
        assert!(text.starts_with("nl_complete[rate_limit]:"), "{text}");
        assert!(text.contains("retry after 20s"), "{text}");
    }

    #[test]
    fn provider_error_message_is_truncated_not_unbounded() {
        let long = "x".repeat(MAX_PROVIDER_DETAIL * 3);
        let body = serde_json::json!({ "error": { "message": long } }).to_string();
        let message = provider_error_message(&body).expect("a message");
        assert!(
            message.len() <= MAX_PROVIDER_DETAIL + 4,
            "{}",
            message.len()
        );
        assert!(message.ends_with('…'));
        // No `error.message` at all → nothing to forward (the code alone carries the diagnosis).
        assert_eq!(provider_error_message("{}"), None);
        assert_eq!(provider_error_message("not json"), None);
        assert_eq!(
            provider_error_message(r#"{"error":{"message":"  "}}"#),
            None
        );
    }

    #[test]
    fn parse_retry_after_reads_delta_seconds() {
        assert_eq!(parse_retry_after(Some("2")), Some(Duration::from_secs(2)));
        assert_eq!(
            parse_retry_after(Some(" 1.5 ")),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(parse_retry_after(Some("0")), Some(Duration::from_secs(0)));
        assert_eq!(parse_retry_after(None), None);
        // An HTTP-date or garbage value → no numeric hint (caller uses its default backoff).
        assert_eq!(
            parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            None
        );
        assert_eq!(parse_retry_after(Some("-3")), None);
    }

    /// `required` as a set — the JSON array is order-insensitive and serde_json sorts object keys.
    fn required_set(node: &serde_json::Value) -> std::collections::BTreeSet<&str> {
        node["required"]
            .as_array()
            .map(|names| names.iter().filter_map(|n| n.as_str()).collect())
            .unwrap_or_default()
    }

    /// Walk a schema and collect every violation of OpenAI's strict dialect. This mirrors the checker
    /// used to diagnose the original 400s, so it fails for the same reasons OpenAI would.
    fn strict_violations(node: &serde_json::Value, path: &str, out: &mut Vec<String>) {
        match node {
            serde_json::Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    strict_violations(item, &format!("{path}[{i}]"), out);
                }
            }
            serde_json::Value::Object(map) => {
                if map.contains_key("properties")
                    || map.get("type").and_then(|t| t.as_str()) == Some("object")
                {
                    if map.get("additionalProperties") != Some(&serde_json::Value::Bool(false)) {
                        out.push(format!("{path}: additionalProperties must be false"));
                    }
                    let declared: Vec<&String> = map
                        .get("properties")
                        .and_then(|p| p.as_object())
                        .map(|p| p.keys().collect())
                        .unwrap_or_default();
                    let required: std::collections::HashSet<&str> = map
                        .get("required")
                        .and_then(|r| r.as_array())
                        .map(|r| r.iter().filter_map(|v| v.as_str()).collect())
                        .unwrap_or_default();
                    for name in declared {
                        if !required.contains(name.as_str()) {
                            out.push(format!("{path}: '{name}' missing from required"));
                        }
                    }
                }
                if map.contains_key("const") {
                    out.push(format!("{path}: 'const' is not part of the strict dialect"));
                }
                for (key, value) in map {
                    match key.as_str() {
                        "enum" | "required" | "description" => {}
                        _ => strict_violations(value, &format!("{path}.{key}"), out),
                    }
                }
            }
            _ => {}
        }
    }

    /// A trimmed stand-in for the real generated schema, reproducing each shape that actually broke:
    /// an optional scalar, an optional enum, an `anyOf` union, a nested object, and a `const`.
    fn sample_intent_schema() -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "intents": {
                    "type": "array",
                    "items": {
                        "anyOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "action": { "const": "spawn_agent" },
                                    "runner": { "type": "string", "enum": ["claude", "codex"] },
                                    "model": { "type": "string" },
                                    "brief": { "type": "string" }
                                },
                                "required": ["action"],
                                "additionalProperties": false
                            },
                            {
                                "type": "object",
                                "properties": {
                                    "action": { "const": "close" },
                                    "target": {
                                        "anyOf": [
                                            { "type": "string" },
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "nodeType": { "type": "string" },
                                                    "count": { "type": "number" }
                                                }
                                            }
                                        ]
                                    }
                                },
                                "required": ["action"],
                                "additionalProperties": false
                            }
                        ]
                    }
                }
            },
            "required": ["intents"],
            "additionalProperties": false
        })
    }

    #[test]
    fn generated_intent_schema_is_rejected_by_strict_mode_before_the_transform() {
        // Guards the premise: without strictify_schema this request is unsendable, which is what put
        // every NL command on the 100s+ cold-CLI path.
        let mut before = Vec::new();
        strict_violations(&sample_intent_schema(), "$", &mut before);
        assert!(
            !before.is_empty(),
            "sample schema should violate strict mode before the transform"
        );
    }

    #[test]
    fn strictify_schema_satisfies_openai_strict_mode() {
        let strict = strictify_schema(&sample_intent_schema());
        let mut after = Vec::new();
        strict_violations(&strict, "$", &mut after);
        assert!(after.is_empty(), "remaining violations: {after:#?}");
    }

    #[test]
    fn strictify_schema_keeps_optional_fields_optional_by_widening_them_to_null() {
        let strict = strictify_schema(&sample_intent_schema());
        let spawn = &strict["properties"]["intents"]["items"]["anyOf"][0];

        // Every property is now required — that is the dialect's demand. Compared as a set, since
        // `required` is one and serde_json orders object keys itself.
        assert_eq!(
            required_set(spawn),
            ["action", "brief", "model", "runner"]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
        );
        // … so "optional" has to be carried by the type instead, or we'd have silently made `model` and
        // `brief` mandatory and forced the model to invent values for them.
        assert_eq!(
            spawn["properties"]["model"]["type"],
            serde_json::json!(["string", "null"])
        );
        assert_eq!(
            spawn["properties"]["brief"]["type"],
            serde_json::json!(["string", "null"])
        );
        // An optional enum admits null as a member too, otherwise the grammar has no legal "absent".
        assert_eq!(
            spawn["properties"]["runner"]["enum"],
            serde_json::json!(["claude", "codex", null])
        );
        // A required field is left strictly typed — `action` must never become nullable.
        assert_eq!(
            spawn["properties"]["action"]["enum"],
            serde_json::json!(["spawn_agent"])
        );
        assert!(spawn["properties"]["action"].get("type").is_none());
    }

    #[test]
    fn strictify_schema_widens_a_union_with_a_null_variant_and_closes_nested_objects() {
        let strict = strictify_schema(&sample_intent_schema());
        let target = &strict["properties"]["intents"]["items"]["anyOf"][1]["properties"]["target"];

        // An optional `anyOf` gains a null variant rather than a bogus top-level `type`.
        let variants = target["anyOf"].as_array().expect("anyOf variants");
        assert_eq!(variants.len(), 3);
        assert_eq!(variants[2], serde_json::json!({ "type": "null" }));
        // The nested object inside the union is closed and fully required as well — the `graph` shape in
        // the real schema failed exactly here.
        let nested = &variants[1];
        assert_eq!(nested["additionalProperties"], serde_json::json!(false));
        assert_eq!(
            required_set(nested),
            ["count", "nodeType"]
                .into_iter()
                .collect::<std::collections::BTreeSet<_>>()
        );
    }

    /// The REAL schema `buildNlIntentSchema` generates, captured from the TS registry
    /// (`tests/fixtures/nl-intent-schema.json`). The hand-written `sample_intent_schema` above
    /// reproduces the shapes that broke; this one guarantees nothing in the actual 20-intent registry
    /// slips past the transform. Regenerate the fixture if the registry's parameter shapes change.
    const REAL_INTENT_SCHEMA: &str = include_str!("../tests/fixtures/nl-intent-schema.json");

    #[test]
    fn strictify_schema_makes_the_real_generated_schema_sendable() {
        let schema: serde_json::Value =
            serde_json::from_str(REAL_INTENT_SCHEMA).expect("fixture parses");

        // The premise, on the real thing: as generated, OpenAI strict mode rejects it outright.
        let mut before = Vec::new();
        strict_violations(&schema, "$", &mut before);
        assert!(
            before.len() >= 10,
            "expected the untransformed registry schema to violate strict mode, got {before:#?}"
        );

        // …and after the transform there is nothing left for OpenAI to complain about.
        let strict = strictify_schema(&schema);
        let mut after = Vec::new();
        strict_violations(&strict, "$", &mut after);
        assert!(after.is_empty(), "remaining violations: {after:#?}");
        assert_eq!(strictify_schema(&strict), strict, "must stay idempotent");
    }

    #[test]
    fn strictify_schema_preserves_every_intent_variant_and_its_action() {
        // The transform must not drop or merge variants — each of the registry's actions has to survive
        // as its own branch, or the grammar would silently stop allowing some commands.
        let schema: serde_json::Value =
            serde_json::from_str(REAL_INTENT_SCHEMA).expect("fixture parses");
        // `action` is a `const` before the transform and a one-member `enum` after it, so each side is
        // read from its own keyword and the resulting action lists compared.
        let variants = |node: &serde_json::Value| -> Vec<serde_json::Value> {
            node["properties"]["intents"]["anyOf"]
                .as_array()
                .and_then(|branches| {
                    branches
                        .iter()
                        .find_map(|branch| branch.get("items")?.get("anyOf")?.as_array().cloned())
                })
                .expect("variants")
        };
        let before: Vec<serde_json::Value> = variants(&schema)
            .iter()
            .map(|v| v["properties"]["action"]["const"].clone())
            .collect();

        let strict = strictify_schema(&schema);
        let after: Vec<serde_json::Value> = variants(&strict)
            .iter()
            .map(|v| v["properties"]["action"]["enum"][0].clone())
            .collect();
        assert_eq!(
            before, after,
            "every action must survive the const→enum normalization"
        );
        assert!(
            after.len() >= 15,
            "unexpectedly few intents: {}",
            after.len()
        );
    }

    #[test]
    fn strictify_schema_is_idempotent() {
        // The transform runs per request; applying it twice must not keep appending null variants.
        let once = strictify_schema(&sample_intent_schema());
        let twice = strictify_schema(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn openai_body_sends_the_strictified_schema() {
        let body = build_openai_body("gpt-4o-mini", "hi", Some(&sample_intent_schema()));
        let sent = &body["response_format"]["json_schema"];
        assert_eq!(sent["strict"], serde_json::json!(true));
        let mut violations = Vec::new();
        strict_violations(&sent["schema"], "$", &mut violations);
        assert!(violations.is_empty(), "unsendable schema: {violations:#?}");
    }

    #[test]
    fn anthropic_and_gemini_bodies_are_untouched_by_the_openai_transform() {
        let schema = sample_intent_schema();
        // The transform is an OpenAI dialect quirk, so the shared schema must reach the other providers
        // exactly as the registry generated it.
        let anthropic = build_messages_body("claude-haiku-4-5", "hi", Some(&schema));
        assert_eq!(anthropic["output_config"]["format"]["schema"], schema);
        // Gemini deliberately carries no schema (its subset rejects anyOf/additionalProperties).
        let gemini = build_gemini_body("hi", Some(&schema));
        assert!(gemini.get("responseSchema").is_none());
        assert_eq!(
            gemini["generationConfig"]["responseMimeType"],
            serde_json::json!("application/json")
        );
    }

    #[test]
    fn transport_message_classifies_timeout_vs_network() {
        assert_eq!(
            code_for_transport_message("timed out reading response"),
            "timeout"
        );
        assert_eq!(
            code_for_transport_message("Connection Failed: dns error"),
            "network"
        );
    }

    #[test]
    fn provider_kind_maps_known_aliases_only() {
        assert_eq!(provider_kind("openai"), Some(NlProviderKind::OpenAi));
        assert_eq!(provider_kind("OpenAI"), Some(NlProviderKind::OpenAi));
        assert_eq!(provider_kind("anthropic"), Some(NlProviderKind::Anthropic));
        assert_eq!(provider_kind("claude"), Some(NlProviderKind::Anthropic));
        assert_eq!(provider_kind("gemini"), Some(NlProviderKind::Gemini));
        assert_eq!(provider_kind("google"), Some(NlProviderKind::Gemini));
        assert_eq!(provider_kind("mistral"), None);
        assert_eq!(provider_kind(""), None);
    }

    #[test]
    fn openai_url_handles_default_and_v1_proxy() {
        assert_eq!(
            build_openai_url(""),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            build_openai_url("https://proxy.test"),
            "https://proxy.test/v1/chat/completions"
        );
        assert_eq!(
            build_openai_url("https://proxy.test/v1"),
            "https://proxy.test/v1/chat/completions"
        );
        assert_eq!(
            build_openai_url("https://proxy.test/v1/"),
            "https://proxy.test/v1/chat/completions"
        );
    }

    #[test]
    fn openai_body_is_a_single_user_turn() {
        let b = build_openai_body("gpt-4o-mini", "hi", None);
        assert_eq!(b["model"], "gpt-4o-mini");
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["messages"][0]["content"], "hi");
        assert!(b.get("response_format").is_none()); // free-form when no schema
    }

    #[test]
    fn messages_body_omits_output_config_without_a_schema() {
        let b = build_messages_body("claude-haiku-4-5", "hi", None);
        assert_eq!(b["messages"][0]["content"], "hi");
        assert!(b.get("output_config").is_none());
    }

    #[test]
    fn messages_body_grammar_enforces_when_a_schema_is_given() {
        let schema = serde_json::json!({ "type": "object", "additionalProperties": false });
        let b = build_messages_body("claude-haiku-4-5", "hi", Some(&schema));
        // Anthropic Messages structured-output shape: output_config.format.{type,schema}.
        assert_eq!(b["output_config"]["format"]["type"], "json_schema");
        assert_eq!(b["output_config"]["format"]["schema"], schema);
    }

    #[test]
    fn openai_body_uses_response_format_json_schema_when_given() {
        let schema = serde_json::json!({ "type": "object", "additionalProperties": false });
        let b = build_openai_body("gpt-4o-mini", "hi", Some(&schema));
        assert_eq!(b["response_format"]["type"], "json_schema");
        assert_eq!(b["response_format"]["json_schema"]["strict"], true);
        // The schema is adapted to strict mode rather than forwarded verbatim: a property-less object is
        // free-form, which strict mode rejects, so it is pinned closed.
        assert_eq!(
            b["response_format"]["json_schema"]["schema"],
            serde_json::json!({
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            })
        );
    }

    #[test]
    fn parses_openai_choice_content() {
        let json = serde_json::json!({ "choices": [{ "message": { "role": "assistant", "content": "hello world" } }] });
        assert_eq!(parse_openai_text(&json).unwrap(), "hello world");
        assert!(parse_openai_text(&serde_json::json!({ "choices": [] })).is_err());
        assert!(parse_openai_text(&serde_json::json!({})).is_err());
    }

    #[test]
    fn gemini_url_puts_the_model_in_the_path() {
        assert_eq!(
            build_gemini_url("", "gemini-2.5-flash"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        assert_eq!(
            build_gemini_url("https://proxy.test", "gemini-2.0-flash"),
            "https://proxy.test/v1beta/models/gemini-2.0-flash:generateContent"
        );
        assert_eq!(
            build_gemini_url("https://proxy.test/", "m"),
            "https://proxy.test/v1beta/models/m:generateContent"
        );
    }

    #[test]
    fn gemini_body_is_a_single_text_part_and_carries_no_model() {
        let b = build_gemini_body("hi", None);
        assert_eq!(b["contents"][0]["parts"][0]["text"], "hi");
        // Gemini carries the model in the URL, not the body.
        assert!(b.get("model").is_none());
        assert_eq!(b["generationConfig"]["maxOutputTokens"], MAX_TOKENS);
        // Free-form when no schema is requested.
        assert!(b["generationConfig"].get("responseMimeType").is_none());
    }

    #[test]
    fn gemini_body_requests_json_mode_when_a_schema_is_given() {
        let schema = serde_json::json!({ "type": "object" });
        let b = build_gemini_body("hi", Some(&schema));
        // Force JSON output via mime type, but DON'T forward the JSON-Schema dialect as responseSchema
        // (Gemini's schema subset rejects additionalProperties/anyOf) — parseNlIntents parses the JSON.
        assert_eq!(
            b["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert!(b["generationConfig"].get("responseSchema").is_none());
    }

    #[test]
    fn parses_gemini_candidate_text() {
        let json = serde_json::json!({
            "candidates": [{ "content": { "parts": [{ "text": "hello" }, { "text": " world" }], "role": "model" } }]
        });
        assert_eq!(parse_gemini_text(&json).unwrap(), "hello world");
        assert!(parse_gemini_text(&serde_json::json!({ "candidates": [] })).is_err());
        assert!(parse_gemini_text(&serde_json::json!({})).is_err());
    }

    #[test]
    fn resolve_prefers_configured_openai_then_registry_anthropic() {
        let registry = ModelRegistry {
            active_provider: "claude".into(),
            active_model: "m".into(),
            providers: vec![],
        };

        // Configured OpenAI wins, with the model override.
        let cfg = NlModelConfig {
            provider: "openai".into(),
            api_key: Some("sk-openai".into()),
            model: Some("gpt-5-mini".into()),
            base_url: None,
        };
        let r = resolve(&cfg, &registry).unwrap();
        assert_eq!(r.kind, NlProviderKind::OpenAi);
        assert_eq!(r.api_key, "sk-openai");
        assert_eq!(r.model, "gpt-5-mini");

        // OpenAI with no model → the fast default.
        let cfg2 = NlModelConfig {
            provider: "openai".into(),
            api_key: Some("k".into()),
            model: None,
            base_url: None,
        };
        assert_eq!(
            resolve(&cfg2, &registry).unwrap().model,
            DEFAULT_OPENAI_NL_MODEL
        );

        // Configured Gemini resolves with its default fast model when none is given.
        let gcfg = NlModelConfig {
            provider: "gemini".into(),
            api_key: Some("g-key".into()),
            model: None,
            base_url: None,
        };
        let g = resolve(&gcfg, &registry).unwrap();
        assert_eq!(g.kind, NlProviderKind::Gemini);
        assert_eq!(g.api_key, "g-key");
        assert_eq!(g.model, DEFAULT_GEMINI_NL_MODEL);

        // No key configured anywhere → None (CLI fallback).
        let empty = NlModelConfig::default();
        assert!(resolve(&empty, &registry).is_none());
    }

    #[test]
    fn redacted_hides_the_key_but_keeps_shape() {
        let cfg = NlModelConfig {
            provider: "openai".into(),
            api_key: Some("sk-secret".into()),
            model: Some("gpt-4o-mini".into()),
            base_url: None,
        };
        let r = cfg.redacted();
        assert_eq!(r.api_key.as_deref(), Some("***"));
        assert_eq!(r.provider, "openai");
        assert_eq!(r.model.as_deref(), Some("gpt-4o-mini"));
    }

    #[test]
    fn debug_never_prints_the_key() {
        // A derived Debug would print the key verbatim; this struct travels through command handlers and
        // error paths where one `{:?}` would leak it into a log.
        let cfg = NlModelConfig {
            provider: "openai".into(),
            api_key: Some("sk-proj-super-secret-value".into()),
            model: None,
            base_url: None,
        };
        let printed = format!("{cfg:?}");
        assert!(!printed.contains("sk-proj"), "{printed}");
        assert!(!printed.contains("super-secret"), "{printed}");
        assert!(printed.contains("<redacted>"), "{printed}");

        let empty = NlModelConfig::default();
        assert!(format!("{empty:?}").contains("<unset>"));
    }

    #[test]
    fn saving_a_redacted_key_keeps_the_stored_one() {
        let dir =
            std::env::temp_dir().join(format!("lotus-nl-model-redaction-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("nl-model.json");

        // Store a real key…
        set_config_at(
            &path,
            NlModelConfig {
                provider: "openai".into(),
                api_key: Some("sk-real-key".into()),
                model: None,
                base_url: None,
            },
        )
        .expect("initial save");

        // …then simulate the Settings round-trip: the renderer read a REDACTED config and saves it back
        // with only the model changed. The key must survive.
        let round_tripped = load_config(&path).redacted();
        assert_eq!(round_tripped.api_key.as_deref(), Some(REDACTED_KEY));
        set_config_at(
            &path,
            NlModelConfig {
                model: Some("gpt-4o-mini".into()),
                ..round_tripped
            },
        )
        .expect("round-trip save");

        let after = load_config(&path);
        assert_eq!(after.api_key.as_deref(), Some("sk-real-key"));
        assert_eq!(after.model.as_deref(), Some("gpt-4o-mini"));

        // An explicitly empty key still clears it — that is how a user removes BYOK (and thereby
        // re-enables the CLI leg).
        set_config_at(
            &path,
            NlModelConfig {
                provider: "openai".into(),
                api_key: Some(String::new()),
                model: None,
                base_url: None,
            },
        )
        .expect("clearing save");
        assert_eq!(load_config(&path).usable_key(), None);

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn saved_config_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("lotus-nl-model-perms-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("nl-model.json");

        set_config_at(
            &path,
            NlModelConfig {
                provider: "anthropic".into(),
                api_key: Some("sk-ant-secret".into()),
                model: None,
                base_url: None,
            },
        )
        .expect("save");

        // The file holds a plaintext credential — it must not be group/world readable.
        let mode = fs::metadata(&path).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "unexpected mode {:o}", mode & 0o777);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nl_model_commands_are_allowed_for_main_app_webviews() {
        let permissions = include_str!("../permissions/main-app-commands.toml");
        for command in [
            "nl_complete",
            "nl_cancel",
            "nl_model_get_config",
            "nl_model_set_config",
        ] {
            assert!(
                permissions.contains(&format!("\"{command}\"")),
                "{command} must be listed in allow-main-app-commands"
            );
        }
    }
}
