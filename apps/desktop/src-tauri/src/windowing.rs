use tauri::{
    menu::{
        AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    },
    AppHandle, Emitter, LogicalPosition, Manager, Runtime, TitleBarStyle, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

pub const NEW_WINDOW_MENU_ID: &str = "new-window";
pub const CLOSE_WINDOW_MENU_ID: &str = "close-window";
pub const OPEN_KEYBOARD_SHORTCUTS_MENU_ID: &str = "open-keyboard-shortcuts";
pub const OPEN_KEYBOARD_SHORTCUTS_EVENT: &str = "lotus://open-keyboard-shortcuts";

pub fn normalize_route(route: Option<&str>) -> String {
    route
        .filter(|route| !route.trim().is_empty())
        .map(|route| route.trim().trim_start_matches('/').to_string())
        .filter(|route| !route.is_empty())
        .unwrap_or_else(|| "index.html".to_string())
}

pub fn create_app_window<R: Runtime>(
    app: &AppHandle<R>,
    route: Option<&str>,
) -> tauri::Result<WebviewWindow<R>> {
    let label = format!("window-{}", uuid::Uuid::new_v4().simple());
    let route = normalize_route(route);

    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(route.into()))
        .title("Lotus")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0);

    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(TitleBarStyle::Overlay)
        .traffic_light_position(LogicalPosition::new(14.0, 16.0));

    let window = builder.build()?;
    apply_windows_chrome(&window);
    Ok(window)
}

