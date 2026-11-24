//! BYOK speech-to-text provider registry for the CodeCanvas NL command bar (voice input).
//!
//! Stored at `~/.lotus/stt-providers.json` (chmod 0600 — it holds API keys, same threat model as
//! `tts-providers.json` / `model-registry.json`). Built-in providers (browser, openai, deepgram)
//! always exist and cannot be deleted — only disabled or reconfigured. The `browser` provider uses
//! the Web Speech API in the renderer (no key); cloud providers are BYOK and route through
//! [`cmd_transcribe`].
//!
//! Cloud transcription ([`cmd_transcribe`]) is implemented per-`kind`: OpenAI Whisper-compatible
//! (`/audio/transcriptions`, multipart) and Deepgram (`/listen`, raw audio). `custom` is treated as
//! OpenAI-compatible. The front-end capture + upload wiring lives in
//! `src/modules/codecanvas/services/voice/cloud-stt-provider.ts`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::{Deserialize, Serialize};

use crate::error::{other, AppError};
pub use crate::stt_decoder_context::SttDecoderContext;
use crate::stt_decoder_context::{
    build_openai_context_fields, parse_openai_transcript, sanitize_decoder_languages,
};
use crate::voice_http::{
    base_endpoint, base_mime, build_multipart, filename_for_mime, map_http_err, MAX_AUDIO_BYTES,
    VOICE_HTTP_TIMEOUT,
};

const QUERY_VALUE_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b'/')
    .add(b'=')
    .add(b'?');

// ─── Domain types ─────────────────────────────────────────────────────────────

/// On-disk + in-memory shape of a single STT provider.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SttProviderConfig {
    pub id: String,
    pub name: String,
    /// Dispatch tag: "browser" | "openai" | "deepgram" | "custom".
    pub kind: String,
    /// Built-in entries ship with Lotus defaults and cannot be deleted (only disabled).
    pub builtin: bool,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Plaintext API key (0600 file). Redacted to "***" over IPC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional BCP-47 language hint (e.g. "en", "id").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

impl std::fmt::Debug for SttProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SttProviderConfig")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("kind", &self.kind)
            .field("builtin", &self.builtin)
            .field("enabled", &self.enabled)
            .field("base_url", &self.base_url)
            .field(
                "api_key",
                &self
                    .api_key
                    .as_deref()
                    .filter(|key| !key.is_empty())
                    .map(|_| "<redacted>"),
            )
            .field("model", &self.model)
            .field("language", &self.language)
            .finish()
    }
}

