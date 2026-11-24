//! Reads an agent CLI's **own** conversation transcript — the durable history behind
//! `DropPayload::transcript_path`.
//!
//! **Why this exists.** Everything else in `agent_hooks` describes hook events, and hook
//! events are what the 60-entry ring holds. Fase 0 measured what that costs: 11.7% of
//! entries evicted, and fourteen app restarts each starting Chat empty because the store is
//! in memory. The files this module reads have neither limit — the CLI writes them, they
//! survive restarts, and nothing clamps them to `BODY_MAX`.
//!
//! **One reader per runner, not one parser.** ADR-2 of `plans/session-history-hardening`
//! predicted the formats would differ, and inspecting real files confirmed it:
//!
//! | | Claude | Codex |
//! |---|---|---|
//! | line kinds | `user`, `assistant` (+ `attachment`, `ai-title`, …) | `event_msg`, `response_item`, `session_meta`, … |
//! | prompt | `user` with string `message.content` | `event_msg` / `user_message`, or 0.15x `item_completed` / `UserMessage` |
//! | prose | `assistant` block `type: "text"` | `event_msg` / `agent_message`, or 0.15x `item_completed` / `AgentMessage` |
//!
//! Cursor (`~/.cursor/projects/*/agent-transcripts/<id>/<id>.jsonl`) is a third column with
//! Claude's block shapes but no `type` on the line and no timestamps — see [`push_cursor`].
//! | tool call | `assistant` block `type: "tool_use"` | `response_item` / `custom_tool_call` |
//!
//! Both were read from live files rather than documentation, and both carry a top-level
//! ISO-8601 `timestamp`.
//!
//! **Output is [`TranscriptEntry`], the shape Chat already renders.** Mapping into the
//! existing vocabulary rather than inventing a richer one means Pocket needs no new
//! renderer to show history it previously could not reach — the client change is which
//! endpoint it calls, not how it draws.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value;

use super::transcript::{TranscriptEntry, UserQuestion};

/// Which runner wrote a transcript file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptFormat {
    Claude,
    Codex,
    /// `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` — Cursor CLI.
    ///
    /// Learned from the hook payload, not installed for: Cursor executes the **Claude-format**
    /// hooks in `~/.claude/settings.json` (probe 2026-08-27: `PreToolUse`/`PostToolUse` fired
    /// for `cursor-agent -p` and reported `transcript_path` into this directory), while
    /// entries written to `~/.cursor/hooks.json` never ran — user-level, project-level, or a
    /// clean file with `type: "command"`, three probes, zero executions on 2026.08.25. So
    /// there is no Cursor installer; this reader is what turns the path Cursor already
    /// reports into a Chat.
    Cursor,
}

impl TranscriptFormat {
    /// Lines sniffed before giving up. Enough to clear the preamble both CLIs write —
    /// Claude opens with `mode` and `file-history-snapshot`, Codex with `session_meta` —
    /// and small enough that a 7MB transcript is not parsed twice to answer one question.
    const SNIFF_LINES: usize = 200;

    /// Which runner wrote this, read from the **content**.
    ///
    /// **Was read from the path, and that was wrong.** The first version keyed on `/.claude/`
    /// or `/.codex/` appearing in the path, which assumes the CLI's default config directory.
    /// This app explicitly supports the opposite: `CLAUDE_CONFIG_DIR` points spawned agents at
    /// a profile directory (`settings::spawned_agent_claude_dir`), and a live device test found
    /// a real transcript under `~/.ccs/instances/acme/projects/…` — a Claude file the path
    /// rule refused to recognise, so Chat silently fell back to the empty ring.
    ///
    /// Content cannot be wrong the way a path convention can. `None` still means "cannot
    /// tell" rather than a default, for the reason it always did: reading one format with the
    /// other's parser yields an empty transcript, which is indistinguishable from a quiet
    /// session.
    pub fn sniff(text: &str) -> Option<Self> {
        for line in text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .take(Self::SNIFF_LINES)
        {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
            match kind {
                // Claude names the speaker and carries the turn under `message`.
                "user" | "assistant" if value.get("message").is_some() => {
                    return Some(Self::Claude)
                }
                // Codex names the record and carries everything under `payload`.
                "event_msg" | "response_item" | "session_meta"
                    if value.get("payload").is_some() =>
                {
                    return Some(Self::Codex)
                }
                // Cursor has no `type` on a message line at all: `role` names the speaker and
                // `message` carries Anthropic-shaped blocks. Its only typed line is
                // `turn_ended`, which says nothing about who wrote the file.
                "" if value.get("message").is_some()
                    && matches!(
                        value.get("role").and_then(Value::as_str),
                        Some("user" | "assistant")
                    ) =>
                {
                    return Some(Self::Cursor)
                }
                _ => {}
            }
        }
        None
    }
}

/// Where a Claude session's transcript would be, found without a hook having said.
///
/// **Closes the restart gap.** `transcript_path` is otherwise only ever *learned*, from a
/// drop file — so a desktop restart leaves Chat empty for a session whose transcript is
/// sitting on disk, until the agent happens to speak again. Fase 0 counted fourteen
/// restarts in one measurement window; that is fourteen times Chat was blank for no
/// reason a reader could see.
///
/// **Found by scanning for the id, not by rebuilding the directory name.** Claude encodes a
/// cwd into a directory by replacing `/` and `.` with `-`
/// (`/Users/x/.claude-mem/observer` → `-Users-x--claude-mem-observer`), and reproducing that
/// means owning a rule this app does not control — a path with a space or a colon would
/// silently miss. A session id is a UUID and unique, so one glob over the project
/// directories answers the same question without imitating anything.
///
/// `roots` are the config directories this app already knows (`~/.claude` plus whatever
/// `CLAUDE_CONFIG_DIR` names). A profile Lotus was not launched under is not searched — the
/// hook path still covers that, which is why this is a fallback rather than a replacement.
pub fn derive_claude_path(
    roots: &[std::path::PathBuf],
    session_id: &str,
) -> Option<std::path::PathBuf> {
    if session_id.is_empty() {
        return None;
    }
    let file = format!("{session_id}.jsonl");
    for root in roots {
        let Ok(projects) = std::fs::read_dir(root.join("projects")) else {
            continue;
        };
        for entry in projects.flatten() {
            let candidate = entry.path().join(&file);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Where a Codex session's transcript is, found by walking its date-partitioned tree.
///
/// **Cannot be computed the way Claude's can.** Codex names a file
/// `sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`, so the id alone does not give a
/// path — the timestamp and the date directories are unknowable from it. `session_index.jsonl`
/// looked like the answer and is not: it carries `id`, `thread_name` and `updated_at`, no
/// path, and held 31 entries against 858 files on this machine.
///
/// So it walks, newest-first. The date directories are zero-padded numbers, which makes
/// descending name order chronological for free, and a session worth resuming is usually a
/// recent one — so the common case exits after a few `read_dir` calls. Measured over those
/// 858 files: **360µs to find today's session, 13.8ms for a miss**, which walks everything.
/// A miss is the honest cost, and it is paid once when a chat opens, not per poll.
pub fn derive_codex_path(
    roots: &[std::path::PathBuf],
    session_id: &str,
) -> Option<std::path::PathBuf> {
    if session_id.is_empty() {
        return None;
    }
    roots
        .iter()
        .find_map(|root| newest_first_find(&root.join("sessions"), session_id, CODEX_TREE_DEPTH))
}

/// `sessions/YYYY/MM/DD/` — three directory levels above the files.
const CODEX_TREE_DEPTH: usize = 3;

/// Where a Cursor conversation's transcript would be: `<root>/projects/*/agent-transcripts/<id>/<id>.jsonl`.
///
/// One glob over the project slugs, for the reason `derive_claude_path` gives — the slug
/// encodes a cwd by a rule this app does not own (`Users-x-workspace-…`, no leading dash,
/// unlike Claude's), and the conversation id is unique on its own.
pub fn derive_cursor_path(roots: &[std::path::PathBuf], conversation_id: &str) -> Option<std::path::PathBuf> {
    if conversation_id.is_empty() {
        return None;
    }
    let leaf = format!("{conversation_id}.jsonl");
    for root in roots {
        let Ok(projects) = std::fs::read_dir(root.join("projects")) else {
            continue;
        };
        for project in projects.flatten() {
            let candidate = project
                .path()
                .join("agent-transcripts")
                .join(conversation_id)
                .join(&leaf);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn newest_first_find(dir: &Path, needle: &str, depth: usize) -> Option<std::path::PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            if depth == 0 {
                continue;
            }
            if let Some(found) = newest_first_find(&path, needle, depth - 1) {
                return Some(found);
            }
        } else if path.extension().is_some_and(|ext| ext == "jsonl")
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.contains(needle))
        {
            return Some(path);
        }
    }
    None
}

/// One page of a transcript, oldest-first — the order Chat renders top to bottom.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub entries: Vec<TranscriptEntry>,
    /// Index of the oldest entry returned, and the cursor a client passes back as `before`
    /// to walk further into the past.
    ///
    /// An index rather than a timestamp because these files are append-only, which makes an
    /// index stable across reads — and because hook timestamps are known to collide inside
    /// one millisecond (`LiveTranscript::_keyOf` documents the same hazard on the phone).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_cursor: Option<usize>,
    /// Whether anything older exists. The honest counterpart to a page that simply came
    /// back short.
    pub has_more: bool,
    /// Entries the file holds in total — the number `total` in the ring response cannot
    /// give, because it only ever counted what it returned.
    pub total_ever: usize,
}

/// Parse an entire transcript file into Chat's vocabulary, oldest-first.
///
/// Takes the text rather than the path so the mapping is testable against captured
/// fixtures without a filesystem. Malformed lines are skipped rather than fatal: these
/// files are appended to by a live process, so the last line can be half-written at the
/// exact moment a reader arrives.
#[cfg(test)]
pub fn parse(text: &str, format: TranscriptFormat) -> Vec<TranscriptEntry> {
    parse_at(text, format, 0)
}

/// [`parse`], with the file's modification time for a format that records no timestamps.
///
/// Cursor writes none — not on a line, not in the file. Chat sorts by timestamp and the
/// phone dedupes on it, so zero everywhere would collapse a session into one instant and
/// shuffle it. The entries are stamped **backwards from `end_ms`, one millisecond apart**,
/// which keeps their order and puts the last one at the moment the file was last written —
/// the only clock these files carry. It is ordering dressed as time, and the reader is told
/// so here rather than left to trust the digits. Formats that carry real timestamps ignore it.
pub fn parse_at(text: &str, format: TranscriptFormat, end_ms: i64) -> Vec<TranscriptEntry> {
    let mut out = Vec::new();
    let mut calls = CodexCalls { names: Default::default() };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match format {
            TranscriptFormat::Claude => push_claude(&value, &mut out),
            TranscriptFormat::Codex => push_codex(&value, &mut calls, &mut out),
            TranscriptFormat::Cursor => push_cursor(&value, &mut out),
        }
    }
    if matches!(format, TranscriptFormat::Cursor) {
        let n = out.len() as i64;
        for (i, entry) in out.iter_mut().enumerate() {
            entry.timestamp = end_ms - (n - 1 - i as i64);
        }
    }
    out
}

