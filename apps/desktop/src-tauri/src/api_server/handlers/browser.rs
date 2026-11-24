use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::{sleep, Duration, Instant};

use crate::api_auth::RequireAuth;
use crate::api_server::ApiState;
use crate::canvas_browser::{
    browser_webview_label, capture_canvas_browser_search, capture_canvas_browser_snapshot,
    validate_browser_url, CanvasBrowserAnnotation,
};

// ─── Capture timeout policy ───────────────────────────────────────────────────

const CAPTURE_TIMEOUT_DEFAULT_MS: u64 = 1800;
const CAPTURE_TIMEOUT_MIN_MS: u64 = 500;
const CAPTURE_TIMEOUT_MAX_MS: u64 = 10_000;

/// Resolve a caller-supplied capture budget into a clamped, safe deadline. A
/// slow page can legitimately need longer than the 1800 ms default, but an
/// unbounded budget would let a hung page pin a request handler indefinitely.
fn resolve_capture_timeout(requested: Option<u64>) -> Duration {
    let ms = requested
        .unwrap_or(CAPTURE_TIMEOUT_DEFAULT_MS)
        .clamp(CAPTURE_TIMEOUT_MIN_MS, CAPTURE_TIMEOUT_MAX_MS);
    Duration::from_millis(ms)
}

// ─── Agent-activity signal (W4) ───────────────────────────────────────────────

/// Emit the "an agent is driving this browser" flag to the frontend, which lights the Browser Node's
/// badge (the web analogue of the iOS Simulator's "Claude is using this device"). Best-effort.
fn emit_browser_activity(state: &ApiState, terminal_id: &str, active: bool) {
    let _ = state.mcp_state.emit_to_frontend(
        "canvas://browser-activity",
        serde_json::json!({ "terminalId": terminal_id, "active": active }),
    );
}

/// RAII guard: emits `active:true` on creation and `active:false` on drop, so the badge clears on
/// EVERY return path of a handler — success, error, or timeout.
struct BrowserActivityGuard<'a> {
    state: &'a ApiState,
    terminal_id: String,
}

impl<'a> BrowserActivityGuard<'a> {
    fn start(state: &'a ApiState, terminal_id: &str) -> Self {
        emit_browser_activity(state, terminal_id, true);
        Self {
            state,
            terminal_id: terminal_id.to_string(),
        }
    }
}

impl Drop for BrowserActivityGuard<'_> {
    fn drop(&mut self) {
        emit_browser_activity(self.state, &self.terminal_id, false);
    }
}

// ─── Origin policy enforcement (slice H2) ─────────────────────────────────────

/// Reject an agent-issued open/navigate whose (already scheme-validated) URL is
/// outside this node's origin allowlist. `Open` policy (the default) permits
/// everything, so this is a no-op until a node opts into an allowlist.
fn enforce_origin_policy(
    state: &ApiState,
    terminal_id: &str,
    url: &str,
) -> Result<(), (StatusCode, String)> {
    let policy = state.canvas_browser_policies.get(terminal_id);
    if policy.allows(url) {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            format!("Origin not allowed by this browser node's policy: {url}"),
        ))
    }
}

// ─── Write-action approval gate (slice H4) ─────────────────────────────────────

/// Longest a write action waits for a human decision in `Ask` mode before the
/// request is abandoned with 408. Bounded so a forgotten prompt can't pin a
/// connection indefinitely.
const APPROVAL_WAIT: Duration = Duration::from_secs(60);

