use serde_json::{json, Value};

/// The in-page inspection builder — single source of truth shared with the
/// vitest suite (`scripts/browser/__tests__/canvas-inspect.test.mjs`). It assigns
/// `globalThis.__lotusInspect` with `buildSnapshot`/`buildSearch` and never
/// navigates; the exfiltration wrapper below appends the transport step.
const INSPECT_BUILDER_JS: &str = include_str!("../../scripts/browser/canvas-inspect.js");

/// The console/network/error collector (W3). Injected as an INITIALIZATION script (document-start,
/// every navigation) so it captures output from the page's first line — see `open_canvas_browser`.
const COLLECTOR_JS: &str = include_str!("../../scripts/browser/canvas-collector.js");

/// The collector IIFE, run at document-start on every navigation of a canvas browser webview.
pub fn collector_init_script() -> &'static str {
    COLLECTOR_JS
}

/// Result exfiltration is still the `codechat-browser-annotation://` navigation
/// intercept (parsed + cancelled by `on_navigation`), so remote pages need no
/// Tauri IPC bridge. Swapping this for a proper invoke channel is plan slice I1.
fn exfiltrate_call(build_expr: &str, request: &str, terminal: &str) -> String {
    // Primary path (slice I1): a real Tauri IPC command, granted to this webview
    // by the `canvas-browser-annotation` capability. Fallback: the legacy
    // navigation-scheme intercept, for the rare case the IPC bridge isn't present
    // (proven pattern — see browser_preview.rs). on_navigation routes tool-result
    // payloads to the same result store the primary path writes to.
    format!(
        r#"try {{
    const payload = {build_expr};
    const json = JSON.stringify(payload);
    const fallback = () => {{ location.href = `codechat-browser-annotation://selected?payload=${{encodeURIComponent(json)}}`; }};
    const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
    if (typeof invoke === "function") {{
      // The invoke rejects when the capability denies it (e.g. a localhost page
      // the annotation capability doesn't grant). Route the rejection to the
      // navigation-scheme fallback so the result still reaches the poller,
      // instead of a silently-dropped promise the agent only sees as a timeout.
      Promise.resolve(invoke("emit_canvas_browser_tool_result", {{ terminalId: {terminal}, requestId: {request}, payload: json }})).catch(fallback);
    }} else {{
      fallback();
    }}
  }} catch (err) {{
    location.href = `codechat-browser-annotation://selected?payload=${{encodeURIComponent(JSON.stringify({{ action: "error", requestId: {request}, message: String(err && err.message || err) }}))}}`;
  }}"#
    )
}

pub fn snapshot_script(request_id: &str, terminal_id: &str) -> String {
    let request = serde_json::to_string(request_id).unwrap_or_else(|_| "\"unknown\"".into());
    let terminal = serde_json::to_string(terminal_id).unwrap_or_else(|_| "\"\"".into());
    let call = exfiltrate_call(
        &format!("globalThis.__lotusInspect.buildSnapshot({request})"),
        &request,
        &terminal,
    );
    format!("{INSPECT_BUILDER_JS}\n;(() => {{\n  {call}\n}})();")
}

pub fn search_script(
    request_id: &str,
    query: &str,
    max_results: usize,
    terminal_id: &str,
) -> String {
    let request = serde_json::to_string(request_id).unwrap_or_else(|_| "\"unknown\"".into());
    let terminal = serde_json::to_string(terminal_id).unwrap_or_else(|_| "\"\"".into());
    let query = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".into());
    let max_results = max_results.clamp(1, 50);
    let call = exfiltrate_call(
        &format!("globalThis.__lotusInspect.buildSearch({request}, {query}, {max_results})"),
        &request,
        &terminal,
    );
    format!("{INSPECT_BUILDER_JS}\n;(() => {{\n  {call}\n}})();")
}

