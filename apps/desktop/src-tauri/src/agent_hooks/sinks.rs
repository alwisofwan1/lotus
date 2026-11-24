//! Additional [`HookEventSink`] implementations: broadcast fan-out and multi-sink.

use std::sync::Arc;

use tokio::sync::broadcast;

use crate::mcp_ipc::McpIpcState;
use crate::notification_event::NotificationEvent;

use super::payload::DropPayload;
use super::processor::HookEventSink;
use super::transcript::TranscriptStore;
use super::watcher::TauriSink;

// ─── BroadcastSink ────────────────────────────────────────────────────────────

/// Converts a `DropPayload` into a `NotificationEvent::AgentStop` and sends it
/// to the notification broadcast channel.  Looks up `pane_id` / `workspace_id`
/// from the live fleet snapshot so SSE subscribers receive fully correlated
/// events without an extra round-trip.
pub struct BroadcastSink {
    tx: broadcast::Sender<NotificationEvent>,
    mcp_state: Arc<McpIpcState>,
}

impl BroadcastSink {
    pub fn new(tx: broadcast::Sender<NotificationEvent>, mcp_state: Arc<McpIpcState>) -> Self {
        Self { tx, mcp_state }
    }
}

impl HookEventSink for BroadcastSink {
    fn emit_hook(&self, payload: &DropPayload) {
        let (pane_id, workspace_id) = resolve_cell(&self.mcp_state, payload.session_id.as_deref());
        // The payload's own pane id is the fallback, and it is not a guess: it comes
        // from `LOTUS_PANE_ID` in the agent's environment, which is exactly what the
        // transcript store already treats as authoritative.
        //
        // Without it, live forwarding silently depends on the **desktop UI**: the fleet
        // snapshot `resolve_cell` searches is pushed from the frontend
        // (`bridge_push_fleet_snapshot`), so a window that is not on a workspace leaves
        // it empty, every forwarded event arrives with no pane, and a phone rebuilding
        // Chat from the socket drops all of them — while a REST refetch shows them,
        // because that path keys on `payload.pane_id`. That asymmetry reproduced the
        // very symptom the live transcript was built to remove.
        //
        // The fleet lookup still goes first, because it is the only source of
        // `workspace_id`; this only fills a pane the payload already knew.
        let pane_id = pane_id.or_else(|| {
            payload
                .pane_id
                .as_deref()
                .filter(|p| !p.is_empty())
                .map(str::to_string)
        });

        let event = NotificationEvent::AgentStop {
            pane_id,
            workspace_id,
            agent_type: payload.agent_type.clone(),
            event: payload.event.clone(),
            tool_target: payload.tool_target.clone(),
            session_id: payload.session_id.clone(),
            title: payload.title.clone(),
            body: payload.body.clone(),
            body_truncated: payload.body_truncated,
            user_prompt: payload.user_prompt.clone(),
            lines_added: payload.lines_added,
            lines_removed: payload.lines_removed,
            status: payload.status.clone(),
            cwd: payload.cwd.clone(),
            timestamp: payload.timestamp,
        };
        // Ignore `SendError` — no active subscribers is expected during boot.
        let _ = self.tx.send(event);
    }
}

// ─── MultiSink ────────────────────────────────────────────────────────────────

/// Fans out to the `TauriSink` (frontend Tauri events), the `BroadcastSink`
/// (HTTP SSE subscribers) and any number of extra consumers.
pub struct MultiSink {
    pub tauri: TauriSink,
    pub broadcast: BroadcastSink,
    /// Additional consumers (MCP pane turn state, the Chat transcript).
    ///
    /// A `Vec` rather than a single `Option`, which is what the original comment
    /// here already asked for: the second downstream arrived and a bespoke field
    /// per consumer is exactly what it was written to avoid.
    pub extras: Vec<std::sync::Arc<dyn HookEventSink>>,
}

impl HookEventSink for MultiSink {
    fn emit_hook(&self, payload: &DropPayload) {
        self.tauri.emit_hook(payload);
        self.broadcast.emit_hook(payload);
        for extra in &self.extras {
            extra.emit_hook(payload);
        }
    }
}

// ─── TranscriptSink ───────────────────────────────────────────────────────────