/// Gate a write action behind this node's approval mode. `Auto` (default) passes
/// through immediately. `Ask` registers the action, emits
/// `canvas://browser-action-pending` for the human UI, and waits: Approve →
/// proceed, Deny → 403, timeout → 408. Read actions never call this.
async fn await_write_approval(
    state: &ApiState,
    terminal_id: &str,
    action: &str,
    detail: &str,
) -> Result<(), (StatusCode, String)> {
    use crate::canvas_browser_approval::{ApprovalDecision, ApprovalMode};

    if state.canvas_browser_approval_modes.get(terminal_id) == ApprovalMode::Auto {
        return Ok(());
    }

    let request_id = uuid::Uuid::new_v4().to_string();
    let rx = state
        .canvas_browser_approval_gate
        .register(request_id.clone());

    // Best-effort surface the pending action to the human UI. If the app handle
    // isn't available (tests), the human resolves via the gate directly.
    let _ = state.mcp_state.emit_to_frontend(
        "canvas://browser-action-pending",
        serde_json::json!({
            "terminalId": terminal_id,
            "requestId": request_id,
            "action": action,
            "detail": detail,
        }),
    );

    match tokio::time::timeout(APPROVAL_WAIT, rx).await {
        Ok(Ok(ApprovalDecision::Approve)) => Ok(()),
        Ok(Ok(ApprovalDecision::Deny)) => Err((
            StatusCode::FORBIDDEN,
            format!("Human denied browser {action} ({detail})"),
        )),
        // Sender dropped without a decision — treat as denial, fail safe.
        Ok(Err(_)) => Err((
            StatusCode::FORBIDDEN,
            format!("Browser {action} approval was cancelled"),
        )),
        Err(_) => {
            state.canvas_browser_approval_gate.forget(&request_id);
            Err((
                StatusCode::REQUEST_TIMEOUT,
                format!("Timed out waiting for human approval of browser {action}"),
            ))
        }
    }
}

