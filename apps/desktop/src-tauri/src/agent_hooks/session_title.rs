//! What a conversation is called, read from the agent CLI's own records — not from its screen.
//!
//! **Why this exists.** Pane titles used to be made by feeding the PTY ring buffer to a model.
//! The ring holds a TUI's paint, not a conversation: 243 title calls recorded between
//! 2026-09-21 and 2026-10-10 were fed banners, spinners (`running PreToolUse hooks…`), the
//! `/resume` picker and shell prompts with their words glued together, and named panes after
//! them ("Starting Voice Core 03" from a spinner, "You've hit your weekly limit" seven times).
//!
//! Both CLIs already title their own conversations, for free:
//!
//! | | Claude | Codex |
//! |---|---|---|
//! | title | `{"type":"ai-title","aiTitle":…}` lines in the transcript (repeated, last wins) | `thread_name` in `<CODEX_HOME>/session_index.jsonl`, keyed by the session id |
//! | session id | the transcript's file name | `session_meta` → `payload.id`, first line |
//!
//! Read from live files 2026-10-10. When a CLI has not written a title (yet), the first real
//! prompt and the latest reply are returned instead, as the material for a model to title from.

use std::path::{Path, PathBuf};

use serde_json::Value;

use super::transcript_source::{parse_at, TranscriptFormat};

/// What one transcript says about the conversation's name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionTitle {
    /// The CLI's own title, when it has written one.
    pub agent_title: Option<String>,
    /// The first prompt a person typed — not a slash command, not a hook's injected context.
    pub first_prompt: Option<String>,
    /// The latest prose the agent wrote.
    pub last_reply: Option<String>,
}

/// The last `ai-title` a Claude transcript carries. Claude repeats the line as the session goes
/// on and may revise it, so the last one is the current name.
pub fn claude_ai_title(text: &str) -> Option<String> {
    text.lines()
        .rev()
        .filter(|line| line.contains("\"ai-title\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("type").and_then(Value::as_str) == Some("ai-title"))
        .find_map(|value| clean(value.get("aiTitle")))
}

/// The session id on a Codex transcript's `session_meta` line.
pub fn codex_session_id(text: &str) -> Option<String> {
    text.lines()
        .filter(|line| line.contains("\"session_meta\""))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value.get("type").and_then(Value::as_str) == Some("session_meta"))
        .and_then(|value| clean(value.pointer("/payload/id")))
}

/// The latest `thread_name` Codex recorded for `session_id`. The index is append-only, so a
/// renamed thread appears twice and the later line is the name.
pub fn codex_thread_name(index: &str, session_id: &str) -> Option<String> {
    index
        .lines()
        .rev()
        .filter(|line| line.contains(session_id))
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.get("id").and_then(Value::as_str) == Some(session_id))
        .find_map(|value| clean(value.get("thread_name")))
}

/// A prompt a person typed, as opposed to what the CLI injects as a user message: slash-command
/// records (`<command-name>`), hook output (`<system-reminder>`), the local-command caveat.
fn is_typed_prompt(text: &str) -> bool {
    let trimmed = text.trim_start();
    !trimmed.is_empty()
        && !trimmed.starts_with('<')
        && !trimmed.starts_with("Caveat:")
        && !trimmed.starts_with("[Request interrupted")
}

/// What `text` (whole JSONL lines of one transcript) says. `codex_index` is the Codex session
/// index, when the transcript is a Codex one and the index could be read.
pub fn title_from(text: &str, format: TranscriptFormat, codex_index: Option<&str>) -> SessionTitle {
    let agent_title = match format {
        TranscriptFormat::Claude => claude_ai_title(text),
        TranscriptFormat::Codex => codex_index
            .zip(codex_session_id(text))
            .and_then(|(index, id)| codex_thread_name(index, &id)),
        TranscriptFormat::Cursor => None,
    };
    let entries = parse_at(text, format, 0);
    let first_prompt = entries
        .iter()
        .filter(|e| e.event == "prompt-submit")
        .map(|e| e.user_prompt.trim())
        .find(|p| is_typed_prompt(p))
        .map(str::to_string);
    let last_reply = entries
        .iter()
        .rev()
        .filter(|e| e.event == "stop")
        .map(|e| e.body.trim())
        .find(|b| !b.is_empty())
        .map(str::to_string);
    SessionTitle {
        agent_title,
        first_prompt,
        last_reply,
    }
}

/// The title facts for the transcript at `path`; `None` when it cannot be read or its format
/// is not one this app parses.
pub fn title_at(path: &str) -> Option<SessionTitle> {
    let len = std::fs::metadata(path).ok()?.len();
    let text = super::session_facts::read_ends(path, len).ok()?;
    let format = TranscriptFormat::sniff(&text)?;
    let index = match format {
        TranscriptFormat::Codex => codex_index_for(Path::new(path))
            .and_then(|index| std::fs::read_to_string(index).ok()),
        _ => None,
    };
    Some(title_from(&text, format, index.as_deref()))
}

