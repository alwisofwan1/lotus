//! Read/write approval gate for Canvas Browser Node actions (plan slice H4).
//!
//! Once the agent can mutate a page (navigate today; click/type in I3), a single
//! prompt injection can trigger a consequential action. This module splits
//! actions into **read** (snapshot/search/console/annotation — always allowed)
//! and **write** (open/navigate/click/type/… — gated), and lets a node run in:
//!
//! - `Auto` (default): writes proceed without prompting — today's behavior.
//! - `Ask`: each write is held until a human Approve/Deny, or it times out.
//!
//! Default stays `Auto` so nothing regresses; `Ask` is opt-in per node. The
//! human resolves via a Tauri command (never the agent HTTP API), mirroring the
//! origin-policy trust boundary in [`crate::canvas_browser_policy`].

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::Url;
use tokio::sync::oneshot;

// ─── Action classification ────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    Read,
    Write,
}

// `classify_route` / `ActionKind` are the write-action contract consumed when
// slice I3 adds click/type/fill routes (each new route gets categorized here,
// with the fail-safe default proven by tests). Not yet called from a handler —
// today's writes (open/navigate) gate explicitly.
#[allow(dead_code)]
/// Classify a `/api/browser/*` route. Read actions only observe the page; write
/// actions change navigation or DOM state. Kept exhaustive so a new route can't
/// silently default to "read" — unknown routes are treated as **write** (fail
/// safe: an unclassified action is gated, never waved through).
pub fn classify_route(path: &str) -> ActionKind {
    let route = path.rsplit('/').next().unwrap_or(path);
    match route {
        // Read-only observation.
        "snapshot" | "search" | "console" | "screenshot" | "latest" | "wait_for" => {
            ActionKind::Read
        }
        // State-changing.
        "open" | "navigate" | "navigate_back" | "click" | "type" | "fill_form"
        | "select_option" | "press_key" | "upload" => ActionKind::Write,
        // Unknown → gate it.
        _ => ActionKind::Write,
    }
}

// ─── Approval mode (per node) ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    Auto,
    Ask,
}

impl Default for ApprovalMode {
    fn default() -> Self {
        Self::Auto
    }
}

// Consumed by the approval-mode UI (build-verified follow-up) to seed a node's
// mode on open. Not wired into the open handler on purpose: auto-seeding `Ask`
// for remote origins would hang navigations until the approval chip ships.
#[allow(dead_code)]
/// Suggested default mode for a freshly-opened node: loopback dev servers are
/// trusted (`Auto`); anything remote is held for approval (`Ask`). The UI uses
/// this to seed a node's mode; the store default stays `Auto` to avoid changing
/// behavior for nodes opened before this shipped.
pub fn default_mode_for_url(url_str: &str) -> ApprovalMode {
    match Url::parse(url_str)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
    {
        Some(host) => {
            let h = host.to_ascii_lowercase();
            if h == "localhost" || h == "::1" || h == "[::1]" || h.starts_with("127.") {
                ApprovalMode::Auto
            } else {
                ApprovalMode::Ask
            }
        }
        None => ApprovalMode::Ask,
    }
}

#[derive(Debug, Default, Clone)]
pub struct CanvasBrowserApprovalModeStore(Arc<Mutex<HashMap<String, ApprovalMode>>>);

impl CanvasBrowserApprovalModeStore {
    pub fn set(&self, terminal_id: &str, mode: ApprovalMode) {
        self.0
            .lock()
            .expect("approval mode lock")
            .insert(terminal_id.to_string(), mode);
    }

    pub fn get(&self, terminal_id: &str) -> ApprovalMode {
        self.0
            .lock()
            .expect("approval mode lock")
            .get(terminal_id)
            .copied()
            .unwrap_or_default()
    }

    pub fn remove(&self, terminal_id: &str) {
        self.0
            .lock()
            .expect("approval mode lock")
            .remove(terminal_id);
    }
}

// ─── Pending-approval gate ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approve,
    Deny,
}

/// Registry of in-flight write actions awaiting a human decision, keyed by a
/// request id. The handler registers, awaits the receiver (with a timeout), and
/// the human resolves by id via a Tauri command.
#[derive(Debug, Default, Clone)]
pub struct CanvasBrowserApprovalGate {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>>,
}