/// Records every hook event into the per-pane transcript so Chat mode has a past.
///
/// A lock rather than a channel: writes are one per hook event (rare), reads are
/// one per phone opening a cell, and a channel would need a draining task whose
/// backlog is the very thing the ring bound exists to prevent.
pub struct TranscriptSink(pub Arc<std::sync::Mutex<TranscriptStore>>);

impl HookEventSink for TranscriptSink {
    fn emit_hook(&self, payload: &DropPayload) {
        // A poisoned lock must not take the pipeline down with it: the transcript
        // is a convenience, while the Tauri and SSE sinks are the product.
        if let Ok(mut store) = self.0.lock() {
            store.record(payload);
        }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/// Correlates a drop-file `session_id` to the fleet member that owns it.
/// Returns `(None, None)` when the session isn't found in the fleet snapshot —
/// common for ephemeral bridge sessions or sessions that exited before the
/// fleet was updated.
fn resolve_cell(
    mcp_state: &McpIpcState,
    session_id: Option<&str>,
) -> (Option<String>, Option<String>) {
    let Some(sid) = session_id else {
        return (None, None);
    };
    for member in mcp_state.fleet_snapshot() {
        if member.session_id.as_deref() == Some(sid) {
            return (Some(member.pane_id), Some(member.workspace_id));
        }
    }
    (None, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_hooks::DropPayload;

    fn payload(pane_id: Option<&str>) -> DropPayload {
        DropPayload {
            version: 1,
            session_id: Some("sess-1".into()),
            agent_type: "claude".into(),
            event: "tool-post".into(),
            status: "running".into(),
            title: "Edit".into(),
            body: String::new(),
            user_prompt: String::new(),
            tool_target: "src/legacy/shim.ts".into(),
            lines_added: Some(0),
            lines_removed: Some(34),
            body_truncated: false,
            transcript_path: String::new(),
            cwd: "/tmp".into(),
            pid: None,
            agent_pid: None,
            pane_id: pane_id.map(str::to_string),
            timestamp: 1,
        }
    }

    fn forwarded(payload: &DropPayload) -> NotificationEvent {
        // An empty fleet, which is the state whenever no Lotus window is sitting on a
        // workspace — the snapshot `resolve_cell` searches is pushed by the frontend.
        let (tx, mut rx) = broadcast::channel(4);
        BroadcastSink::new(tx, Arc::new(McpIpcState::default())).emit_hook(payload);
        rx.try_recv().expect("an event was broadcast")
    }

    /// The gap this closes, found while trying to verify live streaming against a real
    /// host: with no fleet snapshot pushed, every forwarded event carried no pane, so a
    /// phone rebuilding Chat from the socket dropped all of them — while a REST refetch
    /// showed them, because that path reads `payload.pane_id` directly.
    #[test]
    fn falls_back_to_the_payloads_own_pane_when_the_fleet_is_empty() {
        let NotificationEvent::AgentStop { pane_id, .. } = forwarded(&payload(Some("p-1"))) else {
            panic!("expected an AgentStop");
        };

        assert_eq!(pane_id.as_deref(), Some("p-1"));
    }

    /// Not invented when it is genuinely unknown. A payload with no pane id cannot be
    /// attributed to a cell, and guessing would file one agent's steps under another —
    /// the same rule `TranscriptStore::record` applies.
    #[test]
    fn a_payload_with_no_pane_id_still_forwards_without_one() {
        let NotificationEvent::AgentStop { pane_id, .. } = forwarded(&payload(None)) else {
            panic!("expected an AgentStop");
        };

        assert!(pane_id.is_none());
    }

    /// The rest of the line has to survive the trip, or Chat rebuilds a partial entry.
    #[test]
    fn the_forwarded_event_carries_the_whole_chat_line() {
        let NotificationEvent::AgentStop {
            tool_target,
            lines_added,
            lines_removed,
            ..
        } = forwarded(&payload(Some("p-1")))
        else {
            panic!("expected an AgentStop");
        };

        assert_eq!(tool_target, "src/legacy/shim.ts");
        assert_eq!(lines_added, Some(0), "zero is a real count, not an absence");
        assert_eq!(lines_removed, Some(34));
    }
}
