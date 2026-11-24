//! Event → status mapping, for producers that cannot compute it themselves.
//!
//! **Why this exists at all.** The canonical table lives in
//! `apps/desktop/scripts/agent-notify/event-mapping.mjs`, whose own comment says the watcher trusts
//! what the script writes and never re-derives status. That is right for the local hook, which is a
//! node script and can afford the lookup.
//!
//! A hook on a remote machine cannot. It is `sh` and `curl` on purpose — the whole reason
//! `packages/host` chose the same shape is that a hook needing node makes agent status depend on a
//! runtime nobody installed. A `case` statement in that script would be a **third** copy of this
//! table, drifting silently the first time one of them changed.
//!
//! So the remote script sends the event and leaves status blank, and this fills it in. The table is
//! duplicated exactly once, in Rust, and [`tests::the_rust_table_matches_the_javascript_one`] reads
//! the JavaScript file and fails if the two ever disagree — which is the only way a duplicate stays
//! honest.

/// `(status, default title)` for an event name. Case-insensitive, whitespace-tolerant.
///
/// An unknown event falls back to `idle` / "Update", exactly as the JavaScript does: a producer we
/// do not recognise is still telling us something happened.
pub fn event_status(event: &str) -> (&'static str, &'static str) {
    match event.trim().to_ascii_lowercase().as_str() {
        "stop" | "agent-response" | "after-agent" => ("idle", "Finished working"),
        "notification" | "needs-input" => ("needs-input", "Needs input"),
        "error" => ("error", "Error"),
        "session-start" | "before-agent" => ("running", "Working"),
        "prompt-submit" => ("running", "You"),
        "session-end" => ("ended", "Session ended"),
        "tool-pre" | "tool-post" | "tool-post-failed" => ("running", "Tool"),
        _ => ("idle", "Update"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The duplicate this module admits to, held equal by reading the original.
    ///
    /// Not a spot check: every row of the JavaScript table is parsed and compared, so an entry added
    /// or reworded there fails here until this table follows.
    #[test]
    fn the_rust_table_matches_the_javascript_one() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../scripts/agent-notify/event-mapping.mjs"
        );
        let source = std::fs::read_to_string(path).expect("read event-mapping.mjs");

        let mut rows = 0;
        for line in source.lines() {
            let Some(rest) = line.trim().strip_prefix("[\"") else {
                continue;
            };
            let Some((event, tail)) = rest.split_once('"') else {
                continue;
            };
            let Some(status) = between(tail, "status: \"", "\"") else {
                continue;
            };
            let Some(title) = between(tail, "defaultTitle: \"", "\"") else {
                continue;
            };
            rows += 1;

            let (rust_status, rust_title) = event_status(event);
            assert_eq!(
                (rust_status, rust_title),
                (status.as_str(), title.as_str()),
                "event {event:?} disagrees with event-mapping.mjs"
            );
        }

        assert!(
            rows >= 12,
            "parsed only {rows} rows from event-mapping.mjs — the parser, not the table, is wrong"
        );
    }

    fn between(haystack: &str, open: &str, close: &str) -> Option<String> {
        let start = haystack.find(open)? + open.len();
        let rest = &haystack[start..];
        let end = rest.find(close)?;
        Some(rest[..end].to_string())
    }

    #[test]
    fn an_unknown_event_is_still_something_that_happened() {
        assert_eq!(event_status("who-knows"), ("idle", "Update"));
        assert_eq!(event_status(""), ("idle", "Update"));
    }

    #[test]
    fn it_reads_an_event_the_way_a_shell_would_have_written_it() {
        assert_eq!(event_status("  STOP  ").0, "idle");
        assert_eq!(event_status("Tool-Post").0, "running");
    }

    /// A tool event must never arrive as `idle` or `error`: CodeSpace filters that stream on status
    /// alone, reading `idle` as "the agent finished" and `error` as "the agent failed", so either
    /// one would mislabel the whole agent on every tool call.
    #[test]
    fn a_tool_event_stays_running_whatever_happened_to_the_tool() {
        for event in ["tool-pre", "tool-post", "tool-post-failed"] {
            assert_eq!(event_status(event).0, "running", "{event}");
        }
    }
}
