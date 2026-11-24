//! The browser behind the new chat's Preview, CodeChat's inspector and Canvas annotation: an
//! embedded webview per slot, the annotation overlay, and capture. Moved out of CodeChat (07i).
//! Webview labels, the annotation event and its URL scheme keep their `codechat-*` strings, which
//! capabilities and injected scripts match.
use crate::AppError;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview,
    WebviewBuilder, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
};

pub const BROWSER_PREVIEW_WINDOW_LABEL: &str = "codechat-browser-preview";
pub const BROWSER_PREVIEW_EMBED_LABEL_PREFIX: &str = "codechat-browser-preview-embed";

/// Preview's own cookie and storage jar, apart from the app's default one that the agent-driven
/// Canvas Browser uses: a login made in Preview is not handed to an agent. One jar for every
/// Preview, so a login is made once. Fixed forever: a new value logs everyone out.
/// macOS 14+ only; wry falls back to the default jar on older macOS, Windows and Linux.
pub const BROWSER_PREVIEW_DATA_STORE: [u8; 16] = [
    0xB3, 0x9D, 0xAE, 0x22, 0xA7, 0x34, 0x42, 0x3B, 0xA1, 0xEC, 0x86, 0x78, 0x0F, 0x51, 0x7D, 0xE8,
];
pub const BROWSER_ANNOTATION_EVENT: &str = "codechat-browser-annotation";
/// A Preview page started or finished loading: `{ label, phase: "started" | "finished" }`.
/// WebKit's failures never reach wry, so the frontend reads a load that never finishes as stalled.
pub const BROWSER_PREVIEW_LOAD_EVENT: &str = "browser-preview-load";
pub(crate) const BROWSER_ANNOTATION_SCHEME: &str = "codechat-browser-annotation";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPreview {
    pub label: String,
    pub url: String,
    pub reused: bool,
    /// False while a local dev server is not listening yet: nothing was loaded, ask again later.
    pub reachable: bool,
}

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPreviewBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn normalize_browser_preview_url(value: &str) -> Result<Url, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other(
            "Browser preview URL is required.".to_string(),
        ));
    }

    if let Some((scheme, _)) = trimmed.split_once(':') {
        if is_url_scheme(scheme)
            && !scheme.contains('.')
            && !is_loopback_without_scheme(trimmed)
            && scheme != "http"
            && scheme != "https"
        {
            return Err(AppError::Other(format!(
                "Unsupported browser preview URL scheme: {scheme}"
            )));
        }
    }

    let candidate = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else if is_loopback_without_scheme(trimmed) {
        format!("http://{trimmed}")
    } else {
        format!("https://{trimmed}")
    };

    let url = Url::parse(&candidate)
        .map_err(|err| AppError::Other(format!("Invalid browser preview URL: {err}")))?;

    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(AppError::Other(format!(
            "Unsupported browser preview URL scheme: {scheme}"
        ))),
    }
}

pub fn embedded_browser_preview_label(window_label: &str) -> String {
    format!(
        "{BROWSER_PREVIEW_EMBED_LABEL_PREFIX}-{}",
        sanitize_label(window_label)
    )
}

/// One browser per window, or with `slot` one per slot in it (the Chat stage keeps one per chat).
pub fn embedded_browser_preview_slot_label(window_label: &str, slot: Option<&str>) -> String {
    let base = embedded_browser_preview_label(window_label);
    match slot {
        Some(slot) => format!("{base}--{}", sanitize_label(slot)),
        None => base,
    }
}

fn sanitize_label(value: &str) -> String {
    value
        .chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '-' || char == '_' {
                char
            } else {
                '-'
            }
        })
        .collect()
}

/// A `file://` page: WKWebView can't load it with its relative assets, so it goes through the
/// localhost serve route the Canvas Browser uses, confined to `root` (the chat's folder). The
/// address bar keeps the `file://` URL. The token is the preview's label, removed on close.
fn serve_local_file<R: Runtime>(
    app: &AppHandle<R>,
    token: &str,
    value: &str,
    root: Option<&str>,
) -> Result<(Url, String), AppError> {
    use crate::canvas_browser_local_files::{map_local_file_url, LocalFileServeStore};
    let root =
        root.ok_or_else(|| AppError::Other("Local files need a folder to open from.".into()))?;
    let store = app
        .try_state::<LocalFileServeStore>()
        .ok_or_else(|| AppError::Other("Local file serving is unavailable.".into()))?;
    let served = map_local_file_url(value, std::path::Path::new(root), token, store.port())?;
    store.register(token, std::path::PathBuf::from(root));
    Ok((served.serve, served.display))
}

/// Grants pages the pointer lock WKWebView refuses (a game's mouse look). See the script's header.
const POINTER_LOCK_SCRIPT: &str = include_str!("browser_preview_pointer_lock.js");
const POINTER_LOCK_SCHEME: &str = "lotus-preview-lock";

/// `lotus-preview-lock://on` → lock, `…://off` → release; any other address is not a lock request.
pub(crate) fn pointer_lock_request(url: &Url) -> Option<bool> {
    if url.scheme() != POINTER_LOCK_SCHEME {
        return None;
    }
    match url.host_str() {
        Some("on") => Some(true),
        Some("off") => Some(false),
        _ => None,
    }
}

/// Freezes the system cursor in place while mouse deltas still reach the page (what Safari does for a
/// real pointer lock), or lets it go. Releasing is always safe, so every exit path calls it.
fn set_pointer_lock<R: Runtime>(window: &Window<R>, on: bool) {
    if let Err(err) = window.set_cursor_grab(on) {
        eprintln!("[Preview] pointer lock {on}: {err}");
    }
}

