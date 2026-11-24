//! BYOK **voice-to-voice** (speech-to-speech) provider registry for CodeCanvas.
//!
//! Stored at `~/.lotus/s2s-providers.json` (chmod 0600 — it holds API keys, same threat model as
//! `stt-providers.json` / `tts-providers.json` / `model-registry.json`). This backs the opt-in
//! duplex voice mode (see `plans/voice-to-voice/research-and-analysis.md`). It is ADDITIVE: the
//! existing turn-based STT/TTS registries are untouched; nothing here runs unless the user enables
//! voice-to-voice and picks a provider.
//!
//! Built-in providers are realtime S2S endpoints that speak the OpenAI Realtime event schema:
//!   • grok            — xAI Grok Voice Agent, `wss://api.x.ai/v1/realtime` (OpenAI-compatible)
//!   • openai-realtime — OpenAI Realtime, `wss://api.openai.com/v1/realtime`
//! `custom` is treated as an OpenAI-Realtime-compatible endpoint. The WebSocket transport that uses
//! these keys lives in `s2s_stream.rs`; keys never leave Rust (redacted to "***" over IPC).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{other, AppError};

/// The active provider to fall back to when the current one is deleted — the first built-in.
const FALLBACK_ACTIVE: &str = "grok";

// ─── Domain types ─────────────────────────────────────────────────────────────

/// On-disk + in-memory shape of a single voice-to-voice provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct S2sProviderConfig {
    pub id: String,
    pub name: String,
    /// Dispatch tag: "grok" | "openai-realtime" | "custom" (all OpenAI-Realtime-compatible).
    pub kind: String,
    /// Built-in entries ship with Lotus defaults and cannot be deleted (only disabled).
    pub builtin: bool,
    pub enabled: bool,
    /// Realtime WebSocket endpoint (e.g. `wss://api.x.ai/v1/realtime`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Plaintext API key (0600 file). Redacted to "***" over IPC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Realtime model id (e.g. `grok-voice-latest` / `gpt-realtime-2.1`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Provider voice id/name to speak with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

impl S2sProviderConfig {
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
pub struct S2sProviderRegistry {
    /// Active provider id used by the voice-to-voice channel. Defaults to "grok".
    pub active_provider: String,
    pub providers: Vec<S2sProviderConfig>,
}

impl Default for S2sProviderRegistry {
    fn default() -> Self {
        default_registry()
    }
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

pub fn default_registry() -> S2sProviderRegistry {
    S2sProviderRegistry {
        active_provider: FALLBACK_ACTIVE.to_string(),
        providers: vec![
            S2sProviderConfig {
                id: "grok".to_string(),
                name: "Grok Voice (xAI)".to_string(),
                kind: "grok".to_string(),
                builtin: true,
                enabled: false,
                base_url: Some("wss://api.x.ai/v1/realtime".to_string()),
                api_key: None,
                // `grok-voice` was retired; the live alias is `grok-voice-latest`
                // (currently → grok-voice-think-fast-1.0). A stale id → HTTP 403.
                model: Some("grok-voice-latest".to_string()),
                voice: None,
            },
            S2sProviderConfig {
                id: "openai-realtime".to_string(),
                name: "OpenAI Realtime".to_string(),
                kind: "openai-realtime".to_string(),
                builtin: true,
                enabled: false,
                base_url: Some("wss://api.openai.com/v1/realtime".to_string()),
                api_key: None,
                model: Some("gpt-realtime-2.1".to_string()),
                voice: Some("alloy".to_string()),
            },
        ],
    }
}

fn default_path() -> PathBuf {
    crate::paths::lotus_state_dir().join("s2s-providers.json")
}

/// Merge saved providers over the built-in defaults so newly-shipped built-ins appear for existing
/// installs while user edits to known providers persist.
fn reconcile(mut saved: S2sProviderRegistry) -> S2sProviderRegistry {
    for d in default_registry().providers {
        if !saved.providers.iter().any(|p| p.id == d.id) {
            saved.providers.push(d);
        }
    }
    // Migrate exact previous built-in defaults while preserving deliberate custom provider/model
    // choices. Grok's old id is retired; OpenAI's Realtime 2.1 adds low-effort reasoning control for
    // latency-sensitive production voice agents.
    for p in saved.providers.iter_mut() {
        if p.kind == "grok" && p.model.as_deref() == Some("grok-voice") {
            p.model = Some("grok-voice-latest".to_string());
        }
        if p.id == "openai-realtime"
            && p.kind == "openai-realtime"
            && p.model.as_deref() == Some("gpt-realtime")
        {
            p.model = Some("gpt-realtime-2.1".to_string());
        }
    }
    saved
}

// ─── Persistence ──────────────────────────────────────────────────────────────

pub fn load(path: &Path) -> S2sProviderRegistry {
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return default_registry(),
    };
    serde_json::from_slice::<S2sProviderRegistry>(&raw)
        .map(reconcile)
        .unwrap_or_else(|_| default_registry())
}

/// Persist registry to disk (0600). Returns `io::Error` on failure.
pub fn save(path: &Path, registry: &S2sProviderRegistry) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(registry)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write_secret(path, &body)
}

