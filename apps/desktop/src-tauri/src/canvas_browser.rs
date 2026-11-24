use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Webview, WebviewBuilder,
    WebviewUrl, Window,
};

use crate::canvas_browser_local_files::{
    is_file_url, resolve_browser_navigation, LocalFileServeStore, ResolvedBrowserNavigation,
    LOCAL_FILE_SERVE_PREFIX,
};
use crate::canvas_browser_policy::CanvasBrowserPolicyStore;
use crate::AppError;

const CANVAS_BROWSER_ATTACHMENT_TEMP_PREFIX: &str = "lotus-canvas-browser-annotation-";

/// Tauri event emitted when a page-initiated navigation is blocked by policy.
pub const CANVAS_BROWSER_NAVIGATION_BLOCKED_EVENT: &str = "canvas://browser-navigation-blocked";

/// Tauri event emitted when the paired WebView commits to a new top-level URL
/// (link click, redirect, or programmatic navigation). The frontend uses it to
/// keep the address bar in sync with the page — like a real browser — instead of
/// only reflecting URLs the app itself set.
pub const CANVAS_BROWSER_URL_CHANGED_EVENT: &str = "canvas://browser-url-changed";

/// Tauri event emitted when the paired WebView reports a non-empty document title.
pub const CANVAS_BROWSER_TITLE_CHANGED_EVENT: &str = "canvas://browser-title-changed";

// ─── Annotation store ────────────────────────────────────────────────────────

/// One captured annotation entry — raw JSON payload from the overlay script.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBrowserAnnotation {
    pub terminal_id: String,
    /// Raw JSON string from the annotation overlay (bounding box, label, action, …).
    pub payload: String,
    pub url: String,
    pub captured_at: u64,
}

/// In-memory store: one annotation per terminal (latest wins).
#[derive(Debug, Default, Clone)]
pub struct CanvasBrowserAnnotationStore(Arc<Mutex<HashMap<String, CanvasBrowserAnnotation>>>);

impl CanvasBrowserAnnotationStore {
    pub fn set(&self, annotation: CanvasBrowserAnnotation) {
        self.0
            .lock()
            .expect("annotation store lock")
            .insert(annotation.terminal_id.clone(), annotation);
    }

    pub fn get(&self, terminal_id: &str) -> Option<CanvasBrowserAnnotation> {
        self.0
            .lock()
            .expect("annotation store lock")
            .get(terminal_id)
            .cloned()
    }

    pub fn remove(&self, terminal_id: &str) {
        self.0
            .lock()
            .expect("annotation store lock")
            .remove(terminal_id);
    }
}

// ─── Tool-result store (slice I1) ─────────────────────────────────────────────

/// In-memory store for snapshot/search/action *tool results* — kept separate
/// from human annotations so each has one clean concern. Latest-wins per
/// terminal; the polling handler matches on the `requestId` inside the payload.
#[derive(Debug, Default, Clone)]
pub struct CanvasBrowserResultStore(Arc<Mutex<HashMap<String, String>>>);

impl CanvasBrowserResultStore {
    pub fn set(&self, terminal_id: &str, payload: String) {
        self.0
            .lock()
            .expect("result store lock")
            .insert(terminal_id.to_string(), payload);
    }

    pub fn get(&self, terminal_id: &str) -> Option<String> {
        self.0
            .lock()
            .expect("result store lock")
            .get(terminal_id)
            .cloned()
    }

    pub fn remove(&self, terminal_id: &str) {
        self.0
            .lock()
            .expect("result store lock")
            .remove(terminal_id);
    }
}

/// Tool-result `action` kinds the in-page executor emits (snapshot/search/click…).
/// Payloads carrying one of these are routed to the result store; anything else
/// on the exfiltration channel is a human annotation.
pub fn is_tool_result_payload(raw: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get("action").and_then(|a| a.as_str()).map(str::to_string))
        .map(|action| {
            matches!(
                action.as_str(),
                "snapshot" | "search" | "action-result" | "logs"
            )
        })
        .unwrap_or(false)
}

fn parse_canvas_browser_title_payload(raw: &str) -> Option<String> {
    let payload = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    if payload.get("action")?.as_str()? != "canvas-browser-title" {
        return None;
    }
    let title = payload.get("title")?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn canvas_browser_title_script() -> &'static str {
    r#"
(() => {
  let lastTitle = "";
  const emitTitle = () => {
    const title = typeof document.title === "string" ? document.title.trim() : "";
    if (!title || title === lastTitle) return;
    lastTitle = title;
    const payload = encodeURIComponent(JSON.stringify({
      action: "canvas-browser-title",
      title,
    }));
    window.location.href = `codechat-browser-annotation://selected?payload=${payload}`;
  };
  const observeTitle = () => {
    emitTitle();
    const root = document.head || document.documentElement;
    if (!root) return;
    new MutationObserver(emitTitle).observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observeTitle, { once: true });
  } else {
    observeTitle();
  }
  window.addEventListener("load", emitTitle, { once: true });
})();
"#
}

// ─── Open/close result ───────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBrowserOpenResult {
    pub ok: bool,
    pub node_id: String,
    pub url: String,
    pub reused: bool,
}

// ─── WebView label ───────────────────────────────────────────────────────────

/// Tauri event name emitted when the annotation overlay captures a selection.
pub const CANVAS_BROWSER_ANNOTATION_EVENT: &str = "canvas://browser-annotation";

/// Derives a stable Tauri WebView label from the canvas terminal node ID.
/// Label chars must be ASCII alphanumeric, `-`, or `_`.
pub fn browser_webview_label(terminal_id: &str) -> String {
    let sanitized: String = terminal_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("canvas-browser-{sanitized}")
}

// ─── URL normalization (re-export from browser_preview) ─────────────────────

pub use crate::browser_preview::normalize_browser_preview_url;

// ─── Validate URL ────────────────────────────────────────────────────────────

pub fn validate_browser_url(url: &str) -> Result<String, AppError> {
    let parsed = normalize_browser_preview_url(url)?;
    Ok(parsed.to_string())
}

/// Whether a committed URL is a local-file serve URL (`http://127.0.0.1/__local/…`).
fn is_local_serve_url(url: &tauri::Url) -> bool {
    url.host_str() == Some("127.0.0.1")
        && url
            .path()
            .starts_with(&format!("/{LOCAL_FILE_SERVE_PREFIX}/"))
}

