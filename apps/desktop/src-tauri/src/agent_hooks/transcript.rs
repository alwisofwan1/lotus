//! Bounded per-pane history of hook events, so Chat mode has a past.
//!
//! **Why this exists, and why the cheap alternative fails.** The open question
//! asked whether the host should retain a transcript or whether Chat mode could
//! simply say "connected 14:02, nothing before that" and point at Terminal. The
//! second reads cheaper until you follow the primary job story:
//!
//! 1. An agent hits a permission prompt. `PreToolUse` fires, writes a drop file,
//!    and **blocks** (ADR-8).
//! 2. The watcher consumes that file, emits it to the sinks, and unlinks it.
//!    `TauriSink` shows it on the desktop; `BroadcastSink` forwards it over SSE.
//!    Neither keeps it.
//! 3. The operator opens the phone. The agent is blocked, so **no further hook
//!    event will ever fire.**
//!
//! So a Chat mode with no history is empty exactly when the product is needed,
//! and the one event that carried the question is the one already thrown away.
//! That is not a limitation worth stating honestly; it is a hole. Hence: retain.
//!
//! Bounded by entry count rather than bytes, because the count is what the UI
//! renders (the last N steps) and the payload clamp already bounds each field.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::payload::DropPayload;

/// Entries kept per pane. A turn is roughly 5-30 events, so this holds a couple
/// of turns: enough to answer "what led to this question".
pub const MAX_ENTRIES_PER_PANE: usize = 60;

/// Panes tracked at once. Bounds memory without needing a pane-death signal:
/// the least recently written pane is dropped when a new one arrives.
pub const MAX_PANES: usize = 32;

/// One answer an agent is offering, in its own words.
///
/// Mirrors `types/question.ts` on the host side, and it is a **mirror on purpose**: the same
/// question reaches the phone down two paths — read from the runner's file here, read from the
/// same file by `packages/host` on a machine with no desktop — and a client draws one card from
/// either. No `key` here: on a cell with a terminal the digits belong to the screen, and one
/// derived from position would answer a different question (ADR-8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestionOption {
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One question, as the agent asked it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestion {
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub multi_select: bool,
    pub options: Vec<UserQuestionOption>,
}

/// One hook event, trimmed to what Chat renders.
///
/// Deliberately not the whole `DropPayload`: `cwd` alone is capped at 4096 bytes
/// and is a property of the session, not of each event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEntry {
    pub event: String,
    pub status: String,
    pub title: String,
    pub body: String,
    pub user_prompt: String,
    pub tool_target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lines_removed: Option<u32>,
    /// Whether `body` stops short of what the agent actually said.
    ///
    /// Carried all the way to the phone rather than dropped here, because Chat renders
    /// `body` as the agent's whole message: without this, a reply clipped at 8000
    /// bytes is indistinguishable from one that simply ended there.
    ///
    /// Skipped when false so the common entry does not grow — the same treatment
    /// `lines_added` gets, and the reason `tool_target` is omitted when empty.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub body_truncated: bool,
    /// The runner's own id for the tool call this entry is about — on the call and on the
    /// result answering it.
    ///
    /// Pairing used to be by tool **name**, which is all a hook drop carries and which cannot
    /// tell two concurrent `Bash` calls apart. Absent from the ring for that reason, and a
    /// reader without it falls back to the name as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// What the operator chose, on the result answering an `AskUserQuestion`.
    ///
    /// Read out of the runner's own sentence, because that is the only record a cell with a
    /// terminal leaves of the answer. Keyed by the question's own text, so it lines up with
    /// [`questions`] without depending on order. Absent on a refused call — `event` is
    /// `tool-post-failed` there, the word the rest of Chat already uses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<HashMap<String, Vec<String>>>,
    /// What an `AskUserQuestion` step is putting to the operator, whole.
    ///
    /// Absent on every other step, and absent rather than empty: a step that asks nothing
    /// must not grow a field on the wire. Present, it is what Chat draws the question card
    /// from — the words are already here, and scraping the terminal for them was the bug.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub questions: Option<Vec<UserQuestion>>,
    pub timestamp: i64,
}

impl TranscriptEntry {
    fn from_payload(payload: &DropPayload) -> Self {
        Self {
            event: payload.event.clone(),
            status: payload.status.clone(),
            title: payload.title.clone(),
            body: payload.body.clone(),
            user_prompt: payload.user_prompt.clone(),
            tool_target: payload.tool_target.clone(),
            lines_added: payload.lines_added,
            lines_removed: payload.lines_removed,
            body_truncated: payload.body_truncated,
            // A hook drop carries no tool input, so the ring cannot know. The file parser
            // does, and it is what serves this route whenever the transcript path is known.
            questions: None,
            tool_call_id: None,
            answers: None,
            timestamp: payload.timestamp,
        }
    }
}

