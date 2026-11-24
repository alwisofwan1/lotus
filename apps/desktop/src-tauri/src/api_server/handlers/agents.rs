use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::api_server::state::ApiState;
use crate::models::{LaunchConfig, LaunchPtyResult, LaunchResult, ProcessInfo};
use crate::{launch, processes};

// ─── Handlers ─────────────────────────────────────────────────────────────────

/// `POST /api/agent/spawn` — spawn a new Claude agent team.
///
/// Uses `spawn_blocking` because `launch::spawn_claude` performs blocking I/O
/// (file writes, `std::process::Command::spawn`) that must not run on a tokio thread.
pub async fn spawn_agent(
    _auth: RequireAuth,
    State(_state): State<ApiState>,
    Json(config): Json<LaunchConfig>,
) -> Result<Json<LaunchResult>, ApiError> {
    let result = tokio::task::spawn_blocking(move || launch::spawn_claude(config))
        .await
        .map_err(|e| ApiError::internal(format!("task join error: {e}")))?
        .map_err(ApiError::from)?;

    Ok(Json(result))
}

/// `POST /api/agent/spawn-pty` — spawn an agent team inside an interactive
/// headless PTY session and return the session id.
///
/// Unlike `/api/agent/spawn` (one-shot batch run), the spawned `claude`
/// process stays alive after the initial prompt so callers can `attach` /
/// `input` to drive it like a normal PTY session.
pub async fn spawn_agent_pty(
    _auth: RequireAuth,
    State(state): State<ApiState>,
    Json(config): Json<LaunchConfig>,
) -> Result<Json<LaunchPtyResult>, ApiError> {
    let pty_state = state.pty_state.clone();
    let result = tokio::task::spawn_blocking(move || launch::spawn_claude_pty(config, &pty_state))
        .await
        .map_err(|e| ApiError::internal(format!("task join error: {e}")))?
        .map_err(ApiError::from)?;

    Ok(Json(result))
}

/// `GET /api/agent/processes` — list running agent processes.
pub async fn list_processes(_auth: RequireAuth) -> Json<Vec<ProcessInfo>> {
    Json(processes::list_processes())
}

/// `DELETE /api/agent/processes/:pid` — kill a running agent process.
pub async fn kill_process(
    _auth: RequireAuth,
    Path(pid): Path<u32>,
) -> Result<StatusCode, ApiError> {
    processes::kill_process(pid).map_err(ApiError::from)?;
    Ok(StatusCode::NO_CONTENT)
}