impl SttProviderConfig {
    /// Return a copy with `api_key` replaced by `"***"` for safe logging / IPC.
    pub fn redacted(&self) -> Self {
        Self {
            api_key: self.api_key.as_ref().map(|k| {
                if k.is_empty() {
                    k.clone()
                } else {
                    "***".to_string()
                }
            }),
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SttProviderRegistry {
    /// Active provider id used by the voice-input channel. Defaults to "browser".
    pub active_provider: String,
    pub providers: Vec<SttProviderConfig>,
}

impl Default for SttProviderRegistry {
    fn default() -> Self {
        default_registry()
    }
}

/// Transcript returned to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttTranscriptResult {
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub detected_languages: Vec<String>,
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

pub fn default_registry() -> SttProviderRegistry {
    SttProviderRegistry {
        active_provider: "browser".to_string(),
        providers: vec![
            SttProviderConfig {
                id: "browser".to_string(),
                name: "Browser (Web Speech)".to_string(),
                kind: "browser".to_string(),
                builtin: true,
                enabled: true,
                base_url: None,
                api_key: None,
                model: None,
                language: None,
            },
            SttProviderConfig {
                id: "openai".to_string(),
                name: "OpenAI".to_string(),
                kind: "openai".to_string(),
                builtin: true,
                enabled: false,
                base_url: Some("https://api.openai.com/v1".to_string()),
                api_key: None,
                // OpenAI's recommended bounded-recording model; supports structured keyword and
                // multiple-language hints for technical code-switching dictation.
                model: Some("gpt-transcribe".to_string()),
                language: None,
            },
            SttProviderConfig {
                id: "deepgram".to_string(),
                name: "Deepgram".to_string(),
                kind: "deepgram".to_string(),
                builtin: true,
                enabled: false,
                base_url: Some("https://api.deepgram.com/v1".to_string()),
                api_key: None,
                model: Some("nova-2".to_string()),
                language: None,
            },
        ],
    }
}

fn default_path() -> PathBuf {
    crate::paths::lotus_state_dir().join("stt-providers.json")
}

/// Merge saved providers over the built-in defaults so newly-shipped built-ins appear for existing
/// installs while user edits to known providers persist.
fn reconcile(mut saved: SttProviderRegistry) -> SttProviderRegistry {
    // The built-in OpenAI provider used to default to `gpt-4o-transcribe`, which OpenAI deprecated and
    // and which turned short Indonesian turns into English-sounding words (2026-11-04).
    // Move that old default to the current one; any other model the user typed stays as is.
    for p in saved.providers.iter_mut() {
        if p.id == "openai" && p.builtin && p.model.as_deref() == Some("gpt-4o-transcribe") {
            p.model = Some("gpt-transcribe".to_string());
        }
    }
    for d in default_registry().providers {
        if !saved.providers.iter().any(|p| p.id == d.id) {
            saved.providers.push(d);
        }
    }
    saved
}

// ─── Persistence ──────────────────────────────────────────────────────────────

pub fn load(path: &Path) -> SttProviderRegistry {
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return default_registry(),
    };
    serde_json::from_slice::<SttProviderRegistry>(&raw)
        .map(reconcile)
        .unwrap_or_else(|_| default_registry())
}

/// Persist registry to disk (0600). Returns `io::Error` on failure.
pub fn save(path: &Path, registry: &SttProviderRegistry) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(registry)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write_secret(path, &body)
}

/// Atomic write with 0600 perms — same pattern as `tts_providers` / `model_registry`.
fn atomic_write_secret(target: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&tmp, perms)?;
    }
    fs::rename(tmp, target)
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/// Add or update a provider by id (replaced entirely if present).
pub fn upsert_provider(registry: &mut SttProviderRegistry, provider: SttProviderConfig) {
    if let Some(pos) = registry.providers.iter().position(|p| p.id == provider.id) {
        registry.providers[pos] = provider;
    } else {
        registry.providers.push(provider);
    }
}

/// Remove a non-builtin provider by id. Errors if built-in or not found. If the active provider is
/// removed, fall back to "browser" so the voice channel is never left pointing at nothing.
pub fn delete_provider(registry: &mut SttProviderRegistry, id: &str) -> Result<(), AppError> {
    let pos = registry
        .providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| other(format!("stt provider '{id}' not found")))?;

    if registry.providers[pos].builtin {
        return Err(other(format!(
            "stt provider '{id}' is built-in and cannot be deleted"
        )));
    }

    if registry.active_provider == id {
        registry.active_provider = "browser".to_string();
    }

    registry.providers.remove(pos);
    Ok(())
}

// ─── Command implementations (called by Tauri commands in lib.rs) ─────────────

pub fn cmd_list_providers() -> SttProviderRegistry {
    let mut registry = load(&default_path());
    registry.providers = registry
        .providers
        .into_iter()
        .map(|p| p.redacted())
        .collect();
    registry
}

pub fn cmd_get_provider(id: &str) -> Option<SttProviderConfig> {
    load(&default_path())
        .providers
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.redacted())
}

/// Upsert a provider from the settings UI. Preserves the real API key when the incoming value
/// carries the `"***"` redaction sentinel.
pub fn cmd_upsert_provider(provider: SttProviderConfig) -> Result<(), String> {
    let path = default_path();
    let mut registry = load(&path);

    let mut incoming = provider;
    if incoming.api_key.as_deref() == Some("***") {
        if let Some(existing) = registry.providers.iter().find(|p| p.id == incoming.id) {
            incoming.api_key = existing.api_key.clone();
        } else {
            incoming.api_key = None;
        }
    }

    upsert_provider(&mut registry, incoming);
    save(&path, &registry).map_err(|e| e.to_string())
}