/// The directory holding `marker` on this path — `<root>/projects/<proj>/<id>.jsonl` → `<root>`.
///
/// Matched by walking ancestors rather than by counting components, because the two runners
/// nest to different depths and Codex adds three date directories on top.
fn root_above(path: &Path, marker: &str) -> Option<PathBuf> {
    path.ancestors()
        .find(|dir| dir.file_name().is_some_and(|name| name == marker))
        .and_then(Path::parent)
        .map(Path::to_path_buf)
}

/// Per-pane ring of hook events. Cheap to append, cheap to snapshot.
#[derive(Debug, Default)]
pub struct TranscriptStore {
    panes: HashMap<String, VecDeque<TranscriptEntry>>,
    /// Pane ids in least-recently-written order, for eviction.
    order: VecDeque<String>,
    /// Latest transcript path reported for each pane.
    ///
    /// Kept beside the ring rather than inside each entry, for the reason
    /// `TranscriptEntry` gives about `cwd`: it is a property of the session, identical on
    /// every event, and storing it per entry would repeat a 4KB-capped path sixty times
    /// per pane to say one thing.
    ///
    /// Overwritten rather than appended: a pane that is respawned gets a new session and a
    /// new file, and the old path would point at a conversation that is no longer this
    /// cell's. Only non-empty values overwrite — a hook that omits it must not erase a
    /// path an earlier event in the same session already established.
    transcript_paths: HashMap<String, String>,
}

