//! Native WKWebView screenshot capture for Canvas browser nodes.
//!
//! WHY this exists: the DOM/accessibility snapshot path injects `canvas-inspect.js`
//! into the page and relies on exfiltrating the result back out (IPC command or a
//! cancelled navigation) plus a polling handler — three moving parts, all async.
//! An image snapshot is captured ENTIRELY in Rust via `WKWebView.takeSnapshot`,
//! with no page eval, no exfiltration, and no polling. It is the reliable, visually
//! accurate core of the snapshot (mirrors how the Claude Code reference "reads the
//! screen" natively), and it works even when the in-page channel is misbehaving.
//!
//! Tauri 2.10 / WRY 0.54 expose no screenshot API, so we reach the underlying
//! `WKWebView` through `Webview::with_webview` (macOS gives the raw pointer) and
//! call AppKit directly. Non-macOS builds get an unsupported-platform error.

use std::time::Duration;

use tauri::{AppHandle, Runtime};

use crate::error::AppError;

/// A viewport-relative crop region in CSS pixels, plus the CSS viewport dimensions it
/// was measured against. We crop a FULL-viewport snapshot in Rust rather than passing
/// this to `WKSnapshotConfiguration.rect`: the webview runs at an arbitrary page zoom
/// (`WKWebView.setPageZoom`, set via `set_zoom`), so `getBoundingClientRect()` (page CSS
/// coords) and the snapshot's view coords differ by the zoom factor. Self-calibrating
/// crop sidesteps that entirely — the output ratio `png_dim / viewport_dim` absorbs zoom,
/// device pixel ratio, and magnification together, because it's measured from the actual
/// captured PNG rather than assumed.
#[derive(Debug, Clone, Copy, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBrowserScreenshotCropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub viewport_width: f64,
    pub viewport_height: f64,
}

/// Crop a full-viewport PNG to the selected element's region, self-calibrating the
/// CSS→pixel scale from the actual PNG size vs the CSS viewport size (see
/// [`CanvasBrowserScreenshotCropRect`]). Clamps to the image bounds; errors on a
/// degenerate (zero-area) result so callers fall back to the uncropped screenshot.
pub fn crop_png_to_region(
    png: &[u8],
    rect: &CanvasBrowserScreenshotCropRect,
) -> Result<Vec<u8>, AppError> {
    use image::{GenericImageView, ImageEncoder};

    if rect.width <= 0.0
        || rect.height <= 0.0
        || rect.viewport_width <= 0.0
        || rect.viewport_height <= 0.0
    {
        return Err(AppError::Other(
            "Annotation crop rect is degenerate.".into(),
        ));
    }
    let img = image::load_from_memory(png).map_err(|err| {
        AppError::Other(format!("Failed to decode screenshot for cropping: {err}"))
    })?;
    let (img_w, img_h) = img.dimensions();
    if img_w == 0 || img_h == 0 {
        return Err(AppError::Other("Screenshot has zero dimensions.".into()));
    }

    let scale_x = f64::from(img_w) / rect.viewport_width;
    let scale_y = f64::from(img_h) / rect.viewport_height;

    // Clamp the scaled rect into the image so an edge-hugging selection (or a page that
    // reflowed slightly between measure and capture) never wraps or panics.
    let x0 = (rect.x * scale_x).round().clamp(0.0, f64::from(img_w)) as u32;
    let y0 = (rect.y * scale_y).round().clamp(0.0, f64::from(img_h)) as u32;
    let x1 = ((rect.x + rect.width) * scale_x)
        .round()
        .clamp(0.0, f64::from(img_w)) as u32;
    let y1 = ((rect.y + rect.height) * scale_y)
        .round()
        .clamp(0.0, f64::from(img_h)) as u32;
    let crop_w = x1.saturating_sub(x0);
    let crop_h = y1.saturating_sub(y0);
    if crop_w == 0 || crop_h == 0 {
        return Err(AppError::Other(
            "Annotation crop region is empty after clamping.".into(),
        ));
    }

    let cropped = img.crop_imm(x0, y0, crop_w, crop_h).to_rgba8();
    let mut out = std::io::Cursor::new(Vec::new());
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(&cropped, crop_w, crop_h, image::ExtendedColorType::Rgba8)
        .map_err(|err| AppError::Other(format!("Failed to encode cropped screenshot: {err}")))?;
    Ok(out.into_inner())
}

/// Default budget for a native screenshot. `takeSnapshot` is usually well under
/// 300ms, but a heavy page compositing after `afterScreenUpdates` can take longer.
pub const SCREENSHOT_TIMEOUT_DEFAULT_MS: u64 = 4000;
pub const SCREENSHOT_TIMEOUT_MIN_MS: u64 = 500;
pub const SCREENSHOT_TIMEOUT_MAX_MS: u64 = 15_000;