impl CanvasBrowserApprovalGate {
    /// Register a pending action, returning its id and a receiver the caller
    /// awaits. The id is what the human UI resolves against.
    pub fn register(&self, request_id: String) -> oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .expect("approval gate lock")
            .insert(request_id, tx);
        rx
    }

    /// Resolve a pending action. Returns `true` if it was still pending. A
    /// dropped receiver (handler already timed out) is treated as resolved.
    pub fn resolve(&self, request_id: &str, decision: ApprovalDecision) -> bool {
        let Some(tx) = self
            .pending
            .lock()
            .expect("approval gate lock")
            .remove(request_id)
        else {
            return false;
        };
        tx.send(decision).is_ok()
    }

    /// Drop a pending entry without a decision (used on timeout cleanup).
    pub fn forget(&self, request_id: &str) {
        self.pending
            .lock()
            .expect("approval gate lock")
            .remove(request_id);
    }

    #[cfg(test)]
    pub fn pending_ids(&self) -> Vec<String> {
        self.pending
            .lock()
            .expect("approval gate lock")
            .keys()
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn classify_reads_and_writes_and_fails_safe_on_unknown() {
        assert_eq!(classify_route("/api/browser/snapshot"), ActionKind::Read);
        assert_eq!(classify_route("/api/browser/search"), ActionKind::Read);
        assert_eq!(
            classify_route("/api/browser/annotation/latest"),
            ActionKind::Read
        );
        assert_eq!(classify_route("/api/browser/open"), ActionKind::Write);
        assert_eq!(classify_route("/api/browser/navigate"), ActionKind::Write);
        assert_eq!(classify_route("/api/browser/click"), ActionKind::Write);
        // Unknown route is gated, not waved through.
        assert_eq!(classify_route("/api/browser/frobnicate"), ActionKind::Write);
    }

    #[test]
    fn default_mode_trusts_loopback_only() {
        assert_eq!(
            default_mode_for_url("http://localhost:3000/"),
            ApprovalMode::Auto
        );
        assert_eq!(
            default_mode_for_url("http://127.0.0.1:5173/x"),
            ApprovalMode::Auto
        );
        assert_eq!(
            default_mode_for_url("https://example.com/"),
            ApprovalMode::Ask
        );
        assert_eq!(default_mode_for_url("not a url"), ApprovalMode::Ask);
    }

    #[test]
    fn mode_store_defaults_auto_and_round_trips() {
        let store = CanvasBrowserApprovalModeStore::default();
        assert_eq!(store.get("t"), ApprovalMode::Auto);
        store.set("t", ApprovalMode::Ask);
        assert_eq!(store.get("t"), ApprovalMode::Ask);
        store.remove("t");
        assert_eq!(store.get("t"), ApprovalMode::Auto);
    }

    #[tokio::test]
    async fn gate_delivers_approve_and_deny_decisions() {
        let gate = CanvasBrowserApprovalGate::default();

        let rx = gate.register("req-approve".into());
        assert!(gate.resolve("req-approve", ApprovalDecision::Approve));
        assert_eq!(rx.await.unwrap(), ApprovalDecision::Approve);

        let rx = gate.register("req-deny".into());
        assert!(gate.resolve("req-deny", ApprovalDecision::Deny));
        assert_eq!(rx.await.unwrap(), ApprovalDecision::Deny);

        // Resolving an unknown id reports "not pending".
        assert!(!gate.resolve("nope", ApprovalDecision::Approve));
    }

    #[tokio::test]
    async fn gate_timeout_then_late_resolve_is_harmless() {
        let gate = CanvasBrowserApprovalGate::default();
        let rx = gate.register("req-timeout".into());
        // Simulate the handler giving up: forget + drop receiver.
        gate.forget("req-timeout");
        drop(rx);
        // A late human decision finds nothing pending — no panic, returns false.
        assert!(!gate.resolve("req-timeout", ApprovalDecision::Approve));
    }

    #[tokio::test]
    async fn gate_register_await_with_concurrent_resolver() {
        let gate = CanvasBrowserApprovalGate::default();
        let rx = gate.register("req-1".into());

        let gate2 = gate.clone();
        let resolver = tokio::spawn(async move {
            // Wait until the handler-side registration is observable, then approve.
            for _ in 0..100 {
                if gate2.pending_ids().contains(&"req-1".to_string()) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            gate2.resolve("req-1", ApprovalDecision::Approve)
        });

        let decision = tokio::time::timeout(Duration::from_secs(1), rx)
            .await
            .expect("not timed out")
            .expect("sender not dropped");
        assert_eq!(decision, ApprovalDecision::Approve);
        assert!(resolver.await.unwrap());
    }
}
