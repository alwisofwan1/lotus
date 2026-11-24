//! v1 drop-file payload struct + parser.
//!
//! The producer (Node hook script) is the source of truth for field shapes;
//! this module validates and defensively re-clamps on the consumer side so a
//! misbehaving script can't break the watcher loop or push oversized strings
//! into the Tauri event bus.

use serde::{Deserialize, Serialize};

/// The schema version this consumer accepts. Bump in lockstep with the
/// producer when introducing breaking changes.
pub const PAYLOAD_VERSION: u32 = 1;

// Caps mirror the schema doc. We re-apply them defensively in case the
// producer was ever bypassed.
const TITLE_MAX: usize = 200;
/// Raised from 1000 on 2026-08-07, and the number came from counting rather than
/// taste: across 279 real assistant messages, **15.8% were longer than 1000 bytes**
/// — roughly one reply in six was being cut mid-word — while 8000 covers 97.1%.
/// The rest now say so through `body_truncated` instead of just stopping.
///
/// Cost is bounded: only `stop` events carry a body at all (tool events send an
/// empty string), and the per-pane ring holds 60 entries.
const BODY_MAX: usize = 8000;
const USER_PROMPT_MAX: usize = 4000;
const TOOL_TARGET_MAX: usize = 300;
const CWD_MAX: usize = 4096;
/// Same ceiling as [`CWD_MAX`]: both are filesystem paths, and one longer than this is a
/// symptom rather than a session worth pointing at.
const TRANSCRIPT_PATH_MAX: usize = 4096;
const AGENT_TYPE_MAX: usize = 32;
const EVENT_MAX: usize = 32;
const STATUS_MAX: usize = 16;
const SESSION_ID_MAX: usize = 256;

/// Deserialized v1 drop payload. Field order matches the on-disk JSON for
/// readable serialization in tests and Tauri events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropPayload {
    pub version: u32,
    pub session_id: Option<String>,
    pub agent_type: String,
    pub event: String,
    pub status: String,
    pub title: String,
    pub body: String,
    pub user_prompt: String,
    /// Salient argument of a tool call (`rm src/legacy/shim.ts`), extracted by the
    /// hook script so no consumer needs to know each tool's argument schema.
    ///
    /// Additive on purpose, and the version deliberately did NOT move with it:
    /// this struct sets no `deny_unknown_fields`, so a new producer against an old
    /// consumer is ignored and an old producer against a new one gets the default.
    /// A bump would break both of those, and `mcp_config.rs` still emits
    /// `"version":1` from a shell template.
    #[serde(default)]
    pub tool_target: String,
    /// Lines a tool added / removed, when it changed lines at all.
    ///
    /// `None` rather than `0`: "changed nothing" and "no diff applies here" are
    /// different claims, and a `Read` step must not render "+0 -0". Shapes were
    /// verified by capture, not inferred — see `payload-extractors.mjs`.
    #[serde(default)]
    pub lines_added: Option<u32>,
    #[serde(default)]
    pub lines_removed: Option<u32>,
    /// Whether [`BODY_MAX`] cut [`Self::body`] short.
    ///
    /// A flag rather than an ellipsis byte, deliberately. The cap is applied twice —
    /// once by the hook script, once here — and the whole reason the second pass is
    /// safe is that truncation is *idempotent*: re-clamping an already-clamped string
    /// is a no-op. Appending "…" would break that, because the second pass would then
    /// be clamping a string the first pass had already modified. A boolean composes
    /// instead: this pass ORs its own result into whatever the producer reported.
    ///
    /// Additive like [`Self::tool_target`], so the version stays 1.
    #[serde(default)]
    pub body_truncated: bool,
    /// Absolute path of the agent CLI's **own** conversation transcript, when the hook
    /// reports one. Empty when it does not.
    ///
    /// This is the pointer Fase 3 is built on. Everything else in this struct comes from a
    /// hook event, and hook events are what the 60-entry ring holds — Fase 0 measured 11.7%
    /// of them evicted and fourteen restarts each starting Chat empty. The file this names
    /// has neither limit: it is written by the CLI, survives restarts, and is not clamped
    /// by `BODY_MAX`.
    ///
    /// A property of the session rather than of the event, like [`Self::cwd`] — every drop
    /// in a session repeats it. Carried on each drop anyway, because a hook fires with no
    /// handshake and the consumer has nowhere else to learn it.
    ///
    /// Additive like [`Self::tool_target`], so [`PAYLOAD_VERSION`] stays 1.
    #[serde(default)]
    pub transcript_path: String,
    pub cwd: String,
    pub pid: Option<i64>,
    pub agent_pid: Option<i64>,
    /// Canvas pane correlation (LOTUS_PANE_ID) — several canvas agents share one cwd, so this is
    /// the only unambiguous key. Absent on codespace/external drop files (serde default).
    #[serde(default)]
    pub pane_id: Option<String>,
    pub timestamp: i64,
}