/// Build the injected script for an interaction action. `action` is a validated
/// action object; it is serialized to JSON, which is a valid JS object literal,
/// and passed to the in-page executor. The executor resolves the ref, performs
/// the action, and returns a fresh snapshot — all exfiltrated on the same channel.
pub fn action_script(request_id: &str, action: &Value, terminal_id: &str) -> String {
    let request = serde_json::to_string(request_id).unwrap_or_else(|_| "\"unknown\"".into());
    let terminal = serde_json::to_string(terminal_id).unwrap_or_else(|_| "\"\"".into());
    let action_json = serde_json::to_string(action).unwrap_or_else(|_| "{}".into());
    let call = exfiltrate_call(
        &format!("globalThis.__lotusInspect.performAction({request}, {action_json})"),
        &request,
        &terminal,
    );
    format!("{INSPECT_BUILDER_JS}\n;(() => {{\n  {call}\n}})();")
}

/// Build the injected drain script for console/network/error logs. The collector is already
/// installed (document-start init script), so this only reads its ring buffer and exfiltrates on the
/// shared channel. Defensive fallback for pages where the collector never ran (e.g. about:blank).
pub fn logs_script(
    request_id: &str,
    kinds: &[String],
    since: Option<i64>,
    terminal_id: &str,
) -> String {
    let request = serde_json::to_string(request_id).unwrap_or_else(|_| "\"unknown\"".into());
    let terminal = serde_json::to_string(terminal_id).unwrap_or_else(|_| "\"\"".into());
    let opts = json!({ "kinds": kinds, "since": since });
    let opts_json = serde_json::to_string(&opts).unwrap_or_else(|_| "{}".into());
    let build = format!(
        "(globalThis.__lotusCollector ? globalThis.__lotusCollector.drain({request}, {opts_json}) : {{ action: \"logs\", requestId: {request}, entries: [], counts: {{}}, maxSeq: -1, truncated: false, note: \"collector not installed on this page\" }})"
    );
    let call = exfiltrate_call(&build, &request, &terminal);
    format!(";(() => {{\n  {call}\n}})();")
}

pub fn logs_from_payload(raw: &str, request_id: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    if value.get("action")?.as_str()? != "logs" {
        return None;
    }
    if value.get("requestId")?.as_str()? != request_id {
        return None;
    }
    Some(json!({
        "url": value.get("url").cloned().unwrap_or(Value::Null),
        "entries": value.get("entries").cloned().unwrap_or(Value::Array(vec![])),
        "counts": value.get("counts").cloned().unwrap_or(Value::Null),
        "maxSeq": value.get("maxSeq").cloned().unwrap_or(Value::Null),
        "truncated": value.get("truncated").cloned().unwrap_or(Value::Bool(false)),
        "note": value.get("note").cloned().unwrap_or(Value::Null),
    }))
}

pub fn action_from_payload(raw: &str, request_id: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    if value.get("action")?.as_str()? != "action-result" {
        return None;
    }
    if value.get("requestId")?.as_str()? != request_id {
        return None;
    }
    Some(json!({
        "ok": value.get("ok").cloned().unwrap_or(Value::Bool(false)),
        "error": value.get("error").cloned().unwrap_or(Value::Null),
        "filled": value.get("filled").cloned().unwrap_or(Value::Null),
        "matched": value.get("matched").cloned().unwrap_or(Value::Null),
        // Fresh snapshot of the resulting page (already ax-tree + redacted).
        "snapshot": value.get("snapshot").cloned().unwrap_or(Value::Null),
    }))
}