// ─── Request / response types ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpenRequest {
    pub terminal_id: String,
    pub url: String,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOpenResponse {
    pub ok: bool,
    pub webview_label: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigateRequest {
    pub terminal_id: String,
    pub url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserNavigateResponse {
    pub ok: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTerminalQuery {
    pub terminal_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAnnotationResponse {
    pub ok: bool,
    pub annotation: Option<CanvasBrowserAnnotation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotRequest {
    pub terminal_id: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshotResponse {
    pub ok: bool,
    pub request_id: String,
    pub snapshot: Value,
    /// Absolute path to a freshly captured PNG screenshot of the page, or `None`
    /// when the native capture was unavailable (e.g. node parked/off-screen).
    /// The agent reads this file to see the page exactly as rendered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_path: Option<String>,
    /// Captured screenshot dimensions in pixels, when an image was produced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<ScreenshotMeta>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotMeta {
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSearchRequest {
    pub terminal_id: String,
    pub query: String,
    pub max_results: Option<usize>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSearchResponse {
    pub ok: bool,
    pub request_id: String,
    pub search: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLogsRequest {
    pub terminal_id: String,
    /// Optional filter: any of "console" | "network" | "error". Empty/absent = all kinds.
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    /// Only return entries with a `seq` greater than this cursor (from a prior response's `maxSeq`).
    #[serde(default)]
    pub since: Option<i64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLogsResponse {
    pub ok: bool,
    pub request_id: String,
    pub logs: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionRequest {
    pub terminal_id: String,
    /// Action object: `{ "type": "click"|"type"|"fill_form"|"select_option"|"press_key", ... }`.
    pub action: Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserActionResponse {
    pub ok: bool,
    pub request_id: String,
    pub result: Value,
}

/// Interaction actions the agent may request. Kept in sync with the in-page
/// executor (`scripts/browser/canvas-inspect.js`) and gated as write actions.
const SUPPORTED_ACTIONS: &[&str] = &["click", "type", "fill_form", "select_option", "press_key"];

// ─── POST /api/browser/open ───────────────────────────────────────────────────

pub async fn open_browser(
    RequireAuth: RequireAuth,
    State(state): State<ApiState>,
    Json(req): Json<BrowserOpenRequest>,
) -> Result<Json<BrowserOpenResponse>, (StatusCode, String)> {
    let url =
        validate_browser_url(&req.url).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    if req.terminal_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "terminalId is required".into()));
    }

    enforce_origin_policy(&state, &req.terminal_id, &url)?;
    await_write_approval(&state, &req.terminal_id, "open", &url).await?;

    let webview_label = browser_webview_label(&req.terminal_id);

    // Emit Tauri event so the canvas frontend can spawn / navigate the BrowserNode.
    // Fire-and-forget: if AppHandle is not registered yet (e.g. during tests), ignore.
    let _ = state.mcp_state.emit_to_frontend(
        "canvas://browser-open",
        serde_json::json!({
            "terminalId": req.terminal_id,
            "url": url,
            "webviewLabel": webview_label,
            "label": req.label,
        }),
    );

    Ok(Json(BrowserOpenResponse {
        ok: true,
        webview_label,
        url,
    }))
}

// ─── POST /api/browser/navigate ──────────────────────────────────────────────

pub async fn navigate_browser(
    RequireAuth: RequireAuth,
    State(state): State<ApiState>,
    Json(req): Json<BrowserNavigateRequest>,
) -> Result<Json<BrowserNavigateResponse>, (StatusCode, String)> {
    let url =
        validate_browser_url(&req.url).map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    if req.terminal_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "terminalId is required".into()));
    }

    enforce_origin_policy(&state, &req.terminal_id, &url)?;
    await_write_approval(&state, &req.terminal_id, "navigate", &url).await?;

    let _ = state.mcp_state.emit_to_frontend(
        "canvas://browser-navigate",
        serde_json::json!({ "terminalId": req.terminal_id, "url": url }),
    );

    Ok(Json(BrowserNavigateResponse { ok: true }))
}

// ─── POST /api/browser/snapshot ─────────────────────────────────────────────

pub async fn snapshot_browser(
    RequireAuth: RequireAuth,
    State(state): State<ApiState>,
    Json(req): Json<BrowserSnapshotRequest>,
) -> Result<Json<BrowserSnapshotResponse>, (StatusCode, String)> {
    if req.terminal_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "terminalId is required".into()));
    }
    let Some(app) = state.app_handle.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Tauri app handle unavailable".into(),
        ));
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let _activity = BrowserActivityGuard::start(&state, &req.terminal_id);

    // ── 1) Native image capture (reliable core) ──────────────────────────────
    // Captured entirely in Rust (WKWebView.takeSnapshot) — no page eval, no
    // exfiltration, no polling. A failure here (node parked, unsupported OS) is
    // best-effort: it must NOT sink the snapshot, since the ax-tree may still
    // succeed. The screenshot is the visually accurate anchor for the agent.
    let screenshot_timeout =
        crate::canvas_browser_screenshot::resolve_screenshot_timeout(req.timeout_ms);
    let (image_path, image_meta) =
        match crate::canvas_browser_screenshot::capture_canvas_browser_png(
            app,
            &req.terminal_id,
            screenshot_timeout,
        )
        .await
        {
            Ok(png) => match persist_screenshot_png(&req.terminal_id, &png) {
                Ok(result) => (Some(result.0), Some(result.1)),
                Err(e) => {
                    eprintln!("[canvas-browser] screenshot persist failed: {e}");
                    (None, None)
                }
            },
            Err(e) => {
                // Expected & benign when the node is parked/off-screen or non-macOS.
                eprintln!("[canvas-browser] screenshot capture skipped: {e}");
                (None, None)
            }
        };

    // ── 2) Best-effort DOM / accessibility snapshot (in-page channel) ─────────
    // This is the fragile path (eval → exfiltrate → poll). We still attempt it so
    // the agent gets `[ref=eN]` anchors for click/type, but a timeout no longer
    // fails the whole request when an image was captured.
    let ax_snapshot =
        capture_ax_snapshot(&state, app, &req.terminal_id, &request_id, req.timeout_ms).await;

    match (ax_snapshot, image_path) {
        // Nothing came back at all — surface the failure so the agent can retry.
        (None, None) => Err((
            StatusCode::GATEWAY_TIMEOUT,
            "Browser snapshot produced neither a screenshot nor a DOM snapshot; the node may be closed or off-screen."
                .into(),
        )),
        (ax, image_path) => Ok(Json(BrowserSnapshotResponse {
            ok: true,
            request_id,
            snapshot: ax.unwrap_or_else(|| {
                serde_json::json!({
                    "note": "DOM accessibility snapshot unavailable this round (in-page capture timed out). The screenshot reflects the current page; [ref=eN] anchors for click/type are not available — re-run snapshot to obtain them.",
                })
            }),
            image_path,
            image: image_meta,
        })),
    }
}

/// Fire the in-page snapshot script and poll the result store for its payload.
/// Returns `None` on inject failure or timeout — the caller decides whether that
/// is fatal (it isn't when a native screenshot was captured).
async fn capture_ax_snapshot<R: tauri::Runtime>(
    state: &ApiState,
    app: &tauri::AppHandle<R>,
    terminal_id: &str,
    request_id: &str,
    timeout_ms: Option<u64>,
) -> Option<Value> {
    if let Err(e) = capture_canvas_browser_snapshot(app, terminal_id, request_id) {
        eprintln!("[canvas-browser] ax-snapshot inject failed: {e}");
        return None;
    }
    let budget = resolve_capture_timeout(timeout_ms);
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if let Some(payload) = state.browser_results.get(terminal_id) {
            if let Some(snapshot) =
                crate::canvas_browser_snapshot::snapshot_from_payload(&payload, request_id)
            {
                return Some(snapshot);
            }
        }
        sleep(Duration::from_millis(50)).await;
    }
    eprintln!(
        "[canvas-browser] ax-snapshot timed out after {}ms for terminal {terminal_id} (request {request_id}) — in-page exfiltration did not deliver",
        budget.as_millis()
    );
    None
}

