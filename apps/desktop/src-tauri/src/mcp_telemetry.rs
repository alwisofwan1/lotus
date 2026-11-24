//! Bridge MCP bootstrap telemetry.
//!
//! Replaces ad-hoc `eprintln!("[mcp] ...")` calls scattered through the
//! bootstrap path with structured events the frontend can render in the
//! Bridge health surface. We retain a small in-memory ring of the most
//! recent events so a late-binding subscriber (the Bridge UI mounts after
//! bootstrap finishes) can still see what happened.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Tauri event channel used for all MCP telemetry payloads.
pub const EVENT: &str = "lotus://mcp-telemetry";

/// Severity for a single bootstrap step. Frontend treats `Error` as banner-worthy.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct TelemetryEvent {
    pub level: Level,
    pub scope: String,
    pub message: String,
    pub at: i64,
}

const RING_CAP: usize = 32;

static RING: Mutex<Vec<TelemetryEvent>> = Mutex::new(Vec::new());

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Mask secret-shaped substrings before an event is logged/emitted (Phase 7.4 telemetry contract:
/// only ids/status/counts/timing — never secrets or prompts). The IPC secret is a 64-char hex
/// string; `Bearer <token>` can surface in HTTP error strings. Conservative by design — only
/// pure-hex runs >=32 chars and Bearer values are masked — so ports (`127.0.0.1:54321`), file
/// paths, UUID ids (dashes → not pure hex), status words, counts, and timings are all preserved.
pub(crate) fn redact(message: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut mask_next = false;
    for tok in message.split(' ') {
        if mask_next && !tok.is_empty() {
            out.push("[redacted]".into());
            mask_next = false;
            continue;
        }
        if tok.eq_ignore_ascii_case("bearer") {
            out.push(tok.to_string());
            mask_next = true;
            continue;
        }
        // Trim surrounding punctuation, then treat a long pure-hex run as the secret.
        let core = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        if core.len() >= 32 && core.chars().all(|c| c.is_ascii_hexdigit()) {
            out.push(tok.replace(core, "[redacted]"));
        } else {
            out.push(tok.to_string());
        }
    }
    out.join(" ")
}

fn push_ring(event: &TelemetryEvent) {
    let Ok(mut guard) = RING.lock() else { return };
    if guard.len() >= RING_CAP {
        guard.remove(0);
    }
    guard.push(event.clone());
}

/// Snapshot of recent events. Used by the `bridge_mcp_telemetry` Tauri
/// command so the frontend can backfill its banner state on first mount.
pub fn recent() -> Vec<TelemetryEvent> {
    RING.lock().map(|g| g.clone()).unwrap_or_default()
}

/// Emit a telemetry event. Always mirrors to stderr so headless smoke tests
/// keep working; also pushes into the ring and broadcasts to the frontend
/// when an `AppHandle` is available.
pub fn emit(app: Option<&AppHandle>, level: Level, scope: &str, message: impl Into<String>) {
    let event = TelemetryEvent {
        level,
        scope: scope.to_string(),
        message: redact(&message.into()),
        at: now_ms(),
    };
    let label = match level {
        Level::Info => "info",
        Level::Warn => "warn",
        Level::Error => "error",
    };
    eprintln!("[mcp/{label}/{scope}] {}", event.message);
    push_ring(&event);
    if let Some(handle) = app {
        let _ = handle.emit(EVENT, event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_masks_secrets_but_keeps_ids_ports_and_paths() {
        let secret = "a".repeat(64); // the 64-char hex IPC secret shape
        assert_eq!(
            redact(&format!("wrote discovery secret {secret}")),
            "wrote discovery secret [redacted]",
        );
        // Bearer tokens (HTTP error strings) are masked.
        assert_eq!(redact("auth Bearer abc123def"), "auth Bearer [redacted]");
        // Non-secrets survive: ports, paths, and UUID ids (dashes → not pure hex).
        assert_eq!(
            redact("MCP IPC listening on 127.0.0.1:54321"),
            "MCP IPC listening on 127.0.0.1:54321",
        );
        let uuid = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            redact(&format!("session {uuid} ready")),
            format!("session {uuid} ready")
        );
        assert_eq!(
            redact("install config failed: /Users/x/.claude.json"),
            "install config failed: /Users/x/.claude.json",
        );
    }

    #[test]
    fn ring_caps_at_limit() {
        // Reset the ring up front since other tests may have pushed.
        RING.lock().unwrap().clear();
        for i in 0..(RING_CAP + 5) {
            emit(None, Level::Info, "test", format!("msg {i}"));
        }
        let snap = recent();
        assert_eq!(snap.len(), RING_CAP);
        assert!(snap.first().unwrap().message.ends_with("5"));
        assert!(snap
            .last()
            .unwrap()
            .message
            .ends_with(&format!("{}", RING_CAP + 4)));
    }
}
