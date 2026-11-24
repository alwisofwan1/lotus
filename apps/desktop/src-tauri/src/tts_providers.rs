//! BYOK text-to-speech provider registry for CodeCanvas voice feedback.
//!
//! Stored at `~/.lotus/tts-providers.json` (chmod 0600 — it holds API keys, same threat model as
//! `model-registry.json` / `telegram-bot.json`). Built-in providers (browser, openai, elevenlabs)
//! always exist and cannot be deleted — only disabled or reconfigured. The `browser` provider needs
//! no key and is synthesized entirely in the renderer (Web Speech API); cloud providers are BYOK and
//! route through [`cmd_synthesize`].
//!
//! Cloud synthesis ([`cmd_synthesize`]) is implemented per-`kind`: OpenAI-compatible
//! (`/audio/speech`, JSON → mp3) and ElevenLabs (`/text-to-speech/{voice}`). `custom` is treated as
//! OpenAI-compatible. The front-end wiring (request → play) lives in
//! `src/modules/codecanvas/services/voice/cloud-tts-provider.ts`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::StreamExt;
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};

use crate::error::{other, AppError};
use crate::voice_http::{base_endpoint, MAX_AUDIO_BYTES};

// ─── Domain types ─────────────────────────────────────────────────────────────

/// On-disk + in-memory shape of a single TTS provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TtsProviderConfig {
    pub id: String,
    pub name: String,
    /// Dispatch tag: "browser" | "openai" | "elevenlabs" | "custom".
    pub kind: String,
    /// Built-in entries ship with Lotus defaults and cannot be deleted (only disabled).
    pub builtin: bool,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Plaintext API key (0600 file, same threat model as model-registry.json). Redacted over IPC.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed: Option<f32>,
}

impl TtsProviderConfig {
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

/// Voice OUTPUT preferences (ADR-0031). Co-located with the TTS registry because they are voice
/// config, not global IDE prefs. `#[serde(default)]` on the field keeps old files (without `output`)
/// loading cleanly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceOutputSettings {
    /// Master gate: read confirmations aloud after each command.
    pub speak_replies: bool,
    /// Announce when a background (off-viewport) agent finishes a turn.
    pub agent_done_callouts: bool,
    /// Also announce visible (on-viewport) agent completions.
    pub wake_on_finish: bool,
    /// Spoken-style preset: "jarvis" (default) | "warm" | "formal" | "brisk" | "custom". Shapes both
    /// the composed confirmation text (renderer prompt) and the audio delivery (steerable TTS models).
    #[serde(default = "default_tone")]
    pub tone: String,
    /// Free-text delivery instructions — the effective style when `tone == "custom"`. Sent verbatim
    /// as `instructions` to steerable TTS (gpt-4o-mini-tts) and appended to the composer prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone_instructions: Option<String>,
    /// Confirmation length: "brief" | "normal" | "expressive" (consumed by the renderer composer).
    #[serde(default = "default_verbosity")]
    pub verbosity: String,
    /// Minimum gap (ms) between two spoken "agent finished" callouts for the SAME agent, absent a
    /// fresh user-submitted turn — the ultra-minimal frequency cap consumed by `callout-throttle` in
    /// the renderer. 0 disables the cap (announce every turn). Default 45s.
    #[serde(default = "default_agent_done_cooldown_ms")]
    pub agent_done_cooldown_ms: u64,
    /// How a finished agent is announced: "voice" (spoken name) | "sound" (a chime) | "off". Absent in
    /// files written before it existed; the renderer then derives it from `agent_done_callouts`
    /// (on = sound, off = off); Sound is the default (Lotus #184, 2026-11-24).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_done_alert: Option<String>,
    /// Which sound the "sound" alert plays: an id the renderer's `AGENT_DONE_SOUNDS` knows. Absent =
    /// "classic". Kept opaque here; an unknown id falls back to Classic in the renderer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_done_sound: Option<String>,
}

fn default_tone() -> String {
    "jarvis".to_string()
}

fn default_verbosity() -> String {
    "normal".to_string()
}

fn default_agent_done_cooldown_ms() -> u64 {
    45_000
}

impl Default for VoiceOutputSettings {
    fn default() -> Self {
        Self {
            speak_replies: true,
            agent_done_callouts: true,
            wake_on_finish: false,
            tone: default_tone(),
            tone_instructions: None,
            verbosity: default_verbosity(),
            agent_done_cooldown_ms: default_agent_done_cooldown_ms(),
            agent_done_alert: None,
            agent_done_sound: None,
        }
    }
}