pub fn open_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
    value: &str,
    bounds: BrowserPreviewBounds,
    root: Option<&str>,
) -> Result<BrowserPreview, AppError> {
    validate_browser_preview_bounds(bounds)?;
    let label = embedded_browser_preview_slot_label(window.label(), slot);
    let (url, url_string) = if crate::canvas_browser_local_files::is_file_url(value) {
        serve_local_file(app, &label, value, root)?
    } else {
        // Whether a local server listens yet is asked first, off the main thread
        // (`browser_preview_reachable`): this command runs on it, and that probe blocks.
        let url = normalize_browser_preview_url(value)?;
        let display = url.to_string();
        (url, display)
    };

    if let Some(webview) = app.get_webview(&label) {
        navigate_existing_embedded_browser_preview(&webview, url, bounds)?;
        unpark_embedded_browser_preview(&webview)?;
        return Ok(BrowserPreview {
            label,
            url: url_string,
            reused: true,
            reachable: true,
        });
    }

    let annotation_app = app.clone();
    let annotation_window_label = window.label().to_string();
    let lock_window = window.clone();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url.clone()))
        .data_store_identifier(BROWSER_PREVIEW_DATA_STORE)
        .initialization_script(POINTER_LOCK_SCRIPT)
        // `Started` is WebKit's commit: from then on the page has an address Reload can repeat.
        .on_page_load(|webview, payload| {
            let started = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            let picking = {
                let mut placed = placed_previews();
                let slot = placed.get_mut(webview.label());
                match slot {
                    Some(slot) if started => {
                        slot.committed = true;
                        false
                    }
                    Some(slot) => slot.picking,
                    None => false,
                }
            };
            // A new document dropped the pick overlay: put it back while picking.
            if picking {
                let _ = webview.eval(embedded_browser_annotation_script());
            }
            let _ = webview.emit_to(
                webview.window().label(),
                BROWSER_PREVIEW_LOAD_EVENT,
                serde_json::json!({ "label": webview.label(), "phase": if started { "started" } else { "finished" }, "url": payload.url().as_str() }),
            );
        })
        .on_navigation(move |url| {
            if let Some(on) = pointer_lock_request(url) {
                set_pointer_lock(&lock_window, on);
                return false;
            }
            if let Some(payload) = parse_annotation_navigation_payload(url) {
                let _ = annotation_app.emit_to(
                    &annotation_window_label,
                    BROWSER_ANNOTATION_EVENT,
                    payload,
                );
                return false;
            }

            true
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|err| AppError::Other(err.to_string()))?;
    placed_previews().insert(label.clone(), Placed { bounds, parked: false, url: Some(url), committed: false, picking: false });

    Ok(BrowserPreview {
        label,
        url: url_string,
        reused: false,
        reachable: true,
    })
}

pub fn sync_embedded_browser_preview_bounds<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
    bounds: BrowserPreviewBounds,
) -> Result<(), AppError> {
    validate_browser_preview_bounds(bounds)?;
    let label = embedded_browser_preview_slot_label(window.label(), slot);
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };

    set_embedded_browser_preview_bounds(&webview, bounds)
}

pub fn reload_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
) -> Result<(), AppError> {
    let Some(webview) = get_embedded_browser_preview(app, window, slot) else {
        return Ok(());
    };
    // A first load that failed left no page: WebKit's reload is then a no-op, so load it again.
    let unloaded = placed_previews()
        .get(webview.label())
        .filter(|slot| !slot.committed)
        .and_then(|slot| slot.url.clone());
    match unloaded {
        Some(url) => webview.navigate(url),
        None => webview.reload(),
    }
    .map_err(|err| AppError::Other(err.to_string()))
}

pub fn go_back_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
) -> Result<(), AppError> {
    eval_embedded_browser_preview(app, window, slot, "history.back();")
}

pub fn go_forward_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
) -> Result<(), AppError> {
    eval_embedded_browser_preview(app, window, slot, "history.forward();")
}

pub fn start_embedded_browser_annotation_mode<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
) -> Result<(), AppError> {
    let Some(webview) = get_embedded_browser_preview(app, window, slot) else {
        return Ok(());
    };
    set_picking(webview.label(), true);

    webview
        .eval(embedded_browser_annotation_script())
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn emit_embedded_browser_annotation<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    webview: &Webview<R>,
    payload: String,
) -> Result<(), AppError> {
    let expected_label = embedded_browser_preview_label(window.label());
    let label = webview.label();
    if label != expected_label && !label.starts_with(&format!("{expected_label}--")) {
        return Err(AppError::Other(
            "Browser annotation events are only accepted from the embedded browser preview."
                .to_string(),
        ));
    }

    app.emit_to(window.label(), BROWSER_ANNOTATION_EVENT, payload)
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn stop_embedded_browser_annotation_mode<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
) -> Result<(), AppError> {
    set_picking(&embedded_browser_preview_slot_label(window.label(), slot), false);
    eval_embedded_browser_preview(
        app,
        window,
        slot,
        "window.__codechatBrowserAnnotationOverlay?.destroy?.();",
    )
}

/// Hides a browser without unloading it, so a Lotus popup can draw where it was.
pub fn set_embedded_browser_preview_visible<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
    visible: bool,
) -> Result<(), AppError> {
    let Some(webview) = get_embedded_browser_preview(app, window, slot) else {
        return Ok(());
    };
    // A hidden page can no longer release a lock it holds.
    if !visible {
        set_pointer_lock(window, false);
    }

    if visible { unpark_embedded_browser_preview(&webview) } else { park_embedded_browser_preview(&webview) }
}

/// A chat Preview browser as a PNG data URL: the element a pick names when `crop` is given
/// (falling back to the whole page if the crop is empty), or the whole page as a still frame.
pub async fn capture_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
    crop: Option<crate::canvas_browser_screenshot::CanvasBrowserScreenshotCropRect>,
) -> Result<String, AppError> {
    use base64::Engine;

    let webview = get_embedded_browser_preview(app, window, slot)
        .ok_or_else(|| AppError::Other("The preview browser is not open.".into()))?;
    let png = crate::canvas_browser_screenshot::capture_webview_png(
        &webview,
        crate::canvas_browser_screenshot::resolve_screenshot_timeout(None),
    )
    .await?;
    let png = match &crop {
        Some(rect) => crate::canvas_browser_screenshot::crop_png_to_region(&png, rect).unwrap_or(png),
        None => png,
    };
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}

pub fn close_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
) -> Result<(), AppError> {
    // Its folder stops being served once the preview is gone.
    if let Some(store) = app.try_state::<crate::canvas_browser_local_files::LocalFileServeStore>() {
        store.remove(&embedded_browser_preview_slot_label(window.label(), slot));
    }
    set_pointer_lock(window, false);
    placed_previews().remove(&embedded_browser_preview_slot_label(window.label(), slot));
    let Some(webview) = get_embedded_browser_preview(app, window, slot) else {
        return Ok(());
    };

    webview
        .close()
        .map_err(|err| AppError::Other(err.to_string()))
}

fn eval_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
    script: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_embedded_browser_preview(app, window, slot) else {
        return Ok(());
    };

    webview
        .eval(script)
        .map_err(|err| AppError::Other(err.to_string()))
}

fn get_embedded_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    slot: Option<&str>,
) -> Option<Webview<R>> {
    let label = embedded_browser_preview_slot_label(window.label(), slot);
    app.get_webview(&label)
}

pub fn open_browser_preview<R: Runtime>(
    app: &AppHandle<R>,
    value: &str,
) -> Result<BrowserPreview, AppError> {
    let url = normalize_browser_preview_url(value)?;
    let url_string = url.to_string();

    if let Some(window) = app.get_webview_window(BROWSER_PREVIEW_WINDOW_LABEL) {
        navigate_existing_browser_preview(&window, url)?;
        return Ok(BrowserPreview {
            label: BROWSER_PREVIEW_WINDOW_LABEL.to_string(),
            url: url_string,
            reused: true,
            reachable: true,
        });
    }

    WebviewWindowBuilder::new(
        app,
        BROWSER_PREVIEW_WINDOW_LABEL,
        WebviewUrl::External(url),
    )
    .title("Browser Preview")
    .data_store_identifier(BROWSER_PREVIEW_DATA_STORE)
    .inner_size(1200.0, 820.0)
    .min_inner_size(720.0, 480.0)
    .build()
    .map_err(|err| AppError::Other(err.to_string()))?;

    Ok(BrowserPreview {
        label: BROWSER_PREVIEW_WINDOW_LABEL.to_string(),
        url: url_string,
        reused: false,
        reachable: true,
    })
}