/// Take one page ending just before `before`, newest page first when `before` is `None`.
///
/// Pagination is applied after parsing the whole file rather than while reading it. That is
/// deliberate for now and worth knowing: a transcript is a few MB at most, and slicing a
/// parsed list is obviously correct, where a streaming reader that seeks would have to get
/// line boundaries right against a file being appended to. If these files ever grow enough
/// for that to matter, the cursor being an index is what makes the smarter version possible
/// without changing the wire shape.
pub fn page(all: Vec<TranscriptEntry>, before: Option<usize>, limit: usize) -> TranscriptPage {
    let total_ever = all.len();
    let limit = limit.max(1);
    let end = before.unwrap_or(total_ever).min(total_ever);
    let start = end.saturating_sub(limit);
    let entries: Vec<TranscriptEntry> = all[start..end].to_vec();
    TranscriptPage {
        oldest_cursor: (!entries.is_empty()).then_some(start),
        has_more: start > 0,
        total_ever,
        entries,
    }
}

// ── Claude ────────────────────────────────────────────────────────────────────────────

fn push_claude(value: &Value, out: &mut Vec<TranscriptEntry>) {
    let at = iso_to_ms(value.get("timestamp").and_then(Value::as_str).unwrap_or(""));
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(message) = value.get("message") else {
        return;
    };

    match kind {
        "user" => match message.get("content") {
            // A plain string is the operator typing. A list is tool results being fed
            // back — Claude sends those as user messages too, which is why content shape
            // decides the meaning here rather than `type`.
            Some(Value::String(text)) if !text.trim().is_empty() => {
                out.push(prompt_entry(text, at));
            }
            Some(Value::Array(blocks)) => {
                for block in blocks {
                    // A `text` block here is either the operator typing while a tool ran, or the
                    // CLI's own note that they pressed Esc. The second ends the turn, and it is
                    // the **only** record of that: no `stop` follows an interrupted call.
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        let said = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if said.trim().is_empty() {
                            continue;
                        }
                        out.push(if said.starts_with("[Request interrupted by user") {
                            interrupted_entry(at)
                        } else {
                            prompt_entry(said, at)
                        });
                        continue;
                    }
                    if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                        continue;
                    }
                    // `is_error` is what Esc leaves behind on a question, and what a refused
                    // tool leaves on any other call — one word for both.
                    let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                    let mut entry =
                        tool_entry(if failed { "tool-post-failed" } else { "tool-post" }, "", "", at);
                    entry.tool_call_id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .filter(|id| !id.is_empty())
                        .map(str::to_string);
                    if !failed {
                        entry.answers = answers_from_result(block.get("content"));
                    }
                    out.push(entry);
                }
            }
            _ => {}
        },
        "assistant" => {
            let Some(blocks) = message.get("content").and_then(Value::as_array) else {
                return;
            };
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    // Skipped on purpose: `thinking` is not what Chat renders, and it is
                    // the largest thing in these files by volume.
                    Some("thinking") => {}
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.trim().is_empty() {
                            out.push(prose_entry(text, at));
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                        let asked = claude_questions(name, block);
                        let target = match asked.as_ref().and_then(|q| q.first()) {
                            Some(first) => one_line(&first.question),
                            None => claude_tool_target(block),
                        };
                        let mut entry = tool_entry("tool-pre", name, &target, at);
                        entry.questions = asked;
                        entry.tool_call_id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .map(str::to_string);
                        out.push(entry);
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// The salient argument of a Claude tool call, chosen the same way
/// `payload-extractors.mjs` chooses it — so a step read from the file and the same step
/// read from a hook do not describe themselves differently.
fn claude_tool_target(block: &Value) -> String {
    let Some(input) = block.get("input") else {
        return String::new();
    };
    for key in ["command", "file_path", "path", "pattern", "url", "prompt"] {
        if let Some(text) = input.get(key).and_then(Value::as_str) {
            if !text.is_empty() {
                return one_line(text);
            }
        }
    }
    String::new()
}

/// The same shape a Codex `turn_aborted` takes, so one rule closes the turn for both.
fn interrupted_entry(at: i64) -> TranscriptEntry {
    let mut entry = tool_entry("error", "Interrupted", "interrupted", at);
    entry.status = "error".into();
    entry
}

/// The answers inside a question's own result — `"Q"="A"`, one pair per question.
///
/// The CLI writes two openings for the same thing ("The user answered:" and "Your questions
/// have been answered:"), so the pairs are read rather than the sentence around them. `None`
/// when there are none: an ordinary tool's result is prose, and an empty map here would make
/// every completed call look like a question answered with nothing.
fn answers_from_result(content: Option<&Value>) -> Option<HashMap<String, Vec<String>>> {
    let text = content?.as_str()?;
    let mut answers: HashMap<String, Vec<String>> = HashMap::new();
    let mut rest = text;
    // `"question"="answer"`, scanned rather than matched with a regex: this crate carries no
    // regex dependency, and the shape is fixed enough that a scanner says it more plainly.
    while let Some(open) = rest.find('"') {
        let after_open = &rest[open + 1..];
        let Some(close) = after_open.find('"') else { break };
        let question = &after_open[..close];
        let tail = &after_open[close + 1..];
        rest = tail;
        if !tail.starts_with("=\"") {
            continue;
        }
        let value = &tail[2..];
        let Some(end) = value.find('"') else { break };
        if !question.is_empty() {
            answers.insert(question.to_string(), vec![value[..end].to_string()]);
        }
        rest = &value[end + 1..];
    }
    (!answers.is_empty()).then_some(answers)
}

/// What an `AskUserQuestion` call is asking, straight out of the tool's own input.
///
/// `None` for every other tool, and for a call whose input this build cannot read: a question
/// half-read is worse than a step that says only the tool's name, because the card would then
/// offer options the agent did not write.
fn claude_questions(name: &str, block: &Value) -> Option<Vec<UserQuestion>> {
    if name != "AskUserQuestion" {
        return None;
    }
    let asked: Vec<UserQuestion> = block
        .get("input")?
        .get("questions")?
        .as_array()?
        .iter()
        .filter_map(|q| serde_json::from_value::<UserQuestion>(q.clone()).ok())
        .collect();
    (!asked.is_empty()).then_some(asked)
}

// ── Cursor ────────────────────────────────────────────────────────────────────────────

/// One Cursor line. Verbatim shapes from a live probe, 2026-08-27:
///
/// ```text
/// {"role":"user","message":{"content":[{"type":"text","text":"<timestamp>…</timestamp>\n<user_query>\nRun …\n</user_query>"}]}}
/// {"role":"assistant","message":{"content":[{"type":"text","text":"…"},{"type":"tool_use","name":"Shell","input":{"command":"echo pong5"}}]}}
/// {"type":"turn_ended","status":"success"}
/// ```
///
/// No `tool_result` blocks exist — the file records what was called, never what came back —
/// so a Cursor step is `tool-pre` only. Timestamps are stamped by [`parse_at`].
fn push_cursor(value: &Value, out: &mut Vec<TranscriptEntry>) {
    let Some(blocks) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    match value.get("role").and_then(Value::as_str) {
        Some("user") => {
            for block in blocks {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let text = cursor_user_text(block.get("text").and_then(Value::as_str).unwrap_or(""));
                if !text.is_empty() {
                    out.push(prompt_entry(&text, 0));
                }
            }
        }
        Some("assistant") => {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
                        if !text.trim().is_empty() {
                            out.push(prose_entry(text, 0));
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                        out.push(tool_entry("tool-pre", name, &claude_tool_target(block), 0));
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

/// The operator's words out of Cursor's envelope.
///
/// Cursor prepends `<timestamp>…</timestamp>` and wraps the prompt in `<user_query>`; a
/// CodeChat session also carries the harness preamble inside the same block. The query is
/// the conversation; the envelope is not, and drawing it would open every Cursor transcript
/// with a date line and a wall of instructions. A block without the wrapper is kept whole.
fn cursor_user_text(raw: &str) -> String {
    let inner = match (raw.find("<user_query>"), raw.rfind("</user_query>")) {
        (Some(start), Some(end)) if end > start => &raw[start + "<user_query>".len()..end],
        _ => {
            // No query wrapper: drop a leading timestamp tag if there is one, keep the rest.
            match (raw.find("<timestamp>"), raw.find("</timestamp>")) {
                (Some(0), Some(end)) => &raw[end + "</timestamp>".len()..],
                _ => raw,
            }
        }
    };
    inner.trim().to_string()
}

// ── Codex ─────────────────────────────────────────────────────────────────────────────

/// Names of `custom_tool_call`s whose output must not draw its own step.
///
/// `apply_patch` is the one: its result arrives as a rich record — `patch_apply_end`
/// (older rollouts) or an `item_completed` / `FileChange` (0.15x) — carrying the files and
/// a unified diff, and that record is what becomes the `tool-post`. The plain
/// `custom_tool_call_output` for the same call would draw a second, empty step under it.
///
/// Correlated by name rather than by `call_id` because the 0.15x `FileChange` item does
/// not carry the call id at all — only the older `patch_apply_end` does.
struct CodexCalls {
    /// `call_id` → tool name, for every `custom_tool_call` / `function_call` seen so far.
    names: std::collections::HashMap<String, String>,
}

fn push_codex(value: &Value, calls: &mut CodexCalls, out: &mut Vec<TranscriptEntry>) {
    let at = iso_to_ms(value.get("timestamp").and_then(Value::as_str).unwrap_or(""));
    let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(payload) = value.get("payload") else {
        return;
    };
    let sub = payload.get("type").and_then(Value::as_str).unwrap_or("");

    match (kind, sub) {
        // `event_msg` rather than `response_item/message` for prompt and prose: the latter
        // also carries `developer` and `system` roles — the harness preamble, which is not
        // conversation and would open every transcript with a wall of instructions.
        ("event_msg", "user_message") => {
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    out.push(prompt_entry(text, at));
                }
            }
        }
        ("event_msg", "agent_message") => {
            if let Some(text) = payload.get("message").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    out.push(prose_entry(text, at));
                }
            }
        }
        // Codex 0.15x stopped writing `user_message` / `agent_message` and writes one
        // `item_completed` per thread item instead. Measured 2026-08-27 over the 150 newest
        // rollouts on this machine: 48 carried `item_completed`, and **none of those 48 had a
        // single `agent_message`** — so without this arm a current Codex renders zero prose.
        ("event_msg", "item_completed") => {
            if let Some(item) = payload.get("item") {
                push_codex_item(item, at, out);
            }
        }
        ("response_item", "custom_tool_call") => {
            let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
            let input = payload.get("input").and_then(Value::as_str).unwrap_or("");
            calls.remember(payload, name);
            // A patch is not a command: naming its files says what the step did, where the
            // first 300 characters of the patch body would say `*** Begin Patch *** Update`.
            let target = if name == "apply_patch" {
                patch_files(input).join(", ")
            } else {
                clip(&one_line(input))
            };
            out.push(tool_entry("tool-pre", name, &target, at));
        }
        // MCP and built-in function tools (`lotus_list_fleet`, `wait`, …). 629 of these in the
        // 200 newest rollouts, every one previously invisible to Chat.
        ("response_item", "function_call") => {
            let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
            let args = payload.get("arguments").and_then(Value::as_str).unwrap_or("");
            calls.remember(payload, name);
            out.push(tool_entry("tool-pre", name, &clip(&one_line(args)), at));
        }
        ("response_item", "custom_tool_call_output") | ("response_item", "function_call_output") => {
            if calls.is_patch(payload) {
                return;
            }
            out.push(tool_entry("tool-post", "", "", at));
        }
        // The result of an `apply_patch`, with the files it touched and a unified diff per
        // file — the only place a Codex rollout states what changed in a countable form.
        ("event_msg", "patch_apply_end") => {
            let failed = payload.get("success").and_then(Value::as_bool) == Some(false);
            out.push(patch_result(payload.get("changes"), failed, at));
        }
        ("event_msg", "turn_aborted") => {
            let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("aborted");
            let mut entry = tool_entry("error", "Interrupted", reason, at);
            entry.status = "error".into();
            out.push(entry);
        }
        _ => {}
    }
}

impl CodexCalls {
    fn remember(&mut self, payload: &Value, name: &str) {
        if let Some(id) = payload.get("call_id").and_then(Value::as_str) {
            self.names.insert(id.to_string(), name.to_string());
        }
    }

    fn is_patch(&self, payload: &Value) -> bool {
        payload
            .get("call_id")
            .and_then(Value::as_str)
            .and_then(|id| self.names.get(id))
            .is_some_and(|name| name == "apply_patch")
    }
}

/// One 0.15x thread item. Type names are CamelCase here where the older `event_msg`
/// vocabulary was snake_case — verbatim from the files, not normalised.
fn push_codex_item(item: &Value, at: i64, out: &mut Vec<TranscriptEntry>) {
    let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "UserMessage" => {
            let text = item_text(item);
            if !text.trim().is_empty() {
                out.push(prompt_entry(&text, at));
            }
        }
        // Both `commentary` and `final_answer` phases are things the agent said to the
        // operator; the phase is not a reason to hide one of them.
        "AgentMessage" => {
            let text = item_text(item);
            if !text.trim().is_empty() {
                out.push(prose_entry(&text, at));
            }
        }
        "FileChange" => {
            let failed = item.get("status").and_then(Value::as_str) == Some("failed");
            out.push(patch_result(item.get("changes"), failed, at));
        }
        // `Extension` is Codex's envelope for hosted tools; `web.search` is the one seen so
        // far and its query is the only field worth a step line.
        "Extension" => {
            let name = item.get("kind").and_then(Value::as_str).unwrap_or("extension");
            let query = item.get("query").and_then(Value::as_str).unwrap_or("");
            out.push(tool_entry("tool-pre", name, &clip(&one_line(query)), at));
        }
        // `CommandExecution` and `McpToolCall` duplicate the `custom_tool_call` /
        // `function_call` pairs that still appear beside them in 0.15x files (324 and 21 of
        // each in the same 48 rollouts), so they are not drawn twice. `Reasoning` is skipped
        // for the reason Claude's `thinking` blocks are. `ContextCompaction` is bookkeeping.
        _ => {}
    }
}

/// The `text` of every content block on a 0.15x item, joined. Block type is `text` on a
/// `UserMessage` and `Text` on an `AgentMessage` — both spellings are in the files.
fn item_text(item: &Value) -> String {
    item.get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

/// A `tool-post` for an `apply_patch`, from the `changes` map both record shapes share:
/// `{ "<path>": { "type": "update" | "add" | "delete", "unified_diff": "@@ …" } }`.
///
/// The counts are summed over every file, and they are **absent, not zero**, when no
/// `unified_diff` was present — `contract/README.md` says why a client must be able to
/// tell those apart.
fn patch_result(changes: Option<&Value>, failed: bool, at: i64) -> TranscriptEntry {
    let mut files = Vec::new();
    let mut added = 0u32;
    let mut removed = 0u32;
    let mut counted = false;
    if let Some(map) = changes.and_then(Value::as_object) {
        for (path, change) in map {
            files.push(short_path(path));
            if let Some(diff) = change.get("unified_diff").and_then(Value::as_str) {
                let (a, r) = diff_stat(diff);
                added += a;
                removed += r;
                counted = true;
            }
        }
    }
    let event = if failed { "tool-post-failed" } else { "tool-post" };
    let mut entry = tool_entry(event, "apply_patch", &files.join(", "), at);
    if counted {
        entry.lines_added = Some(added);
        entry.lines_removed = Some(removed);
    }
    entry
}

/// `+`/`-` lines of a unified diff, excluding the `+++` / `---` file headers.
fn diff_stat(diff: &str) -> (u32, u32) {
    let mut added = 0;
    let mut removed = 0;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            added += 1;
        } else if line.starts_with('-') {
            removed += 1;
        }
    }
    (added, removed)
}