/// Delivery instructions for steerable TTS, resolved from the tone preset (custom = user's own
/// words, verbatim). None = nothing to send (unknown preset / empty custom text). The trailing
/// language line matters for multilingual users: it tells the model to speak Indonesian text with
/// an Indonesian accent instead of an anglicized one.
pub fn tone_delivery_instructions(output: &VoiceOutputSettings) -> Option<String> {
    const LANGUAGE_LINE: &str =
        "Speak the text's language natively, with its natural accent and rhythm.";
    match output.tone.as_str() {
        "jarvis" => Some(format!(
            "Poised, articulate and courteous — a refined AI valet in the manner of JARVIS: calm, \
             composed and quietly warm, unhurried yet efficient, unfailingly polite. Even, measured \
             pacing with a subtle, dry warmth; never announcer-like, servile or robotic. {LANGUAGE_LINE}"
        )),
        "warm" => Some(format!(
            "Warm, friendly and relaxed — a teammate casually confirming something. \
             Natural conversational pacing, never announcer-like. {LANGUAGE_LINE}"
        )),
        "formal" => Some(format!(
            "Composed, professional and clear. Even pacing, no exclamation. {LANGUAGE_LINE}"
        )),
        "brisk" => Some(format!(
            "Quick, light and efficient. Short phrasing, energetic but not shouty. {LANGUAGE_LINE}"
        )),
        "custom" => output
            .tone_instructions
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TtsProviderRegistry {
    /// Active provider id used by the voice feedback channel. Defaults to "browser".
    pub active_provider: String,
    pub providers: Vec<TtsProviderConfig>,
    /// Voice output preferences (ADR-0031). Defaults applied for files predating this field.
    #[serde(default)]
    pub output: VoiceOutputSettings,
}

impl Default for TtsProviderRegistry {
    fn default() -> Self {
        default_registry()
    }
}

/// Audio payload returned to the renderer for playback.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSynthesisResult {
    pub audio_base64: String,
    pub mime: String,
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

pub fn default_registry() -> TtsProviderRegistry {
    TtsProviderRegistry {
        active_provider: "browser".to_string(),
        providers: vec![
            TtsProviderConfig {
                id: "browser".to_string(),
                name: "Browser (Web Speech)".to_string(),
                kind: "browser".to_string(),
                builtin: true,
                enabled: true,
                base_url: None,
                api_key: None,
                model: None,
                voice: None,
                speed: None,
            },
            TtsProviderConfig {
                id: "openai".to_string(),
                name: "OpenAI".to_string(),
                kind: "openai".to_string(),
                builtin: true,
                enabled: false,
                base_url: Some("https://api.openai.com/v1".to_string()),
                api_key: None,
                model: Some("gpt-4o-mini-tts".to_string()),
                voice: Some("alloy".to_string()),
                speed: None,
            },
            TtsProviderConfig {
                id: "elevenlabs".to_string(),
                name: "ElevenLabs".to_string(),
                kind: "elevenlabs".to_string(),
                builtin: true,
                enabled: false,
                base_url: Some("https://api.elevenlabs.io/v1".to_string()),
                api_key: None,
                // Multilingual v2 over turbo: it is ElevenLabs' most natural model for non-English
                // (Indonesian, Japanese, …) speech — the voice-quality knob that matters most here.
                model: Some("eleven_multilingual_v2".to_string()),
                voice: None,
                speed: None,
            },
        ],
        output: VoiceOutputSettings::default(),
    }
}

fn default_path() -> PathBuf {
    crate::paths::lotus_state_dir().join("tts-providers.json")
}

/// Merge saved providers over the built-in defaults so newly-shipped built-ins appear for existing
/// installs while user edits to known providers persist.
fn reconcile(mut saved: TtsProviderRegistry) -> TtsProviderRegistry {
    for d in default_registry().providers {
        if !saved.providers.iter().any(|p| p.id == d.id) {
            saved.providers.push(d);
        }
    }
    saved
}

// ─── Persistence ──────────────────────────────────────────────────────────────

pub fn load(path: &Path) -> TtsProviderRegistry {
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return default_registry(),
    };
    serde_json::from_slice::<TtsProviderRegistry>(&raw)
        .map(reconcile)
        .unwrap_or_else(|_| default_registry())
}

/// Persist registry to disk (0600). Returns `io::Error` on failure.
pub fn save(path: &Path, registry: &TtsProviderRegistry) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(registry)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write_secret(path, &body)
}