/// Clamp a caller-supplied screenshot budget into a safe range.
pub fn resolve_screenshot_timeout(requested: Option<u64>) -> Duration {
    let ms = requested
        .unwrap_or(SCREENSHOT_TIMEOUT_DEFAULT_MS)
        .clamp(SCREENSHOT_TIMEOUT_MIN_MS, SCREENSHOT_TIMEOUT_MAX_MS);
    Duration::from_millis(ms)
}

/// Capture a full-viewport PNG screenshot of the canvas browser node's native WebView.
///
/// Returns the encoded PNG bytes. Errors if the node isn't open, is parked
/// off-screen (a parked WebView is ~1px and would snapshot to a useless image),
/// the platform is unsupported, or the capture times out. Region cropping is done
/// afterwards in Rust via [`crop_png_to_region`] — NOT via `WKSnapshotConfiguration.rect`,
/// whose view-coordinate space diverges from `getBoundingClientRect()` under page zoom.
pub async fn capture_canvas_browser_png<R: Runtime>(
    app: &AppHandle<R>,
    terminal_id: &str,
    timeout: Duration,
) -> Result<Vec<u8>, AppError> {
    let webview = crate::canvas_browser::get_canvas_webview(app, terminal_id)
        .ok_or_else(|| AppError::Other("Canvas browser is not open.".into()))?;

    // A parked node (off-screen, collapsed to ~1px) would snapshot to a 1px image.
    // Fail with an actionable message rather than returning a useless capture.
    if crate::canvas_browser::canvas_browser_status(app, terminal_id).viewport_parked {
        return Err(AppError::Other(
            "Canvas browser is minimized or off-screen; bring the node into view before capturing a screenshot."
                .into(),
        ));
    }

    capture_webview_png(&webview, timeout).await
}

/// Capture a full-viewport PNG of any native child webview (a Canvas browser node, a chat's
/// Preview browser). The caller checks that the webview is on screen at a useful size.
#[cfg(target_os = "macos")]
pub async fn capture_webview_png<R: Runtime>(
    webview: &tauri::Webview<R>,
    timeout: Duration,
) -> Result<Vec<u8>, AppError> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSImage;
    use objc2_foundation::NSError;
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();

    // `with_webview` runs the closure on the main (UI) thread; `takeSnapshot`'s
    // completion handler also fires on the main thread. We never block the main
    // thread — the closure kicks off the capture and returns; the completion
    // handler hands the PNG bytes back over the oneshot for us to await below.
    webview
        .with_webview(move |platform| {
            // SAFETY: on macOS `inner()` is the live WKWebView owned by this webview.
            let wk_ptr = platform.inner() as *mut WKWebView;
            let Some(wk) = (unsafe { wk_ptr.as_ref() }) else {
                let _ = tx.send(Err("null WKWebView handle".into()));
                return;
            };
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = tx.send(Err("with_webview did not run on the main thread".into()));
                return;
            };

            let config = unsafe { WKSnapshotConfiguration::new(mtm) };
            // Capture after the next layout/paint so recent DOM changes are visible.
            // No `setRect`: we crop the full-viewport result in Rust (self-calibrating),
            // because the view-coordinate rect diverges from CSS coords under page zoom.
            unsafe { config.setAfterScreenUpdates(true) };

            // The handler is `Fn` (called once by AppKit); the Cell hands the single
            // Sender to whichever branch fires so we never double-send.
            let sender = std::cell::Cell::new(Some(tx));
            let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let Some(tx) = sender.take() else { return };
                match unsafe { image.as_ref() } {
                    Some(img) => {
                        let _ = tx.send(png_from_ns_image(img));
                    }
                    None => {
                        let message = unsafe { error.as_ref() }
                            .map(|err| err.localizedDescription().to_string())
                            .unwrap_or_else(|| "takeSnapshot returned no image".into());
                        let _ = tx.send(Err(message));
                    }
                }
            });

            unsafe {
                wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
            }
        })
        .map_err(|e| {
            AppError::Other(format!("Failed to dispatch screenshot to the webview: {e}"))
        })?;

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(bytes))) => Ok(bytes),
        Ok(Ok(Err(message))) => Err(AppError::Other(format!("Screenshot failed: {message}"))),
        Ok(Err(_)) => Err(AppError::Other(
            "Screenshot capture channel closed before returning an image.".into(),
        )),
        Err(_) => Err(AppError::Other(format!(
            "Screenshot timed out after {}ms.",
            timeout.as_millis()
        ))),
    }
}