/// Sanitize a terminal id into a safe single-path-segment file stem.
fn sanitize_terminal_for_file(terminal_id: &str) -> String {
    let cleaned: String = terminal_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "canvas-browser".into()
    } else {
        trimmed.chars().take(96).collect()
    }
}

/// Parse width/height from a PNG's IHDR chunk (big-endian u32 at bytes 16 & 20).
fn png_dimensions(bytes: &[u8]) -> (u32, u32) {
    if bytes.len() < 24 {
        return (0, 0);
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    (width, height)
}

/// Write the PNG to the persistent per-terminal screenshot path (latest wins, so
/// captures stay bounded) and return its absolute path plus dimensions. The path
/// is under the Lotus state dir so it survives long enough for the agent to read.
fn persist_screenshot_png(
    terminal_id: &str,
    png: &[u8],
) -> Result<(String, ScreenshotMeta), String> {
    let dir = crate::paths::lotus_state_dir().join("canvas-screenshots");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create screenshot dir: {e}"))?;
    let path = dir.join(format!("{}.png", sanitize_terminal_for_file(terminal_id)));
    std::fs::write(&path, png).map_err(|e| format!("write screenshot: {e}"))?;
    let (width, height) = png_dimensions(png);
    Ok((
        path.to_string_lossy().into_owned(),
        ScreenshotMeta {
            width,
            height,
            bytes: png.len(),
        },
    ))
}

// ─── POST /api/browser/search ───────────────────────────────────────────────

pub async fn search_browser(
    RequireAuth: RequireAuth,
    State(state): State<ApiState>,
    Json(req): Json<BrowserSearchRequest>,
) -> Result<Json<BrowserSearchResponse>, (StatusCode, String)> {
    if req.terminal_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "terminalId is required".into()));
    }
    let query = req.query.trim();
    if query.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "query is required".into()));
    }
    let Some(app) = state.app_handle.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Tauri app handle unavailable".into(),
        ));
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let _activity = BrowserActivityGuard::start(&state, &req.terminal_id);
    let max_results = req.max_results.unwrap_or(12).clamp(1, 50);
    capture_canvas_browser_search(app, &req.terminal_id, &request_id, query, max_results)
        .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;

    let budget = resolve_capture_timeout(req.timeout_ms);
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if let Some(payload) = state.browser_results.get(&req.terminal_id) {
            if let Some(search) =
                crate::canvas_browser_snapshot::search_from_payload(&payload, &request_id)
            {
                return Ok(Json(BrowserSearchResponse {
                    ok: true,
                    request_id,
                    search,
                }));
            }
        }
        sleep(Duration::from_millis(50)).await;
    }

    Err((
        StatusCode::GATEWAY_TIMEOUT,
        format!(
            "Timed out waiting for browser search after {}ms",
            budget.as_millis()
        ),
    ))
}