impl TranscriptStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records an event. Payloads without a pane id are ignored: Pocket addresses
    /// cells by pane, so there is nothing to attach them to.
    pub fn record(&mut self, payload: &DropPayload) {
        let Some(pane_id) = payload.pane_id.as_deref().filter(|p| !p.is_empty()) else {
            return;
        };

        self.touch(pane_id);
        if !payload.transcript_path.is_empty() {
            self.transcript_paths
                .insert(pane_id.to_string(), payload.transcript_path.clone());
        }
        let entries = self.panes.entry(pane_id.to_string()).or_default();
        entries.push_back(TranscriptEntry::from_payload(payload));
        // Fase 0 counters (`plans/session-history-hardening/issues/01`). The doc comment on
        // MAX_ENTRIES_PER_PANE guesses a turn is "roughly 5-30 events"; the gap between the
        // first append and the first eviction replaces that guess with a number. Both are
        // counted because only the pair answers "how many turns does Chat remember".
        crate::session_diagnostics::transcript_appended(pane_id);
        while entries.len() > MAX_ENTRIES_PER_PANE {
            entries.pop_front();
            crate::session_diagnostics::transcript_evicted(pane_id);
        }
        self.evict_overflow();
    }

    /// Where this pane's agent CLI keeps its own conversation, if a hook has said.
    ///
    /// `None` means no event for this pane has reported one — a runner with no hook
    /// pipeline, or a session whose first drop has not landed yet. It deliberately does not
    /// check that the file exists: this store records what was reported, and whether the
    /// path is still readable is the reader's question, asked at read time.
    pub fn transcript_path(&self, pane_id: &str) -> Option<&str> {
        self.transcript_paths.get(pane_id).map(String::as_str)
    }

    /// Config roots this instance has actually seen a transcript in.
    ///
    /// A pane with no hook yet has to be *searched* for, and searching needs roots. Reading
    /// them from settings only ever finds the profile Lotus itself was launched under — a
    /// pane where somebody ran `ccs initech` or set `CLAUDE_CONFIG_DIR` by hand writes
    /// somewhere Lotus was never told about, and stays blank until the agent speaks again.
    ///
    /// So the roots are **learned rather than guessed**: every path a hook has reported names
    /// its own root, one directory above the `projects/` or `sessions/` it sits under. That is
    /// evidence, and it costs nothing to keep — the paths are already here. It also means no
    /// knowledge of any particular profile manager is baked in; whatever wrote a transcript
    /// once is searched for the next one.
    ///
    /// `marker` is the store directory the runner uses, which is what makes a root a root.
    pub fn known_roots(&self, marker: &str) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = Vec::new();
        for path in self.transcript_paths.values() {
            let Some(root) = root_above(Path::new(path), marker) else {
                continue;
            };
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
        roots
    }

    /// Oldest-first, so the UI renders top to bottom without reversing.
    pub fn snapshot(&self, pane_id: &str) -> Vec<TranscriptEntry> {
        self.panes
            .get(pane_id)
            .map(|entries| entries.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// No `forget(pane_id)` on purpose. The pane cap already bounds memory, so a
    /// pane-death signal would be a second thing to wire and a second thing to get
    /// wrong — and letting a just-exited cell keep its last steps is useful:
    /// Chat can still show why it stopped.
    #[cfg(test)]
    fn tracked_panes(&self) -> usize {
        self.panes.len()
    }

    fn touch(&mut self, pane_id: &str) {
        self.order.retain(|id| id != pane_id);
        self.order.push_back(pane_id.to_string());
    }

    fn evict_overflow(&mut self) {
        while self.order.len() > MAX_PANES {
            if let Some(oldest) = self.order.pop_front() {
                self.panes.remove(&oldest);
                // Evicted with the pane, or the map outlives every ring it describes and
                // grows without bound across a long-running app.
                self.transcript_paths.remove(&oldest);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The cross-language half of the contract.** These names are read by
    /// `packages/host`'s `TranscriptEntry` and by the phone, so a Rust-side rename is a
    /// silent drop on the wire rather than a compile error anywhere.
    #[test]
    fn a_question_serialises_under_the_names_the_phone_reads() {
        let entry = TranscriptEntry {
            event: "tool-pre".into(),
            status: "running".into(),
            title: "AskUserQuestion".into(),
            body: String::new(),
            user_prompt: String::new(),
            tool_target: "Tabs or spaces?".into(),
            lines_added: None,
            lines_removed: None,
            body_truncated: false,
            questions: Some(vec![UserQuestion {
                question: "Tabs or spaces?".into(),
                header: Some("Indentation".into()),
                multi_select: false,
                options: vec![
                    UserQuestionOption {
                        label: "Spaces".into(),
                        description: Some("Indent with spaces.".into()),
                    },
                    UserQuestionOption { label: "Tabs".into(), description: None },
                ],
            }]),
            tool_call_id: Some("toolu_9".into()),
            answers: None,
            timestamp: 1,
        };

        let json = serde_json::to_value(&entry).expect("serialises");
        let asked = &json["questions"][0];
        assert_eq!(asked["question"], "Tabs or spaces?");
        assert_eq!(asked["header"], "Indentation");
        assert_eq!(asked["options"][0]["label"], "Spaces");
        assert_eq!(asked["options"][0]["description"], "Indent with spaces.");
        // Absent rather than null: an option with nothing written under it must not draw
        // a blank line, and `multiSelect: false` is what an absent field already means.
        assert!(asked["options"][1].get("description").is_none());
        assert!(asked.get("multiSelect").is_none());
        // The id the result pairs against, under the name the other two readers use.
        assert_eq!(json["toolCallId"], "toolu_9");
    }

    /// A step that asks nothing must not grow a field on the wire.
    #[test]
    fn an_ordinary_step_carries_no_questions_key() {
        let entry = TranscriptEntry::from_payload(&payload(Some("p-1"), "stop", "", 1));
        let json = serde_json::to_value(&entry).expect("serialises");
        assert!(json.get("questions").is_none());
    }

    /// Fase 3 (`plans/session-history-hardening/issues/04`). The path is what lets a reader
    /// reach history the 60-entry ring cannot hold, so losing it is losing the feature.
    /// The point of learning roots: a pane whose agent ran under a profile Lotus was never
    /// told about still names its own root, because the path says where it is.
    #[test]
    fn a_root_is_learned_from_a_path_lotus_never_configured() {
        let mut store = TranscriptStore::new();
        let mut p = payload(Some("p-1"), "stop", "", 1);
        p.transcript_path = "/Users/x/.ccs/instances/initech/projects/repo/abc.jsonl".into();
        store.record(&p);
        assert_eq!(
            store.known_roots("projects"),
            vec![PathBuf::from("/Users/x/.ccs/instances/initech")]
        );
    }

    /// Codex nests three date directories deeper, so a root cannot be found by counting
    /// components — only by finding the store directory itself.
    #[test]
    fn a_codex_root_is_found_through_its_date_directories() {
        let mut store = TranscriptStore::new();
        let mut p = payload(Some("p-1"), "stop", "", 1);
        p.transcript_path = "/Users/x/.codex/sessions/2026/08/13/rollout-a-b.jsonl".into();
        store.record(&p);
        assert_eq!(
            store.known_roots("sessions"),
            vec![PathBuf::from("/Users/x/.codex")]
        );
        // Asking with the other runner's marker finds nothing rather than a wrong root.
        assert!(store.known_roots("projects").is_empty());
    }

    #[test]
    fn each_root_is_listed_once_however_many_panes_share_it() {
        let mut store = TranscriptStore::new();
        for (pane, path) in [
            ("p-1", "/r/a/projects/one/x.jsonl"),
            ("p-2", "/r/a/projects/two/y.jsonl"),
            ("p-3", "/r/b/projects/three/z.jsonl"),
        ] {
            let mut p = payload(Some(pane), "stop", "", 1);
            p.transcript_path = path.into();
            store.record(&p);
        }
        let mut roots = store.known_roots("projects");
        roots.sort();
        assert_eq!(roots, vec![PathBuf::from("/r/a"), PathBuf::from("/r/b")]);
    }

    /// A path with no store directory in it is not turned into a root by guesswork.
    #[test]
    fn a_path_that_names_no_store_yields_no_root() {
        let mut store = TranscriptStore::new();
        let mut p = payload(Some("p-1"), "stop", "", 1);
        p.transcript_path = "/tmp/stray.jsonl".into();
        store.record(&p);
        assert!(store.known_roots("projects").is_empty());
    }

    #[test]
    fn the_transcript_path_is_remembered_per_pane() {
        let mut store = TranscriptStore::new();
        let mut p = payload(Some("p-1"), "stop", "", 1);
        p.transcript_path = "/x/.codex/sessions/rollout-a.jsonl".into();
        store.record(&p);
        assert_eq!(
            store.transcript_path("p-1"),
            Some("/x/.codex/sessions/rollout-a.jsonl")
        );
        assert_eq!(store.transcript_path("p-2"), None, "unknown pane says so");
    }

    /// A hook that omits the path must not erase one an earlier event established: tool
    /// events and stop events do not all carry the same fields, and Chat would lose its
    /// reader on the next `PreToolUse`.
    #[test]
    fn an_event_without_a_path_leaves_the_known_one_alone() {
        let mut store = TranscriptStore::new();
        let mut first = payload(Some("p-1"), "stop", "", 1);
        first.transcript_path = "/x/a.jsonl".into();
        store.record(&first);
        store.record(&payload(Some("p-1"), "tool-pre", "", 2));
        assert_eq!(store.transcript_path("p-1"), Some("/x/a.jsonl"));
    }

    /// A respawned pane is a new session writing a new file, and serving the old path
    /// would hand a reader a conversation that is no longer this cell's.
    #[test]
    fn a_new_path_replaces_the_old_one() {
        let mut store = TranscriptStore::new();
        let mut first = payload(Some("p-1"), "stop", "", 1);
        first.transcript_path = "/x/old.jsonl".into();
        store.record(&first);
        let mut second = payload(Some("p-1"), "stop", "", 2);
        second.transcript_path = "/x/new.jsonl".into();
        store.record(&second);
        assert_eq!(store.transcript_path("p-1"), Some("/x/new.jsonl"));
    }

    /// Evicted with its pane, or the map outlives every ring it describes.
    #[test]
    fn the_path_is_evicted_with_the_pane() {
        let mut store = TranscriptStore::new();
        for i in 0..(MAX_PANES + 4) {
            let pane = format!("p-{i}");
            let mut p = payload(Some(&pane), "stop", "", i as i64);
            p.transcript_path = format!("/x/{i}.jsonl");
            store.record(&p);
        }
        assert_eq!(
            store.transcript_path("p-0"),
            None,
            "oldest pane's path is gone"
        );
        assert!(store
            .transcript_path(&format!("p-{}", MAX_PANES + 3))
            .is_some());
    }

    fn payload(pane: Option<&str>, event: &str, target: &str, ts: i64) -> DropPayload {
        DropPayload {
            version: 1,
            session_id: Some("s1".into()),
            agent_type: "claude".into(),
            event: event.into(),
            status: "running".into(),
            title: "Bash".into(),
            body: String::new(),
            user_prompt: String::new(),
            tool_target: target.into(),
            lines_added: None,
            lines_removed: None,
            body_truncated: false,
            transcript_path: String::new(),
            cwd: "/tmp".into(),
            pid: None,
            agent_pid: None,
            pane_id: pane.map(str::to_string),
            timestamp: ts,
        }
    }

    #[test]
    fn records_and_returns_events_oldest_first() {
        let mut store = TranscriptStore::new();
        store.record(&payload(Some("p-1"), "tool-pre", "ls", 1));
        store.record(&payload(Some("p-1"), "tool-post", "cat", 2));

        let snapshot = store.snapshot("p-1");

        assert_eq!(snapshot.len(), 2);
        assert_eq!(
            snapshot[0].tool_target, "ls",
            "oldest first, so the UI need not reverse"
        );
        assert_eq!(snapshot[1].tool_target, "cat");
    }

    #[test]
    fn keeps_panes_separate() {
        let mut store = TranscriptStore::new();
        store.record(&payload(Some("p-1"), "tool-pre", "one", 1));
        store.record(&payload(Some("p-2"), "tool-pre", "two", 2));

        assert_eq!(store.snapshot("p-1").len(), 1);
        assert_eq!(store.snapshot("p-2")[0].tool_target, "two");
    }

    /// Several canvas agents share one project cwd, so a payload with no pane id
    /// cannot be attributed to a cell. Storing it under a guess would show one
    /// agent's steps inside another's transcript.
    #[test]
    fn ignores_payloads_with_no_pane_id() {
        let mut store = TranscriptStore::new();
        store.record(&payload(None, "tool-pre", "ls", 1));
        store.record(&payload(Some(""), "tool-pre", "ls", 2));

        assert_eq!(store.tracked_panes(), 0);
    }

    #[test]
    fn drops_the_oldest_entry_past_the_cap() {
        let mut store = TranscriptStore::new();
        for i in 0..(MAX_ENTRIES_PER_PANE as i64 + 10) {
            store.record(&payload(Some("p-1"), "tool-pre", &format!("cmd-{i}"), i));
        }

        let snapshot = store.snapshot("p-1");

        assert_eq!(snapshot.len(), MAX_ENTRIES_PER_PANE);
        assert_eq!(
            snapshot[0].tool_target, "cmd-10",
            "the first ten fell off the front"
        );
        assert_eq!(
            snapshot.last().unwrap().timestamp,
            MAX_ENTRIES_PER_PANE as i64 + 9
        );
    }

    /// Bounds memory without needing a pane-death signal, which would otherwise
    /// be a second thing to wire and a second thing to get wrong.
    #[test]
    fn evicts_the_least_recently_written_pane_past_the_pane_cap() {
        let mut store = TranscriptStore::new();
        for i in 0..MAX_PANES {
            store.record(&payload(Some(&format!("p-{i}")), "tool-pre", "x", 1));
        }
        // Touch the first pane so it is no longer the least recent.
        store.record(&payload(Some("p-0"), "tool-pre", "again", 2));

        store.record(&payload(Some("p-new"), "tool-pre", "y", 3));

        assert_eq!(store.tracked_panes(), MAX_PANES);
        assert!(
            !store.snapshot("p-0").is_empty(),
            "recently written pane survives"
        );
        assert!(
            store.snapshot("p-1").is_empty(),
            "least recent pane was evicted"
        );
    }

    #[test]
    fn snapshot_of_an_unknown_pane_is_empty_not_an_error() {
        assert!(TranscriptStore::new().snapshot("nope").is_empty());
    }

    /// The wire shape crosses into the mobile façade and the `contract/` fixtures,
    /// so the casing is pinned rather than left to serde defaults being remembered.
    /// The counts are the payoff of the capture spike, so their path from payload
    /// to wire is pinned rather than assumed.
    #[test]
    fn diff_counts_reach_the_wire_and_absent_ones_are_omitted() {
        let mut with = payload(Some("p-1"), "tool-post", "src/app.ts", 1);
        with.lines_added = Some(3);
        with.lines_removed = Some(1);
        let without = payload(Some("p-1"), "tool-pre", "ls", 2);

        let a = serde_json::to_value(TranscriptEntry::from_payload(&with)).unwrap();
        let b = serde_json::to_value(TranscriptEntry::from_payload(&without)).unwrap();

        assert_eq!(a["linesAdded"], 3);
        assert_eq!(a["linesRemoved"], 1);
        // Omitted, not zero: a step with no diff must not render "+0 -0".
        assert!(b.get("linesAdded").is_none(), "got {b}");
        assert!(b.get("linesRemoved").is_none());
    }

    #[test]
    fn entry_serializes_camel_case() {
        let entry = TranscriptEntry::from_payload(&payload(Some("p-1"), "tool-pre", "ls", 7));

        let json = serde_json::to_value(&entry).unwrap();

        assert_eq!(json["toolTarget"], "ls");
        assert_eq!(json["userPrompt"], "");
        assert_eq!(json["timestamp"], 7);
        assert!(
            json.get("tool_target").is_none(),
            "snake_case must not leak"
        );
    }
}