/// Atomic write with 0600 perms — same pattern as `model_registry` / `telegram_bot::config`.
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
pub fn upsert_provider(registry: &mut TtsProviderRegistry, provider: TtsProviderConfig) {
    if let Some(pos) = registry.providers.iter().position(|p| p.id == provider.id) {
        registry.providers[pos] = provider;
    } else {
        registry.providers.push(provider);
    }
}

/// Remove a non-builtin provider by id. Errors if built-in or not found. If the active provider is
/// removed, fall back to "browser" so the voice channel is never left pointing at nothing.
pub fn delete_provider(registry: &mut TtsProviderRegistry, id: &str) -> Result<(), AppError> {
    let pos = registry
        .providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| other(format!("tts provider '{id}' not found")))?;

    if registry.providers[pos].builtin {
        return Err(other(format!(
            "tts provider '{id}' is built-in and cannot be deleted"
        )));
    }

    if registry.active_provider == id {
        registry.active_provider = "browser".to_string();
    }

    registry.providers.remove(pos);
    Ok(())
}

// ─── Command implementations (called by Tauri commands in lib.rs) ─────────────

pub fn cmd_list_providers() -> TtsProviderRegistry {
    let mut registry = load(&default_path());
    registry.providers = registry
        .providers
        .into_iter()
        .map(|p| p.redacted())
        .collect();
    registry
}

pub fn cmd_get_provider(id: &str) -> Option<TtsProviderConfig> {
    load(&default_path())
        .providers
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.redacted())
}

/// Upsert a provider from the settings UI. Preserves the real API key when the incoming value
/// carries the `"***"` redaction sentinel.
pub fn cmd_upsert_provider(provider: TtsProviderConfig) -> Result<(), String> {
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
        return Err(format!("tts provider '{id}' not found"));
    }
    registry.active_provider = id.to_string();
    save(&path, &registry).map_err(|e| e.to_string())
}

/// Persist the voice OUTPUT preferences (ADR-0031), preserving providers + active selection.
pub fn cmd_set_output(output: VoiceOutputSettings) -> Result<(), String> {
    let path = default_path();
    let mut registry = load(&path);
    registry.output = output;
    save(&path, &registry).map_err(|e| e.to_string())
}

/// BYOK synthesis seam. Loads the *unredacted* provider config (the API key stays in Rust, never
/// reaching the renderer), calls the provider's TTS HTTP API and returns the audio bytes
/// base64-encoded. The `voice`/`speed` arguments override the provider's stored defaults. `browser`
/// is handled entirely in the renderer and must never reach this command.
pub async fn cmd_synthesize(
    client: &Client,
    provider_id: &str,
    text: &str,
    voice: Option<String>,
    speed: Option<f32>,
) -> Result<TtsSynthesisResult, AppError> {
    let registry = load(&default_path());
    let output = registry.output.clone();
    let provider = registry
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| other(format!("tts provider '{provider_id}' not found")))?;

    if provider.kind == "browser" {
        return Err(other(
            "browser TTS is synthesized in the renderer, not via tts_synthesize",
        ));
    }

    let api_key = provider
        .api_key
        .clone()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            other(format!(
                "tts provider '{provider_id}' has no API key configured"
            ))
        })?;

    let clean = text.trim();
    if clean.is_empty() {
        return Ok(TtsSynthesisResult {
            audio_base64: String::new(),
            mime: "audio/mpeg".to_string(),
        });
    }

    // Argument overrides the stored provider default for both voice and speed.
    let voice = voice
        .filter(|v| !v.is_empty())
        .or_else(|| provider.voice.clone());
    let speed = speed.or(provider.speed);

    // Tone (Settings → Voice) shapes the audio delivery: instructions for steerable OpenAI models,
    // voice_settings for ElevenLabs.
    let tone = tone_delivery_instructions(&output);

    let audio = match provider.kind.as_str() {
        // `openai` and `custom` both speak the OpenAI `/audio/speech` JSON contract.
        "openai" | "custom" => {
            synthesize_openai(
                client,
                base_endpoint(provider.base_url.as_deref(), "https://api.openai.com/v1"),
                &api_key,
                provider.model.as_deref().unwrap_or("gpt-4o-mini-tts"),
                clean,
                voice.as_deref().unwrap_or("alloy"),
                speed,
                tone.as_deref(),
            )
            .await?
        }
        "elevenlabs" => {
            synthesize_elevenlabs(
                client,
                base_endpoint(provider.base_url.as_deref(), "https://api.elevenlabs.io/v1"),
                &api_key,
                provider
                    .model
                    .as_deref()
                    .unwrap_or("eleven_multilingual_v2"),
                clean,
                voice.as_deref(),
                elevenlabs_voice_settings(&output, speed),
            )
            .await?
        }
        other_kind => {
            return Err(other(format!(
                "unsupported tts provider kind '{other_kind}'"
            )));
        }
    };

    Ok(TtsSynthesisResult {
        audio_base64: BASE64.encode(&audio),
        mime: "audio/mpeg".to_string(),
    })
}