pub fn cmd_delete_provider(id: &str) -> Result<(), String> {
    let path = default_path();
    let mut registry = load(&path);
    delete_provider(&mut registry, id).map_err(|e| e.to_string())?;
    save(&path, &registry).map_err(|e| e.to_string())
}

pub fn cmd_set_active_provider(id: &str) -> Result<(), String> {
    let path = default_path();
    let mut registry = load(&path);
    if !registry.providers.iter().any(|p| p.id == id) {
        return Err(format!("stt provider '{id}' not found"));
    }
    registry.active_provider = id.to_string();
    save(&path, &registry).map_err(|e| e.to_string())
}

/// BYOK transcription seam. Loads the *unredacted* provider config (the API key stays in Rust, never
/// reaching the renderer), decodes the recorded audio, POSTs it to the provider's transcription API
/// and returns the text. `browser` is handled entirely in the renderer (Web Speech API) and must
/// never reach this command.
/// Look up a single provider by id — used by the streaming STT path (stt_stream.rs) to read the
/// Deepgram key + model without re-implementing registry loading.
pub fn find_provider(provider_id: &str) -> Option<SttProviderConfig> {
    load(&default_path())
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
}

fn with_configured_language(
    context: Option<&SttDecoderContext>,
    configured_language: Option<&str>,
) -> Option<SttDecoderContext> {
    let mut effective = context.cloned().unwrap_or_default();
    if let Some(language) = configured_language
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        effective.languages = vec![language.to_string()];
    }
    if effective.prompt.is_empty()
        && effective.keywords.is_empty()
        && effective.languages.is_empty()
    {
        None
    } else {
        Some(effective)
    }
}

fn single_language_hint(context: Option<&SttDecoderContext>) -> Option<String> {
    let languages = context
        .map(|value| sanitize_decoder_languages(&value.languages))
        .unwrap_or_default();
    (languages.len() == 1).then(|| languages[0].clone())
}

/// [`cmd_transcribe`] on the blocking pool. A sync Tauri command runs on the main thread, so a slow
/// provider (up to the HTTP timeout) froze the whole UI; the async command awaits this instead.
pub async fn cmd_transcribe_off_main(
    provider_id: String,
    audio_base64: String,
    mime: String,
    context: Option<SttDecoderContext>,
) -> Result<SttTranscriptResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        cmd_transcribe(&provider_id, &audio_base64, &mime, context.as_ref())
    })
    .await
    .map_err(|e| other(format!("transcription task failed: {e}")))?
}

pub fn cmd_transcribe(
    provider_id: &str,
    audio_base64: &str,
    mime: &str,
    context: Option<&SttDecoderContext>,
) -> Result<SttTranscriptResult, AppError> {
    let provider = load(&default_path())
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| other(format!("stt provider '{provider_id}' not found")))?;

    if provider.kind == "browser" {
        return Err(other(
            "browser STT is transcribed in the renderer, not via stt_transcribe",
        ));
    }

    let api_key = provider
        .api_key
        .clone()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            other(format!(
                "stt provider '{provider_id}' has no API key configured"
            ))
        })?;

    let audio = BASE64
        .decode(audio_base64.as_bytes())
        .map_err(|e| other(format!("invalid audio payload: {e}")))?;
    if audio.is_empty() {
        return Ok(SttTranscriptResult {
            text: String::new(),
            detected_languages: Vec::new(),
        });
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(other(format!(
            "recording too large ({} MB) — keep voice commands under {} MB",
            audio.len() / (1024 * 1024),
            MAX_AUDIO_BYTES / (1024 * 1024)
        )));
    }

    let configured_language = provider.language.as_deref().filter(|l| !l.is_empty());
    let effective_context = with_configured_language(context, configured_language);
    let context_language = single_language_hint(effective_context.as_ref());
    let language = configured_language.or(context_language.as_deref());
    let result = match provider.kind.as_str() {
        "deepgram" => transcribe_deepgram(
            base_endpoint(provider.base_url.as_deref(), "https://api.deepgram.com/v1"),
            &api_key,
            provider.model.as_deref(),
            language,
            base_mime(mime),
            &audio,
        )
        .map(|text| SttTranscriptResult {
            text,
            detected_languages: Vec::new(),
        })?,
        // `openai` and `custom` both speak the OpenAI `/audio/transcriptions` multipart contract.
        "openai" | "custom" => transcribe_openai(
            base_endpoint(provider.base_url.as_deref(), "https://api.openai.com/v1"),
            &api_key,
            provider.model.as_deref().unwrap_or("whisper-1"),
            effective_context.as_ref(),
            mime,
            &audio,
        )?,
        other_kind => {
            return Err(other(format!(
                "unsupported stt provider kind '{other_kind}'"
            )));
        }
    };

    Ok(SttTranscriptResult {
        text: result.text.trim().to_string(),
        detected_languages: result.detected_languages,
    })
}