impl DropPayload {
    /// Apply hard length caps to every string field. Idempotent.
    fn clamp(mut self) -> Self {
        truncate_in_place(&mut self.agent_type, AGENT_TYPE_MAX);
        truncate_in_place(&mut self.event, EVENT_MAX);
        truncate_in_place(&mut self.status, STATUS_MAX);
        truncate_in_place(&mut self.title, TITLE_MAX);
        // OR, never assign: a producer that already clamped reports it, and this pass
        // finding nothing left to cut must not erase that.
        self.body_truncated |= truncate_in_place(&mut self.body, BODY_MAX);
        // Fase 0 counter (`plans/session-history-hardening/issues/01`). Every body is
        // measured, not just the cut ones — see `session_diagnostics::body_seen` for why a
        // count of truncations taken here would read zero and be wrong.
        if !self.body.is_empty() {
            crate::session_diagnostics::body_seen(
                &self.agent_type,
                &self.event,
                self.body.len() as u64,
                self.body_truncated,
            );
        }
        truncate_in_place(&mut self.user_prompt, USER_PROMPT_MAX);
        truncate_in_place(&mut self.tool_target, TOOL_TARGET_MAX);
        truncate_in_place(&mut self.transcript_path, TRANSCRIPT_PATH_MAX);
        truncate_in_place(&mut self.cwd, CWD_MAX);
        if let Some(sid) = self.session_id.as_mut() {
            truncate_in_place(sid, SESSION_ID_MAX);
        }
        self
    }
}

/// Why parsing a drop file failed. Each variant maps to a distinct watcher
/// behavior: some indicate corruption (unlink the file), others indicate a
/// transient issue (retry once).
#[derive(Debug, thiserror::Error)]
pub enum DropPayloadError {
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("unsupported payload version {actual} (expected {expected})")]
    UnsupportedVersion { actual: u32, expected: u32 },
    #[error("missing or empty required field: {0}")]
    MissingField(&'static str),
}

/// Parse a UTF-8 JSON byte slice into a validated [`DropPayload`].
///
/// Returns [`DropPayloadError::UnsupportedVersion`] for forward-compatible
/// drops we don't understand yet — the watcher unlinks those files and logs
/// rather than spinning on them.
pub fn parse_drop_payload(raw: &[u8]) -> Result<DropPayload, DropPayloadError> {
    let payload: DropPayload = serde_json::from_slice(raw)?;
    if payload.version != PAYLOAD_VERSION {
        return Err(DropPayloadError::UnsupportedVersion {
            actual: payload.version,
            expected: PAYLOAD_VERSION,
        });
    }
    if payload.agent_type.trim().is_empty() {
        return Err(DropPayloadError::MissingField("agentType"));
    }
    if payload.event.trim().is_empty() {
        return Err(DropPayloadError::MissingField("event"));
    }
    if payload.status.trim().is_empty() {
        return Err(DropPayloadError::MissingField("status"));
    }
    Ok(payload.clamp())
}