/// Read synthesized audio incrementally so oversized responses are rejected before full buffering.
async fn read_audio(resp: Response, ctx: &str) -> Result<Vec<u8>, AppError> {
    read_audio_bounded(resp, ctx, MAX_AUDIO_BYTES).await
}

async fn read_audio_bounded(
    resp: Response,
    ctx: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, AppError> {
    if resp
        .content_length()
        .map(|length| length > max_bytes as u64)
        .unwrap_or(false)
    {
        return Err(other(format!("{ctx}: audio response too large")));
    }

    let mut buf = Vec::new();
    let mut chunks = resp.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|e| other(format!("{ctx}: failed to read audio: {e}")))?;
        if buf.len().saturating_add(chunk.len()) > max_bytes {
            return Err(other(format!("{ctx}: audio response too large")));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

async fn require_success(resp: Response, ctx: &str) -> Result<Response, AppError> {
    if resp.status().is_success() {
        return Ok(resp);
    }

    const MAX_ERROR_BYTES: usize = 1_200;
    const MAX_ERROR_CHARS: usize = 300;
    let status = resp.status();
    let mut bytes = Vec::new();
    let mut chunks = resp.bytes_stream();
    while bytes.len() < MAX_ERROR_BYTES {
        let Some(chunk) = chunks.next().await else {
            break;
        };
        let chunk = chunk.map_err(|e| other(format!("{ctx} failed (HTTP {status}): {e}")))?;
        let remaining = MAX_ERROR_BYTES - bytes.len();
        bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    }
    let snippet: String = String::from_utf8_lossy(&bytes)
        .chars()
        .take(MAX_ERROR_CHARS)
        .collect();
    if snippet.trim().is_empty() {
        Err(other(format!("{ctx} failed (HTTP {status})")))
    } else {
        Err(other(format!("{ctx} failed (HTTP {status}): {snippet}")))
    }
}

/// Build the OpenAI `/audio/speech` request body. `instructions` (tone/delivery steering) is sent
/// ONLY to models that accept it — `gpt-4o-mini-tts` and successors; `tts-1`/`tts-1-hd` reject
/// unknown params. Pure, so the tone→request mapping is testable without HTTP.
fn build_openai_speech_body(
    model: &str,
    text: &str,
    voice: &str,
    speed: Option<f32>,
    instructions: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "mp3",
    });
    if let Some(s) = speed {
        body["speed"] = serde_json::json!(s);
    }
    let steerable = model.starts_with("gpt-4o-mini-tts");
    if let (true, Some(instr)) = (steerable, instructions.filter(|i| !i.trim().is_empty())) {
        body["instructions"] = serde_json::json!(instr);
    }
    body
}

/// Map the tone preset to ElevenLabs `voice_settings`. Presets carry stability/style pairs (lower
/// stability = broader emotional range = less monotone); custom tone has no numeric mapping, so
/// only a configured speed produces settings there. Speed is clamped to ElevenLabs' 0.7–1.2 window.
fn elevenlabs_voice_settings(
    output: &VoiceOutputSettings,
    speed: Option<f32>,
) -> Option<serde_json::Value> {
    let preset = match output.tone.as_str() {
        // JARVIS: poised and composed (higher stability than warm) yet carrying a warm, expressive
        // style — never the monotone of "formal".
        "jarvis" => Some((0.55, 0.35)),
        "warm" => Some((0.40, 0.30)),
        "formal" => Some((0.75, 0.0)),
        "brisk" => Some((0.55, 0.15)),
        _ => None,
    };
    let speed = speed.map(|s| s.clamp(0.7, 1.2));
    match (preset, speed) {
        (Some((stability, style)), speed) => {
            let mut v = serde_json::json!({
                "stability": stability,
                "similarity_boost": 0.75,
                "style": style,
            });
            if let Some(s) = speed {
                v["speed"] = serde_json::json!(s);
            }
            Some(v)
        }
        (None, Some(s)) => Some(serde_json::json!({ "speed": s })),
        (None, None) => None,
    }
}