/// Resolve a browser-node URL into the WebView navigation target plus the address
/// the address bar should display. Remote URLs display as themselves; `file://`
/// URLs are served over localhost but keep their `file://` display so the address
/// bar stays intuitive. Confinement + token registration happen here for files.
fn resolve_canvas_navigation<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    url_str: &str,
    allowed_root: Option<&Path>,
) -> Result<(tauri::Url, String), AppError> {
    // Non-file URLs need no store and keep the existing normalization path.
    if !is_file_url(url_str) {
        let url = normalize_browser_preview_url(url_str)?;
        let display = url.to_string();
        return Ok((url, display));
    }
    let store = app
        .try_state::<LocalFileServeStore>()
        .ok_or_else(|| AppError::Other("Local file serving is unavailable.".into()))?;
    // The token is the node id: one root per node, stable across reloads (so
    // re-opening the same file is a no-op), and cleaned up on close. It is never
    // exposed to page content and the serve route binds to 127.0.0.1 only.
    let token = terminal_id.to_string();
    match resolve_browser_navigation(url_str, allowed_root, &token, store.port())? {
        ResolvedBrowserNavigation::Remote { url } => {
            let display = url.to_string();
            Ok((url, display))
        }
        ResolvedBrowserNavigation::LocalFile { display, serve } => {
            if let Some(root) = allowed_root {
                store.register(&token, root.to_path_buf());
            }
            Ok((serve, display))
        }
    }
}

// ─── Bounds ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub zoom_factor: Option<f64>,
}

const CANVAS_BROWSER_MIN_ZOOM_FACTOR: f64 = 0.35;
const CANVAS_BROWSER_MAX_ZOOM_FACTOR: f64 = 1.25;

fn normalize_canvas_browser_zoom_factor(zoom_factor: Option<f64>) -> f64 {
    let zoom = zoom_factor.unwrap_or(1.0);
    if !zoom.is_finite() {
        return 1.0;
    }
    zoom.clamp(
        CANVAS_BROWSER_MIN_ZOOM_FACTOR,
        CANVAS_BROWSER_MAX_ZOOM_FACTOR,
    )
}

// ─── WebView commands ────────────────────────────────────────────────────────

pub(crate) fn get_canvas_webview<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
) -> Option<Webview<R>> {
    app.get_webview(&browser_webview_label(terminal_id))
}

/// Return keyboard focus to the main app WebView. Called when a browser node's native child
/// WebView is parked for a blocking overlay: focus may still live in that child WebView, so the
/// overlay's own key handlers (e.g. Escape) would never fire until the user clicked.
pub fn focus_canvas_main_webview<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    if let Some(webview) = app.get_webview("main") {
        webview
            .set_focus()
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

fn set_canvas_browser_bounds<R: Runtime>(
    webview: &Webview<R>,
    bounds: CanvasBrowserBounds,
) -> Result<(), AppError> {
    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
            size: tauri::Size::Logical(LogicalSize::new(bounds.width, bounds.height)),
        })
        .map_err(|e| AppError::Other(e.to_string()))?;
    webview
        .set_zoom(normalize_canvas_browser_zoom_factor(bounds.zoom_factor))
        .map_err(|e| AppError::Other(e.to_string()))
}

pub fn open_canvas_browser<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    terminal_id: &str,
    url_str: &str,
    allowed_root: Option<PathBuf>,
    bounds: CanvasBrowserBounds,
) -> Result<CanvasBrowserOpenResult, AppError> {
    let (url, url_string) =
        resolve_canvas_navigation(app, terminal_id, url_str, allowed_root.as_deref())?;
    let label = browser_webview_label(terminal_id);
    let node_id = terminal_id.to_string();

    if let Some(webview) = app.get_webview(&label) {
        // Re-opening at the URL the page is already on is the recovery path
        // (a remounted node re-earning its "active" claim) — skip the navigate
        // so recovery never reloads a live page out from under the user.
        let already_there = webview.url().map(|current| current == url).unwrap_or(false);
        if !already_there {
            webview
                .navigate(url)
                .map_err(|e| AppError::Other(e.to_string()))?;
        }
        set_canvas_browser_bounds(&webview, bounds)?;
        return Ok(CanvasBrowserOpenResult {
            ok: true,
            node_id,
            url: url_string,
            reused: true,
        });
    }

    let annotation_app = app.clone();
    let annotation_store = app.state::<CanvasBrowserAnnotationStore>().inner().clone();
    let result_store = app
        .try_state::<CanvasBrowserResultStore>()
        .map(|s| s.inner().clone());
    let annotation_terminal_id = terminal_id.to_string();
    // Origin policy is looked up fresh per navigation so a human tightening the
    // allowlist mid-session takes effect immediately, without reopening the node.
    let policy_store = app
        .try_state::<CanvasBrowserPolicyStore>()
        .map(|s| s.inner().clone());
    let policy_terminal_id = terminal_id.to_string();
    let title_webview_label = label.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        // W3: install the console/network/error collector at document-start on every navigation,
        // so logs are captured from the page's first line (before any drain).
        .initialization_script(crate::canvas_browser_snapshot::collector_init_script())
        .initialization_script(canvas_browser_title_script())
        .on_navigation(move |nav_url| {
            if let Some(payload) =
                crate::browser_preview::parse_annotation_navigation_payload(&nav_url)
            {
                if let Some(title) = parse_canvas_browser_title_payload(&payload) {
                    let _ = annotation_app.emit(
                        CANVAS_BROWSER_TITLE_CHANGED_EVENT,
                        serde_json::json!({
                            "terminalId": policy_terminal_id,
                            "webviewLabel": title_webview_label,
                            "title": title,
                        }),
                    );
                    return false;
                }
                // Tool results (snapshot/search/action) go to the result store the
                // handlers poll; human annotations keep their store + PTY prompt.
                // This is the nav-scheme FALLBACK — the primary path is the
                // `emit_canvas_browser_tool_result` IPC command (slice I1).
                if is_tool_result_payload(&payload) {
                    eprintln!(
                        "[canvas-browser] tool-result NAV-SCHEME fallback used for {annotation_terminal_id} (primary IPC path did not deliver; len={})",
                        payload.len()
                    );
                    if let Some(store) = result_store.as_ref() {
                        store.set(&annotation_terminal_id, payload.clone());
                    }
                    return false;
                }
                let captured_at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                annotation_store.set(CanvasBrowserAnnotation {
                    terminal_id: annotation_terminal_id.clone(),
                    payload: payload.clone(),
                    url: nav_url.to_string(),
                    captured_at,
                });
                eprintln!(
                    "{}",
                    format_annotation_trace(
                        "nav-scheme",
                        &annotation_terminal_id,
                        annotation_trace_id(&payload).as_deref(),
                        "stored+event-emitted (no pty write on this path)",
                    )
                );
                let _ = annotation_app.emit(
                    CANVAS_BROWSER_ANNOTATION_EVENT,
                    serde_json::json!({
                        "terminalId": annotation_terminal_id,
                        "payload": payload,
                    }),
                );
                return false;
            }
            // Block page-initiated navigations (redirects, link clicks) that fall
            // outside this node's origin allowlist. Only http/https are policed;
            // other schemes are already rejected elsewhere. Open mode allows all.
            // Our own local-file serving (`http://127.0.0.1/__local/…`) is not
            // subject to origin policy, and its URL must never leak to the address
            // bar — the frontend keeps showing the `file://` display instead.
            if is_local_serve_url(&nav_url) {
                return true;
            }
            if matches!(nav_url.scheme(), "http" | "https") {
                if let Some(store) = policy_store.as_ref() {
                    let policy = store.get(&policy_terminal_id);
                    if !policy.allows(nav_url.as_str()) {
                        let _ = annotation_app.emit(
                            CANVAS_BROWSER_NAVIGATION_BLOCKED_EVENT,
                            serde_json::json!({
                                "terminalId": policy_terminal_id,
                                "url": nav_url.to_string(),
                            }),
                        );
                        return false;
                    }
                }
                // Allowed top-level navigation — mirror the destination to the
                // frontend so the address bar follows the page (link clicks,
                // redirects, cross-site jumps), not just app-initiated navigation.
                let _ = annotation_app.emit(
                    CANVAS_BROWSER_URL_CHANGED_EVENT,
                    serde_json::json!({
                        "terminalId": policy_terminal_id,
                        "url": nav_url.to_string(),
                    }),
                );
            }
            true
        });
    let add_child_result = window.add_child(
        builder,
        LogicalPosition::new(bounds.x, bounds.y),
        LogicalSize::new(bounds.width, bounds.height),
    );
    add_child_result.map_err(|e| AppError::Other(e.to_string()))?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_zoom(normalize_canvas_browser_zoom_factor(bounds.zoom_factor))
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(CanvasBrowserOpenResult {
        ok: true,
        node_id,
        url: url_string,
        reused: false,
    })
}

