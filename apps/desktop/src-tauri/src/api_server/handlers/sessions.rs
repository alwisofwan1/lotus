use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::api_server::state::ApiState;
use crate::models::SessionInfo;
use crate::pty;

// ─── Request / response types ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    /// Working directory for the new session. Defaults to the user home dir.
    pub cwd: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// If provided, runs this command instead of the login shell.
    pub command: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSession {
    pub session_id: String,
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/// `GET /api/sessions` — list all active PTY sessions.
pub async fn list_sessions(
    _auth: RequireAuth,
    State(state): State<ApiState>,
) -> Result<Json<Vec<SessionInfo>>, ApiError> {
    let sessions = pty::list_all_sessions(&state.pty_state).map_err(ApiError::from)?;
    Ok(Json(sessions))
}

/// `POST /api/sessions` — create a new headless PTY session.
pub async fn create_session(
    _auth: RequireAuth,
    State(state): State<ApiState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<CreatedSession>), ApiError> {
    let cwd = req.cwd.unwrap_or_default();
    let cols = req.cols.unwrap_or(80);
    let rows = req.rows.unwrap_or(24);

    let session_id = if let Some(command) = req.command {
        pty::create_headless_command_session(cwd, command, cols, rows, &state.pty_state)
    } else {
        pty::create_headless_session(cwd, cols, rows, &state.pty_state)
    }
    .map_err(ApiError::from)?;

    Ok((StatusCode::CREATED, Json(CreatedSession { session_id })))
}

/// `DELETE /api/sessions/:id` — kill a PTY session.
pub async fn kill_session(
    _auth: RequireAuth,
    Path(session_id): Path<String>,
    State(state): State<ApiState>,
) -> Result<StatusCode, ApiError> {
    pty::kill_session(session_id, &state.pty_state).map_err(ApiError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

/// `POST /api/sessions/:id/input` — write data to a PTY session's stdin.
pub async fn write_to_session(
    _auth: RequireAuth,
    Path(session_id): Path<String>,
    State(state): State<ApiState>,
    Json(req): Json<InputRequest>,
) -> Result<StatusCode, ApiError> {
    pty::write_to_session(session_id, req.data, &state.pty_state).map_err(ApiError::from)?;
    Ok(StatusCode::OK)
}

/// `POST /api/sessions/:id/size` — a phone asks to draw this pane at its own size.
///
/// No `token` starts a hold, a `token` renews it. `held: false` means the desktop took the pane
/// back or the lease ran out, and the phone stops asking until Terminal is opened again —
/// an answer, not an error, so it is a 200 (ADR-6 addendum 2026-10-05, `pty/size_lease.rs`).
pub async fn hold_size(
    _auth: RequireAuth,
    Path(session_id): Path<String>,
    State(state): State<ApiState>,
    Json(req): Json<SizeRequest>,
) -> Result<Json<SizeHeld>, ApiError> {
    if req.cols == 0 || req.rows == 0 {
        return Err(ApiError::BadRequest("cols and rows must be positive".into()));
    }
    let hold = pty::hold_remote_size(&session_id, req.cols, req.rows, req.token, &state.pty_state)
        .map_err(ApiError::from)?;
    Ok(Json(match hold {
        pty::RemoteHold::Held { token } => SizeHeld { held: true, token: Some(token) },
        pty::RemoteHold::Lost => SizeHeld { held: false, token: None },
    }))
}

/// `POST /api/sessions/:id/size/release` — the phone left Terminal.
pub async fn release_size(
    _auth: RequireAuth,
    Path(session_id): Path<String>,
    State(state): State<ApiState>,
    Json(req): Json<ReleaseSizeRequest>,
) -> Result<StatusCode, ApiError> {
    pty::release_remote_size(&session_id, req.token, &state.pty_state).map_err(ApiError::from)?;
    Ok(StatusCode::OK)
}

#[derive(Debug, Deserialize)]
pub struct SizeRequest {
    pub cols: u16,
    pub rows: u16,
    pub token: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct ReleaseSizeRequest {
    pub token: u64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct SizeHeld {
    pub held: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct InputRequest {
    pub data: String,
}

/// `GET /api/sessions/:id/stream` — SSE stream of PTY output.
///
/// Each SSE event carries a JSON-encoded string of the raw terminal chunk
/// (may contain ANSI escape codes, CR, LF). We JSON-encode rather than send
/// the raw string because axum's `Event::data()` panics on `\r`/`\n` —
/// JSON escapes them as `\\r`/`\\n` so the assertion passes. The client
/// `JSON.parse`s each line back to the original string.
///
/// Lagged events (slow consumer) are silently dropped rather than
/// disconnecting the subscriber — the ring buffer is 1024 messages deep.
pub async fn stream_session_output(
    _auth: RequireAuth,
    Path(session_id): Path<String>,
    State(state): State<ApiState>,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, ApiError> {
    // Obtain the broadcast sender while holding the lock, then release before subscribing.
    let tx =
        pty::get_session_broadcast_tx(&session_id, &state.pty_state).map_err(ApiError::from)?;
    let rx = tx.subscribe();

    let stream = BroadcastStream::new(rx).filter_map(|result| {
        match result {
            Ok(data) => match Event::default().json_data(&data) {
                Ok(event) => Some(Ok(event)),
                // String serialization shouldn't fail; drop the chunk if it
                // somehow does rather than crashing the worker.
                Err(_) => None,
            },
            // Lagged: the consumer was too slow and some messages were dropped.
            // Continue streaming rather than disconnecting.
            Err(_lagged) => None,
        }
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: PTY output contains LF/CR. axum's `Event::default().data()`
    /// asserts no newlines in the payload and panics — we MUST JSON-encode so
    /// `\n` becomes the two chars `\` + `n` in the wire format. This test
    /// builds the same Event we emit and ensures it does not panic on a
    /// realistic PTY chunk.
    #[test]
    fn sse_event_does_not_panic_on_newline_payload() {
        let pty_chunk = "line1\nline2\r\nline3\x1b[31mred\x1b[0m\n".to_string();
        // json_data() is the only safe way to put a multi-line string into an SSE event.
        let event = Event::default().json_data(&pty_chunk);
        assert!(
            event.is_ok(),
            "PTY chunks with newlines must serialize via json_data without panicking",
        );
    }

    /// Sanity check that the JSON encoding produces a valid SSE-safe payload
    /// (no raw `\r` or `\n` in the serialized form). Documents the contract
    /// our client `JSON.parse`s on.
    #[test]
    fn json_data_payload_contains_no_raw_newlines() {
        let payload = "line1\nline2\r\n\x1b[31mred\x1b[0m\n";
        let json = serde_json::to_string(&payload).expect("serialize");
        assert!(
            !json.contains('\n'),
            "JSON-encoded SSE payload must not contain raw LF"
        );
        assert!(
            !json.contains('\r'),
            "JSON-encoded SSE payload must not contain raw CR"
        );
        // Round-trip: client `JSON.parse` recovers the exact original.
        let restored: String = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, payload);
    }
}
