use crate::AppError;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview,
    WebviewBuilder, WebviewUrl, Window,
};

#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewPaneBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn normalize_url(value: &str) -> Result<Url, AppError> {
    crate::browser_preview::normalize_browser_preview_url(value)
}

fn scoped_label(window_label: &str, raw_label: &str) -> String {
    let normalized = raw_label
        .trim()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("codespace-pane-{window_label}-{normalized}")
}

fn validate_bounds(bounds: WebviewPaneBounds) -> Result<(), AppError> {
    if !bounds.width.is_finite()
        || !bounds.height.is_finite()
        || !bounds.x.is_finite()
        || !bounds.y.is_finite()
    {
        return Err(AppError::Other("Invalid webview pane bounds.".to_string()));
    }
    if bounds.width < 0.0 || bounds.height < 0.0 {
        return Err(AppError::Other(
            "Webview pane bounds must be non-negative.".to_string(),
        ));
    }
    Ok(())
}

fn get_webview<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
) -> Option<Webview<R>> {
    let label = scoped_label(window.label(), raw_label);
    app.get_webview(&label)
}

fn set_bounds<R: Runtime>(webview: &Webview<R>, bounds: WebviewPaneBounds) -> Result<(), AppError> {
    validate_bounds(bounds)?;
    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(LogicalPosition::new(bounds.x, bounds.y)),
            size: tauri::Size::Logical(LogicalSize::new(bounds.width, bounds.height)),
        })
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn webview_create<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
    value: &str,
    bounds: WebviewPaneBounds,
) -> Result<(), AppError> {
    validate_bounds(bounds)?;
    let url = normalize_url(value)?;
    let label = scoped_label(window.label(), raw_label);

    if let Some(webview) = app.get_webview(&label) {
        webview
            .navigate(url)
            .map_err(|err| AppError::Other(err.to_string()))?;
        return set_bounds(&webview, bounds);
    }

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url));
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|err| AppError::Other(err.to_string()))?;
    Ok(())
}

pub fn webview_set_bounds<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
    bounds: WebviewPaneBounds,
) -> Result<(), AppError> {
    let Some(webview) = get_webview(app, window, raw_label) else {
        return Ok(());
    };
    set_bounds(&webview, bounds)
}

pub fn webview_navigate<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
    value: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_webview(app, window, raw_label) else {
        return Ok(());
    };
    let url = normalize_url(value)?;
    webview
        .navigate(url)
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn webview_reload<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_webview(app, window, raw_label) else {
        return Ok(());
    };
    webview
        .reload()
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn webview_back<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_webview(app, window, raw_label) else {
        return Ok(());
    };
    webview
        .eval("history.back();")
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn webview_forward<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_webview(app, window, raw_label) else {
        return Ok(());
    };
    webview
        .eval("history.forward();")
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn webview_set_visible<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
    visible: bool,
) -> Result<(), AppError> {
    let Some(webview) = get_webview(app, window, raw_label) else {
        return Ok(());
    };
    let script = if visible {
        "document.documentElement.style.visibility='';document.documentElement.style.pointerEvents='';"
    } else {
        "document.documentElement.style.visibility='hidden';document.documentElement.style.pointerEvents='none';"
    };
    webview
        .eval(script)
        .map_err(|err| AppError::Other(err.to_string()))
}

pub fn webview_destroy<R: Runtime>(
    app: &AppHandle<R>,
    window: &Window<R>,
    raw_label: &str,
) -> Result<(), AppError> {
    let Some(webview) = get_webview(app, window, raw_label) else {
        return Ok(());
    };
    webview
        .close()
        .map_err(|err| AppError::Other(err.to_string()))
}