pub fn close_canvas_browser<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
) -> Result<(), AppError> {
    // Drop any local-file serve token this node registered so its allowed root is
    // no longer reachable once the node is gone.
    if let Some(store) = app.try_state::<LocalFileServeStore>() {
        store.remove(terminal_id);
    }
    if let Some(webview) = get_canvas_webview(app, terminal_id) {
        webview
            .close()
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    if let Some(store) = app.try_state::<CanvasBrowserAnnotationStore>() {
        store.remove(terminal_id);
    }
    if let Some(store) = app.try_state::<CanvasBrowserResultStore>() {
        store.remove(terminal_id);
    }
    // Drop per-terminal guardrail state so a long session of open/close cycles
    // doesn't accumulate entries. The frontend re-applies a node's persisted
    // policy / approval mode when it reopens, so this loses nothing durable.
    if let Some(policies) = app.try_state::<CanvasBrowserPolicyStore>() {
        policies.remove(terminal_id);
    }
    if let Some(modes) =
        app.try_state::<crate::canvas_browser_approval::CanvasBrowserApprovalModeStore>()
    {
        modes.remove(terminal_id);
    }
    Ok(())
}

/// Error for user-initiated actions against a WebView that no longer exists.
/// These must fail loud: a silent Ok leaves the node claiming "Live" over a
/// black pane, with a URL bar and reload button that appear to work.
fn browser_not_open_error() -> AppError {
    AppError::Other("Canvas browser is not open.".into())
}

pub fn navigate_canvas_browser<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    url_str: &str,
    allowed_root: Option<PathBuf>,
) -> Result<(), AppError> {
    let (url, _display) =
        resolve_canvas_navigation(app, terminal_id, url_str, allowed_root.as_deref())?;
    let Some(webview) = get_canvas_webview(app, terminal_id) else {
        return Err(browser_not_open_error());
    };
    webview
        .navigate(url)
        .map_err(|e| AppError::Other(e.to_string()))
}

pub fn sync_canvas_browser_bounds<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    bounds: CanvasBrowserBounds,
) -> Result<(), AppError> {
    if let Some(webview) = get_canvas_webview(app, terminal_id) {
        set_canvas_browser_bounds(&webview, bounds)?;
    }
    Ok(())
}

/// Read-only probe: does a live native child WebView exist for this node?
///
/// The React tree cannot see into an OS-level native surface, so a node can keep
/// claiming "active" over a black pane long after its WebView was torn down. The
/// frontend health check calls this on window focus / tab visibility regain to
/// detect that gap and self-heal by re-opening. Cheap and side-effect free — it
/// never mutates the WebView, so calling it speculatively is safe.
pub fn is_canvas_browser_open<R: Runtime>(app: &AppHandle<R>, terminal_id: &str) -> bool {
    get_canvas_webview(app, terminal_id).is_some()
}

/// Largest physical WebView dimension still considered "parked". PARKED_BOUNDS is
/// 1x1 logical (≤3px even on 3x retina); a live WebView is never smaller than
/// MIN_VISIBLE_SIZE (8px logical). This threshold cleanly separates the two.
const CANVAS_BROWSER_PARKED_SIZE_MAX_PX: u32 = 4;