/// Atomic write with 0600 perms — same pattern as `stt_providers` / `tts_providers`.
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
pub fn upsert_provider(registry: &mut S2sProviderRegistry, provider: S2sProviderConfig) {
    if let Some(pos) = registry.providers.iter().position(|p| p.id == provider.id) {
        registry.providers[pos] = provider;
    } else {
        registry.providers.push(provider);
    }
}

/// Remove a non-builtin provider by id. Errors if built-in or not found. If the active provider is
/// removed, fall back to the first built-in so the channel is never left pointing at nothing.
pub fn delete_provider(registry: &mut S2sProviderRegistry, id: &str) -> Result<(), AppError> {
    let pos = registry
        .providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| other(format!("s2s provider '{id}' not found")))?;

    if registry.providers[pos].builtin {
        return Err(other(format!(
            "s2s provider '{id}' is built-in and cannot be deleted"
        )));
    }

    if registry.active_provider == id {
        registry.active_provider = FALLBACK_ACTIVE.to_string();
    }

    registry.providers.remove(pos);
    Ok(())
}

// ─── Command implementations (called by Tauri commands in lib.rs) ─────────────

pub fn cmd_list_providers() -> S2sProviderRegistry {
    let mut registry = load(&default_path());
    registry.providers = registry
        .providers
        .into_iter()
        .map(|p| p.redacted())
        .collect();
    registry
}

pub fn cmd_get_provider(id: &str) -> Option<S2sProviderConfig> {
    load(&default_path())
        .providers
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.redacted())
}

/// Upsert a provider from the settings UI. Preserves the real API key when the incoming value
/// carries the `"***"` redaction sentinel.
pub fn cmd_upsert_provider(provider: S2sProviderConfig) -> Result<(), String> {
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
        return Err(format!("s2s provider '{id}' not found"));
    }
    registry.active_provider = id.to_string();
    save(&path, &registry).map_err(|e| e.to_string())
}

