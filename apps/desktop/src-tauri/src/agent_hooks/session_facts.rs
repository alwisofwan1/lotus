//! The model and git branch a session is working with, read from the agent CLI's own
//! transcript (Pocket v4 task #106).
//!
//! **Read, never derived.** A model label made up from the runner's default would be wrong
//! the first time someone picked another one, so both values come from what the CLI wrote:
//!
//! | | Claude | Codex |
//! |---|---|---|
//! | model | `assistant` line, `message.model` | `turn_context` line, `payload.model` |
//! | branch | `gitBranch` on every line | `session_meta` (first line), `payload.git.branch` |
//!
//! Read from live files 2026-10-06. Claude also writes `"model": "<synthetic>"` on lines it
//! makes up itself (an interrupted turn, an API error), which is not a model anyone chose;
//! it is skipped. Cursor's transcript names neither, so a Cursor cell gets nothing.
//!
//! **Only the ends of the file are read.** A transcript grows to megabytes, and the fleet
//! is listed on every phone refresh. The latest model is near the end; Codex's branch is
//! only on the first line. The answer is cached per path until the file's length changes.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

/// Bytes read from the end. Several turns of a busy session; an `assistant` line with a
/// large tool result can be long, so this is generous rather than tight.
const TAIL_BYTES: u64 = 256 * 1024;
/// Bytes read from the start, for Codex's `session_meta` (its instructions make it long).
const HEAD_BYTES: u64 = 64 * 1024;
/// Paths remembered before the cache is dropped and rebuilt. One per live pane is the need.
const CACHE_MAX: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionFacts {
    pub model: Option<String>,
    pub branch: Option<String>,
}

/// What `text` (whole JSONL lines, in file order) says. Later lines win.
pub fn facts_from(text: &str) -> SessionFacts {
    let mut out = SessionFacts::default();
    for line in text.lines() {
        // Cheap filter first: most lines are tool output and carry neither key.
        if !(line.contains("\"model\"")
            || line.contains("\"gitBranch\"")
            || line.contains("\"git\""))
        {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = value.get("payload");
        let model = match kind {
            "assistant" => value.pointer("/message/model"),
            "turn_context" => payload.and_then(|p| p.get("model")),
            _ => None,
        };
        if let Some(model) = named(model).filter(|m| m != "<synthetic>") {
            out.model = Some(model);
        }
        let branch = match kind {
            "session_meta" => payload.and_then(|p| p.pointer("/git/branch")),
            _ => value.get("gitBranch"),
        };
        if let Some(branch) = named(branch) {
            out.branch = Some(branch);
        }
    }
    out
}

fn named(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The facts for the transcript at `path`, or empty when it cannot be read.
pub fn facts_at(path: &str) -> SessionFacts {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, SessionFacts)>>> = OnceLock::new();
    let Ok(len) = std::fs::metadata(path).map(|m| m.len()) else {
        return SessionFacts::default();
    };
    let cache = CACHE.get_or_init(Default::default);
    if let Some((seen, facts)) = cache.lock().ok().and_then(|c| c.get(path).cloned()) {
        if seen == len {
            return facts;
        }
    }
    let facts = read_ends(path, len)
        .map(|text| facts_from(&text))
        .unwrap_or_default();
    if let Ok(mut c) = cache.lock() {
        if c.len() >= CACHE_MAX {
            c.clear();
        }
        c.insert(path.to_string(), (len, facts.clone()));
    }
    facts
}

/// The head, then the tail, each cut back to whole lines. A file small enough is read once.
pub(super) fn read_ends(path: &str, len: u64) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    if len <= HEAD_BYTES + TAIL_BYTES {
        let mut text = String::new();
        file.read_to_string(&mut text)?;
        return Ok(text);
    }
    let mut head = vec![0; HEAD_BYTES as usize];
    file.read_exact(&mut head)?;
    let mut tail = vec![0; TAIL_BYTES as usize];
    file.seek(SeekFrom::Start(len - TAIL_BYTES))?;
    file.read_exact(&mut tail)?;
    Ok(format!(
        "{}\n{}",
        whole_lines_head(&head),
        whole_lines_tail(&tail)
    ))
}

/// Up to the last newline: a line cut in half would not parse anyway, but it could.
fn whole_lines_head(bytes: &[u8]) -> String {
    let end = bytes.iter().rposition(|b| *b == b'\n').unwrap_or(0);
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// From the first newline on.
fn whole_lines_tail(bytes: &[u8]) -> String {
    let start = bytes
        .iter()
        .position(|b| *b == b'\n')
        .map_or(bytes.len(), |i| i + 1);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_gives_the_latest_model_and_branch() {
        let text = [
            r#"{"type":"user","gitBranch":"main","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","gitBranch":"main","message":{"model":"claude-sonnet-5-5"}}"#,
            r#"{"type":"assistant","gitBranch":"feat/x","message":{"model":"claude-opus-5-5"}}"#,
            r#"{"type":"assistant","gitBranch":"feat/x","message":{"model":"<synthetic>"}}"#,
        ]
        .join("\n");
        assert_eq!(
            facts_from(&text),
            SessionFacts {
                model: Some("claude-opus-5-5".into()),
                branch: Some("feat/x".into())
            }
        );
    }

    #[test]
    fn codex_gives_the_turn_model_and_the_session_branch() {
        let text = [
            r#"{"type":"session_meta","payload":{"cwd":"/r","git":{"branch":"main","commit_hash":"c"}}}"#,
            r#"{"type":"turn_context","payload":{"model":"gpt-5.6-luna"}}"#,
        ]
        .join("\n");
        assert_eq!(
            facts_from(&text),
            SessionFacts {
                model: Some("gpt-5.6-luna".into()),
                branch: Some("main".into())
            }
        );
    }

    #[test]
    fn nothing_said_is_nothing_shown() {
        let text = [
            r#"{"type":"session_meta","payload":{"cwd":"/not-a-repo"}}"#,
            r#"{"type":"user","gitBranch":"","message":{"content":"hi"}}"#,
            r#"{"role":"assistant","message":{"content":[]}}"#,
            "not json \"model\"",
        ]
        .join("\n");
        assert_eq!(facts_from(&text), SessionFacts::default());
    }

    #[test]
    fn a_large_file_is_read_at_both_ends_and_cached_by_length() {
        let dir = std::env::temp_dir().join(format!("session-facts-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        let filler = format!(
            "{{\"type\":\"response_item\",\"payload\":\"{}\"}}\n",
            "x".repeat(1000)
        );
        let mut text =
            String::from(r#"{"type":"session_meta","payload":{"git":{"branch":"dev"}}}"#);
        text.push('\n');
        text.push_str(&filler.repeat(400));
        text.push_str(r#"{"type":"turn_context","payload":{"model":"gpt-a"}}"#);
        text.push('\n');
        std::fs::write(&path, &text).unwrap();
        let p = path.to_str().unwrap();

        assert_eq!(
            facts_at(p),
            SessionFacts {
                model: Some("gpt-a".into()),
                branch: Some("dev".into())
            }
        );

        text.push_str(r#"{"type":"turn_context","payload":{"model":"gpt-b"}}"#);
        text.push('\n');
        std::fs::write(&path, &text).unwrap();
        assert_eq!(
            facts_at(p).model.as_deref(),
            Some("gpt-b"),
            "a grown file is read again"
        );

        assert_eq!(
            facts_at(dir.join("gone.jsonl").to_str().unwrap()),
            SessionFacts::default()
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
