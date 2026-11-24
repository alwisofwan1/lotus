use std::time::{SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::mcp_ipc::{check_auth, SharedState};

const CODECANVAS_MEMORY_UPDATED_EVENT: &str = "codecanvas://memory-updated";

#[derive(Deserialize)]
pub(crate) struct CanvasMemoryRequest {
    /// write | list | search | promote | archive | restore.
    action: String,
    #[serde(default)]
    input: Option<crate::codecanvas_memory::WriteMemoryInput>,
    #[serde(default)]
    list: Option<crate::codecanvas_memory::MemoryListQuery>,
    #[serde(default)]
    search: Option<crate::codecanvas_memory::MemorySearchQuery>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    item_id: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn emit_updated(app: &AppHandle, project_id: &str, item_id: &str, action: &str) {
    let _ = app.emit(
        CODECANVAS_MEMORY_UPDATED_EVENT,
        serde_json::json!({
            "projectId": project_id,
            "itemId": item_id,
            "action": action,
            "source": "mcp",
        }),
    );
}

pub async fn canvas_memory(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<CanvasMemoryRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let app = match state.app_handle() {
        Some(app) => app,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "Tauri app handle not registered yet",
            )
                .into_response()
        }
    };
    let connection = match crate::codecanvas_store::open_app_store(&app) {
        Ok(connection) => connection,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };

    match req.action.trim().to_lowercase().as_str() {
        "write" => {
            let Some(input) = req.input.as_ref() else {
                return (StatusCode::BAD_REQUEST, "action 'write' requires input").into_response();
            };
            match crate::codecanvas_memory::write_memory(&connection, input) {
                Ok(item) => {
                    emit_updated(&app, &item.project_id, &item.id, "write");
                    Json(serde_json::json!({ "ok": true, "item": item })).into_response()
                }
                Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
            }
        }
        "list" => {
            let Some(query) = req.list.as_ref() else {
                return (StatusCode::BAD_REQUEST, "action 'list' requires list").into_response();
            };
            match crate::codecanvas_memory::list_memory(&connection, query) {
                Ok(items) => {
                    Json(serde_json::json!({ "ok": true, "items": items })).into_response()
                }
                Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
            }
        }
        "search" => {
            let Some(query) = req.search.as_ref() else {
                return (StatusCode::BAD_REQUEST, "action 'search' requires search")
                    .into_response();
            };
            match crate::codecanvas_memory::search_memory(&connection, query) {
                Ok(results) => {
                    Json(serde_json::json!({ "ok": true, "results": results })).into_response()
                }
                Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
            }
        }
        "promote" => {
            let Some(input) = req.input.as_ref() else {
                return (StatusCode::BAD_REQUEST, "action 'promote' requires input")
                    .into_response();
            };
            match crate::codecanvas_memory::promote_external_context(&connection, input) {
                Ok(item) => {
                    emit_updated(&app, &item.project_id, &item.id, "promote");
                    Json(serde_json::json!({ "ok": true, "item": item })).into_response()
                }
                Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
            }
        }
        "archive" => item_action(&connection, &app, &req, ItemAction::Archive),
        "restore" => item_action(&connection, &app, &req, ItemAction::Restore),
        _ => (
            StatusCode::BAD_REQUEST,
            "unknown action: expected write, list, search, promote, archive, restore",
        )
            .into_response(),
    }
}

/// The two single-item state changes an agent may make. Pinning is deliberately absent: a pinned row
/// is exempt from retention, so keeping that decision with the human stops agents from growing an
/// unprunable memory that every other agent in the project then has to read.
#[derive(Copy, Clone)]
enum ItemAction {
    Archive,
    Restore,
}

impl ItemAction {
    fn name(self) -> &'static str {
        match self {
            ItemAction::Archive => "archive",
            ItemAction::Restore => "restore",
        }
    }

    fn apply(
        self,
        connection: &rusqlite::Connection,
        project_id: &str,
        item_id: &str,
        now: i64,
    ) -> crate::codecanvas_store::CodeCanvasStoreResult<()> {
        match self {
            ItemAction::Archive => {
                crate::codecanvas_memory::archive_memory_item(connection, project_id, item_id, now)
            }
            ItemAction::Restore => {
                crate::codecanvas_memory::restore_memory_item(connection, project_id, item_id, now)
            }
        }
    }
}

fn item_action(
    connection: &rusqlite::Connection,
    app: &AppHandle,
    req: &CanvasMemoryRequest,
    action: ItemAction,
) -> Response {
    let project_id = req.project_id.as_deref().map(str::trim).unwrap_or_default();
    let item_id = req.item_id.as_deref().map(str::trim).unwrap_or_default();
    if project_id.is_empty() || item_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            format!("action '{}' requires project_id and item_id", action.name()),
        )
            .into_response();
    }
    match action.apply(connection, project_id, item_id, now_ms()) {
        Ok(()) => {
            emit_updated(app, project_id, item_id, action.name());
            Json(serde_json::json!({
                "ok": true,
                "projectId": project_id,
                "itemId": item_id,
                "action": action.name(),
            }))
            .into_response()
        }
        Err(err) => (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    }
}
