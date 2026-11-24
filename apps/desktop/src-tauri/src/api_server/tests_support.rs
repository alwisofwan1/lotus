use std::sync::{Arc, Mutex};

use axum::Router;
use tempfile::TempDir;

use crate::api_auth::ApiKey;
use crate::api_server::{build_router, state, ApiState};
use crate::canvas_browser::{CanvasBrowserAnnotationStore, CanvasBrowserResultStore};
use crate::canvas_browser_approval::{CanvasBrowserApprovalGate, CanvasBrowserApprovalModeStore};
use crate::canvas_browser_policy::CanvasBrowserPolicyStore;
use crate::mcp_ipc::McpIpcState;
use crate::notification_event::NotificationEvent;
use crate::pty::{PtyState, PtyStore};

pub fn test_state() -> ApiState {
    let pty_state: PtyState = Arc::new(Mutex::new(PtyStore::default()));
    let api_key = Arc::new(ApiKey("test-secret-key".to_string()));
    let mcp_state = Arc::new(McpIpcState::new("test-ipc-secret".to_string()));
    let (notification_tx, _) =
        tokio::sync::broadcast::channel::<NotificationEvent>(state::NOTIFICATION_CHANNEL_CAPACITY);
    ApiState {
        pty_state,
        api_key,
        port: crate::api_server::API_PORT,
        mcp_state,
        notification_tx,
        browser_annotations: CanvasBrowserAnnotationStore::default(),
        browser_results: CanvasBrowserResultStore::default(),
        canvas_browser_policies: CanvasBrowserPolicyStore::default(),
        canvas_browser_approval_modes: CanvasBrowserApprovalModeStore::default(),
        canvas_browser_approval_gate: CanvasBrowserApprovalGate::default(),
        canvas_browser_local_files: crate::canvas_browser_local_files::LocalFileServeStore::default(
        ),
        transcripts: std::sync::Arc::new(std::sync::Mutex::new(
            crate::agent_hooks::TranscriptStore::new(),
        )),
        hook_sink: None,
        app_handle: None,
    }
}

/// Builds a router whose state carries a caller-supplied policy store, so handler
/// tests can assert origin-allowlist enforcement (403) end-to-end.
pub fn test_router_with_policies(policies: CanvasBrowserPolicyStore) -> Router {
    let mut state = test_state();
    state.canvas_browser_policies = policies;
    build_router(state)
}

pub fn auth_header() -> (&'static str, &'static str) {
    ("authorization", "Bearer test-secret-key")
}

/// Builds a full router for use in handler tests.
/// `_dir` is accepted for API compatibility with handlers that write to temp dirs.
pub fn test_router(_dir: &TempDir) -> Router {
    build_router(test_state())
}