/// File names from an `apply_patch` body: `*** Update File: a/b.rs` → `b.rs`.
fn patch_files(patch: &str) -> Vec<String> {
    patch
        .lines()
        .filter_map(|line| {
            let rest = line.strip_prefix("*** ")?;
            let (_, path) = rest.split_once(" File: ")?;
            Some(short_path(path.trim()))
        })
        .collect()
}

/// The last path component, or the path itself. Codex writes absolute paths into
/// `changes`; on a phone the directory is noise and the file name is the step.
fn short_path(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

/// The same 300-character ceiling `payload-extractors.mjs` puts on a hook's `tool_target`,
/// so a step read from the file is no longer than the same step read from a hook.
fn clip(text: &str) -> String {
    if text.chars().count() <= 300 {
        return text.to_string();
    }
    text.chars().take(300).collect()
}

// ── Shared shaping ────────────────────────────────────────────────────────────────────
//
// Titles and statuses match `scripts/agent-notify/event-mapping.mjs` exactly. A step read
// from the file must be indistinguishable from the same step read from a hook, or Chat
// would render the same moment two ways depending on where it came from.

fn prompt_entry(text: &str, at: i64) -> TranscriptEntry {
    TranscriptEntry {
        event: "prompt-submit".into(),
        status: "running".into(),
        title: "You".into(),
        body: text.to_string(),
        user_prompt: text.to_string(),
        tool_target: String::new(),
        lines_added: None,
        lines_removed: None,
        body_truncated: false,
        questions: None,
        tool_call_id: None,
        answers: None,
        timestamp: at,
    }
}

fn prose_entry(text: &str, at: i64) -> TranscriptEntry {
    TranscriptEntry {
        event: "stop".into(),
        status: "idle".into(),
        title: "Finished working".into(),
        body: text.to_string(),
        user_prompt: String::new(),
        tool_target: String::new(),
        lines_added: None,
        lines_removed: None,
        // Never true here, and that is the point of the whole slice: the file is the
        // unclamped source, so nothing read from it was ever cut.
        body_truncated: false,
        questions: None,
        tool_call_id: None,
        answers: None,
        timestamp: at,
    }
}

fn tool_entry(event: &str, name: &str, target: &str, at: i64) -> TranscriptEntry {
    TranscriptEntry {
        event: event.into(),
        status: "running".into(),
        title: if name.is_empty() {
            "Tool".into()
        } else {
            name.to_string()
        },
        body: String::new(),
        user_prompt: String::new(),
        tool_target: target.to_string(),
        lines_added: None,
        lines_removed: None,
        body_truncated: false,
        questions: None,
        tool_call_id: None,
        answers: None,
        timestamp: at,
    }
}

fn one_line(text: &str) -> String {
    let flat: String = text
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    flat.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `2026-08-13T10:19:39.672Z` → epoch milliseconds. Returns 0 on anything unexpected.
///
/// Hand-rolled rather than a dependency: both CLIs write the same fixed UTC shape, and
/// pulling a date crate into this binary for one function is a poor trade. Zero on failure
/// rather than dropping the entry — an entry with a wrong timestamp is still the thing the
/// agent said, and sorting is by file order anyway.
fn iso_to_ms(text: &str) -> i64 {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return 0;
    }
    let num = |from: usize, to: usize| -> i64 { text[from..to].parse::<i64>().unwrap_or(-1) };
    let (y, mo, d) = (num(0, 4), num(5, 7), num(8, 10));
    let (h, mi, s) = (num(11, 13), num(14, 16), num(17, 19));
    if [y, mo, d, h, mi, s].iter().any(|v| *v < 0) {
        return 0;
    }
    let millis = if bytes.len() >= 23 && bytes[19] == b'.' {
        num(20, 23).max(0)
    } else {
        0
    };
    (days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + s) * 1_000 + millis
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Verbatim from a live file — `~/.claude/projects/**/*.jsonl`, 2026-08-13.
    const CLAUDE: &str = r#"
{"type":"user","timestamp":"2026-08-13T10:19:39.672Z","message":{"role":"user","content":"run the tests"}}
{"type":"assistant","timestamp":"2026-08-13T10:19:46.153Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm","signature":"x"}]}}
{"type":"assistant","timestamp":"2026-08-13T10:19:47.000Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll pull the git log."},{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"git log -1"}}]}}
{"type":"user","timestamp":"2026-08-13T10:19:48.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ddd9b9be"}]}}
{"type":"ai-title","aiTitle":"noise","sessionId":"s"}
{"not json
"#;

    /// Verbatim from a live file — `~/.codex/sessions/**/rollout-*.jsonl`, 2026-08-13.
    const CODEX: &str = r#"
{"timestamp":"2026-08-13T03:22:59.695Z","type":"session_meta","payload":{"id":"s1","cwd":"/tmp"}}
{"timestamp":"2026-08-13T03:23:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"Read notes.txt and reply with one short sentence."}}
{"timestamp":"2026-08-13T03:23:01.000Z","type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"system preamble"}]}}
{"timestamp":"2026-08-13T03:23:02.000Z","type":"event_msg","payload":{"type":"agent_message","message":"Saya akan membaca notes.txt."}}
{"timestamp":"2026-08-13T03:23:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"sed -n '1,200p'\n notes.txt"}}
{"timestamp":"2026-08-13T03:23:04.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":[]}}
{"timestamp":"2026-08-13T03:23:05.000Z","type":"event_msg","payload":{"type":"token_count","info":{}}}
"#;

    #[test]
    fn claude_lines_become_chat_vocabulary() {
        let entries = parse(CLAUDE, TranscriptFormat::Claude);
        let kinds: Vec<&str> = entries.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(kinds, ["prompt-submit", "stop", "tool-pre", "tool-post"]);
        assert_eq!(entries[0].user_prompt, "run the tests");
        assert_eq!(entries[1].body, "I'll pull the git log.");
        assert_eq!(entries[2].title, "Bash");
        assert_eq!(entries[2].tool_target, "git log -1");
    }

    /// **Esc ends the turn, and the file is the only place that says so.** Read off a live
    /// cell 2026-09-09: refusing a question writes the rejection and then a `user` message
    /// reading "[Request interrupted by user for tool use]" — no `stop`, no closing prose. A
    /// phone kept a spinner and a STOP button up for three and a half minutes over it.
    #[test]
    fn claude_an_interrupted_turn_is_an_error_step() {
        let text = r#"
{"type":"user","timestamp":"2026-09-09T10:00:06.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}
"#;
        let entries = parse(text, TranscriptFormat::Claude);

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].event, "error");
        assert_eq!(entries[0].status, "error");
        assert_eq!(entries[0].title, "Interrupted");
    }

    /// A sentence the operator typed while a tool ran is still a prompt.
    #[test]
    fn claude_a_typed_sentence_in_a_user_message_stays_a_prompt() {
        let text = r#"
{"type":"user","timestamp":"2026-09-09T10:00:06.000Z","message":{"role":"user","content":[{"type":"text","text":"carry on"}]}}
"#;
        let entries = parse(text, TranscriptFormat::Claude);

        assert_eq!(entries[0].event, "prompt-submit");
        assert_eq!(entries[0].user_prompt, "carry on");
    }

    /// **What became of the question, from the runner's own record.** Probed 2026-09-09: Esc
    /// writes a `tool_result` with `is_error: true`, and answering writes
    /// *`Your questions have been answered: "Q"="A"`*. Both are keyed by `tool_use_id`, and
    /// without reading them the card a phone drew stayed on screen whatever the operator did at
    /// the keyboard. The twin of this is `transcript/claude-transcript.ts`.
    #[test]
    fn claude_a_result_carries_the_call_it_answers_and_the_answer_itself() {
        let text = r#"
{"type":"assistant","timestamp":"2026-09-09T10:00:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_9","name":"AskUserQuestion","input":{"questions":[{"question":"Tabs or spaces?","options":[{"label":"Tabs"}]}]}}]}}
{"type":"user","timestamp":"2026-09-09T10:00:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"Your questions have been answered: \"Tabs or spaces?\"=\"Tabs\". You can now continue."}]}}
"#;
        let entries = parse(text, TranscriptFormat::Claude);

        assert_eq!(entries[0].tool_call_id.as_deref(), Some("toolu_9"));
        assert_eq!(entries[1].tool_call_id.as_deref(), Some("toolu_9"));
        assert_eq!(entries[1].event, "tool-post");
        let answers = entries[1].answers.as_ref().expect("the answer crosses");
        assert_eq!(answers.get("Tabs or spaces?"), Some(&vec!["Tabs".to_string()]));
    }

    /// Esc. Said in the word the rest of Chat already uses for a call that did not go through.
    #[test]
    fn claude_a_refused_call_is_a_failed_result_carrying_no_answers() {
        let text = r#"
{"type":"user","timestamp":"2026-09-09T10:00:05.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_9","is_error":true,"content":"The user doesn't want to proceed with this tool use."}]}}
"#;
        let entries = parse(text, TranscriptFormat::Claude);

        assert_eq!(entries[0].event, "tool-post-failed");
        assert!(entries[0].answers.is_none());
    }

    /// An ordinary result is prose. An empty answer map here would make every completed call
    /// look like a question answered with nothing.
    #[test]
    fn claude_an_ordinary_result_carries_no_answers() {
        let entries = parse(CLAUDE, TranscriptFormat::Claude);
        assert!(entries.iter().all(|e| e.answers.is_none()));
    }

    /// **The question is on disk, and used to be dropped one line later.** `AskUserQuestion`
    /// keeps its questions, options and descriptions in the tool's own input, and the CLI
    /// writes all of it here — but none of the keys [`claude_tool_target`] looks for is in it,
    /// so the step reached the phone bare and Chat fell back to scraping the terminal for
    /// words that were already on disk. Reported from a device 2026-09-09; the twin of this
    /// fix is `adapters/mobile/transcript/claude-transcript.ts`, and shipping one without the
    /// other is how a desktop-backed cell kept showing the raw terminal.
    #[test]
    fn claude_a_question_keeps_its_options_and_their_own_words() {
        let text = r#"
{"type":"assistant","timestamp":"2026-09-09T10:19:47.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"AskUserQuestion","input":{"questions":[{"question":"Mau contoh pertanyaan tentang apa?","header":"Topik","options":[{"label":"Fitur project ini","description":"Contoh pilihan seputar kartu digital."},{"label":"Warna favorit"}]}]}}]}}
"#;
        let entries = parse(text, TranscriptFormat::Claude);

        let asked = entries[0].questions.as_ref().expect("the question crosses");
        assert_eq!(asked[0].question, "Mau contoh pertanyaan tentang apa?");
        assert_eq!(asked[0].header.as_deref(), Some("Topik"));
        assert_eq!(asked[0].options[0].label, "Fitur project ini");
        assert_eq!(
            asked[0].options[0].description.as_deref(),
            Some("Contoh pilihan seputar kartu digital.")
        );
        assert_eq!(asked[0].options[1].description, None);
        // And the step line says what was asked, rather than naming the tool and nothing else.
        assert_eq!(entries[0].tool_target, "Mau contoh pertanyaan tentang apa?");
    }

    /// Every other tool keeps the shape it had — absent, not an empty list, so a step that
    /// asks nothing does not grow a field on the wire.
    #[test]
    fn claude_an_ordinary_tool_carries_no_questions() {
        let entries = parse(CLAUDE, TranscriptFormat::Claude);
        assert!(entries.iter().all(|e| e.questions.is_none()));
    }

    /// The largest thing in these files by volume, and not something Chat draws.
    #[test]
    fn claude_thinking_blocks_are_skipped() {
        let entries = parse(CLAUDE, TranscriptFormat::Claude);
        assert!(entries.iter().all(|e| e.body != "hmm"));
    }

    #[test]
    fn codex_lines_become_the_same_vocabulary() {
        let entries = parse(CODEX, TranscriptFormat::Codex);
        let kinds: Vec<&str> = entries.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(kinds, ["prompt-submit", "stop", "tool-pre", "tool-post"]);
        assert_eq!(
            entries[0].user_prompt,
            "Read notes.txt and reply with one short sentence."
        );
        assert_eq!(entries[1].body, "Saya akan membaca notes.txt.");
        assert_eq!(entries[2].title, "exec");
        // Newlines flattened, so a multi-line command stays one step line.
        assert_eq!(entries[2].tool_target, "sed -n '1,200p' notes.txt");
    }

    /// `response_item/message` carries `developer` and `system` roles — the harness
    /// preamble. Reading those would open every Codex transcript with a wall of
    /// instructions the operator never wrote.
    #[test]
    fn codex_developer_preamble_is_not_conversation() {
        let entries = parse(CODEX, TranscriptFormat::Codex);
        assert!(entries.iter().all(|e| !e.body.contains("system preamble")));
    }

    /// Verbatim shapes from a 0.150.1 rollout, 2026-08-27. This era writes no
    /// `user_message` / `agent_message` at all — 48 of the 150 newest files on the machine
    /// that found this, and every one of them rendered as tool steps with nothing said.
    const CODEX_015X: &str = r#"
{"timestamp":"2026-08-27T03:00:00.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"UserMessage","id":"u1","content":[{"type":"text","text":"Add a test for the guard."}]}}}
{"timestamp":"2026-08-27T03:00:01.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"Reasoning","id":"rs1","summary_text":["**Planning**"],"raw_content":[]}}}
{"timestamp":"2026-08-27T03:00:02.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"AgentMessage","id":"m1","content":[{"type":"Text","text":"Saya cek dulu."}],"phase":"commentary"}}}
{"timestamp":"2026-08-27T03:00:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"rg -n guard lib"}}
{"timestamp":"2026-08-27T03:00:04.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"e1","command":["/bin/zsh","-lc","rg -n guard lib"],"status":"completed","stdout":"x"}}}
{"timestamp":"2026-08-27T03:00:05.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c1","output":"x"}}
{"timestamp":"2026-08-27T03:00:06.000Z","type":"response_item","payload":{"type":"function_call","call_id":"f1","name":"lotus_list_fleet","namespace":"mcp__lotus","arguments":"{\"verbose\":true}"}}
{"timestamp":"2026-08-27T03:00:07.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"f1","output":"[]"}}
{"timestamp":"2026-08-27T03:00:08.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"c2","name":"apply_patch","input":"*** Begin Patch\n*** Update File: /Users/op/Lotus/apps/pocket/test/ansi_guard_test.dart\n@@\n-old\n+new\n+newer\n*** End Patch"}}
{"timestamp":"2026-08-27T03:00:09.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"FileChange","id":"fc1","changes":{"/Users/op/Lotus/apps/pocket/test/ansi_guard_test.dart":{"type":"update","unified_diff":"@@ -1,1 +1,2 @@\n-old\n+new\n+newer"}},"status":"completed"}}}
{"timestamp":"2026-08-27T03:00:10.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"c2","output":"Success."}}
{"timestamp":"2026-08-27T03:00:11.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"Extension","kind":"web.search","id":"w1","query":"flutter kitty graphics"}}}
{"timestamp":"2026-08-27T03:00:12.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"AgentMessage","id":"m2","content":[{"type":"Text","text":"Selesai."}],"phase":"final_answer"}}}
{"timestamp":"2026-08-27T03:00:13.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"t2","reason":"interrupted","duration_ms":3952}}
"#;

    #[test]
    fn codex_015x_items_are_read_where_the_old_event_msgs_used_to_be() {
        let entries = parse(CODEX_015X, TranscriptFormat::Codex);
        let kinds: Vec<&str> = entries.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(
            kinds,
            [
                "prompt-submit",
                "stop",
                "tool-pre",
                "tool-post",
                "tool-pre",
                "tool-post",
                "tool-pre",
                "tool-post",
                "tool-pre",
                "stop",
                "error",
            ]
        );
        assert_eq!(entries[0].user_prompt, "Add a test for the guard.");
        // Both phases are drawn: `commentary` and `final_answer` are both things it said.
        assert_eq!(entries[1].body, "Saya cek dulu.");
        assert_eq!(entries[9].body, "Selesai.");
    }

    /// A `Reasoning` item is the most numerous thing in a 0.15x file (385 of 915 items
    /// measured) and, like Claude's `thinking`, not something Chat draws.
    #[test]
    fn codex_reasoning_items_are_skipped() {
        let entries = parse(CODEX_015X, TranscriptFormat::Codex);
        assert!(entries.iter().all(|e| !e.body.contains("Planning")));
    }

    /// `CommandExecution` items sit beside the `custom_tool_call` pair for the same
    /// command; drawing both would show every command twice.
    #[test]
    fn codex_command_execution_items_do_not_duplicate_the_tool_call() {
        let entries = parse(CODEX_015X, TranscriptFormat::Codex);
        let execs = entries
            .iter()
            .filter(|e| e.event == "tool-pre" && e.title == "exec")
            .count();
        assert_eq!(execs, 1);
    }

    #[test]
    fn codex_function_calls_become_steps() {
        let entries = parse(CODEX_015X, TranscriptFormat::Codex);
        let call = entries.iter().find(|e| e.title == "lotus_list_fleet").expect("mcp call drawn");
        assert_eq!(call.event, "tool-pre");
        assert_eq!(call.tool_target, r#"{"verbose":true}"#);
    }

    /// The patch's own result record is the step; the plain `custom_tool_call_output`
    /// that follows it for the same call is not drawn a second time.
    #[test]
    fn codex_apply_patch_draws_its_files_and_a_diffstat_once() {
        let entries = parse(CODEX_015X, TranscriptFormat::Codex);
        let patch: Vec<&TranscriptEntry> =
            entries.iter().filter(|e| e.title == "apply_patch").collect();
        assert_eq!(patch.len(), 2, "one tool-pre, one tool-post");
        assert_eq!(patch[0].event, "tool-pre");
        assert_eq!(patch[0].tool_target, "ansi_guard_test.dart");
        assert_eq!(patch[0].lines_added, None, "the call itself has not changed anything yet");
        assert_eq!(patch[1].event, "tool-post");
        assert_eq!(patch[1].tool_target, "ansi_guard_test.dart");
        assert_eq!((patch[1].lines_added, patch[1].lines_removed), (Some(2), Some(1)));
        // No empty tool-post sneaks in between the FileChange and the web search.
        let after_patch = entries.iter().position(|e| e.title == "web.search").unwrap();
        assert_eq!(entries[after_patch - 1].title, "apply_patch");
    }

    /// Older rollouts (pre-0.15x) record the same result as `patch_apply_end`, keyed by
    /// `call_id`, and it arrives *before* the `custom_tool_call_output` (51 of 51 pairs
    /// measured 2026-08-27).
    #[test]
    fn codex_patch_apply_end_is_the_same_step_in_an_older_file() {
        let older = r#"
{"timestamp":"2026-08-13T03:23:03.000Z","type":"response_item","payload":{"type":"custom_tool_call","call_id":"p1","name":"apply_patch","input":"*** Begin Patch\n*** Add File: notes.md\n+hello\n*** End Patch"}}
{"timestamp":"2026-08-13T03:23:04.000Z","type":"event_msg","payload":{"type":"patch_apply_end","call_id":"p1","success":true,"changes":{"/tmp/notes.md":{"type":"add","unified_diff":"@@ -0,0 +1 @@\n+hello"}}}}
{"timestamp":"2026-08-13T03:23:05.000Z","type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"p1","output":"Success."}}
"#;
        let entries = parse(older, TranscriptFormat::Codex);
        let kinds: Vec<&str> = entries.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(kinds, ["tool-pre", "tool-post"]);
        assert_eq!(entries[1].tool_target, "notes.md");
        assert_eq!((entries[1].lines_added, entries[1].lines_removed), (Some(1), Some(0)));
    }

    /// A failed patch is `tool-post-failed`, the same promotion `run-hook.mjs` applies to a
    /// hook's `PostToolUse`. And a `changes` map with no diffs gets no counts — absent,
    /// not `+0 −0`.
    #[test]
    fn codex_failed_patch_and_diffless_changes() {
        let text = r#"
{"timestamp":"2026-08-13T03:23:04.000Z","type":"event_msg","payload":{"type":"patch_apply_end","call_id":"p1","success":false,"changes":{"/tmp/a.md":{"type":"delete"}}}}
"#;
        let entries = parse(text, TranscriptFormat::Codex);
        assert_eq!(entries[0].event, "tool-post-failed");
        assert_eq!(entries[0].tool_target, "a.md");
        assert_eq!((entries[0].lines_added, entries[0].lines_removed), (None, None));
    }

    #[test]
    fn codex_turn_aborted_is_an_error_step_naming_the_reason() {
        let entries = parse(CODEX_015X, TranscriptFormat::Codex);
        let last = entries.last().unwrap();
        assert_eq!((last.event.as_str(), last.status.as_str()), ("error", "error"));
        assert_eq!(last.title, "Interrupted");
        assert_eq!(last.tool_target, "interrupted");
    }

    #[test]
    fn diff_stat_ignores_file_headers() {
        assert_eq!(diff_stat("--- a
+++ b
@@
-x
+y
+z
 ctx"), (2, 1));
    }

    /// Verbatim from the probe session of 2026-08-27 (`cursor-agent -p`, LOTUS_PANE_ID set).
    const CURSOR: &str = r#"
{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>Thursday, Aug 27, 2026, 8:32 PM (UTC+7)</timestamp>\n<user_query>\nRun the shell command: echo pong5. Then reply with exactly one word: pong\n</user_query>"}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"Running the echo command, then replying with one word."},{"type":"tool_use","name":"Shell","input":{"command":"echo pong5","description":"Echo pong5 to stdout"}}]}}
{"role":"assistant","message":{"content":[{"type":"text","text":"pong"}]}}
{"type":"turn_ended","status":"success"}
"#;

    #[test]
    fn cursor_is_recognised_by_content_and_read_into_the_same_vocabulary() {
        assert_eq!(TranscriptFormat::sniff(CURSOR), Some(TranscriptFormat::Cursor));
        let entries = parse_at(CURSOR, TranscriptFormat::Cursor, 1_787_837_587_000);
        let kinds: Vec<&str> = entries.iter().map(|e| e.event.as_str()).collect();
        assert_eq!(kinds, ["prompt-submit", "stop", "tool-pre", "stop"]);
        // The envelope is gone; the operator's sentence is what remains.
        assert_eq!(
            entries[0].user_prompt,
            "Run the shell command: echo pong5. Then reply with exactly one word: pong"
        );
        assert_eq!(entries[2].title, "Shell");
        assert_eq!(entries[2].tool_target, "echo pong5");
        assert_eq!(entries[3].body, "pong");
    }

    /// Cursor records no clock. Stamped backwards from the file's mtime, one millisecond
    /// apart: order survives, the last line sits at the moment the file was written, and
    /// nothing collapses into a single instant.
    #[test]
    fn cursor_entries_are_stamped_backwards_from_the_file_time() {
        let entries = parse_at(CURSOR, TranscriptFormat::Cursor, 1_000_000);
        let stamps: Vec<i64> = entries.iter().map(|e| e.timestamp).collect();
        assert_eq!(stamps, [999_997, 999_998, 999_999, 1_000_000]);
    }

    #[test]
    fn cursor_user_envelope_is_unwrapped_and_a_bare_prompt_is_kept_whole() {
        assert_eq!(cursor_user_text("<timestamp>x</timestamp>\n<user_query>\nhi\n</user_query>"), "hi");
        assert_eq!(cursor_user_text("<timestamp>x</timestamp> plain"), "plain");
        assert_eq!(cursor_user_text("plain"), "plain");
    }

    /// A Cursor line is neither of the other two: no `type`, so the Claude reader is blind
    /// to it, and no `payload`, so the Codex one is.
    #[test]
    fn cursor_lines_are_not_mistaken_for_claude_or_codex() {
        assert!(parse(CURSOR, TranscriptFormat::Claude).is_empty());
        assert!(parse(CURSOR, TranscriptFormat::Codex).is_empty());
        assert_eq!(TranscriptFormat::sniff(CLAUDE), Some(TranscriptFormat::Claude));
        assert_eq!(TranscriptFormat::sniff(CODEX), Some(TranscriptFormat::Codex));
    }

    #[test]
    fn a_cursor_conversation_is_found_under_any_project_slug() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join(".cursor");
        let leaf = root
            .join("projects")
            .join("Users-x-workspace-repo")
            .join("agent-transcripts")
            .join("abc-1");
        std::fs::create_dir_all(&leaf).unwrap();
        std::fs::write(leaf.join("abc-1.jsonl"), "{}").unwrap();
        assert_eq!(derive_cursor_path(&[root.clone()], "abc-1"), Some(leaf.join("abc-1.jsonl")));
        assert_eq!(derive_cursor_path(&[root.clone()], "zzz"), None);
        assert_eq!(derive_cursor_path(&[root], ""), None);
    }

    /// These files are appended to by a live process, so the last line can be half-written
    /// at the moment a reader arrives. One torn line must not cost the whole history.
    #[test]
    fn a_torn_last_line_does_not_discard_the_file() {
        let entries = parse(CLAUDE, TranscriptFormat::Claude);
        assert_eq!(entries.len(), 4, "the four real entries survive");
    }

    #[test]
    fn reading_the_wrong_format_yields_nothing_rather_than_nonsense() {
        assert!(parse(CODEX, TranscriptFormat::Claude).is_empty());
        assert!(parse(CLAUDE, TranscriptFormat::Codex).is_empty());
    }

    /// Fase 3: the restart gap. `transcript_path` is otherwise only learned from a hook,
    /// so a desktop restart blanks Chat for a session whose file is right there on disk.
    #[test]
    fn a_session_is_found_by_id_without_rebuilding_the_directory_name() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().join("profile");
        // A directory name this code deliberately does not try to reproduce — Claude's
        // encoding turns `/` and `.` into `-`, and imitating that is how a path with a
        // space would silently miss.
        let project = root.join("projects").join("-Users-x--claude-mem-observer");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(project.join("abc-123.jsonl"), "{}").unwrap();

        let found = derive_claude_path(&[root.clone()], "abc-123");
        assert_eq!(found, Some(project.join("abc-123.jsonl")));
    }

    #[test]
    fn a_session_with_no_file_is_not_guessed_at() {
        let dir = tempfile::TempDir::new().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("projects").join("-a")).unwrap();
        // Another session's transcript sits right beside it — serving that would show one
        // cell another cell's conversation, which is worse than showing nothing.
        std::fs::write(root.join("projects").join("-a").join("other.jsonl"), "{}").unwrap();

        assert_eq!(derive_claude_path(&[root], "missing"), None);
    }

    #[test]
    fn the_first_root_that_has_it_wins_and_a_missing_root_is_skipped() {
        let dir = tempfile::TempDir::new().unwrap();
        let real = dir.path().join("second");
        std::fs::create_dir_all(real.join("projects").join("-p")).unwrap();
        std::fs::write(real.join("projects").join("-p").join("s.jsonl"), "{}").unwrap();

        let roots = vec![dir.path().join("does-not-exist"), real.clone()];
        assert_eq!(
            derive_claude_path(&roots, "s"),
            Some(real.join("projects").join("-p").join("s.jsonl"))
        );
    }

    #[test]
    fn an_empty_session_id_never_matches() {
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(dir.path().join("projects").join("-p")).unwrap();
        std::fs::write(dir.path().join("projects").join("-p").join(".jsonl"), "{}").unwrap();
        assert_eq!(derive_claude_path(&[dir.path().to_path_buf()], ""), None);
    }

    fn codex_tree(dir: &std::path::Path, entries: &[(&str, &str)]) {
        for (day, name) in entries {
            let d = dir.join("sessions").join("2026").join("08").join(day);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(name), "{}").unwrap();
        }
    }

    /// Runs against the real tree on this machine, if it is there — a fixture cannot show
    /// what the walk costs across three years of date directories, which is the number that
    /// decides whether walking beats building an index. It measures the miss too, because
    /// the hit exits early and would flatter the result.
    ///
    /// Ignored by default because it reads `~/.codex`, which CI does not have.
    #[test]
    #[ignore = "reads ~/.codex; run with --ignored"]
    fn the_walk_finds_a_real_codex_session() {
        let root = dirs::home_dir().unwrap().join(".codex");
        // Takes its own subject from the tree, so it needs no fixture and no env var.
        let newest = newest_first_find(&root.join("sessions"), "rollout-", CODEX_TREE_DEPTH)
            .expect("no Codex sessions on this machine");
        // The last five dash-groups are the uuid; everything before is `rollout-<timestamp>`.
        let name = newest.file_stem().unwrap().to_str().unwrap();
        let parts: Vec<&str> = name.split('-').collect();
        let sid = parts[parts.len() - 5..].join("-");

        let hit = std::time::Instant::now();
        let found = derive_codex_path(&[root.clone()], &sid);
        let hit = hit.elapsed();
        assert_eq!(found.as_deref(), Some(newest.as_path()));

        // A miss walks the whole tree, so it — not the hit — is what the cost is.
        let miss = std::time::Instant::now();
        assert_eq!(derive_codex_path(&[root], "no-such-session"), None);
        eprintln!("hit {hit:?}, full walk {:?}", miss.elapsed());
    }

    /// Codex buries the id in `rollout-<timestamp>-<uuid>.jsonl` under `YYYY/MM/DD`, so
    /// unlike Claude the path cannot be computed from the id — it has to be found.
    #[test]
    fn a_codex_session_is_found_inside_its_dated_filename() {
        let dir = tempfile::TempDir::new().unwrap();
        codex_tree(
            dir.path(),
            &[("13", "rollout-2026-08-13T10-22-59-abc-123.jsonl")],
        );
        let found = derive_codex_path(&[dir.path().to_path_buf()], "abc-123");
        assert_eq!(
            found.unwrap().file_name().unwrap(),
            "rollout-2026-08-13T10-22-59-abc-123.jsonl"
        );
    }

    /// Date directories are zero-padded, so descending name order is chronological for
    /// free — and a session worth resuming is usually a recent one.
    #[test]
    fn the_newest_day_is_searched_first() {
        let dir = tempfile::TempDir::new().unwrap();
        codex_tree(
            dir.path(),
            &[
                ("01", "rollout-2026-08-01T00-00-00-dupe.jsonl"),
                ("28", "rollout-2026-08-28T00-00-00-dupe.jsonl"),
            ],
        );
        let found = derive_codex_path(&[dir.path().to_path_buf()], "dupe").unwrap();
        assert!(found.to_string_lossy().contains("/28/"), "got {found:?}");
    }

    #[test]
    fn a_codex_session_with_no_file_is_not_guessed_at() {
        let dir = tempfile::TempDir::new().unwrap();
        codex_tree(
            dir.path(),
            &[("13", "rollout-2026-08-13T10-22-59-someone-else.jsonl")],
        );
        assert_eq!(
            derive_codex_path(&[dir.path().to_path_buf()], "missing"),
            None
        );
        assert_eq!(derive_codex_path(&[dir.path().to_path_buf()], ""), None);
    }

    /// A `CODEX_HOME` profile is searched before the default, and a root that is not there
    /// is skipped rather than ending the search.
    #[test]
    fn a_missing_codex_root_is_skipped() {
        let dir = tempfile::TempDir::new().unwrap();
        let real = dir.path().join("profile");
        codex_tree(&real, &[("13", "rollout-2026-08-13T00-00-00-here.jsonl")]);
        let roots = vec![dir.path().join("does-not-exist"), real];
        assert!(derive_codex_path(&roots, "here").is_some());
    }

    #[test]
    fn the_format_is_read_from_content_not_from_where_the_file_lives() {
        assert_eq!(
            TranscriptFormat::sniff(CLAUDE),
            Some(TranscriptFormat::Claude)
        );
        assert_eq!(
            TranscriptFormat::sniff(CODEX),
            Some(TranscriptFormat::Codex)
        );
        assert_eq!(
            TranscriptFormat::sniff("not json\n{\"type\":\"other\"}"),
            None,
            "cannot tell must not become a default that reads empty"
        );
    }

    /// The bug a live device test found. `CLAUDE_CONFIG_DIR` puts a spawned agent's
    /// transcripts under a profile directory — a real one was at
    /// `~/.ccs/instances/acme/projects/…` — and the path rule this replaced refused to
    /// recognise it, so Chat fell back to the empty ring and looked broken.
    #[test]
    fn a_claude_transcript_outside_the_default_directory_is_still_claude() {
        // Verbatim opening of that file: two preamble kinds before the first real turn.
        let real = concat!(
            r#"{"type":"mode","mode":"default"}"#,
            "\n",
            r#"{"type":"file-history-snapshot","messageId":"x"}"#,
            "\n",
            r#"{"type":"user","timestamp":"2026-08-14T10:00:00.000Z","message":{"role":"user","content":"hi"}}"#,
        );
        assert_eq!(
            TranscriptFormat::sniff(real),
            Some(TranscriptFormat::Claude)
        );
        assert_eq!(parse(real, TranscriptFormat::Claude).len(), 1);
    }

    fn entries(n: usize) -> Vec<TranscriptEntry> {
        (0..n)
            .map(|i| prompt_entry(&format!("p{i}"), i as i64))
            .collect()
    }

    #[test]
    fn the_newest_page_comes_back_first_and_says_there_is_more() {
        let page = page(entries(100), None, 20);
        assert_eq!(page.entries.len(), 20);
        assert_eq!(page.entries[0].body, "p80", "oldest-first within the page");
        assert_eq!(page.oldest_cursor, Some(80));
        assert!(page.has_more);
        assert_eq!(
            page.total_ever, 100,
            "what the ring's `total` could never say"
        );
    }

    #[test]
    fn the_cursor_walks_backwards_without_gaps_or_repeats() {
        let all = entries(100);
        let first = page(all.clone(), None, 20);
        let second = page(all, first.oldest_cursor, 20);
        assert_eq!(second.entries.last().unwrap().body, "p79", "no gap");
        assert_eq!(second.entries[0].body, "p60", "no repeat");
        assert_eq!(second.oldest_cursor, Some(60));
    }

    #[test]
    fn reaching_the_start_says_so_instead_of_looping() {
        let page = page(entries(10), Some(5), 20);
        assert_eq!(page.entries.len(), 5);
        assert_eq!(page.oldest_cursor, Some(0));
        assert!(!page.has_more);
    }

    #[test]
    fn an_empty_transcript_is_a_valid_answer() {
        let page = page(Vec::new(), None, 20);
        assert!(page.entries.is_empty());
        assert_eq!(page.oldest_cursor, None);
        assert!(!page.has_more);
        assert_eq!(page.total_ever, 0);
    }

    #[test]
    fn iso_timestamps_become_epoch_millis() {
        assert_eq!(iso_to_ms("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(iso_to_ms("2026-08-13T10:19:39.672Z"), 1_786_616_379_672);
        // Leap day, because the civil-days maths is where an off-by-one would hide.
        assert_eq!(iso_to_ms("2024-02-29T00:00:00Z"), 1_709_164_800_000);
        assert_eq!(iso_to_ms("nonsense"), 0);
        assert_eq!(iso_to_ms(""), 0);
    }
}

/// Runs the readers against whatever real transcripts this machine has.
///
/// `#[ignore]`d because it depends on the operator's own `~/.claude` and `~/.codex`, but
/// kept in the tree rather than done once by hand: the fixtures above are excerpts I chose,
/// and a format only drifts in the parts nobody excerpted.
///
/// Run: `cargo test --lib transcript_source_live -- --ignored --nocapture`
#[cfg(test)]
mod transcript_source_live {
    use super::*;

    fn newest(glob_dir: &str, depth: usize) -> Option<std::path::PathBuf> {
        fn walk(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else {
                return;
            };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() && depth > 0 {
                    walk(&p, depth - 1, out);
                } else if p.extension().is_some_and(|x| x == "jsonl") {
                    out.push(p);
                }
            }
        }
        let mut found = Vec::new();
        walk(
            &std::path::PathBuf::from(std::env::var("HOME").ok()?).join(glob_dir),
            depth,
            &mut found,
        );
        found.sort_by_key(|p| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
        });
        found.pop()
    }

    fn largest_with(glob_dir: &str, depth: usize, needle: &str) -> Option<std::path::PathBuf> {
        fn walk(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else {
                return;
            };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() && depth > 0 {
                    walk(&p, depth - 1, out);
                } else if p.extension().is_some_and(|x| x == "jsonl") {
                    out.push(p);
                }
            }
        }
        let mut found = Vec::new();
        walk(
            &std::path::PathBuf::from(std::env::var("HOME").ok()?).join(glob_dir),
            depth,
            &mut found,
        );
        found
            .into_iter()
            .filter(|p| std::fs::read_to_string(p).is_ok_and(|t| t.contains(needle)))
            .max_by_key(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
    }

    fn report(label: &str, path: &std::path::Path, format: TranscriptFormat) {
        let text = std::fs::read_to_string(path).expect("readable");
        // The file's mtime, as `fleet.rs` passes it — the only clock a Cursor file has.
        let modified_ms = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let entries = parse_at(&text, format, modified_ms);
        let count = |kind: &str| entries.iter().filter(|e| e.event == kind).count();
        println!(
            "{label}: {} entries — prompt {} / prose {} / tool {} — {}",
            entries.len(),
            count("prompt-submit"),
            count("stop"),
            count("tool-pre"),
            path.display()
        );
        assert!(
            !entries.is_empty(),
            "{label}: a real transcript parsed to nothing"
        );
        assert!(
            entries.iter().all(|e| e.timestamp > 0),
            "{label}: every entry carries a real timestamp"
        );
    }

    #[test]
    #[ignore = "reads the operator's own transcripts; run explicitly"]
    fn the_readers_handle_this_machines_real_files() {
        if let Some(p) = newest(".claude/projects", 2) {
            report("claude", &p, TranscriptFormat::Claude);
        }
        if let Some(p) = newest(".codex/sessions", 4) {
            report("codex", &p, TranscriptFormat::Codex);
        }
        // The largest 0.15x rollout on the machine — the era that writes `item_completed`
        // and no `agent_message`. The newest file is usually a one-prompt session and says
        // nothing about prose; this one must show some, or the 0.15x arm has regressed.
        if let Some(p) = largest_with(".codex/sessions", 4, "\"item_completed\"") {
            let text = std::fs::read_to_string(&p).expect("readable");
            let entries = parse(&text, TranscriptFormat::Codex);
            report("codex-0.15x", &p, TranscriptFormat::Codex);
            assert!(
                entries.iter().any(|e| e.event == "stop" && !e.body.is_empty()),
                "a 0.15x rollout with item_completed records must yield prose"
            );
        }
        // Cursor: the newest agent transcript on the machine, sniffed by content like the
        // others. Must yield prose — the file is the only place a Cursor cell's words live.
        if let Some(p) = newest(".cursor/projects", 4) {
            let text = std::fs::read_to_string(&p).expect("readable");
            assert_eq!(TranscriptFormat::sniff(&text), Some(TranscriptFormat::Cursor));
            report("cursor", &p, TranscriptFormat::Cursor);
        }
        // The directory a `CLAUDE_CONFIG_DIR` profile writes to. Included because the path
        // rule this replaced refused to recognise exactly this, and a live device test is
        // what caught it — a fixture would not have.
        // The newest transcript over every ccs instance and account dir. `newest` joins onto HOME,
        // and joining an absolute dir replaces it.
        let mut dirs: Vec<String> = vec![".ccs/instances".into()];
        dirs.extend(
            crate::accounts::claude_accounts()
                .into_iter()
                .filter(|a| a.id != crate::accounts::DEFAULT)
                .map(|a| a.dir.to_string_lossy().into_owned()),
        );
        let modified = |p: &std::path::PathBuf| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let newest_profile = dirs.iter().filter_map(|d| newest(d, 4)).max_by_key(modified);
        if let Some(p) = newest_profile {
            let format = TranscriptFormat::sniff(&std::fs::read_to_string(&p).expect("readable"))
                .expect("a profile transcript is still recognisable by content");
            report("ccs-profile", &p, format);
        }
    }
}
