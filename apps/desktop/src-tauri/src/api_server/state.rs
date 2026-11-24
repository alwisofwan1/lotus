use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::broadcast;

use crate::api_auth::ApiKey;
use crate::canvas_browser::{CanvasBrowserAnnotationStore, CanvasBrowserResultStore};
use crate::canvas_browser_approval::{CanvasBrowserApprovalGate, CanvasBrowserApprovalModeStore};
use crate::canvas_browser_local_files::LocalFileServeStore;
use crate::canvas_browser_policy::CanvasBrowserPolicyStore;
use crate::mcp_ipc::McpIpcState;
use crate::notification_event::NotificationEvent;
use crate::pty::PtyState;

/// Capacity of the notification broadcast channel.  256 events buffers a burst
/// without consuming significant memory while staying well below the per-subscriber
/// lag threshold that would trigger `Lagged` events under normal load.
pub const NOTIFICATION_CHANNEL_CAPACITY: usize = 256;

/// Shared application state injected into every axum handler via `State<ApiState>`.
///
/// `mcp_state` lets the HTTP API serve fleet/task data without each Telegram or
/// remote client needing its own MCP IPC channel — one Bearer token covers both
/// the local PTY surface and the cell control surface.
///
/// `notification_tx` is the sender half of the notification broadcast channel.
/// Handlers subscribe by calling `.subscribe()` on this sender; the agent-hooks
/// watcher and the CellStalled ticker send events through it.
///
/// `browser_annotations` is the in-memory store for Canvas Browser Node
/// screenshot annotations, keyed by terminal node ID.
#[derive(Clone)]
pub struct ApiState {
    pub pty_state: PtyState,
    pub api_key: Arc<ApiKey>,
    pub port: u16,
    pub mcp_state: Arc<McpIpcState>,
    /// The **same** sink the drop-file watcher emits into, so a hook that arrives over HTTP from
    /// another machine produces effects identical to one dropped on this disk. `None` when the
    /// watcher never started (no home directory) — the route then says so rather than swallowing
    /// the report.
    pub hook_sink: Option<Arc<dyn crate::agent_hooks::HookEventSink>>,
    pub notification_tx: broadcast::Sender<NotificationEvent>,
    pub browser_annotations: CanvasBrowserAnnotationStore,
    /// Per-terminal snapshot/search/action tool-result payloads (slice I1).
    pub browser_results: CanvasBrowserResultStore,
    /// Per-terminal origin allowlist for the Canvas Browser Node (default Open).
    pub canvas_browser_policies: CanvasBrowserPolicyStore,
    /// Per-terminal write-action approval mode (default Auto).
    pub canvas_browser_approval_modes: CanvasBrowserApprovalModeStore,
    /// In-flight write actions awaiting a human decision.
    pub canvas_browser_approval_gate: CanvasBrowserApprovalGate,
    /// Token → allowed-root map for serving local `file://` content over localhost.
    pub canvas_browser_local_files: LocalFileServeStore,
    /// Per-pane hook-event history, so Chat mode on the phone is not empty for an
    /// agent that is blocked and therefore emitting nothing new.
    pub transcripts: Arc<std::sync::Mutex<crate::agent_hooks::TranscriptStore>>,
    pub app_handle: Option<AppHandle>,
}