/// Encode an `NSImage` (as returned by `takeSnapshot`) to PNG bytes. Runs on the
/// main thread inside the completion handler; all intermediate AppKit objects are
/// released via an autorelease pool so a burst of captures doesn't accumulate.
#[cfg(target_os = "macos")]
fn png_from_ns_image(image: &objc2_app_kit::NSImage) -> Result<Vec<u8>, String> {
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::{NSData, NSDictionary, NSString};

    autoreleasepool(|_| {
        let tiff = image
            .TIFFRepresentation()
            .ok_or("NSImage has no TIFF representation")?;
        let bitmap =
            NSBitmapImageRep::imageRepWithData(&tiff).ok_or("Failed to build NSBitmapImageRep")?;
        let properties: objc2::rc::Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::new();
        let png: objc2::rc::Retained<NSData> = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or("Failed to encode PNG from bitmap")?;
        Ok(png.to_vec())
    })
}

#[cfg(not(target_os = "macos"))]
pub async fn capture_webview_png<R: Runtime>(
    _webview: &tauri::Webview<R>,
    _timeout: Duration,
) -> Result<Vec<u8>, AppError> {
    Err(AppError::Other(
        "Browser screenshot capture is only supported on macOS.".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_defaults_and_clamps() {
        assert_eq!(
            resolve_screenshot_timeout(None),
            Duration::from_millis(SCREENSHOT_TIMEOUT_DEFAULT_MS)
        );
        assert_eq!(
            resolve_screenshot_timeout(Some(10)),
            Duration::from_millis(SCREENSHOT_TIMEOUT_MIN_MS)
        );
        assert_eq!(
            resolve_screenshot_timeout(Some(999_999)),
            Duration::from_millis(SCREENSHOT_TIMEOUT_MAX_MS)
        );
        assert_eq!(
            resolve_screenshot_timeout(Some(2500)),
            Duration::from_millis(2500)
        );
    }

    #[test]
    fn crop_rect_deserializes_from_the_frontend_wire_format() {
        let rect: CanvasBrowserScreenshotCropRect = serde_json::from_str(
            r#"{"x":587.725,"y":99.25,"width":503.55,"height":283.5,"viewportWidth":1438,"viewportHeight":785}"#,
        )
        .expect("crop rect should deserialize");
        assert_eq!(
            rect,
            CanvasBrowserScreenshotCropRect {
                x: 587.725,
                y: 99.25,
                width: 503.55,
                height: 283.5,
                viewport_width: 1438.0,
                viewport_height: 785.0,
            }
        );
    }

    /// Build a solid-color RGBA PNG of the given pixel dimensions for crop tests.
    fn solid_png(width: u32, height: u32) -> Vec<u8> {
        use image::{ImageEncoder, ImageFormat};
        let buf = image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::codecs::png::PngEncoder::new(&mut out)
            .write_image(&buf, width, height, image::ExtendedColorType::Rgba8)
            .expect("encode test png");
        let _ = ImageFormat::Png;
        out.into_inner()
    }

    fn png_dims(bytes: &[u8]) -> (u32, u32) {
        let img = image::load_from_memory(bytes).expect("decode cropped png");
        (img.width(), img.height())
    }

    #[test]
    fn crop_scales_css_rect_by_the_measured_output_ratio_not_an_assumed_one() {
        // A 2× device-scale capture: viewport is 100×50 CSS but the PNG is 200×100 px.
        // The crop must self-calibrate from the ACTUAL png/viewport ratio (2×), so a
        // 40×20 CSS rect becomes an 80×40 px crop — regardless of what zoom produced it.
        let png = solid_png(200, 100);
        let rect = CanvasBrowserScreenshotCropRect {
            x: 10.0,
            y: 10.0,
            width: 40.0,
            height: 20.0,
            viewport_width: 100.0,
            viewport_height: 50.0,
        };
        let cropped = crop_png_to_region(&png, &rect).expect("crop succeeds");
        assert_eq!(png_dims(&cropped), (80, 40));
    }

    #[test]
    fn crop_clamps_a_rect_that_would_spill_past_the_image_edge() {
        // viewport == png (1× scale). A rect near the right/bottom edge whose expanded box
        // would exceed the bounds must clamp to the image instead of erroring or wrapping.
        let png = solid_png(100, 100);
        let rect = CanvasBrowserScreenshotCropRect {
            x: 80.0,
            y: 80.0,
            width: 40.0,
            height: 40.0,
            viewport_width: 100.0,
            viewport_height: 100.0,
        };
        let cropped = crop_png_to_region(&png, &rect).expect("crop succeeds");
        assert_eq!(png_dims(&cropped), (20, 20));
    }

    #[test]
    fn crop_returns_none_signal_for_a_degenerate_rect() {
        let png = solid_png(100, 100);
        let rect = CanvasBrowserScreenshotCropRect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
            viewport_width: 100.0,
            viewport_height: 100.0,
        };
        assert!(crop_png_to_region(&png, &rect).is_err());
    }
}