/// Build the ElevenLabs `text-to-speech` request body (voice_settings only when there is any).
fn build_elevenlabs_speech_body(
    model: &str,
    text: &str,
    voice_settings: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut body = serde_json::json!({ "text": text, "model_id": model });
    if let Some(vs) = voice_settings {
        body["voice_settings"] = vs;
    }
    body
}

/// OpenAI-compatible synthesis: `POST {base}/audio/speech` (JSON body) → mp3 bytes.
async fn synthesize_openai(
    client: &Client,
    base_url: String,
    api_key: &str,
    model: &str,
    text: &str,
    voice: &str,
    speed: Option<f32>,
    instructions: Option<&str>,
) -> Result<Vec<u8>, AppError> {
    let url = format!("{base_url}/audio/speech");
    let body = build_openai_speech_body(model, text, voice, speed, instructions);

    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| other(format!("OpenAI speech failed: {e}")))?;
    read_audio(
        require_success(resp, "OpenAI speech").await?,
        "OpenAI speech",
    )
    .await
}

/// `{base}/text-to-speech/{voice_id}` with the id percent-encoded as one path segment, so an id
/// holding `/`, `?` or `#` cannot reach a different endpoint.
fn elevenlabs_speech_url(base_url: &str, voice_id: &str) -> String {
    const UNRESERVED: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~');
    format!(
        "{base_url}/text-to-speech/{}",
        percent_encoding::utf8_percent_encode(voice_id, UNRESERVED)
    )
}

