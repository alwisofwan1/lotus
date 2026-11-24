//! Dictation for a paired phone: the phone holds the microphone, the host holds the key.
//!
//! ADR-11 forbids Pocket from having an API key of its own, so audio travels to the
//! host and the host calls the provider. That is the only reason this route exists —
//! the desktop itself reaches the same code through a Tauri command.

use axum::Json;
use serde::{Deserialize, Serialize};

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::stt_providers::{self, SttDecoderContext, SttProviderRegistry};

/// The device recognizer, and the default. `cmd_transcribe` rejects it by design:
/// in that mode the renderer transcribes, not Rust.
const DEVICE_PROVIDER: &str = "browser";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    pub audio_base64: String,
    pub mime: String,
    /// Optional bias text — repo vocabulary, so `SSHTransport.swift` survives.
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResponse {
    pub text: String,
    /// Which provider produced this. The id, never the key (ADR-11) — enough for a
    /// client to show what it is spending, and to notice a wrong active provider.
    pub provider: String,
}

/// `POST /api/stt/transcribe` — transcribe with whichever provider this host has active.
///
/// The provider id is deliberately **not** a request field. A paired phone has no
/// business naming one, and accepting one would let a remote device reach a
/// configuration it cannot see.
pub async fn transcribe(
    _: RequireAuth,
    Json(req): Json<TranscribeRequest>,
) -> Result<Json<TranscribeResponse>, ApiError> {
    let provider = server_side_provider(&stt_providers::cmd_list_providers()).ok_or_else(|| {
        ApiError::unavailable(
            "this host has no server-side STT provider active — transcribe on the device instead",
        )
    })?;

    // `cmd_transcribe` is blocking `ureq` with a 60-second timeout (`voice_http.rs`),
    // so calling it inline would park a Tokio worker for up to a minute per request.
    let id = provider.clone();
    let context = req.prompt.map(|prompt| SttDecoderContext {
        prompt,
        ..SttDecoderContext::default()
    });
    let result = tokio::task::spawn_blocking(move || {
        stt_providers::cmd_transcribe(&id, &req.audio_base64, &req.mime, context.as_ref())
    })
    .await
    .map_err(|e| ApiError::internal(format!("transcription task failed: {e}")))??;

    Ok(Json(TranscribeResponse {
        text: result.text,
        provider,
    }))
}

/// The active provider, unless it is the device recognizer.
///
/// `None` is not an error — it is the fork a phone needs: this host will not
/// transcribe, so use the device's own recognizer. A separate function because the
/// decision is worth testing without a config file or a network call.
pub fn server_side_provider(registry: &SttProviderRegistry) -> Option<String> {
    let active = registry.active_provider.trim();
    if active.is_empty() || active == DEVICE_PROVIDER {
        return None;
    }
    Some(active.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stt_providers::default_registry;

    #[test]
    fn a_fresh_host_offers_no_server_side_provider() {
        // The shipped default is the device recognizer, so "voice works" must never
        // be assumed from "the host is reachable".
        assert_eq!(server_side_provider(&default_registry()), None);
    }

    #[test]
    fn a_configured_provider_is_named() {
        let registry = SttProviderRegistry {
            active_provider: "openai".to_string(),
            ..default_registry()
        };

        assert_eq!(server_side_provider(&registry), Some("openai".to_string()));
    }

    // A blank id is what a half-finished settings edit leaves behind. Treating it as
    // a provider would send audio to `cmd_transcribe` only to fail there, after the
    // upload — the phone should have taken the device path before recording finished.
    #[test]
    fn a_blank_active_provider_is_no_provider() {
        let registry = SttProviderRegistry {
            active_provider: "   ".to_string(),
            ..default_registry()
        };

        assert_eq!(server_side_provider(&registry), None);
    }
}