// ─── POST /api/browser/logs (W3) ──────────────────────────────────────────────

pub async fn logs_browser(
    RequireAuth: RequireAuth,
    State(state): State<ApiState>,
    Json(req): Json<BrowserLogsRequest>,
) -> Result<Json<BrowserLogsResponse>, (StatusCode, String)> {
    if req.terminal_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "terminalId is required".into()));
    }
    let Some(app) = state.app_handle.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Tauri app handle unavailable".into(),
        ));
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    let _activity = BrowserActivityGuard::start(&state, &req.terminal_id);
    let kinds = req.kinds.unwrap_or_default();
    crate::canvas_browser::capture_canvas_browser_logs(
        app,
        &req.terminal_id,
        &request_id,
        &kinds,
        req.since,
    )
    .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;

    let budget = resolve_capture_timeout(req.timeout_ms);
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if let Some(payload) = state.browser_results.get(&req.terminal_id) {
            if let Some(logs) =
                crate::canvas_browser_snapshot::logs_from_payload(&payload, &request_id)
            {
                return Ok(Json(BrowserLogsResponse {
                    ok: true,
                    request_id,
                    logs,
                }));
            }
        }
        sleep(Duration::from_millis(50)).await;
    }

    Err((
        StatusCode::GATEWAY_TIMEOUT,
        format!(
            "Timed out waiting for browser logs after {}ms",
            budget.as_millis()
        ),
    ))
}

// ─── GET /api/browser/annotation/latest ──────────────────────────────────────

pub async fn get_latest_annotation(
    RequireAuth: RequireAuth,
    State(state): State<ApiState>,
    Query(q): Query<BrowserTerminalQuery>,
) -> Result<Json<BrowserAnnotationResponse>, (StatusCode, String)> {
    if q.terminal_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "terminalId is required".into()));
    }

    let annotation = state.browser_annotations.get(&q.terminal_id);
    Ok(Json(BrowserAnnotationResponse {
        ok: true,
        annotation,
    }))
}

// ─── POST /api/browser/action (slice I3) ─────────────────────────────────────

