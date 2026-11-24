//! Unsaved editor edits per window, so ⌘Q does not throw them away without asking.
//!
//! Editor buffers live only in each webview's memory. Closing one window is guarded in the
//! webview (`onCloseRequested`), but quitting the app skips every window's close handler: it
//! arrives here as `RunEvent::ExitRequested`. Each window reports how many files it holds
//! unsaved; a user quit while any are held is stopped and handed to that window to ask.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

/// The event a window gets when a quit was stopped for its unsaved files (payload: the count).
pub const QUIT_BLOCKED_EVENT: &str = "lotus://quit-blocked-unsaved";

fn registry() -> &'static Mutex<HashMap<String, u32>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn report(window_label: &str, count: u32) {
    let mut map = registry().lock().unwrap_or_else(|poison| poison.into_inner());
    if count == 0 {
        map.remove(window_label);
    } else {
        map.insert(window_label.to_string(), count);
    }
}

/// A destroyed window's edits are gone with it (its own close handler already asked).
pub fn forget(window_label: &str) {
    report(window_label, 0);
}

/// The window holding the most unsaved files, and the total over every window.
fn worst_window() -> Option<(String, u32)> {
    let map = registry().lock().unwrap_or_else(|poison| poison.into_inner());
    let total: u32 = map.values().sum();
    map.iter()
        .max_by_key(|(_, count)| **count)
        .map(|(label, _)| (label.clone(), total))
}

/// On a user quit: true when it must be stopped. The window with the most unsaved files is
/// brought forward and told, and asks; its answer quits through [`quit_discarding`].
pub fn should_block_quit(app: &AppHandle) -> bool {
    let Some((label, total)) = worst_window() else {
        return false;
    };
    let Some(window) = app.get_webview_window(&label) else {
        // A label with no window left: nothing can ask, so do not hold the quit hostage.
        forget(&label);
        return should_block_quit(app);
    };
    eprintln!("[editor] quit stopped: {total} unsaved file(s), asking in window {label}");
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit(QUIT_BLOCKED_EVENT, total);
    true
}

/// The user chose to quit and lose the unsaved edits.
pub fn quit_discarding(app: &AppHandle) {
    registry()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .clear();
    // Through `terminate:` again, so running agents are still asked about.
    crate::quit_guard::request_quit(app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_keeps_a_count_per_window_and_zero_removes_it() {
        report("test-a", 2);
        report("test-b", 5);
        let (label, total) = worst_window().unwrap();
        assert_eq!(label, "test-b");
        assert!(total >= 7);
        report("test-b", 0);
        forget("test-a");
        let map = registry().lock().unwrap();
        assert!(!map.contains_key("test-a") && !map.contains_key("test-b"));
    }
}
