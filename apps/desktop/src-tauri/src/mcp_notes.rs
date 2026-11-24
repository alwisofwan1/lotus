//! `/v1/notes` — the module-neutral notes route behind the `lotus_notes_*` MCP tools (ADR-0047).
//! Action-based like `/v1/canvas-memory`, so later note actions join this route instead of growing
//! new ones. Read and write logic live in `notes.rs` / `notes_write.rs`; this is the HTTP adapter
//! plus the one routing decision a write needs: through the open canvas, or to the store.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::mcp_ipc::{check_auth, SharedState};
use crate::notes::{note_view, NoteRecord, NotesReadError, NotesReadQuery, DEFAULT_MAX_CHARS};
use crate::notes_write::{resolve_write, write_to_store, NotesWriteError, NotesWriteRequest};

/// The event the canvas window listens on to apply a resolved write.
const NOTES_WRITE_EVENT: &str = "mcp://notes-write";
/// Broadcast after a STORE write. Safety net: if a canvas has the project open after all (its
/// registration failed or raced), it adopts the write instead of autosaving over it.
const NOTES_WRITTEN_EVENT: &str = "notes://written";
/// A canvas applies a write in milliseconds; this only bounds a window that stopped answering.
const CANVAS_WRITE_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Deserialize)]
pub(crate) struct NotesRequest {
    /// read | write.
    action: String,
    #[serde(default)]
    read: NotesReadQuery,
    #[serde(default)]
    write: NotesWriteRequest,
}

/// What the canvas reports back after applying a write — the note as it now is in the editor.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanvasWrittenNote {
    id: String,
    content: String,
    #[serde(default)]
    note_number: Option<u64>,
    #[serde(default)]
    edited_at: Option<i64>,
    #[serde(default)]
    edited_by: Option<String>,
    #[serde(default)]
    cover_uri: Option<String>,
    #[serde(default)]
    linked_node_ids: Vec<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn caller_error(err: &(dyn std::error::Error + Send + Sync + 'static)) -> StatusCode {
    match err.downcast_ref::<NotesWriteError>() {
        Some(NotesWriteError::Conflict { .. }) => StatusCode::CONFLICT,
        Some(_) => StatusCode::BAD_REQUEST,
        None if err.downcast_ref::<NotesReadError>().is_some() => StatusCode::BAD_REQUEST,
        None => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub async fn notes(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<NotesRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let Some(app) = state.app_handle() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Tauri app handle not registered yet",
        )
            .into_response();
    };
    let connection = match crate::codecanvas_store::open_app_store(&app) {
        Ok(connection) => connection,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };
    match req.action.trim().to_lowercase().as_str() {
        "read" => match crate::notes::read_notes(&connection, &req.read) {
            Ok(outcome) => Json(outcome).into_response(),
            Err(err) => (caller_error(err.as_ref()), err.to_string()).into_response(),
        },
        "write" => {
            // The author is the caller's display name in the fleet — the footer says "Edited by <name>".
            let author = req.write.caller_pane_id.as_deref().and_then(|pane| {
                state
                    .fleet_snapshot()
                    .into_iter()
                    .find(|member| member.pane_id == pane)
                    .map(|member| member.display_name)
                    .filter(|name| !name.trim().is_empty())
            });
            let resolved = match resolve_write(&connection, &req.write, author, || {
                format!("note-{}", uuid::Uuid::new_v4())
            }) {
                Ok(resolved) => resolved,
                Err(err) => return (caller_error(err.as_ref()), err.to_string()).into_response(),
            };
            let Some(window) = state.note_canvas_window(&resolved.project_id) else {
                return match write_to_store(&connection, &resolved, now_ms()) {
                    Ok(note) => {
                        let _ = state.emit_to_frontend(
                            NOTES_WRITTEN_EVENT,
                            serde_json::json!({ "write": resolved, "note": note }),
                        );
                        Json(serde_json::json!({ "kind": "written", "via": "store", "mode": resolved.mode, "note": note }))
                            .into_response()
                    }
                    Err(err) => (caller_error(err.as_ref()), err.to_string()).into_response(),
                };
            };
            drop(connection);
            let (req_id, rx) = state.register_pending();
            if let Err(err) = state.emit_to_window(
                &window,
                NOTES_WRITE_EVENT,
                serde_json::json!({ "requestId": req_id, "write": resolved }),
            ) {
                state.forget_pending(&req_id);
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!("cannot reach the canvas: {err}"),
                )
                    .into_response();
            }
            match tokio::time::timeout(CANVAS_WRITE_TIMEOUT, rx).await {
                Ok(Ok(result)) if result.ok => {
                    let written = result
                        .data
                        .and_then(|data| serde_json::from_value::<CanvasWrittenNote>(data).ok());
                    let Some(written) = written else {
                        return (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "the canvas applied the write but sent no note back",
                        )
                            .into_response();
                    };
                    let note = note_view(
                        NoteRecord {
                            id: written.id,
                            content: written.content,
                            note_number: written.note_number,
                            edited_at: written.edited_at,
                            edited_by: written.edited_by,
                            cover_uri: written.cover_uri,
                            linked_node_ids: written.linked_node_ids,
                        },
                        &resolved.project_id,
                        true,
                        DEFAULT_MAX_CHARS,
                    );
                    Json(serde_json::json!({ "kind": "written", "via": "canvas", "mode": resolved.mode, "note": note })).into_response()
                }
                // The canvas refused (the user is typing in that note, or it changed): say why.
                Ok(Ok(result)) => (
                    StatusCode::CONFLICT,
                    result
                        .error
                        .unwrap_or_else(|| "the canvas refused the write".into()),
                )
                    .into_response(),
                Ok(Err(_)) => (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "canvas write channel closed",
                )
                    .into_response(),
                Err(_) => {
                    state.forget_pending(&req_id);
                    (
                        StatusCode::GATEWAY_TIMEOUT,
                        "the open canvas did not answer — nothing was written",
                    )
                        .into_response()
                }
            }
        }
        _ => (
            StatusCode::BAD_REQUEST,
            "unknown action: expected read or write",
        )
            .into_response(),
    }
}