fn navigate_existing_embedded_browser_preview<R: Runtime>(
    webview: &Webview<R>,
    url: Url,
    bounds: BrowserPreviewBounds,
) -> Result<(), AppError> {
    if let Some(slot) = placed_previews().get_mut(webview.label()) {
        slot.url = Some(url.clone());
        slot.committed = false;
    }
    webview
        .navigate(url)
        .map_err(|err| AppError::Other(err.to_string()))?;
    set_embedded_browser_preview_bounds(webview, bounds)
}

fn set_embedded_browser_preview_bounds<R: Runtime>(
    webview: &Webview<R>,
    bounds: BrowserPreviewBounds,
) -> Result<(), AppError> {
    let parked = {
        let mut placed = placed_previews();
        let slot = placed.entry(webview.label().to_string()).or_insert(Placed { bounds, parked: false, url: None, committed: true, picking: false });
        slot.bounds = bounds;
        slot.parked
    };
    // A hidden browser keeps its place off-window; it takes these bounds when shown again.
    if parked {
        return Ok(());
    }
    apply_embedded_browser_preview_bounds(webview, bounds)
}

fn apply_embedded_browser_preview_bounds<R: Runtime>(
    webview: &Webview<R>,
    bounds: BrowserPreviewBounds,
) -> Result<(), AppError> {
    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
            size: tauri::Size::Logical(LogicalSize::new(bounds.width, bounds.height)),
        })
        .map_err(|err| AppError::Other(err.to_string()))
}

/// Where each embedded browser belongs, and whether it is parked off-window while hidden.
/// A hidden WKWebView (`setHidden`) still takes file drags on macOS: a chat's hidden Preview
/// swallowed every image dragged over its old box (2026-11-03, `[DEBUG-drop]` trace), so hiding
/// also moves it out of the window.
#[derive(Debug, Clone)]
struct Placed {
    bounds: BrowserPreviewBounds,
    parked: bool,
    /// The address last asked for, and whether a page from it has committed yet.
    url: Option<Url>,
    committed: bool,
    /// The pick overlay is on: it goes back on each new document.
    picking: bool,
}

/// Whether a Preview may load `value` now. A dev server still starting fails a load for good
/// (2026-11-11, -1004 in the unified log, then a blank page Reload could not bring back), so the
/// Preview waits for it instead. Async: the probe blocks up to 250 ms per address, and a sync
/// command would hold the main thread, freezing the whole window, once a second while it waits.
/// Whether a Preview can load `value` now: `"ok"`, `"refused"` (a local port nothing listens on
/// yet) or `"unknown-host"` (a name DNS does not know). WebKit reports neither of the last two to
/// wry, so without this the panel only says "Not loading" after `STALL_MS`.
pub async fn browser_preview_reachable(value: String) -> &'static str {
    if crate::canvas_browser_local_files::is_file_url(&value) {
        return "ok";
    }
    // A bad address is left for `open` to report.
    let Ok(url) = normalize_browser_preview_url(&value) else { return "ok" };
    let check = tauri::async_runtime::spawn_blocking(move || reachability(&url));
    // A slow resolver (offline, captive portal) is left to WebKit rather than holding the page.
    match tokio::time::timeout(std::time::Duration::from_millis(1500), check).await {
        Ok(Ok(answer)) => answer,
        _ => "ok",
    }
}

fn reachability(url: &Url) -> &'static str {
    if loopback_refuses(url) {
        return "refused";
    }
    let Some(host) = url.host_str() else { return "ok" };
    // An IP needs no lookup; a name is looked up once here, which also warms the cache WebKit uses.
    if host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok() {
        return "ok";
    }
    if url.socket_addrs(|| None).is_err() { "unknown-host" } else { "ok" }
}

/// Whether `url` is a local address nothing listens on yet. Anything not local is left to load.
pub(crate) fn loopback_refuses(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let local = host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified());
    if !local {
        return false;
    }
    // WebKit tries every address `localhost` has (::1 and 127.0.0.1); so does this.
    let Ok(addrs) = url.socket_addrs(|| None) else { return false };
    let timeout = std::time::Duration::from_millis(250);
    !addrs.is_empty() && !addrs.iter().any(|addr| std::net::TcpStream::connect_timeout(addr, timeout).is_ok())
}

const PARKED_AT: f64 = -100_000.0;

fn set_picking(label: &str, on: bool) {
    if let Some(slot) = placed_previews().get_mut(label) {
        slot.picking = on;
    }
}

fn placed_previews() -> std::sync::MutexGuard<'static, std::collections::HashMap<String, Placed>> {
    static PLACED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Placed>>> = std::sync::OnceLock::new();
    PLACED.get_or_init(Default::default).lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn park_embedded_browser_preview<R: Runtime>(webview: &Webview<R>) -> Result<(), AppError> {
    if let Some(slot) = placed_previews().get_mut(webview.label()) {
        slot.parked = true;
    }
    webview.hide().map_err(|err| AppError::Other(err.to_string()))?;
    webview
        .set_position(tauri::Position::Logical(LogicalPosition::new(PARKED_AT, PARKED_AT)))
        .map_err(|err| AppError::Other(err.to_string()))
}

fn unpark_embedded_browser_preview<R: Runtime>(webview: &Webview<R>) -> Result<(), AppError> {
    let back = placed_previews().get_mut(webview.label()).and_then(|slot| {
        let was = slot.parked;
        slot.parked = false;
        was.then_some(slot.bounds)
    });
    if let Some(bounds) = back {
        apply_embedded_browser_preview_bounds(webview, bounds)?;
    }
    webview.show().map_err(|err| AppError::Other(err.to_string()))
}

fn navigate_existing_browser_preview<R: Runtime>(
    window: &WebviewWindow<R>,
    url: Url,
) -> Result<(), AppError> {
    window
        .navigate(url)
        .map_err(|err| AppError::Other(err.to_string()))?;
    window
        .show()
        .map_err(|err| AppError::Other(err.to_string()))?;
    window
        .set_focus()
        .map_err(|err| AppError::Other(err.to_string()))
}