/// OpenAI Whisper-compatible transcription: `POST {base}/audio/transcriptions` (multipart). Returns
/// the `text` field of the JSON response.
fn transcribe_openai(
    base_url: String,
    api_key: &str,
    model: &str,
    context: Option<&SttDecoderContext>,
    mime: &str,
    audio: &[u8],
) -> Result<SttTranscriptResult, AppError> {
    let url = format!("{base_url}/audio/transcriptions");
    let boundary = "----LotusSttBoundaryQ8x2vT9wKmRp";
    // temperature=0 → deterministic, fewer hallucinated words. Context is projected by model
    // capability so official OpenAI extensions never leak into unknown compatible endpoints.
    let mut owned_fields = vec![
        ("model".to_string(), model.to_string()),
        ("temperature".to_string(), "0".to_string()),
    ];
    owned_fields.extend(build_openai_context_fields(
        model,
        context,
        base_url == "https://api.openai.com/v1",
    ));
    let fields: Vec<(&str, &str)> = owned_fields
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    let body = build_multipart(
        boundary,
        &fields,
        "file",
        filename_for_mime(mime),
        base_mime(mime),
        audio,
    );

    let resp = ureq::post(&url)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .timeout(VOICE_HTTP_TIMEOUT)
        .send_bytes(&body)
        .map_err(map_http_err("OpenAI transcription"))?;

    let raw = resp.into_string().map_err(|e| {
        other(format!(
            "OpenAI transcription: failed to read response: {e}"
        ))
    })?;
    parse_openai_transcript(&raw)
}

fn build_deepgram_url(base_url: String, model: Option<&str>, language: Option<&str>) -> String {
    let mut query: Vec<String> = vec!["smart_format=true".to_string()];
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        query.push(format!(
            "model={}",
            utf8_percent_encode(m, QUERY_VALUE_ENCODE_SET)
        ));
    }
    if let Some(lang) = language.filter(|lang| !lang.is_empty()) {
        query.push(format!(
            "language={}",
            utf8_percent_encode(lang, QUERY_VALUE_ENCODE_SET)
        ));
    }
    format!("{base_url}/listen?{}", query.join("&"))
}

/// Deepgram transcription: `POST {base}/listen` with the raw audio as the request body. Returns the
/// first channel/alternative transcript.
fn transcribe_deepgram(
    base_url: String,
    api_key: &str,
    model: Option<&str>,
    language: Option<&str>,
    content_type: &str,
    audio: &[u8],
) -> Result<String, AppError> {
    let url = build_deepgram_url(base_url, model, language);

    let resp = ureq::post(&url)
        .set("Authorization", &format!("Token {api_key}"))
        .set("Content-Type", content_type)
        .timeout(VOICE_HTTP_TIMEOUT)
        .send_bytes(audio)
        .map_err(map_http_err("Deepgram transcription"))?;

    let raw = resp.into_string().map_err(|e| {
        other(format!(
            "Deepgram transcription: failed to read response: {e}"
        ))
    })?;
    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| other(format!("Deepgram transcription: invalid response: {e}")))?;
    Ok(
        json["results"]["channels"][0]["alternatives"][0]["transcript"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

#[cfg(test)]
#[path = "stt_providers_tests.rs"]
mod tests;
