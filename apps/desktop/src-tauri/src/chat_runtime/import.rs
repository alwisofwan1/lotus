//! Brings old CodeChat history (`codechat.sqlite3`) into the new chat (#290).
//!
//! CodeChat never kept a Claude or Codex session id, so an imported thread cannot resume: its
//! history is shown, and the next message starts a fresh session. Each CodeChat message becomes
//! completed ThreadEvents; a user message starts a turn, the assistant messages after it fill it.
//! CodeChat's database is opened read-only and never changed.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Map, Value};

use super::store::{title_of, ThreadRecord};

pub struct Imported {
    pub record: ThreadRecord,
    pub events: Vec<(i64, Value)>,
}

/// Every CodeChat session that has messages, oldest first. A missing database has none.
pub fn read(path: &Path, home: &str) -> Result<Vec<Imported>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut sessions = conn
        .prepare(
            "SELECT id, title, workspace_path, runtime_config_json, updated_at FROM sessions
             WHERE EXISTS (SELECT 1 FROM messages WHERE session_id = sessions.id) ORDER BY updated_at",
        )
        .map_err(|e| e.to_string())?;
    let mut messages = conn
        .prepare("SELECT message_id, role, parts_json, created_at FROM messages WHERE session_id = ?1 ORDER BY position")
        .map_err(|e| e.to_string())?;
    let rows = sessions
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, title, workspace, config, updated_at) in rows {
        let msgs = messages
            .query_map([&id], |row| {
                Ok(Message {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    parts: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or(Value::Null),
                    at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let config: Value = config.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or(Value::Null);
        out.push(session(&id, &title, workspace, &config, updated_at, &msgs, home));
    }
    Ok(out)
}

pub struct Message {
    pub id: String,
    pub role: String,
    pub parts: Value,
    pub at: i64,
}

pub fn session(
    id: &str,
    title: &str,
    workspace: Option<String>,
    config: &Value,
    updated_at: i64,
    messages: &[Message],
    home: &str,
) -> Imported {
    let agent = config.get("agentId").and_then(Value::as_str).unwrap_or("");
    let model = config.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string);
    // Only Codex runs as Codex; every other CodeChat agent (Claude profiles, Cursor, opencode, qwen)
    // continues on Claude, keeping the model only when it was Claude's own.
    let (runner, model, effort) = match agent {
        "codex" => ("codex", model, config.get("effort").and_then(Value::as_str).map(str::to_string)),
        "claude" => ("claude", model, None),
        _ => ("claude", None, None),
    };
    let events = events(messages);
    let created_at = events.first().map_or(updated_at, |(at, _)| *at);
    let first_text = messages.iter().find(|m| m.role == "user").map(|m| text_of(&m.parts));
    Imported {
        record: ThreadRecord {
            id: uuid::Uuid::new_v4().to_string(),
            cwd: workspace.filter(|w| !w.trim().is_empty()).unwrap_or_else(|| home.to_string()),
            model,
            permission_mode: "default".into(),
            runner: runner.into(),
            provider: None,
            effort,
            provider_session_id: None,
            account: None,
            created_at,
            updated_at: updated_at.max(created_at),
            title: title_of(title).or_else(|| first_text.as_deref().and_then(title_of)),
            imported_from: Some(id.to_string()),
            archived: false,
            pinned_at: None,
            last_turn_ended_at: None,
            last_read_at: None,
            turn_started_at: None,
            status: None,
            link: None,
            parent_id: None,
            machine: None,
            agent_name: None,
            role: None,
            verify: None,
        },
        events,
    }
}

fn text_of(parts: &Value) -> String {
    parts
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn events(messages: &[Message]) -> Vec<(i64, Value)> {
    let mut events = Vec::new();
    let mut turn: Option<String> = None;
    let close = |events: &mut Vec<(i64, Value)>, turn: &mut Option<String>, at: i64| {
        if let Some(turn_id) = turn.take() {
            events.push((at, json!({"type": "turn/completed", "turnId": turn_id, "status": "completed", "error": null, "usage": null})));
        }
    };
    for (n, message) in messages.iter().enumerate() {
        let at = message.at;
        if message.role == "user" {
            close(&mut events, &mut turn, at);
            let turn_id = format!("import-{n}");
            let input = json!({"text": text_of(&message.parts), "clientRequestId": message.id});
            events.push((at, json!({"type": "turn/started", "turnId": turn_id, "input": input})));
            turn = Some(turn_id);
            continue;
        }
        let turn_id = turn.get_or_insert_with(|| {
            let turn_id = format!("import-{n}");
            events.push((at, json!({"type": "turn/started", "turnId": turn_id, "input": null})));
            turn_id
        });
        for (i, part) in message.parts.as_array().into_iter().flatten().enumerate() {
            if let Some(item) = item(&format!("{}-{i}", message.id), part) {
                events.push((at, json!({"type": "item/completed", "turnId": turn_id, "item": item})));
            }
        }
    }
    let last = messages.last().map_or(0, |m| m.at);
    close(&mut events, &mut turn, last);
    events
}

fn item(id: &str, part: &Value) -> Option<Value> {
    let str_at = |v: &Value, key: &str| v.get(key).and_then(Value::as_str).map(str::to_string);
    match part.get("type").and_then(Value::as_str)? {
        kind @ ("text" | "reasoning") => {
            let text = str_at(part, "text").filter(|t| !t.trim().is_empty())?;
            let kind = if kind == "text" { "agentMessage" } else { "reasoning" };
            Some(json!({"id": id, "status": "completed", "kind": kind, "text": text}))
        }
        "dynamic-tool" => {
            let name = str_at(part, "toolName").unwrap_or_else(|| "tool".into());
            let input = part.get("input").cloned().unwrap_or(Value::Object(Map::new()));
            let output = match part.get("output") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(other) => Some(other.to_string()),
            };
            Some(match (name.as_str(), str_at(&input, "command"), str_at(&input, "file_path")) {
                ("Bash", Some(command), _) => json!({"id": id, "status": "completed", "kind": "command",
                    "command": command, "description": str_at(&input, "description"), "output": output}),
                ("Read", _, Some(path)) => json!({"id": id, "status": "completed", "kind": "fileRead",
                    "path": path, "lineCount": null}),
                _ => json!({"id": id, "status": "completed", "kind": "tool",
                    "name": name, "input": input, "output": output}),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(id: &str, role: &str, at: i64, parts: Value) -> Message {
        Message { id: id.into(), role: role.into(), parts, at }
    }

    #[test]
    fn turns_messages_into_completed_turns() {
        let messages = [
            message("u1", "user", 10, json!([{"type": "text", "text": "List files"}])),
            message("a1", "assistant", 11, json!([
                {"type": "reasoning", "state": "done", "text": "Use ls"},
                {"type": "dynamic-tool", "toolName": "Bash", "state": "input-available", "toolCallId": "t",
                 "input": {"command": "ls", "description": "List"}},
                {"type": "dynamic-tool", "toolName": "Read", "input": {"file_path": "/w/a.md"}},
                {"type": "dynamic-tool", "toolName": "Grep", "input": {"pattern": "x"}, "output": {"n": 1}},
                {"type": "text", "text": "Two files.", "state": "streaming"},
                {"type": "text", "text": "  "},
            ])),
            message("u2", "user", 12, json!([{"type": "text", "text": "Thanks"}])),
        ];
        let imported = session("s1", "", None, &json!({"agentId": "cursor", "model": "auto"}), 13, &messages, "/home");
        let kinds: Vec<String> = imported
            .events
            .iter()
            .map(|(_, e)| {
                let t = e["type"].as_str().unwrap();
                e.pointer("/item/kind").and_then(Value::as_str).map_or(t.to_string(), |k| format!("{t}:{k}"))
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "turn/started", "item/completed:reasoning", "item/completed:command", "item/completed:fileRead",
                "item/completed:tool", "item/completed:agentMessage", "turn/completed", "turn/started", "turn/completed",
            ]
        );
        assert_eq!(imported.events[4].1["item"]["output"], json!("{\"n\":1}"));
        assert_eq!(imported.events[7].1["input"]["text"], json!("Thanks"));
        let r = &imported.record;
        assert_eq!((r.runner.as_str(), r.model.as_deref(), r.cwd.as_str()), ("claude", None, "/home"));
        assert_eq!((r.title.as_deref(), r.imported_from.as_deref()), (Some("List files"), Some("s1")));
        assert_eq!((r.created_at, r.updated_at), (10, 13));
    }

    #[test]
    fn keeps_codex_and_claude_models_and_opens_a_turn_for_a_leading_reply() {
        let messages = [message("a1", "assistant", 5, json!([{"type": "text", "text": "Hi"}]))];
        let codex = session("s", "Fix it", Some("/w".into()), &json!({"agentId": "codex", "model": "gpt-5.4", "effort": "high"}), 5, &messages, "/h");
        assert_eq!((codex.record.runner.as_str(), codex.record.model.as_deref(), codex.record.effort.as_deref()), ("codex", Some("gpt-5.4"), Some("high")));
        assert_eq!(codex.record.title.as_deref(), Some("Fix it"));
        assert_eq!(codex.events[0].1["input"], Value::Null);
        let claude = session("s", "t", None, &json!({"agentId": "claude", "model": "sonnet"}), 5, &messages, "/h");
        assert_eq!((claude.record.model.as_deref(), claude.record.effort), (Some("sonnet"), None));
    }
}