pub(crate) fn parse_annotation_navigation_payload(url: &Url) -> Option<String> {
    if url.scheme() != BROWSER_ANNOTATION_SCHEME {
        return None;
    }

    let action = url.host_str().unwrap_or_default();
    if action == "cancel" {
        return Some(r#"{"action":"cancel"}"#.to_string());
    }

    if action != "selected" {
        return None;
    }

    url.query_pairs()
        .find_map(|(key, value)| (key == "payload").then(|| value.into_owned()))
}

// The raw string contains literal `{` / `}` escaped as `{{` / `}}` for
// `format!`. Rewriting it to a plain string literal would mean unescaping
// hundreds of CSS / JS braces — far riskier than tolerating this lint.
#[allow(clippy::useless_format)]
pub(crate) fn embedded_browser_annotation_script() -> String {
    format!(
        r##"
(() => {{
  const previous = window.__codechatBrowserAnnotationOverlay;
  if (previous && typeof previous.destroy === "function") previous.destroy();

  const style = document.createElement("style");
  style.dataset.codechatAnnotation = "style";
  style.textContent = `
    [data-codechat-annotation-root] {{
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      cursor: crosshair;
      pointer-events: auto;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    [data-codechat-annotation-toolbar] {{
      position: fixed;
      left: 12px;
      top: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid rgba(250, 204, 21, 0.32);
      border-radius: 7px;
      background: rgba(12, 12, 13, 0.88);
      color: #fef3c7;
      padding: 6px 8px;
      font-size: 11px;
      line-height: 1;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.38);
      backdrop-filter: blur(14px);
    }}
    [data-codechat-annotation-hover],
    [data-codechat-annotation-draft] {{
      position: fixed;
      border: 1px solid rgba(96, 165, 250, 0.95);
      background: rgba(59, 130, 246, 0.08);
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.5), 0 0 24px rgba(59, 130, 246, 0.22);
      border-radius: 4px;
      pointer-events: none;
    }}
    [data-codechat-annotation-draft] {{
      border-color: rgba(250, 204, 21, 0.95);
      background: rgba(250, 204, 21, 0.12);
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.5), 0 0 24px rgba(250, 204, 21, 0.18);
    }}
    [data-codechat-annotation-selected] {{
      position: fixed;
      border: 1px solid rgba(250, 204, 21, 0.95);
      background: rgba(250, 204, 21, 0.08);
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.5), 0 0 24px rgba(250, 204, 21, 0.16);
      border-radius: 4px;
      pointer-events: none;
    }}
    [data-codechat-annotation-label] {{
      position: fixed;
      transform: translateY(-100%);
      border: 1px solid rgba(96, 165, 250, 0.75);
      border-radius: 4px 4px 0 0;
      background: rgba(37, 99, 235, 0.9);
      color: white;
      padding: 2px 5px;
      font-size: 10px;
      font-weight: 600;
      line-height: 1.2;
      pointer-events: none;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    [data-codechat-annotation-composer] {{
      position: fixed;
      z-index: 2147483647;
      width: min(420px, calc(100vw - 32px));
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 12px;
      background: rgba(18, 18, 20, 0.94);
      color: rgba(255, 255, 255, 0.92);
      padding: 10px;
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.42);
      backdrop-filter: blur(16px);
      cursor: default;
    }}
    [data-codechat-annotation-composer][hidden] {{
      display: none;
    }}
    [data-codechat-annotation-tag] {{
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 7px;
      background: rgba(96, 165, 250, 0.16);
      color: #bfdbfe;
      padding: 4px 7px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      max-width: 100%;
    }}
    [data-codechat-annotation-input-row] {{
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }}
    [data-codechat-annotation-input] {{
      min-width: 0;
      flex: 1;
      border: 0;
      outline: none;
      background: transparent;
      color: rgba(255, 255, 255, 0.92);
      font-size: 13px;
      line-height: 20px;
    }}
    [data-codechat-annotation-input]::placeholder {{
      color: rgba(255, 255, 255, 0.35);
    }}
    [data-codechat-annotation-submit] {{
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.28);
      color: white;
      font-size: 17px;
      line-height: 1;
      cursor: pointer;
    }}
  `;
  document.documentElement.appendChild(style);

  const root = document.createElement("div");
  root.dataset.codechatAnnotationRoot = "true";
  const toolbar = document.createElement("div");
  toolbar.dataset.codechatAnnotationToolbar = "true";
  toolbar.textContent = "Click an element or drag a region. Toggle Annotate to stop.";
  const hoverBox = document.createElement("div");
  hoverBox.dataset.codechatAnnotationHover = "true";
  const label = document.createElement("div");
  label.dataset.codechatAnnotationLabel = "true";
  const draft = document.createElement("div");
  draft.dataset.codechatAnnotationDraft = "true";
  draft.hidden = true;
  const selectedLayer = document.createElement("div");
  selectedLayer.dataset.codechatAnnotationSelectedLayer = "true";
  const composer = document.createElement("div");
  composer.dataset.codechatAnnotationComposer = "true";
  composer.hidden = true;
  const composerTag = document.createElement("div");
  composerTag.dataset.codechatAnnotationTag = "true";
  const composerRow = document.createElement("div");
  composerRow.dataset.codechatAnnotationInputRow = "true";
  const composerInput = document.createElement("input");
  composerInput.dataset.codechatAnnotationInput = "true";
  composerInput.placeholder = "Describe the change or press Enter to add to chat";
  const composerSubmit = document.createElement("button");
  composerSubmit.type = "button";
  composerSubmit.dataset.codechatAnnotationSubmit = "true";
  composerSubmit.textContent = "↑";
  composerSubmit.setAttribute("aria-label", "Add browser annotation to chat");
  composerRow.append(composerInput, composerSubmit);
  composer.append(composerTag, composerRow);
  root.append(toolbar, selectedLayer, hoverBox, label, draft, composer);
  document.documentElement.appendChild(root);

  let start = null;
  let dragging = false;
  let lastElement = null;
  let pendingPayload = null;
  let pendingElement = null;

  const destroy = () => {{
    document.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("mousemove", onMouseMove, true);
    root.removeEventListener("mousedown", onMouseDown, true);
    root.removeEventListener("mouseup", onMouseUp, true);
    root.removeEventListener("mouseleave", onMouseLeave, true);
    root.remove();
    style.remove();
    if (window.__codechatBrowserAnnotationOverlay?.destroy === destroy) {{
      delete window.__codechatBrowserAnnotationOverlay;
    }}
  }};

  const isComposerTarget = (target) => target instanceof Element && Boolean(target.closest("[data-codechat-annotation-composer]"));
  const isAnnotationSubmitKey = (event) => (event.key === "Enter" || event.key === "NumpadEnter") && !event.shiftKey && !event.isComposing;

  const attrSelector = (name, value) => `[${{name}}=${{JSON.stringify(String(value))}}]`;
  const safeIdent = (value) => {{
    const normalized = String(value || "");
    return /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(normalized) ? normalized : "";
  }};

  const elementAt = (x, y) => {{
    root.style.pointerEvents = "none";
    let element = document.elementFromPoint(x, y);
    while (element && element.shadowRoot) {{
      const deeper = element.shadowRoot.elementFromPoint(x, y);
      if (!deeper || deeper === element) break;
      element = deeper;
    }}
    root.style.pointerEvents = "auto";
    return element instanceof HTMLElement ? element : null;
  }};

  const elementArea = (element) => {{
    if (!element) return Number.POSITIVE_INFINITY;
    const rect = element.getBoundingClientRect();
    return Math.max(1, rect.width) * Math.max(1, rect.height);
  }};

  const bestElementForRect = (rect, endX, endY) => {{
    const candidates = [
      elementAt(rect.x + rect.width / 2, rect.y + rect.height / 2),
      elementAt(endX, endY),
      elementAt(rect.x + 1, rect.y + 1),
      elementAt(rect.x + rect.width - 1, rect.y + rect.height - 1),
    ].filter(Boolean);
    if (!candidates.length) return null;
    return candidates.sort((left, right) => elementArea(left) - elementArea(right))[0];
  }};

  const selectorFor = (element) => {{
    if (!element) return "browser-preview";
    if (element.id) {{
      const safeId = safeIdent(element.id);
      return safeId ? "#" + safeId : attrSelector("id", element.id);
    }}
    const testId = element.getAttribute("data-testid") || element.getAttribute("data-test");
    if (testId) return attrSelector("data-testid", testId);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {{
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList || []).map(safeIdent).filter(Boolean).slice(0, 2);
      if (classes.length) part += "." + classes.join(".");
      const parent = current.parentElement;
      if (parent) {{
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${{siblings.indexOf(current) + 1}})`;
      }}
      parts.unshift(part);
      if (parts.length >= 4) break;
      current = parent;
    }}
    return parts.join(" > ") || element.tagName.toLowerCase();
  }};

  const labelFor = (element) => {{
    if (!element) return "Browser region";
    const aria = element.getAttribute("aria-label");
    const text = (aria || readElementText(element)).replace(/\\s+/g, " ").trim();
    return text ? `${{element.tagName.toLowerCase()}}: ${{text.slice(0, 72)}}` : element.tagName.toLowerCase();
  }};

  const readElementText = (element) => {{
    if (!element) return "";
    const value = "value" in element ? element.value : "";
    const placeholder = element.getAttribute("placeholder") || "";
    const aria = element.getAttribute("aria-label") || "";
    const title = element.getAttribute("title") || "";
    const name = element.getAttribute("name") || "";
    const text = element.innerText || element.textContent || "";
    return (value || placeholder || aria || title || text || name || "").replace(/\\s+/g, " ").trim().slice(0, 500);
  }};

  const summarizeElement = (element) => {{
    if (!element) return [];
    const summary = [];
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    summary.push(role ? `element: ${{tag}} role=${{role}}` : `element: ${{tag}}`);

    const images = Array.from(element.matches("img") ? [element] : element.querySelectorAll("img")).slice(0, 6);
    if (images.length) {{
      summary.push(`images: ${{images.length}} visible sample${{images.length === 1 ? "" : "s"}}`);
      for (const image of images.slice(0, 4)) {{
        const alt = image.getAttribute("alt") || image.getAttribute("aria-label") || "";
        const src = image.currentSrc || image.src || "";
        const srcLabel = src ? src.split("?")[0].split("/").slice(-2).join("/") : "";
        summary.push(`image: ${{alt || srcLabel || "untitled image"}}`);
      }}
    }}

    const links = Array.from(element.matches("a") ? [element] : element.querySelectorAll("a"))
      .map((link) => (link.innerText || link.textContent || link.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 5);
    if (links.length) summary.push(`links/buttons: ${{links.join(" | ")}}`);

    const buttons = Array.from(element.matches("button,input[type='button'],input[type='submit']") ? [element] : element.querySelectorAll("button,input[type='button'],input[type='submit']"))
      .map(readElementText)
      .filter(Boolean)
      .slice(0, 5);
    if (buttons.length) summary.push(`actions: ${{buttons.join(" | ")}}`);

    return summary.slice(0, 8);
  }};

  // Design details for the agent (Orca's Design Mode): the styles that decide how it looks, a
  // short piece of its HTML, and, on a React dev build, the component that drew it.
  const STYLE_PROPS = ["display", "position", "width", "height", "margin", "padding", "gap", "color",
    "background-color", "font-family", "font-size", "font-weight", "line-height", "text-align",
    "border", "border-radius", "box-shadow", "opacity"];
  const EMPTY_STYLE = ["", "none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)", "static", "1"];
  const stylesFor = (element) => {{
    if (!element) return {{}};
    const computed = window.getComputedStyle(element);
    const styles = {{}};
    for (const prop of STYLE_PROPS) {{
      const value = computed.getPropertyValue(prop).trim();
      if (!EMPTY_STYLE.includes(value) && !/^0px none/.test(value)) styles[prop] = value.slice(0, 120);
    }}
    return styles;
  }};
  const htmlFor = (element) => {{
    if (!element) return "";
    const html = (element.outerHTML || "").replace(/\s+/g, " ").trim();
    return html.length > 600 ? html.slice(0, 600) + "…" : html;
  }};
  const reactComponentFor = (element) => {{
    try {{
      const key = element && Object.keys(element).find((k) => k.startsWith("__reactFiber$"));
      for (let fiber = key ? element[key] : null, hops = 0; fiber && hops < 40; fiber = fiber.return, hops++) {{
        const type = fiber.type;
        const name = type && typeof type !== "string" ? type.displayName || type.name : "";
        if (name && /^[A-Z]/.test(name)) return name;
      }}
    }} catch (_) {{}}
    return "";
  }};

  const sanitizeAttachmentName = (value) => {{
    const normalized = String(value || "browser-selection").trim().toLowerCase();
    return normalized
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "browser-selection";
  }};

  const imageExtensionFor = (mimeType, src) => {{
    if (mimeType === "image/png") return "png";
    if (mimeType === "image/webp") return "webp";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/svg+xml") return "svg";
    const pathExtension = String(src || "").split("?")[0].split(".").pop();
    return pathExtension && /^[a-z0-9]{{2,5}}$/i.test(pathExtension) ? pathExtension.toLowerCase() : "jpg";
  }};

  const primaryImagesFor = (element) => {{
    if (!element) return [];
    const images = Array.from(element.matches("img") ? [element] : element.querySelectorAll("img"));
    return images
      .filter((image) => {{
        const rect = image.getBoundingClientRect();
        return rect.width >= 16 && rect.height >= 16;
      }})
      .sort((left, right) => {{
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        return (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
      }})
      .slice(0, 1);
  }};

  const readBlobAsDataUrl = (blob) => new Promise((resolve, reject) => {{
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("Failed to read image blob."));
    reader.readAsDataURL(blob);
  }});

  const visualAttachmentsFor = async (element) => {{
    const attachments = [];
    for (const image of primaryImagesFor(element)) {{
      const src = image.currentSrc || image.src || "";
      const alt = image.getAttribute("alt") || image.getAttribute("aria-label") || image.getAttribute("title") || "";
      if (!src) continue;
      try {{
        let content = "";
        let mimeType = "image/*";
        if (src.startsWith("data:image/")) {{
          content = src;
          mimeType = src.slice(5, src.indexOf(";")) || "image/*";
        }} else if (/^https?:\/\//i.test(src)) {{
          const response = await fetch(src, {{ mode: "cors", credentials: "omit", cache: "force-cache" }});
          if (!response.ok) continue;
          const blob = await response.blob();
          if (!blob.type.startsWith("image/") || blob.size > 8 * 1024 * 1024) continue;
          mimeType = blob.type;
          content = await readBlobAsDataUrl(blob);
        }}
        if (!content.startsWith("data:image/")) continue;
        const extension = imageExtensionFor(mimeType, src);
        const srcName = src.split("?")[0].split("/").pop() || "browser-selection";
        const name = `${{sanitizeAttachmentName(alt || srcName)}}.${{extension}}`;
        attachments.push({{ name, content, mimeType, previewUrl: content }});
      }} catch (error) {{
        console.warn("[CodeChat] Failed to capture browser annotation image.", error);
      }}
    }}
    return attachments;
  }};

  const setBox = (node, rect) => {{
    node.style.left = `${{Math.max(0, rect.x)}}px`;
    node.style.top = `${{Math.max(0, rect.y)}}px`;
    node.style.width = `${{Math.max(0, rect.width)}}px`;
    node.style.height = `${{Math.max(0, rect.height)}}px`;
  }};

  const payloadForElement = (element, rect) => ({{
    id: `browser-${{Date.now().toString(36)}}-${{Math.random().toString(36).slice(2, 8)}}`,
    action: "selected",
    url: window.location.href,
    title: document.title || "",
    selector: selectorFor(element),
    label: labelFor(element),
    text: readElementText(element),
    status: "pending",
    createdAt: new Date().toISOString(),
    classes: element ? Array.from(element.classList || []).slice(0, 12) : [],
    summary: summarizeElement(element),
    computedStyles: stylesFor(element),
    outerHTML: htmlFor(element),
    reactComponent: reactComponentFor(element),
    boundingBox: {{
      x: Math.round(rect.x + window.scrollX),
      y: Math.round(rect.y + window.scrollY),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }},
    viewport: {{
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }},
  }});

  const persistSelection = (payload) => {{
    selectedLayer.replaceChildren();
    const box = document.createElement("div");
    box.dataset.codechatAnnotationSelected = "true";
    const viewportRect = {{
      x: payload.boundingBox.x - window.scrollX,
      y: payload.boundingBox.y - window.scrollY,
      width: payload.boundingBox.width,
      height: payload.boundingBox.height,
    }};
    setBox(box, viewportRect);
    const selectionLabel = document.createElement("div");
    selectionLabel.dataset.codechatAnnotationLabel = "true";
    selectionLabel.textContent = payload.label || "Browser selection";
    selectionLabel.style.left = `${{Math.max(0, viewportRect.x)}}px`;
    selectionLabel.style.top = `${{Math.max(18, viewportRect.y)}}px`;
    selectedLayer.append(box, selectionLabel);
  }};

  const placeComposer = (payload) => {{
    const viewportRect = {{
      x: payload.boundingBox.x - window.scrollX,
      y: payload.boundingBox.y - window.scrollY,
      width: payload.boundingBox.width,
      height: payload.boundingBox.height,
    }};
    const preferredLeft = viewportRect.x;
    const preferredTop = viewportRect.y + viewportRect.height + 12;
    const maxLeft = Math.max(16, window.innerWidth - 436);
    const maxTop = Math.max(16, window.innerHeight - 128);
    composer.style.left = `${{Math.min(Math.max(16, preferredLeft), maxLeft)}}px`;
    composer.style.top = `${{Math.min(Math.max(16, preferredTop), maxTop)}}px`;
  }};

  const stageSelection = (payload, element) => {{
    pendingPayload = payload;
    pendingElement = element || null;
    persistSelection(payload);
    composerTag.textContent = payload.selector || payload.label || "Browser selection";
    composerInput.value = "";
    composer.hidden = false;
    placeComposer(payload);
    requestAnimationFrame(() => composerInput.focus());
  }};

  const send = (payload) => {{
    const emitViaNavigation = (payload) => {{
      const encodedPayload = encodeURIComponent(JSON.stringify(payload));
      window.location.href = `codechat-browser-annotation://selected?payload=${{encodedPayload}}`;
    }};
    const navigationPayload = payload.visualAttachments?.length
      ? {{ ...payload, visualAttachments: payload.visualAttachments.map((attachment) => ({{
        name: attachment.name,
        mimeType: attachment.mimeType,
      }})) }}
      : payload;
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    emitViaNavigation(navigationPayload);
    if (typeof invoke !== "function") {{
      console.warn("[CodeChat] Browser annotation bridge is unavailable.");
      return;
    }}
    invoke("browser_preview_emit_annotation", {{
      payload: JSON.stringify(payload),
    }}).catch((error) => {{
      console.warn("[CodeChat] Failed to emit browser annotation.", error);
    }});
  }};

  const submitPendingSelection = () => {{
    if (!pendingPayload) return;
    const element = pendingElement;
    // boundingBox/viewport were staged when the element was first selected — the user may have
    // spent seconds typing their message, during which the page can scroll or reflow (e.g. a
    // dynamically-loading grid). Re-measure the LIVE element now so a pixel-precise crop (the
    // native screenshot) targets where the element actually is, not where it was at selection
    // time. A detached/zero-size element (removed from the DOM meanwhile) falls back to the
    // staged rect rather than submitting a degenerate box.
    const freshRect = element ? element.getBoundingClientRect() : null;
    const freshMeasurement = freshRect && freshRect.width > 0 && freshRect.height > 0
      ? {{
          boundingBox: {{
            x: Math.round(freshRect.x + window.scrollX),
            y: Math.round(freshRect.y + window.scrollY),
            width: Math.round(freshRect.width),
            height: Math.round(freshRect.height),
          }},
          viewport: {{
            width: window.innerWidth,
            height: window.innerHeight,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
          }},
        }}
      : {{}};
    const payload = {{
      ...pendingPayload,
      ...freshMeasurement,
      message: composerInput.value.trim(),
    }};
    composer.hidden = true;
    // The annotation screenshot is captured shortly after this submit (via the main app,
    // several async hops later). Clear the selection box + element label AND the hint
    // toolbar now so that native capture shows the pure page pixels — not the overlay's
    // own blue ring / "img" badge / hint bar. Re-entering annotation mode re-evals this
    // script, which destroys and recreates the overlay, so no restore is needed.
    selectedLayer.replaceChildren(); // clear selection chrome before screenshot capture
    toolbar.style.display = "none"; // hide hint before screenshot capture
    pendingPayload = null;
    pendingElement = null;
    send(payload);
    visualAttachmentsFor(element).then((visualAttachments) => {{
      if (visualAttachments.length) {{
        send({{ ...payload, visualAttachments }});
      }}
    }}).catch((error) => {{
      console.warn("[CodeChat] Failed to capture browser annotation image.", error);
    }});
  }};

  composer.addEventListener("mousedown", (event) => {{
    event.stopPropagation();
  }}, true);
  composer.addEventListener("mouseup", (event) => {{
    event.stopPropagation();
  }}, true);
  composerSubmit.addEventListener("click", (event) => {{
    event.preventDefault();
    event.stopPropagation();
    submitPendingSelection();
  }});
  composerInput.addEventListener("keydown", (event) => {{
    event.stopPropagation();
    if (isAnnotationSubmitKey(event)) {{
      event.preventDefault();
      submitPendingSelection();
    }}
    if (event.key === "Escape") {{
      event.preventDefault();
      pendingPayload = null;
      composer.hidden = true;
      selectedLayer.replaceChildren();
    }}
  }});

  function onMouseMove(event) {{
    if (isComposerTarget(event.target)) return;
    const element = elementAt(event.clientX, event.clientY);
    lastElement = element;
    if (!dragging && element) {{
      const rect = element.getBoundingClientRect();
      setBox(hoverBox, rect);
      label.textContent = labelFor(element);
      label.style.left = `${{Math.max(0, rect.left)}}px`;
      label.style.top = `${{Math.max(18, rect.top)}}px`;
    }}
    if (dragging && start) {{
      const x = Math.min(start.x, event.clientX);
      const y = Math.min(start.y, event.clientY);
      const width = Math.abs(event.clientX - start.x);
      const height = Math.abs(event.clientY - start.y);
      setBox(draft, {{ x, y, width, height }});
      draft.hidden = false;
    }}
  }}

  function onMouseDown(event) {{
    if (event.button !== 0) return;
    if (isComposerTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    start = {{ x: event.clientX, y: event.clientY }};
    dragging = true;
    draft.hidden = true;
  }}

  function onMouseUp(event) {{
    if (isComposerTarget(event.target)) return;
    if (!dragging || !start) return;
    event.preventDefault();
    event.stopPropagation();
    const width = Math.abs(event.clientX - start.x);
    const height = Math.abs(event.clientY - start.y);
    dragging = false;
    draft.hidden = true;

    if (width >= 8 && height >= 8) {{
      const rect = {{
        x: Math.min(start.x, event.clientX),
        y: Math.min(start.y, event.clientY),
        width,
        height,
      }};
      const element = bestElementForRect(rect, event.clientX, event.clientY);
      stageSelection(payloadForElement(element, rect), element);
      return;
    }}

    const element = elementAt(event.clientX, event.clientY) || lastElement;
    if (!element) return;
    stageSelection(payloadForElement(element, element.getBoundingClientRect()), element);
  }}

  function onMouseLeave() {{
    hoverBox.style.width = "0";
    hoverBox.style.height = "0";
    label.textContent = "";
  }}

  function onKeyDown(event) {{
    if (pendingPayload && !composer.hidden && isAnnotationSubmitKey(event)) {{
      event.preventDefault();
      event.stopPropagation();
      submitPendingSelection();
      return;
    }}
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    start = null;
    dragging = false;
    draft.hidden = true;
    pendingPayload = null;
    composer.hidden = true;
    selectedLayer.replaceChildren();
  }}

  document.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("mousemove", onMouseMove, true);
  root.addEventListener("mousedown", onMouseDown, true);
  root.addEventListener("mouseup", onMouseUp, true);
  root.addEventListener("mouseleave", onMouseLeave, true);
  window.__codechatBrowserAnnotationOverlay = {{ destroy }};
}})();
"##,
    )
}

fn validate_browser_preview_bounds(bounds: BrowserPreviewBounds) -> Result<(), AppError> {
    if bounds.width < 120.0 || bounds.height < 120.0 {
        return Err(AppError::Other(
            "Browser preview pane is too small to embed a native WebView.".to_string(),
        ));
    }

    if !bounds.x.is_finite()
        || !bounds.y.is_finite()
        || !bounds.width.is_finite()
        || !bounds.height.is_finite()
    {
        return Err(AppError::Other(
            "Browser preview pane bounds are invalid.".to_string(),
        ));
    }

    Ok(())
}

fn is_loopback_without_scheme(value: &str) -> bool {
    let host = value
        .split_once('/')
        .map(|(host, _)| host)
        .unwrap_or(value)
        .split_once(':')
        .map(|(host, _)| host)
        .unwrap_or(value);

    matches!(host, "localhost" | "127.0.0.1" | "0.0.0.0")
}

fn is_url_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    first.is_ascii_alphabetic()
        && chars.all(|char| char.is_ascii_alphanumeric() || matches!(char, '+' | '-' | '.'))
}

#[cfg(test)]
mod tests {
    use super::normalize_browser_preview_url;
    use super::{
        embedded_browser_annotation_script, embedded_browser_preview_label,
        parse_annotation_navigation_payload, BrowserPreviewBounds,
    };
    use std::{fs, process::Command};
    use tauri::Url;

    /// The page's IPC channel for a pick (the one that carries its pictures) is granted by URL
    /// pattern, and `http://*` matches only the default port: every dev server and every local
    /// file (served on the API port) was refused, so only the URL-scheme channel got through.
    #[test]
    fn annotation_capability_admits_pages_on_any_port() {
        use std::str::FromStr;
        use tauri::utils::acl::RemoteUrlPattern;
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/browser-preview-annotation.json")).unwrap();
        let patterns: Vec<RemoteUrlPattern> = capability["remote"]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| RemoteUrlPattern::from_str(p.as_str().unwrap()).unwrap())
            .collect();
        for page in ["http://localhost:3000/", "http://127.0.0.1:5173/a", "http://localhost/", "https://example.com/", "https://example.com:8443/"] {
            let url = Url::parse(page).unwrap();
            assert!(patterns.iter().any(|p| p.test(&url)), "{page} is not admitted");
        }
        assert_eq!(capability["webviews"], serde_json::json!(["codechat-browser-preview-embed-*"]));
    }

    #[test]
    fn loopback_refuses_only_a_local_port_nothing_listens_on() {
        use super::loopback_refuses;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let at = |host: &str| Url::parse(&format!("http://{host}:{port}/")).unwrap();
        assert!(!loopback_refuses(&at("127.0.0.1")));
        drop(listener);
        assert!(loopback_refuses(&at("127.0.0.1")));
        assert!(loopback_refuses(&at("[::1]")));
        // Not local: left to load, whatever the network says.
        assert!(!loopback_refuses(&Url::parse("https://example.invalid/").unwrap()));
    }

    #[test]
    fn reachability_names_a_host_dns_does_not_know() {
        use super::reachability;
        // `.invalid` never resolves (RFC 6761).
        assert_eq!(reachability(&Url::parse("https://lotus-preview-test.invalid/").unwrap()), "unknown-host");
        assert_eq!(reachability(&Url::parse("http://127.0.0.1:1/").unwrap()), "refused");
        assert_eq!(reachability(&Url::parse("https://93.184.216.34/").unwrap()), "ok");
    }

    #[test]
    fn normalize_browser_preview_url_defaults_loopback_to_http() {
        let url = normalize_browser_preview_url("localhost:5173").unwrap();
        assert_eq!(url.as_str(), "http://localhost:5173/");
    }

    #[test]
    fn normalize_browser_preview_url_defaults_domains_to_https() {
        let url = normalize_browser_preview_url("google.com").unwrap();
        assert_eq!(url.as_str(), "https://google.com/");
    }

    #[test]
    fn normalize_browser_preview_url_rejects_unsupported_schemes() {
        let error = normalize_browser_preview_url("javascript:alert(1)").unwrap_err();
        assert!(error
            .to_string()
            .contains("Unsupported browser preview URL scheme"));
    }

    #[test]
    fn embedded_browser_preview_slot_label_is_scoped_to_window_and_slot() {
        assert_eq!(
            super::embedded_browser_preview_slot_label("main", Some("thread/1")),
            "codechat-browser-preview-embed-main--thread-1"
        );
        assert_eq!(
            super::embedded_browser_preview_slot_label("main", None),
            embedded_browser_preview_label("main")
        );
    }

    #[test]
    fn embedded_browser_preview_label_is_scoped_to_window() {
        assert_eq!(
            embedded_browser_preview_label("window-a/b"),
            "codechat-browser-preview-embed-window-a-b"
        );
    }

    #[test]
    fn browser_preview_bounds_deserialize_from_camel_case() {
        let bounds: BrowserPreviewBounds = serde_json::from_value(serde_json::json!({
            "x": 10,
            "y": 20,
            "width": 320,
            "height": 240,
        }))
        .unwrap();

        assert_eq!(bounds.width, 320.0);
    }

    #[test]
    fn parses_annotation_navigation_payload() {
        let url = Url::parse("codechat-browser-annotation://selected?payload=%7B%22url%22%3A%22https%3A%2F%2Fexample.com%22%7D").unwrap();

        assert_eq!(
            parse_annotation_navigation_payload(&url).as_deref(),
            Some(r#"{"url":"https://example.com"}"#)
        );
    }

    #[test]
    fn annotation_script_uses_ipc_bridge() {
        let script = embedded_browser_annotation_script();

        assert!(script.contains("browser_preview_emit_annotation"));
        assert!(script.contains("window.__TAURI_INTERNALS__?.invoke"));
        assert!(script.contains("data-codechat-annotation-selected"));
        assert!(script.contains("data-codechat-annotation-composer"));
        assert!(script.contains("selectedLayer.replaceChildren()"));
        assert!(script.contains("message: composerInput.value.trim()"));
        assert!(script.contains("createdAt: new Date().toISOString()"));
        assert!(script.contains(
            "const attrSelector = (name, value) => `[${name}=${JSON.stringify(String(value))}]`;"
        ));
        assert!(script.contains("const safeIdent = (value) =>"));
        assert!(!script.contains(r#"replace(/[^a-zA-Z0-9_-]/g, "\\$&")"#));
        assert!(script.contains("isAnnotationSubmitKey(event)"));
        assert!(script.contains("!composer.hidden"));
        assert!(script.contains("emitViaNavigation(navigationPayload);"));
        assert!(script.contains("codechat-browser-annotation://selected?payload="));
        assert!(script.contains(
            "id: `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`"
        ));
        assert!(script.contains("bestElementForRect(rect, event.clientX, event.clientY)"));
        assert!(script.contains("readElementText(element)"));
        assert!(script.contains("summarizeElement(element)"));
        assert!(script.contains("computedStyles: stylesFor(element)"));
        assert!(script.contains("outerHTML: htmlFor(element)"));
        assert!(script.contains("visualAttachmentsFor(element)"));
        assert!(script.contains("send(payload);"));
        assert!(script.contains("send({ ...payload, visualAttachments });"));
        assert!(script.contains("readBlobAsDataUrl(blob)"));
        assert!(script.contains("blob.size > 8 * 1024 * 1024"));
        assert!(script.contains("images.length"));
        assert!(script.contains("element.value"));
        assert!(!script.contains("window.open"));
        assert!(script.contains("Toggle Annotate to stop"));
        assert!(!script.contains("://cancel"));
        assert!(script.contains("data-codechat-annotation-root"));
        assert!(script.contains("document.elementFromPoint"));
    }

    #[test]
    fn annotation_script_remeasures_the_element_at_submit_time() {
        // boundingBox is staged when the element is first selected, but the user can spend
        // several seconds typing their annotation message before submitting — during that gap
        // a dynamic page (e.g. YouTube's homepage grid) can scroll or reflow, leaving the staged
        // rect stale. A stale rect only degraded a text hint before; now it drives a pixel-precise
        // native screenshot crop, so submit must re-measure the live element, not reuse the stage-
        // time snapshot verbatim.
        let script = embedded_browser_annotation_script();

        assert!(
            script.contains("const freshRect = element ? element.getBoundingClientRect() : null;")
        );
        assert!(script.contains("freshRect.width > 0 && freshRect.height > 0"));
    }

    #[test]
    fn annotation_script_clears_selection_chrome_on_submit_so_it_is_not_captured() {
        // The selection box + element label are drawn into `selectedLayer` so the user sees
        // what they picked while typing. But the annotation screenshot is captured shortly
        // after submit — if that chrome is still in the DOM it bleeds into the crop (a blue
        // ring + an "img" badge over the captured element). Submit must clear it, so the
        // layer is cleared in TWO places: when a selection is (re)drawn, and again on submit.
        let script = embedded_browser_annotation_script();
        assert!(
            script.contains("selectedLayer.replaceChildren(); // clear selection chrome before screenshot capture"),
            "submitPendingSelection must clear the selection chrome so it is not captured"
        );
        assert!(
            script.contains("toolbar.style.display = \"none\"; // hide hint before screenshot capture"),
            "submitPendingSelection must hide the toolbar hint so it is not captured for top-of-viewport selections"
        );
    }

    #[test]
    fn reads_pointer_lock_requests_only_from_their_own_scheme() {
        let at = |s: &str| super::pointer_lock_request(&Url::parse(s).unwrap());
        assert_eq!(at("lotus-preview-lock://on"), Some(true));
        assert_eq!(at("lotus-preview-lock://off"), Some(false));
        assert_eq!(at("lotus-preview-lock://maybe"), None);
        assert_eq!(at("https://on.example"), None);
    }

    #[test]
    fn pointer_lock_script_is_valid_javascript() {
        let path = std::env::temp_dir().join("lotus-preview-pointer-lock-check.js");
        fs::write(&path, super::POINTER_LOCK_SCRIPT).unwrap();
        let output = Command::new("node")
            .arg("--check")
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn annotation_script_is_valid_javascript() {
        let script = embedded_browser_annotation_script();
        let path = std::env::temp_dir().join("codechat-browser-annotation-script-check.js");
        fs::write(&path, script).unwrap();

        let output = Command::new("node")
            .arg("--check")
            .arg(&path)
            .output()
            .unwrap();

        assert!(
            output.status.success(),
            "annotation script failed JavaScript syntax check:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }
}