/// Clamps `s` to `max` bytes, returning whether anything was actually removed.
///
/// The bool is what lets `body` say it was cut. Every other field discards it —
/// a clipped `cwd` or `title` is cosmetic, while a clipped assistant message is a
/// sentence that stops mid-word and reads as if the agent stopped there.
fn truncate_in_place(s: &mut String, max: usize) -> bool {
    if s.len() <= max {
        return false;
    }
    // `truncate` requires a char boundary; find the last boundary <= max so
    // we never split a multibyte UTF-8 sequence.
    let mut cut = max;
    while !s.is_char_boundary(cut) && cut > 0 {
        cut -= 1;
    }
    s.truncate(cut);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The field is additive, so the version does not move. That is the whole
    /// reason a bump would be wrong here: `DropPayload` sets no
    /// `deny_unknown_fields`, so an old consumer ignores it and a new consumer
    /// defaults it. Bumping would turn a compatible change into a breaking one in
    /// BOTH directions, and `mcp_config.rs` still emits `"version":1` from a
    /// shell template.
    #[test]
    fn tool_target_is_additive_so_old_payloads_still_parse() {
        let without = serde_json::json!({
            "version": 1,
            "sessionId": "s1",
            "agentType": "claude",
            "event": "tool-pre",
            "status": "running",
            "title": "Bash",
            "body": "",
            "userPrompt": "",
            "cwd": "/tmp",
            "pid": null,
            "agentPid": null,
            "timestamp": 1
        })
        .to_string();

        let parsed = parse_drop_payload(without.as_bytes()).expect("v1 without the field parses");

        assert_eq!(parsed.tool_target, "");
    }

    #[test]
    fn tool_target_round_trips_when_present() {
        let with = serde_json::json!({
            "version": 1,
            "sessionId": "s1",
            "agentType": "claude",
            "event": "tool-pre",
            "status": "running",
            "title": "Bash",
            "body": "",
            "userPrompt": "",
            "toolTarget": "rm src/legacy/shim.ts",
            "cwd": "/tmp",
            "pid": null,
            "agentPid": null,
            "timestamp": 1
        })
        .to_string();

        let parsed = parse_drop_payload(with.as_bytes()).expect("parse");

        assert_eq!(parsed.tool_target, "rm src/legacy/shim.ts");
    }

    /// The producer already caps at 300, but the caps here exist because the
    /// producer can be bypassed — a hand-written drop file, or a future runner.
    #[test]
    fn tool_target_is_clamped_even_when_the_producer_was_bypassed() {
        let json = serde_json::json!({
            "version": 1,
            "sessionId": "s1",
            "agentType": "claude",
            "event": "tool-pre",
            "status": "running",
            "title": "Bash",
            "body": "",
            "userPrompt": "",
            "toolTarget": "x".repeat(5000),
            "cwd": "/tmp",
            "pid": null,
            "agentPid": null,
            "timestamp": 1
        })
        .to_string();

        let parsed = parse_drop_payload(json.as_bytes()).expect("parse");

        assert!(
            parsed.tool_target.len() <= 300,
            "got {}",
            parsed.tool_target.len()
        );
    }

    /// Forward compatibility in the other direction: a producer newer than this
    /// consumer must not be rejected for sending fields we have not heard of.
    #[test]
    fn unknown_fields_are_ignored_rather_than_rejected() {
        let json = serde_json::json!({
            "version": 1,
            "sessionId": "s1",
            "agentType": "claude",
            "event": "tool-pre",
            "status": "running",
            "title": "Bash",
            "body": "",
            "userPrompt": "",
            "toolDiffStat": "+12 -3",
            "somethingFromNextYear": { "nested": true },
            "cwd": "/tmp",
            "pid": null,
            "agentPid": null,
            "timestamp": 1
        })
        .to_string();

        assert!(parse_drop_payload(json.as_bytes()).is_ok());
    }

    fn minimal_v1_json() -> String {
        serde_json::json!({
            "version": 1,
            "sessionId": "abc-123",
            "agentType": "claude",
            "event": "stop",
            "status": "idle",
            "title": "Finished working",
            "body": "Done.",
            "userPrompt": "do thing",
            "cwd": "/tmp/proj",
            "pid": 999,
            "agentPid": 998,
            "timestamp": 1_714_000_000_000_i64,
        })
        .to_string()
    }

    #[test]
    fn parses_minimal_v1_payload() {
        let payload = parse_drop_payload(minimal_v1_json().as_bytes()).expect("parse");
        assert_eq!(payload.version, 1);
        assert_eq!(payload.session_id.as_deref(), Some("abc-123"));
        assert_eq!(payload.agent_type, "claude");
        assert_eq!(payload.event, "stop");
        assert_eq!(payload.status, "idle");
        assert_eq!(payload.title, "Finished working");
        assert_eq!(payload.body, "Done.");
        assert_eq!(payload.user_prompt, "do thing");
        assert_eq!(payload.cwd, "/tmp/proj");
        assert_eq!(payload.pid, Some(999));
        assert_eq!(payload.agent_pid, Some(998));
        assert_eq!(payload.timestamp, 1_714_000_000_000);
    }

    #[test]
    fn parses_pane_id_and_defaults_it_when_absent() {
        // Canvas hooks carry LOTUS_PANE_ID; older/codespace drop files omit the field entirely —
        // both must parse (serde default), since the watcher processes whatever is on disk.
        let with_pane = serde_json::json!({
            "version": 1, "sessionId": "abc", "agentType": "claude", "event": "stop",
            "status": "idle", "title": "", "body": "", "userPrompt": "", "cwd": "",
            "pid": null, "agentPid": null, "paneId": "node-atlas-1",
            "timestamp": 0,
        })
        .to_string();
        let payload = parse_drop_payload(with_pane.as_bytes()).expect("parse");
        assert_eq!(payload.pane_id.as_deref(), Some("node-atlas-1"));

        let without = parse_drop_payload(minimal_v1_json().as_bytes()).expect("parse");
        assert!(without.pane_id.is_none());
    }

    #[test]
    fn null_session_id_is_accepted() {
        let json = serde_json::json!({
            "version": 1,
            "sessionId": null,
            "agentType": "claude",
            "event": "stop",
            "status": "idle",
            "title": "",
            "body": "",
            "userPrompt": "",
            "cwd": "",
            "pid": null,
            "agentPid": null,
            "timestamp": 0,
        })
        .to_string();
        let payload = parse_drop_payload(json.as_bytes()).expect("parse");
        assert!(payload.session_id.is_none());
        assert!(payload.pid.is_none());
        assert!(payload.agent_pid.is_none());
    }

    #[test]
    fn rejects_invalid_json() {
        let err = parse_drop_payload(b"not json {").unwrap_err();
        assert!(matches!(err, DropPayloadError::Json(_)));
    }

    #[test]
    fn rejects_unknown_version() {
        let json = serde_json::json!({
            "version": 99,
            "sessionId": null,
            "agentType": "claude",
            "event": "stop",
            "status": "idle",
            "title": "",
            "body": "",
            "userPrompt": "",
            "cwd": "",
            "pid": null,
            "agentPid": null,
            "timestamp": 0,
        })
        .to_string();
        let err = parse_drop_payload(json.as_bytes()).unwrap_err();
        match err {
            DropPayloadError::UnsupportedVersion { actual, expected } => {
                assert_eq!(actual, 99);
                assert_eq!(expected, PAYLOAD_VERSION);
            }
            other => panic!("expected UnsupportedVersion, got {other:?}"),
        }
    }

    #[test]
    fn rejects_missing_agent_type() {
        let json = serde_json::json!({
            "version": 1,
            "sessionId": null,
            "agentType": "",
            "event": "stop",
            "status": "idle",
            "title": "",
            "body": "",
            "userPrompt": "",
            "cwd": "",
            "pid": null,
            "agentPid": null,
            "timestamp": 0,
        })
        .to_string();
        let err = parse_drop_payload(json.as_bytes()).unwrap_err();
        assert!(matches!(err, DropPayloadError::MissingField("agentType")));
    }

    #[test]
    fn rejects_missing_event() {
        let json = serde_json::json!({
            "version": 1,
            "sessionId": null,
            "agentType": "claude",
            "event": "  ",
            "status": "idle",
            "title": "",
            "body": "",
            "userPrompt": "",
            "cwd": "",
            "pid": null,
            "agentPid": null,
            "timestamp": 0,
        })
        .to_string();
        let err = parse_drop_payload(json.as_bytes()).unwrap_err();
        assert!(matches!(err, DropPayloadError::MissingField("event")));
    }

    #[test]
    fn defensively_clamps_oversized_strings() {
        let json = serde_json::json!({
            "version": 1,
            "sessionId": "s".repeat(500),
            "agentType": "claude".to_string() + &"X".repeat(100),
            "event": "stop",
            "status": "idle",
            "title": "T".repeat(500),
            // Comfortably past BODY_MAX, so this stays a clamp test as the cap moves.
            "body": "B".repeat(BODY_MAX * 2),
            "userPrompt": "P".repeat(10_000),
            "cwd": "/".to_string() + &"x".repeat(10_000),
            "pid": null,
            "agentPid": null,
            "timestamp": 0,
        })
        .to_string();
        let payload = parse_drop_payload(json.as_bytes()).expect("parse");
        assert_eq!(payload.title.len(), TITLE_MAX);
        assert_eq!(payload.body.len(), BODY_MAX);
        assert_eq!(payload.user_prompt.len(), USER_PROMPT_MAX);
        assert!(payload.cwd.len() <= CWD_MAX);
        assert!(payload.agent_type.len() <= AGENT_TYPE_MAX);
        assert!(payload.session_id.as_ref().unwrap().len() <= SESSION_ID_MAX);
        assert!(payload.body_truncated, "a body this pass cut must say so");
    }

    fn payload_json(body: &str, body_truncated: Option<bool>) -> String {
        let mut json = serde_json::json!({
            "version": 1,
            "sessionId": "s1",
            "agentType": "claude",
            "event": "stop",
            "status": "idle",
            "title": "Finished working",
            "body": body,
            "userPrompt": "",
            "cwd": "/tmp",
            "pid": null,
            "agentPid": null,
            "timestamp": 0,
        });
        if let Some(flag) = body_truncated {
            json["bodyTruncated"] = serde_json::Value::Bool(flag);
        }
        json.to_string()
    }

    /// The common case, and the one that must not grow a false positive: a reply
    /// well inside the cap is not truncated, and says so.
    #[test]
    fn a_body_inside_the_cap_is_not_flagged() {
        let payload = parse_drop_payload(payload_json("short enough", None).as_bytes()).unwrap();

        assert!(!payload.body_truncated);
        assert_eq!(payload.body, "short enough");
    }

    /// The reason the flag is ORed rather than assigned. The producer clamps first,
    /// so by the time this pass sees the string there is nothing left to cut — and a
    /// consumer that wrote its own result over the producer's would erase the fact.
    #[test]
    fn a_producer_that_already_clamped_keeps_its_flag_through_this_pass() {
        let already = "B".repeat(BODY_MAX);
        let payload = parse_drop_payload(payload_json(&already, Some(true)).as_bytes()).unwrap();

        assert_eq!(
            payload.body.len(),
            BODY_MAX,
            "nothing left for this pass to cut"
        );
        assert!(payload.body_truncated, "the producer's report survived");
    }

    /// Old producer, new consumer: the field is absent and defaults to false rather
    /// than failing the parse. This is what lets the version stay 1.
    #[test]
    fn a_payload_without_the_field_still_parses() {
        let payload = parse_drop_payload(payload_json("no flag here", None).as_bytes()).unwrap();

        assert!(!payload.body_truncated);
    }

    /// Clamping twice must land in the same place, which is the property that makes
    /// the defensive second pass safe. An ellipsis byte would have broken it — hence
    /// a boolean.
    #[test]
    fn clamping_is_idempotent() {
        let big = "B".repeat(BODY_MAX * 2);
        let once = parse_drop_payload(payload_json(&big, None).as_bytes())
            .unwrap()
            .body;
        let twice = parse_drop_payload(payload_json(&once, None).as_bytes())
            .unwrap()
            .body;

        assert_eq!(once, twice);
    }

    #[test]
    fn truncate_respects_utf8_char_boundaries() {
        // 4-byte emoji at byte position 0..4. If we naively truncate to byte
        // 2 we'd produce invalid UTF-8 / panic. Confirm we land on a
        // boundary.
        let mut s = "🦀🦀🦀🦀🦀".to_string(); // 5 emoji × 4 bytes = 20 bytes
        truncate_in_place(&mut s, 6);
        // Should land on a 4-byte boundary at or before 6.
        assert!(s.len() <= 6);
        assert!(s.is_char_boundary(s.len()));
    }

    #[test]
    fn round_trips_through_json_unchanged() {
        let payload = parse_drop_payload(minimal_v1_json().as_bytes()).expect("parse");
        let serialized = serde_json::to_string(&payload).expect("serialize");
        let reparsed = parse_drop_payload(serialized.as_bytes()).expect("reparse");
        assert_eq!(payload, reparsed);
    }
}
