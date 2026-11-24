use serde::Serialize;

/// Events pushed from the Lotus desktop to SSE subscribers via
/// `GET /api/notifications/stream`.
///
/// The `#[serde(tag = "kind")]` attribute adds a `kind` string field so
/// clients can switch on event type without unwrapping nested objects.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotificationEvent {
    /// An agent process exited (or emitted a completion hook via the drop-file
    /// mechanism).  `pane_id` and `workspace_id` are resolved from the fleet
    /// snapshot at emit time — both are `None` for ephemeral bridge sessions.
    AgentStop {
        #[serde(skip_serializing_if = "Option::is_none")]
        pane_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        /// Provider string from the drop-file payload (e.g. `claude`, `codex`).
        agent_type: String,
        /// Hook event that produced this (`tool-pre`, `tool-post`, `stop`, …).
        ///
        /// Added because every drop payload arrives as this one variant, so
        /// without it a subscriber cannot tell a tool step from a session start:
        /// both carry `status: "running"`. Consumers that filter on `status`
        /// alone keep working, since JSON ignores fields it does not read.
        event: String,
        /// CLI session id, when the hook payload carried one.
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        /// Short display title from the hook payload.
        title: String,
        /// Longer body text from the hook payload.
        body: String,
        /// Whether `body` was cut by the 8000-byte cap.
        ///
        /// Forwarded because a subscriber that renders `body` as the agent's own
        /// words (Pocket's Chat) otherwise cannot tell a clipped reply from a
        /// finished one. Omitted when false so the common event does not grow.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        body_truncated: bool,
        /// The user prompt the agent is working on.
        ///
        /// Added 2026-08-07 so one forwarded event carries everything one Chat line
        /// needs — without it a phone rebuilding the transcript live loses the "you
        /// asked" bubble until it refetches over HTTP.
        ///
        /// Cheaper than it looks, and that was measured rather than assumed: the hook
        /// scripts read this from the payload's `prompt` key, which only
        /// `UserPromptSubmit` carries — every `tool-pre` / `tool-post` leaves it
        /// empty, and empty is omitted. So it rides once per turn, not once per tool
        /// call, which is what makes it affordable on a metered link.
        #[serde(default, skip_serializing_if = "String::is_empty")]
        user_prompt: String,
        /// Lines a tool added / removed, when it changed lines at all.
        ///
        /// `None` rather than `0` — "changed nothing" and "no diff applies" are
        /// different claims, and a `Read` step must never render `+0 −0`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines_added: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        lines_removed: Option<u32>,
        /// Agent-reported completion status (e.g. `idle`, `error`).
        status: String,
        /// Salient argument of a tool call (`rm src/legacy/shim.ts`).
        ///
        /// Omitted when empty so non-tool events do not grow. Without it the
        /// extraction the hook script performs would stop at the desktop, and a
        /// phone could only render the tool's name.
        #[serde(skip_serializing_if = "String::is_empty")]
        tool_target: String,
        /// Working directory the agent was running in.
        cwd: String,
        /// Unix epoch milliseconds from the drop-file `timestamp` field.
        timestamp: i64,
    },

    /// A fleet cell has produced no PTY output for longer than the configured
    /// stall threshold.  Emitted by the 30 s background ticker in `lib.rs`.
    CellStalled {
        pane_id: String,
        workspace_id: String,
        session_id: String,
        /// Milliseconds since the cell last produced any output.
        idle_ms: u64,
        /// Unix epoch milliseconds when this event was generated.
        timestamp: i64,
    },

    /// The broadcast channel dropped events — the consumer fell too far behind.
    /// Subscribers should re-fetch the current fleet state to resync.
    Lagged { missed: u64 },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_stop(event: &str, tool_target: &str) -> NotificationEvent {
        NotificationEvent::AgentStop {
            pane_id: Some("p-1".into()),
            workspace_id: None,
            agent_type: "claude".into(),
            event: event.into(),
            tool_target: tool_target.into(),
            session_id: None,
            title: "Bash".into(),
            body: String::new(),
            body_truncated: false,
            user_prompt: String::new(),
            lines_added: None,
            lines_removed: None,
            status: "running".into(),
            cwd: "/tmp".into(),
            timestamp: 1,
        }
    }

    /// Pins the wire shape, because this crosses a process boundary: the mobile
    /// façade consumes it over SSE and `contract/` fixtures are generated from it.
    #[test]
    fn agent_stop_carries_event_and_tool_target() {
        let json = serde_json::to_value(agent_stop("tool-pre", "rm src/legacy/shim.ts")).unwrap();

        assert_eq!(json["kind"], "agent_stop");
        assert_eq!(json["event"], "tool-pre");
        assert_eq!(json["tool_target"], "rm src/legacy/shim.ts");
    }

    /// A turn-end event has no tool argument, and emitting `"tool_target": ""`
    /// on every one of them would be noise on a metered mobile connection.
    #[test]
    fn empty_tool_target_is_omitted_rather_than_sent_blank() {
        let json = serde_json::to_value(agent_stop("stop", "")).unwrap();

        assert!(
            json.get("tool_target").is_none(),
            "expected the key to be absent, got {json}"
        );
        assert_eq!(
            json["event"], "stop",
            "event is always present, unlike the target"
        );
    }

    /// A forwarded event has to carry everything one Chat line needs, or a client
    /// rebuilding the transcript live silently loses parts of it until it refetches.
    #[test]
    fn a_turn_carries_its_prompt_and_diff_so_one_event_is_a_whole_chat_line() {
        let json = serde_json::to_value(NotificationEvent::AgentStop {
            pane_id: Some("p-1".into()),
            workspace_id: None,
            agent_type: "claude".into(),
            event: "tool-post".into(),
            tool_target: "src/legacy/shim.ts".into(),
            session_id: None,
            title: "Edit".into(),
            body: String::new(),
            body_truncated: false,
            user_prompt: "delete the shim".into(),
            lines_added: Some(0),
            lines_removed: Some(34),
            status: "running".into(),
            cwd: "/tmp".into(),
            timestamp: 1,
        })
        .unwrap();

        assert_eq!(json["user_prompt"], "delete the shim");
        // Zero is a real count here and must survive: an Edit that removed 34 lines
        // and added none is `+0 −34`, not a missing field.
        assert_eq!(json["lines_added"], 0);
        assert_eq!(json["lines_removed"], 34);
    }

    /// The additions must not cost anything on the event that fires most often.
    #[test]
    fn an_ordinary_tool_step_sends_none_of_the_new_fields() {
        let json = serde_json::to_value(agent_stop("tool-pre", "ls")).unwrap();

        // `user_prompt` is only populated by `UserPromptSubmit`, so it rides once per
        // turn rather than once per tool call — but only if empty means absent.
        assert!(json.get("user_prompt").is_none(), "got {json}");
        assert!(json.get("lines_added").is_none(), "got {json}");
        assert!(json.get("lines_removed").is_none(), "got {json}");
        assert!(json.get("body_truncated").is_none(), "got {json}");
    }

    /// A clipped reply has to announce itself, or it reads as a finished one.
    #[test]
    fn a_truncated_body_says_so_on_the_wire() {
        let mut event = agent_stop("stop", "");
        if let NotificationEvent::AgentStop {
            body,
            body_truncated,
            ..
        } = &mut event
        {
            *body = "a".repeat(8000);
            *body_truncated = true;
        }

        let json = serde_json::to_value(&event).unwrap();

        assert_eq!(json["body_truncated"], true);
    }

    /// The reason `event` had to be added: every drop payload becomes this one
    /// variant, so `status` alone cannot separate a tool step from a session
    /// start. Both say "running".
    #[test]
    fn status_alone_cannot_distinguish_a_tool_step_from_a_session_start() {
        let tool = serde_json::to_value(agent_stop("tool-pre", "ls")).unwrap();
        let start = serde_json::to_value(agent_stop("session-start", "")).unwrap();

        assert_eq!(
            tool["status"], start["status"],
            "status is identical, by design"
        );
        assert_ne!(
            tool["event"], start["event"],
            "which is why event has to be there"
        );
    }
}
