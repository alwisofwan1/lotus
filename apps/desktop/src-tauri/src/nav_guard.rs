//! Refuses a main window's page from being replaced after its first load (release builds only).
//!
//! A page load reaps every PTY session of the window (`on_page_load` in lib.rs), so an unrequested
//! reload kills every running agent. On 2026-11-15 15:25 a JS-initiated main-frame load did exactly
//! that, and left WebKit's mouse queue stuck. Nothing in Lotus replaces the main page on purpose
//! (routing is client-side), so the guard refuses it and records `page.blocked` with the url.

use std::collections::HashSet;
use std::sync::Mutex;
use tauri::{Runtime, Url, Webview};

/// Window labels whose first page load already went through.
static LOADED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("nav-guard")
        .on_navigation(|webview: &Webview<R>, next: &Url| {
            // Child webviews (canvas browser, panes, preview) navigate freely.
            if webview.label() != webview.window().label() {
                return true;
            }
            let first = LOADED
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_or_insert_with(HashSet::new)
                .insert(webview.label().to_string());
            let current = webview.url().ok();
            let ok = allow(cfg!(debug_assertions), first, current.as_ref(), next);
            if !ok {
                eprintln!("[nav-guard] blocked main-page load: {next}");
                crate::session_diagnostics::main_page_blocked(next.as_str());
            }
            ok
        })
        .build()
}

/// The window was destroyed: a new one with the same label gets its first load again.
pub fn forget(label: &str) {
    if let Some(set) = LOADED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        set.remove(label);
    }
}

/// wry asks for iframe loads too, without saying which frame. So only a load of the app's own
/// page (same scheme, host and port: never a `blob:` PDF or the `127.0.0.1` music player) that is
/// not a fragment jump within the current document is refused.
fn allow(dev: bool, first: bool, current: Option<&Url>, next: &Url) -> bool {
    if dev || first {
        return true;
    }
    let Some(cur) = current else { return true };
    if (cur.scheme(), cur.host_str(), cur.port()) != (next.scheme(), next.host_str(), next.port()) {
        return true;
    }
    let base = |u: &Url| {
        let mut u = u.clone();
        u.set_fragment(None);
        u
    };
    base(cur) == base(next) && cur.fragment() != next.fragment()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn refuses_a_reload_or_new_document_of_the_app_page() {
        let cur = u("tauri://localhost/code");
        assert!(!allow(false, false, Some(&cur), &u("tauri://localhost/code")));
        assert!(!allow(false, false, Some(&cur), &u("tauri://localhost/chat")));
    }

    #[test]
    fn allows_first_load_dev_fragments_and_other_origins() {
        let cur = u("tauri://localhost/code");
        assert!(allow(false, true, Some(&cur), &u("tauri://localhost/code")));
        assert!(allow(true, false, Some(&cur), &u("tauri://localhost/code")));
        assert!(allow(false, false, Some(&cur), &u("tauri://localhost/code#top")));
        assert!(allow(false, false, Some(&cur), &u("blob:tauri://localhost/1f2e")));
        assert!(allow(false, false, Some(&cur), &u("http://127.0.0.1:4545/api/music/youtube-player")));
        assert!(allow(false, false, Some(&cur), &u("https://www.youtube.com/embed/x")));
        assert!(allow(false, false, Some(&cur), &u("about:blank")));
    }
}
