//! `POST /api/hook/drop` — the way an agent on another machine reports what it is doing.
//!
//! **This route exists because there was no door at all.** Until now the desktop had exactly one
//! entrance for hook events: a JSON file dropped into `~/.lotus/agent-hooks/global/` and picked up
//! by a filesystem watcher. That works perfectly for an agent on this machine and not at all for one
//! on a VPS, whose drop file lands on the VPS's disk where nothing is watching. The agent is not
//! quiet — it is shouting into a directory no one reads.
//!
//! **One new entrance, zero new branches downstream.** The body is the same v1 payload the drop file
//! carries, parsed by the same parser, and emitted through the **same sink instance** the watcher
//! uses. Headlines, turn state, the Chat transcript and the SSE fan-out cannot tell the two apart,
//! which is the only way "a remote agent behaves like a local one" stays true as any of them change.
//!
//! The producer on the far side is deliberately `sh` + `curl`, never node —
//! `packages/host/src/server/routes/hooks.ts` made that call first, for the same reason: a hook that
//! needs a runtime the machine may not have makes agent status depend on an install nobody asked for.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;

use crate::agent_hooks::{event_status, parse_drop_payload, PAYLOAD_VERSION};
use crate::api_auth::RequireAuth;
use crate::api_server::state::ApiState;

#[derive(Serialize)]
pub struct HookDropResponse {
    pub ok: bool,
    /// Echoed so a caller reading its own logs can tell which pane it just reported for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
}

#[derive(Serialize)]
pub struct HookDropError {
    pub ok: bool,
    pub error: String,
}

/// Accept one v1 hook payload over HTTP and emit it exactly as a dropped file would.
///
/// Returns 400 for anything unparseable rather than 500: the body came from a shell script on
/// someone else's machine, so a malformed one is an expected input, not a fault here. The message
/// says which field, because the only person who can fix it is reading `curl`'s output.
pub async fn post_hook_drop(
    _auth: RequireAuth,
    State(state): State<ApiState>,
    body: axum::body::Bytes,
) -> Result<Json<HookDropResponse>, (StatusCode, Json<HookDropError>)> {
    let body = fill_derived_fields(&body);
    let payload = parse_drop_payload(&body).map_err(|error| {
        (
            StatusCode::BAD_REQUEST,
            Json(HookDropError {
                ok: false,
                error: format!("hook payload v{PAYLOAD_VERSION} expected: {error}"),
            }),
        )
    })?;

    let Some(sink) = state.hook_sink.as_ref() else {
        // The watcher never started (no home directory), so there is nothing to emit into. Saying so
        // beats accepting the report and dropping it.
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HookDropError {
                ok: false,
                error: "agent hooks are not running on this desktop".to_string(),
            }),
        ));
    };

    let pane_id = payload.pane_id.clone();
    sink.emit_hook(&payload);
    Ok(Json(HookDropResponse { ok: true, pane_id }))
}

/// Fill in what a shell producer cannot compute for itself.
///
/// **Only the remote path needs this, and only two fields.** The local hook is a node script that
/// looks the event up in `event-mapping.mjs` before writing its drop file; a hook on a VPS is `sh`
/// and `curl`, and a `case` table there would be a third copy of that mapping, drifting the first
/// time one of them changed. So the script sends the event and leaves `status` and `title` blank,
/// and they are derived here from the one Rust table that is pinned equal to the JavaScript one.
///
/// A payload that already carries them is passed through untouched: this must never second-guess a
/// producer that did the work, or the two paths would stop being the same payload.
///
/// Anything that is not JSON at all is returned unchanged, so the parser — not this — gets to say
/// what is wrong with it.
pub(crate) fn fill_derived_fields(raw: &[u8]) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(raw) else {
        return raw.to_vec();
    };
    let Some(object) = value.as_object_mut() else {
        return raw.to_vec();
    };

    let event = object
        .get("event")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    if event.trim().is_empty() {
        // No event means nothing to derive from; let the parser refuse it by name.
        return raw.to_vec();
    }
    let (status, default_title) = event_status(&event);

    if is_blank(object.get("status")) {
        object.insert("status".into(), serde_json::Value::String(status.to_string()));
    }
    if is_blank(object.get("title")) {
        object.insert(
            "title".into(),
            serde_json::Value::String(default_title.to_string()),
        );
    }

    serde_json::to_vec(&value).unwrap_or_else(|_| raw.to_vec())
}

fn is_blank(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => true,
        Some(serde_json::Value::String(text)) => text.trim().is_empty(),
        Some(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filled(raw: &str) -> serde_json::Value {
        serde_json::from_slice(&fill_derived_fields(raw.as_bytes())).expect("still json")
    }

    #[test]
    fn a_shell_producer_may_leave_status_and_title_to_us() {
        let value = filled(r#"{"event":"stop","status":"","title":""}"#);
        assert_eq!(value["status"], "idle");
        assert_eq!(value["title"], "Finished working");
    }

    #[test]
    fn absent_is_treated_the_same_as_blank() {
        let value = filled(r#"{"event":"notification"}"#);
        assert_eq!(value["status"], "needs-input");
        assert_eq!(value["title"], "Needs input");
    }

    /// The node producer looks the event up itself. Overriding it here would make the two paths
    /// disagree about the same event, which is the one thing this endpoint exists to prevent.
    #[test]
    fn a_producer_that_did_the_work_is_never_second_guessed() {
        let value = filled(r#"{"event":"stop","status":"running","title":"Still going"}"#);
        assert_eq!(value["status"], "running");
        assert_eq!(value["title"], "Still going");
    }

    #[test]
    fn nothing_is_invented_without_an_event_to_derive_from() {
        let value = filled(r#"{"status":"","title":""}"#);
        assert_eq!(value["status"], "");
        assert!(value.get("title").is_some());
    }

    #[test]
    fn a_body_that_is_not_json_is_left_for_the_parser_to_refuse() {
        assert_eq!(fill_derived_fields(b"not json"), b"not json".to_vec());
        assert_eq!(fill_derived_fields(b"[1,2]"), b"[1,2]".to_vec());
    }
}