/// A WebView collapsed to (or near) the off-screen park sentinel in either
/// dimension is parked, not showing a page.
fn is_parked_viewport_size(width: u32, height: u32) -> bool {
    width <= CANVAS_BROWSER_PARKED_SIZE_MAX_PX || height <= CANVAS_BROWSER_PARKED_SIZE_MAX_PX
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBrowserStatus {
    /// The native child WebView exists.
    pub open: bool,
    /// The WebView exists but sits at (or near) PARKED_BOUNDS — off-screen and
    /// ~1px. This is the recurrence black pane: a live "active" claim over a
    /// surface that was parked and never re-synced. `false` when not `open`.
    pub viewport_parked: bool,
}

/// Read-only status probe richer than {@link is_canvas_browser_open}: reports
/// both existence AND whether an existing WebView is parked off-screen. The
/// frontend health check uses this to tell the two black-pane classes apart —
/// absent (re-open) vs open-but-parked (re-push bounds). Side-effect free.
pub fn canvas_browser_status<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
) -> CanvasBrowserStatus {
    match get_canvas_webview(app, terminal_id) {
        None => CanvasBrowserStatus {
            open: false,
            viewport_parked: false,
        },
        Some(webview) => {
            // If the size can't be read, treat it as not-parked: a spurious
            // resync is cheap and self-correcting, but a false "parked" could
            // loop resyncs against a healthy view.
            let viewport_parked = webview
                .size()
                .map(|s| is_parked_viewport_size(s.width, s.height))
                .unwrap_or(false);
            CanvasBrowserStatus {
                open: true,
                viewport_parked,
            }
        }
    }
}

pub fn reload_canvas_browser<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_canvas_webview(app, terminal_id) else {
        return Err(browser_not_open_error());
    };
    webview.reload().map_err(|e| AppError::Other(e.to_string()))
}

/// Move the paired browser through its session history. `delta` is a step count
/// (-1 = back, +1 = forward), driven via `history.go` — the same fire-and-forget
/// eval path the codespace panes use. No-ops harmlessly at the ends of history.
pub fn history_canvas_browser<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    delta: i32,
) -> Result<(), AppError> {
    // Clamp to a single step in either direction: the URL bar only ever offers
    // one-step back/forward, and a large jump from a stale UI is never intended.
    let step = delta.clamp(-1, 1);
    if step == 0 {
        return Ok(());
    }
    let Some(webview) = get_canvas_webview(app, terminal_id) else {
        return Err(browser_not_open_error());
    };
    webview
        .eval(&format!("history.go({step});"))
        .map_err(|e| AppError::Other(e.to_string()))
}

pub fn start_canvas_browser_annotation_mode<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
) -> Result<(), AppError> {
    if let Some(webview) = get_canvas_webview(app, terminal_id) {
        let terminal_json = serde_json::to_string(terminal_id).unwrap_or_else(|_| "null".into());
        let script = crate::browser_preview::embedded_browser_annotation_script()
            .replace(
                "browser_preview_emit_annotation",
                "emit_canvas_browser_annotation",
            )
            .replace(
                "payload: JSON.stringify(payload),",
                &format!("terminalId: {terminal_json},\n      payload: JSON.stringify(payload),"),
            );
        webview
            .eval(&script)
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

pub fn stop_canvas_browser_annotation_mode<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
) -> Result<(), AppError> {
    if let Some(webview) = get_canvas_webview(app, terminal_id) {
        webview
            .eval("window.__codechatBrowserAnnotationOverlay?.destroy?.();")
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

pub fn capture_canvas_browser_snapshot<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    request_id: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_canvas_webview(app, terminal_id) else {
        return Err(AppError::Other("Canvas browser is not open.".into()));
    };
    webview
        .eval(&crate::canvas_browser_snapshot::snapshot_script(
            request_id,
            terminal_id,
        ))
        .map_err(|e| AppError::Other(e.to_string()))
}

pub fn capture_canvas_browser_search<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    request_id: &str,
    query: &str,
    max_results: usize,
) -> Result<(), AppError> {
    let Some(webview) = get_canvas_webview(app, terminal_id) else {
        return Err(AppError::Other("Canvas browser is not open.".into()));
    };
    webview
        .eval(&crate::canvas_browser_snapshot::search_script(
            request_id,
            query,
            max_results,
            terminal_id,
        ))
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Drain the in-page console/network/error collector (W3). The collector was installed at
/// document-start; this reads its ring buffer and exfiltrates on the shared channel.
pub fn capture_canvas_browser_logs<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    request_id: &str,
    kinds: &[String],
    since: Option<i64>,
) -> Result<(), AppError> {
    let Some(webview) = get_canvas_webview(app, terminal_id) else {
        return Err(AppError::Other("Canvas browser is not open.".into()));
    };
    webview
        .eval(&crate::canvas_browser_snapshot::logs_script(
            request_id,
            kinds,
            since,
            terminal_id,
        ))
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Inject an interaction action (click/type/fill_form/…) built from a validated
/// JSON action object. The result (ok/error + a fresh snapshot) is exfiltrated
/// on the same channel as snapshot/search and picked up by the polling handler.
pub fn capture_canvas_browser_action<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    request_id: &str,
    action: &serde_json::Value,
) -> Result<(), AppError> {
    let Some(webview) = get_canvas_webview(app, terminal_id) else {
        return Err(AppError::Other("Canvas browser is not open.".into()));
    };
    webview
        .eval(&crate::canvas_browser_snapshot::action_script(
            request_id,
            action,
            terminal_id,
        ))
        .map_err(|e| AppError::Other(e.to_string()))
}

/// Capture a full-viewport native screenshot (macOS `takeSnapshot`) for a Browser Node
/// annotation and persist it, returning the file path. Invoked from the MAIN app webview
/// after the annotation's TEXT context has already been delivered via the always-reliable
/// nav-scheme path — deliberately NOT triggered from inside the annotated (often
/// remote-origin) child webview, so it never depends on that webview's fragile IPC
/// capability grant. Best-effort: callers treat failure as "no screenshot this time,"
/// never as a reason to invalidate the text delivery that already succeeded.
pub async fn capture_canvas_browser_annotation_screenshot<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    crop_rect: Option<crate::canvas_browser_screenshot::CanvasBrowserScreenshotCropRect>,
) -> Result<String, AppError> {
    let full_png = crate::canvas_browser_screenshot::capture_canvas_browser_png(
        app,
        terminal_id,
        crate::canvas_browser_screenshot::resolve_screenshot_timeout(None),
    )
    .await?;
    // Crop to the selected region when a rect is supplied — self-calibrating from the
    // real PNG size vs the CSS viewport, so page zoom / Retina never skew it. A crop
    // failure (degenerate/edge rect) falls back to the full-viewport capture rather
    // than losing the screenshot entirely.
    let png = match &crop_rect {
        Some(rect) => crate::canvas_browser_screenshot::crop_png_to_region(&full_png, rect)
            .unwrap_or(full_png),
        None => full_png,
    };
    persist_canvas_browser_annotation_screenshot(terminal_id, &png)
}