pub async fn action_browser(
    RequireAuth: RequireAuth,
    State(state): State<ApiState>,
    Json(req): Json<BrowserActionRequest>,
) -> Result<Json<BrowserActionResponse>, (StatusCode, String)> {
    if req.terminal_id.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "terminalId is required".into()));
    }

    // Validate the action shape before touching the webview.
    let action_type = req
        .action
        .get("type")
        .and_then(Value::as_str)
        .ok_or((StatusCode::BAD_REQUEST, "action.type is required".into()))?;
    if !SUPPORTED_ACTIONS.contains(&action_type) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!(
                "Unsupported action \"{action_type}\"; expected one of: {}",
                SUPPORTED_ACTIONS.join(", ")
            ),
        ));
    }

    // Every interaction is a write action → subject to the approval gate. The
    // detail surfaced to the human is the target ref (or the key/type).
    let detail = req
        .action
        .get("ref")
        .and_then(Value::as_str)
        .or_else(|| req.action.get("key").and_then(Value::as_str))
        .unwrap_or(action_type)
        .to_string();
    await_write_approval(&state, &req.terminal_id, action_type, &detail).await?;

    let Some(app) = state.app_handle.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Tauri app handle unavailable".into(),
        ));
    };

    let request_id = uuid::Uuid::new_v4().to_string();
    // Guard starts AFTER approval so the badge reflects active driving, not a pending human prompt.
    let _activity = BrowserActivityGuard::start(&state, &req.terminal_id);
    crate::canvas_browser::capture_canvas_browser_action(
        app,
        &req.terminal_id,
        &request_id,
        &req.action,
    )
    .map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;

    let budget = resolve_capture_timeout(req.timeout_ms);
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if let Some(payload) = state.browser_results.get(&req.terminal_id) {
            if let Some(result) =
                crate::canvas_browser_snapshot::action_from_payload(&payload, &request_id)
            {
                return Ok(Json(BrowserActionResponse {
                    ok: result.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    request_id,
                    result,
                }));
            }
        }
        sleep(Duration::from_millis(50)).await;
    }

    Err((
        StatusCode::GATEWAY_TIMEOUT,
        format!(
            "Timed out waiting for browser action result after {}ms",
            budget.as_millis()
        ),
    ))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{
        resolve_capture_timeout, BrowserOpenRequest, CAPTURE_TIMEOUT_DEFAULT_MS,
        CAPTURE_TIMEOUT_MAX_MS, CAPTURE_TIMEOUT_MIN_MS,
    };
    use crate::api_server::tests_support::{auth_header, test_router};
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[test]
    fn capture_timeout_defaults_and_clamps() {
        assert_eq!(
            resolve_capture_timeout(None).as_millis() as u64,
            CAPTURE_TIMEOUT_DEFAULT_MS
        );
        // Below the floor clamps up; above the ceiling clamps down.
        assert_eq!(
            resolve_capture_timeout(Some(10)).as_millis() as u64,
            CAPTURE_TIMEOUT_MIN_MS
        );
        assert_eq!(
            resolve_capture_timeout(Some(999_999)).as_millis() as u64,
            CAPTURE_TIMEOUT_MAX_MS
        );
        // A value inside the range passes through untouched.
        assert_eq!(resolve_capture_timeout(Some(3000)).as_millis() as u64, 3000);
    }

    #[test]
    fn browser_open_request_accepts_an_optional_label() {
        let with_label: BrowserOpenRequest = serde_json::from_value(serde_json::json!({
            "terminalId": "term-1",
            "url": "https://example.com",
            "label": "Ghibli Grove Bible",
        }))
        .unwrap();
        assert_eq!(with_label.label.as_deref(), Some("Ghibli Grove Bible"));

        let without_label: BrowserOpenRequest = serde_json::from_value(serde_json::json!({
            "terminalId": "term-1",
            "url": "https://example.com",
        }))
        .unwrap();
        assert!(without_label.label.is_none());
    }

    #[tokio::test]
    async fn snapshot_accepts_timeout_ms_without_rejecting_body() {
        // The handler still 503s without an app handle, but only AFTER the body
        // (now carrying timeoutMs) deserializes — proving the field is accepted.
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/snapshot")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"terminalId":"node-xyz","timeoutMs":5000}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn open_browser_rejects_invalid_url() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/open")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","url":"javascript:alert(1)"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn open_browser_rejects_empty_terminal_id() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/open")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"","url":"http://localhost:3000"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn open_browser_returns_webview_label() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/open")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-abc","url":"http://localhost:3000"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["webviewLabel"], "canvas-browser-node-abc");
    }

    #[tokio::test]
    async fn snapshot_returns_service_unavailable_without_app_handle() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/snapshot")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"terminalId":"node-xyz"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn search_rejects_empty_query() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/search")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"terminalId":"node-xyz","query":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn search_returns_service_unavailable_without_app_handle() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/search")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-xyz","query":"login","maxResults":5}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn open_blocked_by_allowlist_returns_forbidden() {
        use crate::api_server::tests_support::test_router_with_policies;
        use crate::canvas_browser_policy::{
            CanvasBrowserPolicy, CanvasBrowserPolicyMode, CanvasBrowserPolicyStore,
        };

        let policies = CanvasBrowserPolicyStore::default();
        policies.set(
            "node-1",
            CanvasBrowserPolicy {
                mode: CanvasBrowserPolicyMode::Allowlist,
                origins: vec!["localhost:3000".into()],
            },
        );
        let app = test_router_with_policies(policies);

        // In-allowlist origin passes policy (then 200 optimistic open).
        let ok = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/open")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","url":"http://localhost:3000"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);

        // Out-of-allowlist origin is rejected before any webview work.
        let blocked = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/open")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","url":"https://evil.example.com"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn navigate_blocked_by_allowlist_returns_forbidden() {
        use crate::api_server::tests_support::test_router_with_policies;
        use crate::canvas_browser_policy::{
            CanvasBrowserPolicy, CanvasBrowserPolicyMode, CanvasBrowserPolicyStore,
        };

        let policies = CanvasBrowserPolicyStore::default();
        policies.set(
            "node-1",
            CanvasBrowserPolicy {
                mode: CanvasBrowserPolicyMode::Allowlist,
                origins: vec!["https://example.com".into()],
            },
        );
        let app = test_router_with_policies(policies);

        let blocked = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/navigate")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","url":"https://other.example.org/login"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn open_default_open_policy_allows_any_origin() {
        // No policy set → Open default → any http/https origin passes.
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/open")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-free","url":"https://anywhere.example.io"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn action_rejects_missing_or_unsupported_type() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        // Missing action.type.
        let missing = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/action")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"terminalId":"node-1","action":{}}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::BAD_REQUEST);

        // Unknown action type.
        let bad = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/action")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","action":{"type":"hack","ref":"e1"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn action_without_app_handle_is_service_unavailable_in_auto_mode() {
        // Valid write action, Auto mode → passes the gate, then 503 (no webview
        // runtime in the test router). Proves the gate doesn't block Auto.
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/action")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","action":{"type":"click","ref":"e1"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn action_ask_mode_denied_returns_forbidden() {
        use crate::api_server::build_router;
        use crate::api_server::tests_support::test_state;
        use crate::canvas_browser_approval::{ApprovalDecision, ApprovalMode};

        let state = test_state();
        state
            .canvas_browser_approval_modes
            .set("node-1", ApprovalMode::Ask);
        let gate = state.canvas_browser_approval_gate.clone();
        let app = build_router(state);

        let resolver = tokio::spawn(async move {
            for _ in 0..500 {
                if let Some(id) = gate.pending_ids().first() {
                    gate.resolve(id, ApprovalDecision::Deny);
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        });

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/action")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","action":{"type":"type","ref":"e1","text":"x"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        resolver.await.unwrap();
    }

    #[tokio::test]
    async fn navigate_auto_mode_passes_through_without_approval() {
        // Default approval mode is Auto → navigate returns immediately (200).
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/navigate")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","url":"http://localhost:3000/x"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn navigate_ask_mode_waits_for_human_approval() {
        use crate::api_server::build_router;
        use crate::api_server::tests_support::test_state;
        use crate::canvas_browser_approval::{ApprovalDecision, ApprovalMode};

        // Approve path: a concurrent human resolves the pending action.
        let state = test_state();
        state
            .canvas_browser_approval_modes
            .set("node-1", ApprovalMode::Ask);
        let gate = state.canvas_browser_approval_gate.clone();
        let app = build_router(state);

        let resolver = tokio::spawn(async move {
            for _ in 0..500 {
                let ids = gate.pending_ids();
                if let Some(id) = ids.first() {
                    gate.resolve(id, ApprovalDecision::Approve);
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        });

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/navigate")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","url":"https://example.com/"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        resolver.await.unwrap();
    }

    #[tokio::test]
    async fn navigate_ask_mode_denied_returns_forbidden() {
        use crate::api_server::build_router;
        use crate::api_server::tests_support::test_state;
        use crate::canvas_browser_approval::{ApprovalDecision, ApprovalMode};

        let state = test_state();
        state
            .canvas_browser_approval_modes
            .set("node-1", ApprovalMode::Ask);
        let gate = state.canvas_browser_approval_gate.clone();
        let app = build_router(state);

        let resolver = tokio::spawn(async move {
            for _ in 0..500 {
                let ids = gate.pending_ids();
                if let Some(id) = ids.first() {
                    gate.resolve(id, ApprovalDecision::Deny);
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(2)).await;
            }
        });

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/browser/navigate")
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"terminalId":"node-1","url":"https://example.com/"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        resolver.await.unwrap();
    }

    #[tokio::test]
    async fn get_latest_annotation_returns_none_when_no_annotation() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/browser/annotation/latest?terminalId=node-xyz")
                    .header(auth_header().0, auth_header().1)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["ok"], true);
        assert!(json["annotation"].is_null());
    }
}
