//! Every command the webview can reach must also be a command it is allowed to call.
//!
//! Two lists describe that, by hand, in two languages: `generate_handler!` in `lib.rs` registers
//! them, and `permissions/main-app-commands.toml` permits them. Nothing makes the two agree — a
//! command registered but not permitted compiles, passes every Rust test (they call the functions
//! directly), passes typecheck, and then fails in the running app with
//! `<name> not allowed. Command not found`.
//!
//! That is exactly how `vault_list_tickets` shipped. This test is the thing that was missing.

/// Everything from `marker` to the end of its line, removed.
fn strip_line_comments(text: &str, marker: &str) -> String {
    text.lines()
        .map(|line| match line.find(marker) {
            Some(at) => &line[..at],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The names inside `tauri::generate_handler![ … ]`, as `lib.rs` writes them.
fn registered_commands() -> Vec<String> {
    let source = include_str!("lib.rs");
    let start = source
        .find("generate_handler![")
        .expect("lib.rs registers commands with generate_handler!");
    let body = &source[start + "generate_handler![".len()..];
    let end = body.find(']').expect("the handler list is closed");

    // Comments are stripped per LINE before anything is split on commas. Both lists carry them,
    // and an entry-wise filter silently eats the first name after every comment — which is how the
    // first version of this test reported `create_session` as unregistered.
    strip_line_comments(&body[..end], "//")
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| entry.rsplit("::").next().unwrap_or(entry).trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

/// The names inside `commands.allow = [ … ]` of the first-party permission set.
fn permitted_commands() -> Vec<String> {
    let manifest = include_str!("../permissions/main-app-commands.toml");
    let start = manifest
        .find("commands.allow")
        .expect("the manifest permits commands");
    let body = &manifest[start..];
    let open = body.find('[').expect("the allow list opens");
    let close = body.find(']').expect("the allow list closes");

    strip_line_comments(&body[open + 1..close], "#")
        .split(',')
        .map(|entry| entry.trim().trim_matches('"').trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// Registered but not permitted, and left that way on purpose.
///
/// Every one of these has zero callers in the frontend, so nothing is broken by them today: they
/// are commands exposed to a webview that never asks. The right fix is probably to drop them from
/// `generate_handler!` rather than to widen the allowlist, and that is a decision for whoever owns
/// them — widening an ACL is not a tidy-up. Listed here so the guard can be strict about NEW gaps
/// from its first day.
const KNOWN_UNPERMITTED: &[&str] = &[
    "read_scrollback",
    "editor_rename_entry",
    "editor_rename_entry_ssh",
    "browser_preview_emit_annotation",
    "emit_canvas_browser_tool_result",
];

/// Permitted but no longer registered: dead text in the manifest, harmless, and the same two
/// lists drifting. Recorded rather than deleted for the same reason as above.
const KNOWN_STALE_PERMISSIONS: &[&str] = &[
    "close_all_sessions",
    "create_team",
    "update_team",
    "list_tasks",
    "create_task",
    "list_logs",
    "read_log_chunk",
];

#[test]
fn every_registered_command_is_permitted() {
    let permitted = permitted_commands();
    let missing: Vec<String> = registered_commands()
        .into_iter()
        .filter(|name| !permitted.contains(name))
        .filter(|name| !KNOWN_UNPERMITTED.contains(&name.as_str()))
        .collect();

    assert!(
        missing.is_empty(),
        "registered in generate_handler! but absent from permissions/main-app-commands.toml, \
         so the webview will be told \"not allowed. Command not found\": {missing:?}"
    );
}

/// The reverse is a smaller problem — a permitted command that no longer exists is dead text, not
/// a broken feature — but it is the same list drifting, and it is free to notice.
#[test]
fn every_permitted_command_is_registered() {
    let registered = registered_commands();
    let stale: Vec<String> = permitted_commands()
        .into_iter()
        .filter(|name| !registered.contains(name))
        .filter(|name| !KNOWN_STALE_PERMISSIONS.contains(&name.as_str()))
        .collect();

    assert!(
        stale.is_empty(),
        "permitted in main-app-commands.toml but no longer registered: {stale:?}"
    );
}