pub fn snapshot_from_payload(raw: &str, request_id: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    if value.get("action")?.as_str()? != "snapshot" {
        return None;
    }
    if value.get("requestId")?.as_str()? != request_id {
        return None;
    }
    Some(json!({
        "url": value.get("url").cloned().unwrap_or(Value::Null),
        "title": value.get("title").cloned().unwrap_or(Value::Null),
        "text": value.get("text").cloned().unwrap_or(Value::Null),
        // Playwright-style accessibility tree + ref bookkeeping (slice I2).
        "tree": value.get("tree").cloned().unwrap_or(Value::Null),
        "refEpoch": value.get("refEpoch").cloned().unwrap_or(Value::Null),
        "refCount": value.get("refCount").cloned().unwrap_or(Value::Null),
        "truncated": value.get("truncated").cloned().unwrap_or(Value::Bool(false)),
        // Legacy flat list, retained one release for backward-compat.
        "elements": value.get("elements").cloned().unwrap_or(Value::Array(vec![])),
        "viewport": value.get("viewport").cloned().unwrap_or(Value::Null),
        "capturedAt": value.get("capturedAt").cloned().unwrap_or(Value::Null),
    }))
}

pub fn search_from_payload(raw: &str, request_id: &str) -> Option<Value> {
    let value = serde_json::from_str::<Value>(raw).ok()?;
    if value.get("action")?.as_str()? != "search" {
        return None;
    }
    if value.get("requestId")?.as_str()? != request_id {
        return None;
    }
    Some(json!({
        "query": value.get("query").cloned().unwrap_or(Value::Null),
        "url": value.get("url").cloned().unwrap_or(Value::Null),
        "title": value.get("title").cloned().unwrap_or(Value::Null),
        "totalResults": value.get("totalResults").cloned().unwrap_or(Value::Number(0.into())),
        "results": value.get("results").cloned().unwrap_or(Value::Array(vec![])),
        "viewport": value.get("viewport").cloned().unwrap_or(Value::Null),
        "capturedAt": value.get("capturedAt").cloned().unwrap_or(Value::Null),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_script_embeds_builder_request_id_and_dual_path() {
        let script = snapshot_script("req-1", "node-7");
        // The shared builder is inlined, and the wrapper calls it with the id.
        assert!(script.contains("globalThis.__lotusInspect"));
        assert!(script.contains("buildSnapshot(\"req-1\")"));
        // Primary path: the IPC command, carrying the terminal + request ids.
        assert!(script.contains("emit_canvas_browser_tool_result"));
        assert!(script.contains("terminalId: \"node-7\""));
        assert!(script.contains("requestId: \"req-1\""));
        // Fallback path: the legacy navigation scheme.
        assert!(script.contains("codechat-browser-annotation://selected"));
    }

    #[test]
    fn exfiltration_falls_back_to_navigation_when_the_ipc_invoke_rejects() {
        // A denied `emit_canvas_browser_tool_result` invoke rejects its promise.
        // If the invoke is fire-and-forget, that rejection is swallowed: the
        // result never reaches the store and the agent sees an opaque timeout.
        // The script must handle the rejection and route the SAME payload through
        // the navigation-scheme fallback so the result is still delivered.
        let script = snapshot_script("req-1", "node-7");
        assert!(
            script.contains("Promise.resolve(invoke("),
            "invoke result must be awaited so a rejection can be handled, not fire-and-forget"
        );
        assert!(
            script.contains(".catch("),
            "a rejected invoke must fall through to the navigation-scheme fallback"
        );
    }

    #[test]
    fn snapshot_from_payload_passes_through_ax_tree_fields() {
        let raw = r#"{"action":"snapshot","requestId":"req-1","url":"http://localhost","title":"Home","text":"Hi","tree":"- button \"Cari\" [ref=e1]","refEpoch":3,"refCount":1,"truncated":false,"elements":[{"tag":"button"}]}"#;
        let snapshot = snapshot_from_payload(raw, "req-1").expect("snapshot");
        assert_eq!(snapshot["title"], "Home");
        assert_eq!(snapshot["tree"], "- button \"Cari\" [ref=e1]");
        assert_eq!(snapshot["refEpoch"], 3);
        assert_eq!(snapshot["refCount"], 1);
        assert_eq!(snapshot["truncated"], false);
        assert_eq!(snapshot["elements"][0]["tag"], "button");
        assert!(snapshot_from_payload(raw, "other").is_none());
        assert!(
            snapshot_from_payload(r#"{"action":"selected","requestId":"req-1"}"#, "req-1")
                .is_none()
        );
    }

    #[test]
    fn search_script_embeds_builder_query_and_request_id() {
        let script = search_script("req-1", "Sign in", 8, "node-1");
        assert!(script.contains("globalThis.__lotusInspect"));
        assert!(script.contains("buildSearch(\"req-1\", \"Sign in\", 8)"));
        assert!(script.contains("emit_canvas_browser_tool_result"));
        assert!(script.contains("codechat-browser-annotation://selected"));
    }

    #[test]
    fn action_script_embeds_builder_and_serialized_action() {
        let action = json!({"type": "click", "ref": "e3"});
        let script = action_script("req-9", &action, "node-2");
        assert!(script.contains("globalThis.__lotusInspect"));
        assert!(script.contains("performAction(\"req-9\""));
        // The action object is inlined as a JS object literal.
        assert!(script.contains("\"type\":\"click\""));
        assert!(script.contains("\"ref\":\"e3\""));
        assert!(script.contains("emit_canvas_browser_tool_result"));
        assert!(script.contains("codechat-browser-annotation://selected"));
    }

    #[test]
    fn action_from_payload_passes_result_and_snapshot_for_matching_request() {
        let raw = r#"{"action":"action-result","requestId":"req-9","ok":true,"filled":2,"snapshot":{"action":"snapshot","tree":"- button \"Go\" [ref=e1]"}}"#;
        let result = action_from_payload(raw, "req-9").expect("result");
        assert_eq!(result["ok"], true);
        assert_eq!(result["filled"], 2);
        assert_eq!(result["snapshot"]["tree"], "- button \"Go\" [ref=e1]");
        // Wrong request id or wrong action kind → ignored.
        assert!(action_from_payload(raw, "other").is_none());
        assert!(
            action_from_payload(r#"{"action":"snapshot","requestId":"req-9"}"#, "req-9").is_none()
        );
    }

    #[test]
    fn search_from_payload_accepts_matching_search_only() {
        let raw = r#"{"action":"search","requestId":"req-1","query":"login","url":"http://localhost","title":"Home","totalResults":1,"results":[{"kind":"element","text":"Login"}]}"#;
        let search = search_from_payload(raw, "req-1").expect("search");
        assert_eq!(search["query"], "login");
        assert_eq!(search["results"][0]["text"], "Login");
        assert!(search_from_payload(raw, "other").is_none());
        assert!(
            search_from_payload(r#"{"action":"snapshot","requestId":"req-1"}"#, "req-1").is_none()
        );
    }

    #[test]
    fn logs_from_payload_accepts_matching_logs_only() {
        let raw = r#"{"action":"logs","requestId":"req-3","entries":[{"seq":1,"kind":"console","level":"error","text":"boom"}],"counts":{"console":1,"error":0,"network":0},"maxSeq":1,"truncated":false}"#;
        let logs = logs_from_payload(raw, "req-3").expect("logs");
        assert_eq!(logs["entries"][0]["text"], "boom");
        assert_eq!(logs["maxSeq"], 1);
        assert_eq!(logs["counts"]["console"], 1);
        assert!(logs_from_payload(raw, "other").is_none());
        assert!(
            logs_from_payload(r#"{"action":"snapshot","requestId":"req-3"}"#, "req-3").is_none()
        );
    }

    #[test]
    fn logs_script_drains_collector_with_dual_path_exfiltration() {
        let script = logs_script("req-2", &["console".into()], Some(3), "node-1");
        assert!(script.contains("__lotusCollector"));
        assert!(script.contains("drain(\"req-2\""));
        assert!(script.contains("\"kinds\":[\"console\"]"));
        assert!(script.contains("\"since\":3"));
        // Both exfiltration paths, same as snapshot/search/action.
        assert!(script.contains("emit_canvas_browser_tool_result"));
        assert!(script.contains("codechat-browser-annotation://selected"));
    }
}