/// Look up a single provider by id (unredacted) — used by the streaming S2S transport
/// (`s2s_stream.rs`) to read the endpoint + key without re-implementing registry loading.
pub fn find_provider(provider_id: &str) -> Option<S2sProviderConfig> {
    load(&default_path())
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str, kind: &str, key: Option<&str>) -> S2sProviderConfig {
        S2sProviderConfig {
            id: id.to_string(),
            name: id.to_string(),
            kind: kind.to_string(),
            builtin: false,
            enabled: true,
            base_url: None,
            api_key: key.map(|k| k.to_string()),
            model: None,
            voice: None,
        }
    }

    #[test]
    fn redacts_a_present_api_key_but_keeps_empty() {
        assert_eq!(
            cfg("x", "grok", Some("xai-secret"))
                .redacted()
                .api_key
                .as_deref(),
            Some("***")
        );
        assert_eq!(
            cfg("x", "grok", Some("")).redacted().api_key.as_deref(),
            Some("")
        );
        assert_eq!(cfg("x", "grok", None).redacted().api_key, None);
    }

    #[test]
    fn default_registry_ships_grok_and_openai_disabled_without_keys() {
        let r = default_registry();
        assert_eq!(r.active_provider, "grok");
        let grok = r.providers.iter().find(|p| p.id == "grok").unwrap();
        assert!(grok.builtin && !grok.enabled && grok.api_key.is_none());
        assert_eq!(grok.base_url.as_deref(), Some("wss://api.x.ai/v1/realtime"));
        assert!(r.providers.iter().any(|p| p.id == "openai-realtime"));
    }

    #[test]
    fn reconcile_adds_missing_builtins_without_dropping_saved() {
        let saved = S2sProviderRegistry {
            active_provider: "grok".to_string(),
            providers: vec![cfg("grok", "grok", Some("xai-real"))],
        };
        let merged = reconcile(saved);
        assert!(merged.providers.iter().any(|p| p.id == "openai-realtime"));
        let grok = merged.providers.iter().find(|p| p.id == "grok").unwrap();
        assert_eq!(grok.api_key.as_deref(), Some("xai-real"));
    }

    #[test]
    fn default_realtime_models_follow_current_provider_recommendations() {
        let registry = default_registry();
        let grok = registry.providers.iter().find(|p| p.id == "grok").unwrap();
        let openai = registry
            .providers
            .iter()
            .find(|p| p.id == "openai-realtime")
            .unwrap();
        assert_eq!(grok.model.as_deref(), Some("grok-voice-latest"));
        assert_eq!(openai.model.as_deref(), Some("gpt-realtime-2.1"));
    }

    #[test]
    fn reconcile_migrates_retired_grok_model_but_leaves_custom_picks() {
        let mut stale = cfg("grok", "grok", Some("xai-real"));
        stale.model = Some("grok-voice".to_string());
        let mut deliberate = cfg("grok2", "grok", Some("xai-real"));
        deliberate.model = Some("grok-voice-fast-1.0".to_string());
        let merged = reconcile(S2sProviderRegistry {
            active_provider: "grok".to_string(),
            providers: vec![stale, deliberate],
        });
        assert_eq!(
            merged
                .providers
                .iter()
                .find(|p| p.id == "grok")
                .unwrap()
                .model
                .as_deref(),
            Some("grok-voice-latest"),
            "the retired grok-voice id must migrate"
        );
        assert_eq!(
            merged
                .providers
                .iter()
                .find(|p| p.id == "grok2")
                .unwrap()
                .model
                .as_deref(),
            Some("grok-voice-fast-1.0"),
            "a deliberate model pick must be preserved"
        );
    }

    #[test]
    fn reconcile_migrates_previous_builtin_openai_model_but_preserves_custom_picks() {
        let mut stale = cfg("openai-realtime", "openai-realtime", Some("sk-real"));
        stale.model = Some("gpt-realtime".to_string());
        let mut deliberate = cfg("openai-custom", "openai-realtime", Some("sk-real"));
        deliberate.model = Some("gpt-realtime-1.5".to_string());

        let merged = reconcile(S2sProviderRegistry {
            active_provider: "openai-realtime".to_string(),
            providers: vec![stale, deliberate],
        });

        assert_eq!(
            merged
                .providers
                .iter()
                .find(|p| p.id == "openai-realtime")
                .unwrap()
                .model
                .as_deref(),
            Some("gpt-realtime-2.1")
        );
        assert_eq!(
            merged
                .providers
                .iter()
                .find(|p| p.id == "openai-custom")
                .unwrap()
                .model
                .as_deref(),
            Some("gpt-realtime-1.5")
        );
    }

    #[test]
    fn upsert_sentinel_preserves_existing_key_while_updating_other_fields() {
        let mut reg = S2sProviderRegistry {
            active_provider: "grok".to_string(),
            providers: vec![cfg("grok", "grok", Some("xai-real"))],
        };
        let mut incoming = cfg("grok", "grok", Some("***"));
        incoming.enabled = false;
        if incoming.api_key.as_deref() == Some("***") {
            if let Some(existing) = reg.providers.iter().find(|p| p.id == incoming.id) {
                incoming.api_key = existing.api_key.clone();
            }
        }
        upsert_provider(&mut reg, incoming);
        let saved = reg.providers.iter().find(|p| p.id == "grok").unwrap();
        assert_eq!(saved.api_key.as_deref(), Some("xai-real"));
        assert!(!saved.enabled);
    }

    #[test]
    fn delete_builtin_is_rejected_and_custom_falls_back_active() {
        let mut reg = default_registry();
        assert!(delete_provider(&mut reg, "grok").is_err());

        reg.providers.push(cfg("my-s2s", "custom", Some("k")));
        reg.active_provider = "my-s2s".to_string();
        delete_provider(&mut reg, "my-s2s").unwrap();
        assert_eq!(reg.active_provider, "grok");
    }
}
