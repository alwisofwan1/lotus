use axum::extract::State;
use axum::Json;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::api_server::state::ApiState;
use crate::bridge_chat::{self, BridgeChatRequest, BridgeChatResponse};
use crate::model_registry;

/// `POST /api/bridge/chat` — send one message to a Claude bridge session.
///
/// Request body:
/// ```json
/// { "text": "user message", "sessionId": "previous-id" | null, "model": "..." | null }
/// ```
/// Response body:
/// ```json
/// { "sessionId": "claude-session-id", "text": "assistant reply", "isError": false }
/// ```
///
/// Wraps the synchronous `bridge_chat::chat` in `spawn_blocking` so the tokio
/// HTTP worker is not held while `claude` runs (typically several seconds).
pub async fn chat(
    _auth: RequireAuth,
    State(_state): State<ApiState>,
    Json(mut req): Json<BridgeChatRequest>,
) -> Result<Json<BridgeChatResponse>, ApiError> {
    // Hydrate api_key / base_url from the model registry when the caller omits them.
    // Lets the Telegram bot (or any HTTP caller) benefit from registry-stored
    // credentials without having to forward them explicitly.
    if req.api_key.is_none() || req.base_url.is_none() {
        let registry = model_registry::read();
        if let Some(pc) = registry
            .providers
            .iter()
            .find(|p| p.id == registry.active_provider && p.enabled)
        {
            if req.api_key.is_none() {
                // Filter out the sentinel "***" placeholder — never forward it.
                req.api_key = pc.api_key.clone().filter(|k| k != "***");
            }
            if req.base_url.is_none() {
                req.base_url = pc.base_url.clone();
            }
        }
    }

    let result = tokio::task::spawn_blocking(move || bridge_chat::chat(req))
        .await
        .map_err(|e| ApiError::internal(format!("task join error: {e}")))?
        .map_err(ApiError::from)?;

    Ok(Json(result))
}