/// `<CODEX_HOME>/session_index.jsonl` for a transcript under `<CODEX_HOME>/sessions/…`.
fn codex_index_for(path: &Path) -> Option<PathBuf> {
    let home = path
        .ancestors()
        .find(|dir| dir.file_name().is_some_and(|name| name == "sessions"))?
        .parent()?;
    Some(home.join("session_index.jsonl"))
}

/// The config directory a Claude transcript belongs to: the parent of its `projects/`.
///
/// A title sidecar spawned with this as `CLAUDE_CONFIG_DIR` runs on the same account as the
/// pane it titles — not on whichever profile happens to be the default.
pub fn claude_config_dir_of(path: &str) -> Option<PathBuf> {
    Path::new(path)
        .ancestors()
        .find(|dir| dir.file_name().is_some_and(|name| name == "projects"))?
        .parent()
        .map(Path::to_path_buf)
}

fn clean(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: &str = concat!(
        r#"{"type":"mode","mode":"normal","sessionId":"s1"}"#, "\n",
        r#"{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>"},"timestamp":"2026-10-10T07:00:00Z"}"#, "\n",
        r#"{"type":"user","message":{"role":"user","content":"Tolong analisis fitur auto title"},"timestamp":"2026-10-10T07:00:01Z"}"#, "\n",
        r#"{"type":"ai-title","aiTitle":"Fitur auto title","sessionId":"s1"}"#, "\n",
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Sumbernya layar TUI."}]},"timestamp":"2026-10-10T07:00:02Z"}"#, "\n",
        r#"{"type":"ai-title","aiTitle":"Fitur auto title codeshare","sessionId":"s1"}"#, "\n",
    );

    #[test]
    fn claude_title_is_the_last_ai_title_line() {
        assert_eq!(claude_ai_title(CLAUDE).as_deref(), Some("Fitur auto title codeshare"));
    }

    #[test]
    fn claude_transcript_gives_title_first_typed_prompt_and_last_reply() {
        let title = title_from(CLAUDE, TranscriptFormat::Claude, None);
        assert_eq!(title.agent_title.as_deref(), Some("Fitur auto title codeshare"));
        // The `/clear` record is the CLI's, not a prompt anyone typed.
        assert_eq!(title.first_prompt.as_deref(), Some("Tolong analisis fitur auto title"));
        assert_eq!(title.last_reply.as_deref(), Some("Sumbernya layar TUI."));
    }

    #[test]
    fn a_claude_session_without_an_ai_title_has_none() {
        let text = CLAUDE
            .lines()
            .filter(|l| !l.contains("ai-title"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(title_from(&text, TranscriptFormat::Claude, None).agent_title, None);
    }

    #[test]
    fn codex_title_comes_from_the_index_by_session_id_and_the_last_entry_wins() {
        let transcript = r#"{"type":"session_meta","payload":{"id":"abc","cwd":"/x"}}"#;
        let index = concat!(
            r#"{"id":"zzz","thread_name":"Other thread"}"#, "\n",
            r#"{"id":"abc","thread_name":"First name"}"#, "\n",
            r#"{"id":"abc","thread_name":"Renamed thread"}"#, "\n",
        );
        assert_eq!(codex_session_id(transcript).as_deref(), Some("abc"));
        assert_eq!(codex_thread_name(index, "abc").as_deref(), Some("Renamed thread"));
        assert_eq!(codex_thread_name(index, "nope"), None);
    }

    #[test]
    fn config_dir_is_the_parent_of_projects() {
        assert_eq!(
            claude_config_dir_of("/u/.ccs/instances/work/projects/-x/s.jsonl"),
            Some(PathBuf::from("/u/.ccs/instances/work"))
        );
        assert_eq!(claude_config_dir_of("/tmp/s.jsonl"), None);
    }

    #[test]
    fn codex_index_sits_beside_sessions() {
        assert_eq!(
            codex_index_for(Path::new("/u/.codex/sessions/2026/10/10/r.jsonl")),
            Some(PathBuf::from("/u/.codex/session_index.jsonl"))
        );
    }

    #[test]
    fn title_at_reads_a_real_file() {
        let dir = std::env::temp_dir().join(format!("lotus-title-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("s1.jsonl");
        std::fs::write(&path, CLAUDE).unwrap();
        let title = title_at(path.to_str().unwrap()).expect("readable");
        assert_eq!(title.agent_title.as_deref(), Some("Fitur auto title codeshare"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