/// Windows: drop the native title bar and hide the native menubar row; the webview draws one title
/// row in their place (`WindowsTitleBar.tsx`). The menu stays attached, only hidden, so it can be
/// popped from that row by [`show_window_menu`]. No-op elsewhere.
pub fn apply_windows_chrome<R: Runtime>(window: &WebviewWindow<R>) {
    #[cfg(windows)]
    {
        if let Err(err) = window.set_decorations(false) {
            eprintln!("[windowing] could not drop the native title bar: {err}");
        }
        if let Err(err) = window.hide_menu() {
            eprintln!("[windowing] could not hide the native menubar: {err}");
        }
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Pop the app menu's top-level submenu titled `title` (File, Edit, Window, Help) at window point
/// `x`,`y` (logical px), so the drawn title row reuses the exact items and handlers of
/// [`build_app_menu`].
pub fn show_window_menu<R: Runtime>(
    window: &WebviewWindow<R>,
    title: &str,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let menu = window
        .app_handle()
        .menu()
        .ok_or("the app has no menu")?;
    let submenu = menu
        .items()
        .map_err(|err| err.to_string())?
        .into_iter()
        .filter_map(|item| item.as_submenu().cloned())
        .find(|submenu| submenu.text().is_ok_and(|text| text == title))
        .ok_or_else(|| format!("no {title} menu"))?;
    window
        .popup_menu_at(&submenu, LogicalPosition::new(x, y))
        .map_err(|err| err.to_string())
}

/// Surface a window for an already-running instance: focus one if it exists,
/// otherwise build a fresh one.
///
/// The fallback is the whole point. On macOS, closing the last window does not
/// exit a Tauri app — the process stays alive with zero webview windows. From
/// that state `webview_windows()` is empty, so "focus the existing window" is a
/// silent no-op and the app is unreachable: the Dock shows "Running in
/// Background", relaunching hands off to the windowless instance via the
/// single-instance guard, and nothing ever appears on screen.
pub fn focus_or_create_window<R: Runtime>(app: &AppHandle<R>) {
    // `windows()`, not `webview_windows()`: Tauri drops a window from the latter once it hosts a
    // child webview (browser preview, Canvas Browser, webview pane), so a live window looked absent
    // and every Dock click built a new one.
    if let Some(window) = app.windows().into_values().find(|w| is_app_window_label(w.label())) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    match create_app_window(app, None) {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(err) => eprintln!("[windowing] failed to recreate a window: {err}"),
    }
}

/// Workbench windows only — `main` and `create_app_window`'s `window-*`, never the separate
/// Browser Preview window.
fn is_app_window_label(label: &str) -> bool {
    label == "main" || label.starts_with("window-")
}

pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    let new_window = MenuItem::with_id(
        app,
        NEW_WINDOW_MENU_ID,
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let separator_1 = PredefinedMenuItem::separator(app)?;
    let close_window = MenuItem::with_id(
        app,
        CLOSE_WINDOW_MENU_ID,
        "Close Window",
        true,
        None::<&str>,
    )?;
    let quit = PredefinedMenuItem::quit(app, None)?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_window,
            &separator_1,
            &close_window,
            #[cfg(not(target_os = "macos"))]
            &quit,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &close_window,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::show_all(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[
            &MenuItem::with_id(
                app,
                OPEN_KEYBOARD_SHORTCUTS_MENU_ID,
                "Keyboard Shortcuts",
                true,
                Some("CmdOrCtrl+/"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::about(app, None, Some(about_metadata.clone()))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::show_all(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?,
            &file_menu,
            &edit_menu,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                "View",
                true,
                &[&PredefinedMenuItem::fullscreen(app, None)?],
            )?,
            &window_menu,
            &help_menu,
        ],
    )
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if event.id().as_ref() == NEW_WINDOW_MENU_ID {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(err) = create_app_window(&app, None) {
                eprintln!("failed to create Lotus window: {err}");
            }
        });
        return;
    }

    if event.id().as_ref() == CLOSE_WINDOW_MENU_ID {
        if let Some(window) = app.get_focused_window() {
            if let Err(err) = window.close() {
                eprintln!("failed to close Lotus window from menu: {err}");
            }
        }
        return;
    }

    if event.id().as_ref() == OPEN_KEYBOARD_SHORTCUTS_MENU_ID {
        if let Err(err) = app.emit(OPEN_KEYBOARD_SHORTCUTS_EVENT, ()) {
            eprintln!("failed to emit keyboard shortcuts event: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{is_app_window_label, normalize_route};
    use tauri::{Manager, WebviewBuilder, WebviewUrl, WindowBuilder};

    #[test]
    fn a_window_with_a_child_webview_is_still_found() {
        let app = tauri::test::mock_app();
        let window = WindowBuilder::new(&app, "main").build().unwrap();
        window
            .add_child(
                WebviewBuilder::new("main", WebviewUrl::default()),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(10.0, 10.0),
            )
            .unwrap();
        window
            .add_child(
                WebviewBuilder::new("embedded-browser-preview", WebviewUrl::default()),
                tauri::LogicalPosition::new(0.0, 0.0),
                tauri::LogicalSize::new(10.0, 10.0),
            )
            .unwrap();
        // The bug: this is how the window used to be looked up.
        assert!(app.webview_windows().is_empty());
        assert!(app.windows().into_values().any(|w| is_app_window_label(w.label())));
    }

    #[test]
    fn only_workbench_windows_are_surfaced() {
        assert!(is_app_window_label("main"));
        assert!(is_app_window_label("window-3f2a"));
        assert!(!is_app_window_label(crate::browser_preview::BROWSER_PREVIEW_WINDOW_LABEL));
    }

    #[test]
    fn normalize_route_defaults_to_index_when_missing() {
        assert_eq!(normalize_route(None), "index.html");
        assert_eq!(normalize_route(Some("")), "index.html");
        assert_eq!(normalize_route(Some("   ")), "index.html");
        assert_eq!(normalize_route(Some("/")), "index.html");
    }

    #[test]
    fn normalize_route_strips_leading_slash_and_whitespace() {
        assert_eq!(normalize_route(Some("/teams")), "teams");
        assert_eq!(normalize_route(Some(" /settings ")), "settings");
        assert_eq!(normalize_route(Some("codechat")), "codechat");
    }
}