/// ElevenLabs synthesis: `POST {base}/text-to-speech/{voice_id}` (JSON body) → mp3 bytes. Falls back
/// to the well-known "Rachel" voice when none is configured.
async fn synthesize_elevenlabs(
    client: &Client,
    base_url: String,
    api_key: &str,
    model: &str,
    text: &str,
    voice: Option<&str>,
    voice_settings: Option<serde_json::Value>,
) -> Result<Vec<u8>, AppError> {
    let voice_id = voice
        .filter(|v| !v.is_empty())
        .unwrap_or("21m00Tcm4TlvDq8ikWAM");
    let url = elevenlabs_speech_url(&base_url, voice_id);
    let body = build_elevenlabs_speech_body(model, text, voice_settings);

    let resp = client
        .post(&url)
        .header("xi-api-key", api_key)
        .header("Accept", "audio/mpeg")
        .json(&body)
        .send()
        .await
        .map_err(|e| other(format!("ElevenLabs speech failed: {e}")))?;
    read_audio(
        require_success(resp, "ElevenLabs speech").await?,
        "ElevenLabs speech",
    )
    .await
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elevenlabs_url_encodes_the_voice_id_as_one_path_segment() {
        assert_eq!(
            elevenlabs_speech_url("https://api.elevenlabs.io/v1", "21m00Tcm4TlvDq8ikWAM"),
            "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"
        );
        assert_eq!(
            elevenlabs_speech_url("https://api.elevenlabs.io/v1", "../voices?x=1#y"),
            "https://api.elevenlabs.io/v1/text-to-speech/..%2Fvoices%3Fx%3D1%23y"
        );
    }
    use axum::body::{Body, Bytes};
    use axum::http::{Response, StatusCode};
    use axum::routing::{get, post};
    use axum::Router;
    use std::convert::Infallible;

    async fn spawn_server(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    fn cfg(id: &str, kind: &str, key: Option<&str>) -> TtsProviderConfig {
        TtsProviderConfig {
            id: id.to_string(),
            name: id.to_string(),
            kind: kind.to_string(),
            builtin: false,
            enabled: true,
            base_url: None,
            api_key: key.map(|k| k.to_string()),
            model: None,
            voice: None,
            speed: None,
        }
    }

    #[test]
    fn redacts_a_present_api_key_but_keeps_empty() {
        assert_eq!(
            cfg("x", "openai", Some("sk-secret"))
                .redacted()
                .api_key
                .as_deref(),
            Some("***")
        );
        assert_eq!(
            cfg("x", "openai", Some("")).redacted().api_key.as_deref(),
            Some("")
        );
        assert_eq!(cfg("x", "openai", None).redacted().api_key, None);
    }

    #[test]
    fn default_registry_defaults_to_browser_active_and_enabled() {
        let r = default_registry();
        assert_eq!(r.active_provider, "browser");
        assert!(r
            .providers
            .iter()
            .any(|p| p.id == "browser" && p.enabled && p.builtin));
        // Cloud providers ship disabled with no key (BYOK).
        let openai = r.providers.iter().find(|p| p.id == "openai").unwrap();
        assert!(!openai.enabled && openai.api_key.is_none());
    }

    #[test]
    fn reconcile_adds_missing_builtins_without_dropping_saved() {
        let saved = TtsProviderRegistry {
            active_provider: "openai".to_string(),
            providers: vec![cfg("openai", "openai", Some("sk-real"))],
            output: VoiceOutputSettings::default(),
        };
        let merged = reconcile(saved);
        assert!(merged.providers.iter().any(|p| p.id == "browser"));
        // Saved openai (with its key) is preserved, not overwritten by the default.
        let openai = merged.providers.iter().find(|p| p.id == "openai").unwrap();
        assert_eq!(openai.api_key.as_deref(), Some("sk-real"));
    }

    #[test]
    fn upsert_sentinel_preserves_existing_key_while_updating_other_fields() {
        let mut reg = TtsProviderRegistry {
            active_provider: "browser".to_string(),
            providers: vec![cfg("openai", "openai", Some("sk-real"))],
            output: VoiceOutputSettings::default(),
        };
        // Mirror cmd_upsert_provider's sentinel handling.
        let mut incoming = cfg("openai", "openai", Some("***"));
        incoming.enabled = false;
        if incoming.api_key.as_deref() == Some("***") {
            if let Some(existing) = reg.providers.iter().find(|p| p.id == incoming.id) {
                incoming.api_key = existing.api_key.clone();
            }
        }
        upsert_provider(&mut reg, incoming);
        let saved = reg.providers.iter().find(|p| p.id == "openai").unwrap();
        assert_eq!(saved.api_key.as_deref(), Some("sk-real"));
        assert!(!saved.enabled, "non-key fields still update");
    }

    #[test]
    fn delete_builtin_is_rejected_and_custom_falls_back_active() {
        let mut reg = default_registry();
        assert!(
            delete_provider(&mut reg, "openai").is_err(),
            "built-in cannot be deleted"
        );

        reg.providers.push(cfg("my-tts", "custom", Some("k")));
        reg.active_provider = "my-tts".to_string();
        delete_provider(&mut reg, "my-tts").unwrap();
        assert_eq!(
            reg.active_provider, "browser",
            "active falls back to browser"
        );
    }

    #[test]
    fn legacy_config_without_optional_fields_deserializes() {
        let legacy = r#"{"activeProvider":"browser","providers":[{"id":"browser","name":"Browser","kind":"browser","builtin":true,"enabled":true}]}"#;
        let reg: TtsProviderRegistry = serde_json::from_str(legacy).unwrap();
        assert_eq!(reg.active_provider, "browser");
        assert!(reg.providers[0].api_key.is_none());
        // No `output` in legacy JSON → defaults applied (ADR-0031).
        assert_eq!(reg.output, VoiceOutputSettings::default());
    }

    #[test]
    fn voice_output_defaults_and_round_trip() {
        let d = VoiceOutputSettings::default();
        assert!(d.speak_replies && d.agent_done_callouts && !d.wake_on_finish);
        assert_eq!(d.agent_done_cooldown_ms, 45_000);
        // Round-trips through the registry (output persisted alongside providers).
        let mut reg = default_registry();
        reg.output.wake_on_finish = true;
        reg.output.agent_done_cooldown_ms = 120_000;
        let json = serde_json::to_string(&reg).unwrap();
        let back: TtsProviderRegistry = serde_json::from_str(&json).unwrap();
        assert!(back.output.wake_on_finish);
        assert_eq!(back.output.agent_done_cooldown_ms, 120_000);
    }

    #[test]
    fn legacy_output_without_cooldown_defaults_to_45s() {
        // A pre-cooldown file (no agentDoneCooldownMs) must load with the 45s default applied.
        let legacy = r#"{"activeProvider":"browser","providers":[],"output":{"speakReplies":true,"agentDoneCallouts":true,"wakeOnFinish":false}}"#;
        let reg: TtsProviderRegistry = serde_json::from_str(legacy).unwrap();
        assert_eq!(reg.output.agent_done_cooldown_ms, 45_000);
    }

    #[test]
    fn agent_done_alert_is_absent_on_legacy_files_and_round_trips_when_set() {
        let legacy = r#"{"activeProvider":"browser","providers":[],"output":{"speakReplies":true,"agentDoneCallouts":true,"wakeOnFinish":false}}"#;
        let mut reg: TtsProviderRegistry = serde_json::from_str(legacy).unwrap();
        assert_eq!(reg.output.agent_done_alert, None);
        assert!(!serde_json::to_string(&reg)
            .unwrap()
            .contains("agentDoneAlert"));
        reg.output.agent_done_alert = Some("sound".to_string());
        let back: TtsProviderRegistry =
            serde_json::from_str(&serde_json::to_string(&reg).unwrap()).unwrap();
        assert_eq!(back.output.agent_done_alert.as_deref(), Some("sound"));
    }

    #[test]
    fn agent_done_sound_is_absent_on_legacy_files_and_round_trips_when_set() {
        let legacy = r#"{"activeProvider":"browser","providers":[],"output":{"speakReplies":true,"agentDoneCallouts":true,"wakeOnFinish":false}}"#;
        let mut reg: TtsProviderRegistry = serde_json::from_str(legacy).unwrap();
        assert_eq!(reg.output.agent_done_sound, None);
        assert!(!serde_json::to_string(&reg)
            .unwrap()
            .contains("agentDoneSound"));
        reg.output.agent_done_sound = Some("droplet".to_string());
        let back: TtsProviderRegistry =
            serde_json::from_str(&serde_json::to_string(&reg).unwrap()).unwrap();
        assert_eq!(back.output.agent_done_sound.as_deref(), Some("droplet"));
    }

    // ─── Tone / verbosity (voice naturalness) ─────────────────────────────────

    #[test]
    fn tone_and_verbosity_default_jarvis_normal_and_legacy_output_deserializes() {
        let d = VoiceOutputSettings::default();
        assert_eq!(d.tone, "jarvis");
        assert_eq!(d.verbosity, "normal");
        // A pre-tone file (only the three toggles) still loads, with defaults applied.
        let legacy = r#"{"activeProvider":"browser","providers":[],"output":{"speakReplies":true,"agentDoneCallouts":true,"wakeOnFinish":false}}"#;
        let reg: TtsProviderRegistry = serde_json::from_str(legacy).unwrap();
        assert_eq!(reg.output.tone, "jarvis");
        assert_eq!(reg.output.verbosity, "normal");
    }

    #[test]
    fn tone_delivery_instructions_map_presets_and_use_custom_text_verbatim() {
        let mut out = VoiceOutputSettings::default();
        // Default is JARVIS — a poised valet register, never the monotone of formal.
        assert!(tone_delivery_instructions(&out)
            .unwrap()
            .to_lowercase()
            .contains("valet"));
        out.tone = "warm".to_string();
        assert!(tone_delivery_instructions(&out)
            .unwrap()
            .to_lowercase()
            .contains("warm"));
        out.tone = "formal".to_string();
        assert!(tone_delivery_instructions(&out).is_some());
        out.tone = "custom".to_string();
        out.tone_instructions = Some("Bicara santai seperti teman dekat.".to_string());
        assert_eq!(
            tone_delivery_instructions(&out).as_deref(),
            Some("Bicara santai seperti teman dekat.")
        );
        // Custom with no text → nothing to send.
        out.tone_instructions = Some("   ".to_string());
        assert_eq!(tone_delivery_instructions(&out), None);
    }

    #[test]
    fn openai_body_sends_instructions_only_to_steerable_models() {
        let steerable =
            build_openai_speech_body("gpt-4o-mini-tts", "halo", "alloy", None, Some("warm tone"));
        assert_eq!(steerable["instructions"], "warm tone");
        // tts-1 / tts-1-hd reject the param — it must be omitted there.
        let legacy =
            build_openai_speech_body("tts-1", "halo", "alloy", Some(1.2), Some("warm tone"));
        assert!(legacy.get("instructions").is_none());
        // f32 → JSON widens to f64; compare with tolerance.
        assert!((legacy["speed"].as_f64().unwrap() - 1.2).abs() < 1e-6);
        assert_eq!(legacy["voice"], "alloy");
    }

    #[test]
    fn elevenlabs_voice_settings_map_tone_and_clamp_speed() {
        let mut out = VoiceOutputSettings::default(); // jarvis
                                                      // JARVIS carries warmth (style > 0) while staying more composed than the warm preset.
        let jarvis = elevenlabs_voice_settings(&out, None).unwrap();
        assert!(
            jarvis["style"].as_f64().unwrap() > 0.0,
            "jarvis keeps warmth"
        );
        out.tone = "warm".to_string();
        let warm = elevenlabs_voice_settings(&out, None).unwrap();
        assert!(
            warm["stability"].as_f64().unwrap() < 0.6,
            "warm = expressive"
        );
        assert!(warm["style"].as_f64().unwrap() > 0.0);
        assert!(
            jarvis["stability"].as_f64().unwrap() > warm["stability"].as_f64().unwrap(),
            "jarvis is more composed than warm"
        );
        out.tone = "formal".to_string();
        let formal = elevenlabs_voice_settings(&out, None).unwrap();
        assert!(formal["stability"].as_f64().unwrap() > warm["stability"].as_f64().unwrap());
        // Speed rides along, clamped to ElevenLabs' supported 0.7–1.2 window (f32 tolerance).
        let fast = elevenlabs_voice_settings(&out, Some(2.0)).unwrap();
        assert!((fast["speed"].as_f64().unwrap() - 1.2).abs() < 1e-6);
        // Custom tone has no numeric mapping; without a speed there is nothing to send.
        out.tone = "custom".to_string();
        assert!(elevenlabs_voice_settings(&out, None).is_none());
        assert!(elevenlabs_voice_settings(&out, Some(1.1)).is_some());
    }

    #[test]
    fn elevenlabs_body_includes_voice_settings_only_when_present() {
        let with = build_elevenlabs_speech_body(
            "eleven_multilingual_v2",
            "halo",
            Some(serde_json::json!({"stability": 0.4})),
        );
        assert_eq!(with["voice_settings"]["stability"], 0.4);
        let without = build_elevenlabs_speech_body("eleven_multilingual_v2", "halo", None);
        assert!(without.get("voice_settings").is_none());
        assert_eq!(without["text"], "halo");
    }

    #[test]
    fn default_elevenlabs_model_is_multilingual_for_natural_non_english() {
        let r = default_registry();
        let el = r.providers.iter().find(|p| p.id == "elevenlabs").unwrap();
        assert_eq!(el.model.as_deref(), Some("eleven_multilingual_v2"));
    }

    #[tokio::test]
    async fn async_openai_synthesis_reads_streamed_audio_from_local_server() {
        let app = Router::new().route(
            "/audio/speech",
            post(|| async {
                let chunks = tokio_stream::iter([
                    Ok::<_, Infallible>(Bytes::from_static(b"audio-")),
                    Ok(Bytes::from_static(b"bytes")),
                ]);
                Body::from_stream(chunks)
            }),
        );
        let base_url = spawn_server(app).await;
        let client = reqwest::Client::new();

        let audio = synthesize_openai(
            &client,
            base_url,
            "secret",
            "gpt-4o-mini-tts",
            "hello",
            "alloy",
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(audio, b"audio-bytes");
    }

    #[tokio::test]
    async fn streamed_audio_limit_is_enforced_before_full_buffering() {
        let app = Router::new().route(
            "/audio",
            get(|| async {
                let chunks = tokio_stream::iter([
                    Ok::<_, Infallible>(Bytes::from_static(b"abc")),
                    Ok(Bytes::from_static(b"def")),
                    Ok(Bytes::from_static(b"should-not-be-buffered")),
                ]);
                Body::from_stream(chunks)
            }),
        );
        let base_url = spawn_server(app).await;
        let response = reqwest::Client::new()
            .get(format!("{base_url}/audio"))
            .send()
            .await
            .unwrap();

        let error = read_audio_bounded(response, "test speech", 5)
            .await
            .unwrap_err();

        assert_eq!(error.to_string(), "test speech: audio response too large");
    }

    #[tokio::test]
    async fn provider_http_error_body_is_bounded() {
        let body = format!("{}END", "x".repeat(400));
        let app = Router::new().route(
            "/audio/speech",
            post(move || {
                let body = body.clone();
                async move {
                    Response::builder()
                        .status(StatusCode::BAD_REQUEST)
                        .body(Body::from(body))
                        .unwrap()
                }
            }),
        );
        let base_url = spawn_server(app).await;

        let error = synthesize_openai(
            &reqwest::Client::new(),
            base_url,
            "secret",
            "gpt-4o-mini-tts",
            "hello",
            "alloy",
            None,
            None,
        )
        .await
        .unwrap_err()
        .to_string();

        assert!(error.ends_with(&"x".repeat(300)));
        assert!(!error.contains("END"));
    }
}