/// Persist a native screenshot (full viewport, macOS `takeSnapshot`) captured for an
/// annotation submission. One file per call — never overwrites a prior capture, so an
/// agent that reads a path from an earlier submission doesn't race a newer one.
fn persist_canvas_browser_annotation_screenshot(
    terminal_id: &str,
    png: &[u8],
) -> Result<String, AppError> {
    let sanitized_terminal_id: String = terminal_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let dir = crate::paths::lotus_state_dir().join("canvas-annotation-screenshots");
    fs::create_dir_all(&dir).map_err(|err| {
        AppError::Other(format!("Failed to create annotation screenshot dir: {err}"))
    })?;
    let path: PathBuf = dir.join(format!(
        "{sanitized_terminal_id}-{}.png",
        uuid::Uuid::new_v4()
    ));
    fs::write(&path, png)
        .map_err(|err| AppError::Other(format!("Failed to write annotation screenshot: {err}")))?;
    Ok(path.to_string_lossy().into_owned())
}

fn sanitize_attachment_stem(name: &str) -> String {
    let stem = name
        .split(['/', '\\'])
        .next_back()
        .unwrap_or("browser-selection")
        .split('.')
        .next()
        .unwrap_or("browser-selection");
    let sanitized: String = stem
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "browser-selection".into()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn extension_for_data_url(content: &str, mime_type: Option<&str>) -> Option<&'static str> {
    let mime = mime_type.or_else(|| {
        content
            .strip_prefix("data:")?
            .split_once(';')
            .map(|(mime, _)| mime)
    })?;
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn persist_canvas_browser_visual_attachments(payload: &str) -> Result<Option<String>, AppError> {
    let mut value: serde_json::Value = serde_json::from_str(payload).map_err(|err| {
        AppError::Other(format!("Invalid canvas browser annotation payload: {err}"))
    })?;
    let Some(attachments) = value
        .get_mut("visualAttachments")
        .and_then(|raw| raw.as_array_mut())
    else {
        return Ok(None);
    };
    if attachments.is_empty()
        || !attachments.iter().any(|attachment| {
            attachment
                .get("content")
                .and_then(|raw| raw.as_str())
                .is_some_and(|content| content.starts_with("data:image/"))
        })
    {
        return Ok(None);
    }

    let temp_dir = std::env::temp_dir().join(format!(
        "{CANVAS_BROWSER_ATTACHMENT_TEMP_PREFIX}{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&temp_dir).map_err(|err| {
        AppError::Other(format!(
            "Failed to create canvas browser annotation temp dir: {err}"
        ))
    })?;

    for (index, attachment) in attachments.iter_mut().enumerate() {
        let Some(object) = attachment.as_object_mut() else {
            continue;
        };
        let Some(content) = object
            .get("content")
            .and_then(|raw| raw.as_str())
            .map(str::to_string)
        else {
            continue;
        };
        if !content.starts_with("data:image/") {
            continue;
        }
        let mime_type = object
            .get("mimeType")
            .and_then(|raw| raw.as_str())
            .map(str::to_string);
        let Some(extension) = extension_for_data_url(&content, mime_type.as_deref()) else {
            continue;
        };
        let Some((_, encoded)) = content.split_once(',') else {
            continue;
        };
        let decoded = BASE64.decode(encoded).map_err(|err| {
            AppError::Other(format!(
                "Failed to decode canvas browser annotation image: {err}"
            ))
        })?;
        if decoded.len() > 8 * 1024 * 1024 {
            return Err(AppError::Other(
                "Canvas browser annotation image is too large.".into(),
            ));
        }
        let name = object
            .get("name")
            .and_then(|raw| raw.as_str())
            .unwrap_or("browser-selection");
        let file_name = format!("{index}-{}.{}", sanitize_attachment_stem(name), extension);
        let path: PathBuf = temp_dir.join(file_name);
        fs::write(&path, decoded).map_err(|err| {
            AppError::Other(format!(
                "Failed to write canvas browser annotation image: {err}"
            ))
        })?;
        object.insert(
            "path".into(),
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        );
        object.remove("content");
        object.remove("previewUrl");
    }

    serde_json::to_string(&value).map(Some).map_err(|err| {
        AppError::Other(format!(
            "Failed to serialize canvas browser annotation payload: {err}"
        ))
    })
}

/// Extract the human annotation's own `id` field for cross-path trace correlation
/// (Slice 0 instrumentation). `None` for malformed JSON or payloads without an id.
fn annotation_trace_id(payload: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

/// Build a grep-friendly diagnostic line shared by every annotation delivery path
/// (nav-scheme, IPC, frontend-routing) so a live repro can be correlated by
/// `terminal=`/`id=` across the Rust dev terminal and the browser console.
fn format_annotation_trace(
    path: &str,
    terminal_id: &str,
    annotation_id: Option<&str>,
    detail: &str,
) -> String {
    format!(
        "[canvas-browser][annotation-trace] path={path} terminal={terminal_id} id={} detail={detail}",
        annotation_id.unwrap_or("-")
    )
}

/// Relay a frontend-formatted trace line (already shaped by the TS
/// `formatAnnotationTrace`) into this process's stderr, so `frontend-hook` and
/// `frontend-route` lines land in the same Rust dev terminal as the
/// `nav-scheme`/`ipc` lines above instead of only the WebView DevTools console.
pub fn log_canvas_browser_annotation_trace(line: &str) {
    eprintln!("{line}");
}

/// IPC command backend (slice I1): the injected snapshot/search/action script
/// calls this via `window.__TAURI_INTERNALS__.invoke` to deliver its result —
/// the primary, robust path that doesn't depend on cancelling a navigation.
/// Only accepts genuine tool-result payloads; anything else is ignored so this
/// capability-granted command can't be abused to spoof a human annotation.
pub fn emit_canvas_browser_tool_result<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    payload: String,
) -> Result<(), AppError> {
    if !is_tool_result_payload(&payload) {
        eprintln!(
            "[canvas-browser] tool-result IPC (primary) REJECTED non-tool payload for {terminal_id} (len={})",
            payload.len()
        );
        return Ok(());
    }
    if let Some(store) = app.try_state::<CanvasBrowserResultStore>() {
        eprintln!(
            "[canvas-browser] tool-result IPC (primary) delivered for {terminal_id} (len={})",
            payload.len()
        );
        store.set(terminal_id, payload);
    } else {
        eprintln!(
            "[canvas-browser] tool-result IPC (primary): result store MISSING for {terminal_id}"
        );
    }
    Ok(())
}

pub fn emit_canvas_browser_annotation<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    payload: String,
) -> Result<(), AppError> {
    // Entry trace BEFORE any early return: without this, an IPC invoke that
    // reaches Rust but fails the webview/persist checks below is silent —
    // indistinguishable from the child WebView's invoke() never firing at all.
    eprintln!(
        "{}",
        format_annotation_trace(
            "ipc",
            terminal_id,
            annotation_trace_id(&payload).as_deref(),
            "invoked"
        )
    );
    if get_canvas_webview(app, terminal_id).is_none() {
        eprintln!(
            "{}",
            format_annotation_trace(
                "ipc",
                terminal_id,
                annotation_trace_id(&payload).as_deref(),
                "failed:webview-not-open",
            )
        );
        return Err(AppError::Other("Canvas browser is not open.".into()));
    }
    let payload = match persist_canvas_browser_visual_attachments(&payload) {
        Ok(rewritten) => rewritten.unwrap_or(payload),
        Err(err) => {
            eprintln!(
                "{}",
                format_annotation_trace(
                    "ipc",
                    terminal_id,
                    annotation_trace_id(&payload).as_deref(),
                    &format!("failed:attachment-persist({err})"),
                )
            );
            return Err(err);
        }
    };
    if let Some(store) = app.try_state::<CanvasBrowserAnnotationStore>() {
        store.set(CanvasBrowserAnnotation {
            terminal_id: terminal_id.to_string(),
            payload: payload.clone(),
            url: String::new(),
            captured_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        });
    }
    // The frontend writes the short <pick> prompt to the paired terminal; this path only stores.
    eprintln!(
        "{}",
        format_annotation_trace(
            "ipc",
            terminal_id,
            annotation_trace_id(&payload).as_deref(),
            "stored+event-emitted",
        )
    );

    app.emit(
        CANVAS_BROWSER_ANNOTATION_EVENT,
        serde_json::json!({
            "terminalId": terminal_id,
            "payload": payload,
            "source": "native",
        }),
    )
    .map_err(|err| AppError::Other(err.to_string()))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_store_set_get_remove() {
        let store = CanvasBrowserResultStore::default();
        assert!(store.get("t").is_none());
        store.set("t", r#"{"action":"snapshot","requestId":"r1"}"#.into());
        assert!(store.get("t").unwrap().contains("snapshot"));
        store.remove("t");
        assert!(store.get("t").is_none());
    }

    #[test]
    fn tool_result_payloads_are_distinguished_from_human_annotations() {
        assert!(is_tool_result_payload(
            r#"{"action":"snapshot","requestId":"r"}"#
        ));
        assert!(is_tool_result_payload(
            r#"{"action":"search","requestId":"r"}"#
        ));
        assert!(is_tool_result_payload(
            r#"{"action":"action-result","requestId":"r"}"#
        ));
        // Human annotation selections and malformed payloads are NOT tool results.
        assert!(!is_tool_result_payload(
            r#"{"action":"selected","label":"hero"}"#
        ));
        assert!(!is_tool_result_payload(r#"{"action":"error"}"#));
        assert!(!is_tool_result_payload("not json"));
    }

    #[test]
    fn browser_title_payload_is_distinguished_and_trimmed() {
        assert_eq!(
            parse_canvas_browser_title_payload(
                r#"{"action":"canvas-browser-title","title":"  Ghibli Grove  "}"#
            )
            .as_deref(),
            Some("Ghibli Grove")
        );
        assert!(parse_canvas_browser_title_payload(
            r#"{"action":"selected","title":"Not a title event"}"#
        )
        .is_none());
        assert!(parse_canvas_browser_title_payload(
            r#"{"action":"canvas-browser-title","title":"   "}"#
        )
        .is_none());
    }

    #[test]
    fn browser_title_script_posts_on_load_and_title_changes() {
        let script = canvas_browser_title_script();
        assert!(script.contains("codechat-browser-annotation://selected?payload="));
        assert!(script.contains("canvas-browser-title"));
        assert!(script.contains("document.title"));
        assert!(script.contains("DOMContentLoaded"));
        assert!(script.contains("window.addEventListener(\"load\""));
        assert!(script.contains("MutationObserver"));

        let path = std::env::temp_dir().join("canvas-browser-title-script-check.js");
        fs::write(&path, script).unwrap();
        let output = std::process::Command::new("node")
            .arg("--check")
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "title script failed JavaScript syntax check:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn annotation_store_set_and_get() {
        let store = CanvasBrowserAnnotationStore::default();
        store.set(CanvasBrowserAnnotation {
            terminal_id: "node-term-1".into(),
            payload: r#"{"action":"selected","label":"hero"}"#.into(),
            url: "http://localhost:3000".into(),
            captured_at: 1000,
        });
        let got = store.get("node-term-1").expect("should find entry");
        assert!(got.payload.contains("selected"));
        assert_eq!(got.url, "http://localhost:3000");
    }

    #[test]
    fn annotation_store_latest_wins() {
        let store = CanvasBrowserAnnotationStore::default();
        store.set(CanvasBrowserAnnotation {
            terminal_id: "t1".into(),
            payload: r#"{"action":"selected","label":"old"}"#.into(),
            url: "http://a.com".into(),
            captured_at: 1,
        });
        store.set(CanvasBrowserAnnotation {
            terminal_id: "t1".into(),
            payload: r#"{"action":"selected","label":"new"}"#.into(),
            url: "http://b.com".into(),
            captured_at: 2,
        });
        assert!(store.get("t1").unwrap().payload.contains("new"));
    }

    #[test]
    fn annotation_store_returns_none_for_unknown_terminal() {
        let store = CanvasBrowserAnnotationStore::default();
        assert!(store.get("no-such-terminal").is_none());
    }

    #[test]
    fn annotation_store_remove_clears_entry() {
        let store = CanvasBrowserAnnotationStore::default();
        store.set(CanvasBrowserAnnotation {
            terminal_id: "t2".into(),
            payload: r#"{"action":"cancel"}"#.into(),
            url: "http://x.com".into(),
            captured_at: 0,
        });
        store.remove("t2");
        assert!(store.get("t2").is_none());
    }

    // Verify-first instrumentation (Slice 0): a diagnostic trace id extracted from
    // the human annotation's own payload, so a live repro can correlate the same
    // selection across the nav-scheme, IPC, and frontend-routing delivery paths.
    #[test]
    fn annotation_trace_id_extracts_the_payload_id() {
        let payload = r#"{"action":"selected","id":"browser-abc123","label":"hero"}"#;
        assert_eq!(
            annotation_trace_id(payload).as_deref(),
            Some("browser-abc123")
        );
    }

    #[test]
    fn annotation_trace_id_is_none_for_malformed_or_missing_id() {
        assert_eq!(annotation_trace_id("not json"), None);
        assert_eq!(annotation_trace_id(r#"{"action":"selected"}"#), None);
    }

    #[test]
    fn annotation_trace_line_has_a_consistent_grep_friendly_shape() {
        let line = format_annotation_trace("ipc", "term-1", Some("browser-abc123"), "pty=sent");
        assert_eq!(
            line,
            "[canvas-browser][annotation-trace] path=ipc terminal=term-1 id=browser-abc123 detail=pty=sent"
        );
    }

    #[test]
    fn annotation_trace_line_falls_back_to_dash_for_unknown_id() {
        let line = format_annotation_trace("nav-scheme", "term-1", None, "stored+event-only");
        assert_eq!(
            line,
            "[canvas-browser][annotation-trace] path=nav-scheme terminal=term-1 id=- detail=stored+event-only"
        );
    }

    // A navigate/reload/history against a missing WebView must FAIL, not silently
    // succeed: the silent Ok left nodes claiming "Live" over a black pane with a
    // URL bar that appeared to work. The frontend recovers only if it hears the
    // truth (it re-opens or shows the recovery overlay on error).
    #[test]
    fn navigate_without_webview_is_an_error() {
        let app = tauri::test::mock_app();
        let err =
            navigate_canvas_browser(app.handle(), "no-such-node", "https://example.com", None)
                .expect_err("navigate on a missing webview must fail loud");
        assert!(err.to_string().contains("not open"));
    }

    #[test]
    fn navigate_file_url_registers_serve_token_under_allowed_root() {
        let app = tauri::test::mock_app();
        let store = crate::canvas_browser_local_files::LocalFileServeStore::with_port(9999);
        app.manage(store.clone());
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("index.html");
        std::fs::write(&file, b"<h1>hi</h1>").expect("write");
        let file_url = tauri::Url::from_file_path(&file)
            .expect("file url")
            .to_string();

        // No webview exists so navigate ultimately errors, but confinement +
        // token registration run first — that side effect is what we assert.
        let _ = navigate_canvas_browser(
            app.handle(),
            "node-1",
            &file_url,
            Some(dir.path().to_path_buf()),
        );

        assert!(
            store.root_for("node-1").is_some(),
            "a file:// navigation registers a serve token for the node"
        );
    }

    #[test]
    fn navigate_file_url_without_allowed_root_is_rejected() {
        let app = tauri::test::mock_app();
        let store = crate::canvas_browser_local_files::LocalFileServeStore::with_port(9999);
        app.manage(store);

        let err = navigate_canvas_browser(app.handle(), "node-2", "file:///etc/hosts", None)
            .expect_err("file:// without an allowed root must be rejected");
        assert!(err.to_string().to_lowercase().contains("allowed folder"));
    }

    #[test]
    fn reload_without_webview_is_an_error() {
        let app = tauri::test::mock_app();
        let err = reload_canvas_browser(app.handle(), "no-such-node")
            .expect_err("reload on a missing webview must fail loud");
        assert!(err.to_string().contains("not open"));
    }

    #[test]
    fn history_without_webview_is_an_error() {
        let app = tauri::test::mock_app();
        let err = history_canvas_browser(app.handle(), "no-such-node", -1)
            .expect_err("history on a missing webview must fail loud");
        assert!(err.to_string().contains("not open"));
    }

    #[test]
    fn history_zero_delta_stays_a_noop_even_without_webview() {
        // delta 0 never touches the webview — keep it a no-op so a stale UI
        // sending a zero step cannot produce a spurious recovery overlay.
        let app = tauri::test::mock_app();
        assert!(history_canvas_browser(app.handle(), "no-such-node", 0).is_ok());
    }

    #[test]
    fn bounds_sync_without_webview_stays_lenient() {
        // The bounds loop races teardown by design (park/close vs. rAF sync);
        // erroring here would put the frontend park-retry into a spin.
        let app = tauri::test::mock_app();
        let bounds = CanvasBrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
            zoom_factor: None,
        };
        assert!(sync_canvas_browser_bounds(app.handle(), "no-such-node", bounds).is_ok());
    }

    #[test]
    fn is_open_reports_false_for_a_missing_webview() {
        // The self-heal probe must report absence honestly so the frontend can
        // re-open, rather than the silent-Ok that stranded nodes on a black pane.
        let app = tauri::test::mock_app();
        assert!(!is_canvas_browser_open(app.handle(), "no-such-node"));
    }

    #[test]
    fn status_reports_closed_and_unparked_for_a_missing_webview() {
        // A node with no native WebView is "not open"; parked-ness is meaningless
        // (there is no surface to be parked), so it must not be reported as parked
        // — that would make the frontend resync bounds onto nothing instead of
        // re-opening.
        let app = tauri::test::mock_app();
        let status = canvas_browser_status(app.handle(), "no-such-node");
        assert!(!status.open);
        assert!(!status.viewport_parked);
    }

    #[test]
    fn parked_viewport_size_detects_the_off_screen_park_sentinel() {
        // PARKED_BOUNDS is 1x1 logical (≤4px physical even on 3x retina); a live
        // WebView is never smaller than MIN_VISIBLE_SIZE (8px logical). Either
        // dimension collapsing to the sentinel means the surface is parked.
        assert!(is_parked_viewport_size(1, 1));
        assert!(is_parked_viewport_size(2, 2)); // 1px logical @ 2x
        assert!(is_parked_viewport_size(1280, 3)); // height collapsed
        assert!(is_parked_viewport_size(3, 720)); // width collapsed
                                                  // Real viewports are never this small.
        assert!(!is_parked_viewport_size(8, 8));
        assert!(!is_parked_viewport_size(1280, 720));
    }

    #[test]
    fn browser_webview_label_sanitizes_special_chars() {
        assert_eq!(
            browser_webview_label("node/abc:123"),
            "canvas-browser-node-abc-123"
        );
    }

    #[test]
    fn browser_webview_label_preserves_alphanumeric_and_dash() {
        assert_eq!(
            browser_webview_label("node-abc_123"),
            "canvas-browser-node-abc_123"
        );
    }

    #[test]
    fn validate_browser_url_accepts_localhost() {
        let url = validate_browser_url("localhost:3000").expect("valid");
        assert_eq!(url, "http://localhost:3000/");
    }

    #[test]
    fn validate_browser_url_rejects_javascript_scheme() {
        assert!(validate_browser_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn canvas_browser_zoom_factor_defaults_to_actual_size() {
        assert_eq!(normalize_canvas_browser_zoom_factor(None), 1.0);
        assert_eq!(normalize_canvas_browser_zoom_factor(Some(f64::NAN)), 1.0);
    }

    #[test]
    fn canvas_browser_zoom_factor_is_clamped_to_supported_range() {
        assert_eq!(normalize_canvas_browser_zoom_factor(Some(0.1)), 0.35);
        assert_eq!(normalize_canvas_browser_zoom_factor(Some(1.5)), 1.25);
        assert_eq!(normalize_canvas_browser_zoom_factor(Some(0.75)), 0.75);
    }

    #[test]
    fn persists_annotation_screenshot_png_to_a_unique_file() {
        let png = b"not a real png but bytes are all persist_canvas_browser_annotation_screenshot cares about";
        let path_str = persist_canvas_browser_annotation_screenshot("term/weird:id", png)
            .expect("persist succeeds");
        let path = std::path::Path::new(&path_str);
        assert!(path.exists());
        assert_eq!(std::fs::read(path).expect("read screenshot"), png);
        assert!(path_str.contains("term-weird-id"));
        assert!(path_str.ends_with(".png"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn persists_annotation_screenshot_under_a_distinct_path_per_call() {
        let png = b"png bytes";
        let first =
            persist_canvas_browser_annotation_screenshot("term-1", png).expect("persist succeeds");
        let second =
            persist_canvas_browser_annotation_screenshot("term-1", png).expect("persist succeeds");
        assert_ne!(
            first, second,
            "each capture must get its own file, never overwrite a prior one"
        );
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }

    #[test]
    fn persists_visual_attachment_data_urls_as_temp_paths() {
        let payload = r#"{
            "action":"selected",
            "id":"a1",
            "visualAttachments":[{
                "name":"google logo.png",
                "mimeType":"image/png",
                "content":"data:image/png;base64,aGVsbG8=",
                "previewUrl":"data:image/png;base64,aGVsbG8="
            }]
        }"#;

        let next = persist_canvas_browser_visual_attachments(payload)
            .expect("persist succeeds")
            .expect("payload with content emits");
        let value: serde_json::Value = serde_json::from_str(&next).expect("json");
        let attachment = &value["visualAttachments"][0];
        let path = attachment["path"].as_str().expect("path");
        assert!(path.contains(CANVAS_BROWSER_ATTACHMENT_TEMP_PREFIX));
        assert_eq!(std::fs::read(path).expect("read image"), b"hello");
        assert!(attachment.get("content").is_none());
        assert!(attachment.get("previewUrl").is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn metadata_only_visual_attachment_does_not_emit_full_payload() {
        let payload = r#"{"action":"selected","id":"a1","visualAttachments":[{"name":"google.png","mimeType":"image/png"}]}"#;
        assert!(persist_canvas_browser_visual_attachments(payload)
            .expect("parse")
            .is_none());
    }

    /// A page loaded inside a Canvas browser node must be able to deliver
    /// snapshot/annotation tool results via the primary IPC path whether it is a
    /// remote site OR a local dev server (localhost). `local: false` silently
    /// denied every localhost page, forcing the slower nav-scheme fallback. The
    /// capability stays scoped to `canvas-browser-*` child webviews (never the
    /// main app), so granting local content the two emit commands is safe.
    #[test]
    fn canvas_browser_annotation_capability_covers_local_and_remote_pages() {
        let capability = include_str!("../capabilities/canvas-browser-annotation.json");
        let value: serde_json::Value =
            serde_json::from_str(capability).expect("capability is valid JSON");

        assert_eq!(
            value["local"], serde_json::Value::Bool(true),
            "local dev-server pages (localhost) must be granted the emit commands, not just remote sites"
        );
        // Never widen beyond the child browser webviews.
        assert_eq!(value["webviews"], serde_json::json!(["canvas-browser-*"]));
        let permissions = value["permissions"].as_array().expect("permissions array");
        assert!(permissions
            .iter()
            .any(|p| p == "allow-emit-canvas-browser-tool-result"));
    }

    /// Every canvas-browser command registered for the main app WebView must also
    /// be listed in the main-app permission allowlist — otherwise the invoke is
    /// silently denied at runtime. `is_canvas_browser_open` shipped without its
    /// allowlist entry, which left the black-pane self-heal probe permanently
    /// dead in production. This guards against that class of drift for the whole
    /// command family, not just one name.
    #[test]
    fn canvas_browser_commands_are_allowlisted_for_main_app_webviews() {
        // Scoped to child browser WebViews via a separate capability, never the
        // main app — see canvas-browser-annotation.json.
        const CHILD_WEBVIEW_ONLY: &[&str] = &["emit_canvas_browser_tool_result"];

        let handler_src = include_str!("lib.rs");
        let allowlist = include_str!("../permissions/main-app-commands.toml");

        let registered: Vec<&str> = handler_src
            .lines()
            .filter_map(|line| line.trim().strip_prefix("commands::"))
            .map(|rest| rest.trim_end_matches(','))
            .filter(|name| name.contains("canvas_browser"))
            .filter(|name| !CHILD_WEBVIEW_ONLY.contains(name))
            .collect();

        // Sanity: the scan actually found the command family (guards against a
        // future refactor silently emptying this test).
        assert!(
            registered.contains(&"is_canvas_browser_open"),
            "scan should find is_canvas_browser_open in the generate_handler! block"
        );

        for command in registered {
            assert!(
                allowlist.contains(&format!("\"{command}\"")),
                "{command} is registered as a Tauri command but missing from \
                 allow-main-app-commands — the invoke will be silently denied"
            );
        }
    }
}
