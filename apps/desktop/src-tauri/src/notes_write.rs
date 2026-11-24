//! Agent writes to notes (ADR-0047, write path).
//!
//! The one hard part is a race. While a canvas has the project open, the note lives in the editor
//! and the canvas autosaves its in-memory nodes — a write straight to the store would be overwritten
//! a second later. So a write is RESOLVED here (target, conflict check, new content) and then either
//! handed to the window that has the canvas open (`mcp_notes.rs` routes it), or, when no canvas has
//! the project open (Code / Chat mode), applied to the stored snapshot by [`write_to_store`].
//!
//! Every write carries the agent's display name as `editedBy`, which the note footer shows; a user
//! edit clears it again.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::notes::{
    load_snapshot, note_view, notes_from_snapshot, parse_canvas_pane_id, project_summaries,
    NoteRecord, NoteView,
};

/// A single write may not grow a note past this; a note is a page, not a dump target.
pub const MAX_NOTE_CHARS: usize = 100_000;
/// Default size of a note an agent creates — the same as a new note in the UI (DEFAULT_NOTE_SIZE).
const NEW_NOTE_SIZE: (f64, f64) = (440.0, 520.0);
/// Gap between a created note and the agent it is placed beside.
const NEW_NOTE_GAP: f64 = 80.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WriteMode {
    /// Add `markdown` as new blocks at the end.
    Append,
    /// Replace the whole note.
    Replace,
    /// A new note, wired to the calling canvas agent.
    Create,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct NotesWriteRequest {
    #[serde(default)]
    pub caller_pane_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub note_id: Option<String>,
    #[serde(default)]
    pub mode: Option<WriteMode>,
    #[serde(default)]
    pub markdown: String,
    /// The `editedAt` the agent last read. If the note changed since, the write is refused.
    #[serde(default)]
    pub expected_edited_at: Option<i64>,
}

/// A write with its target and new content decided — what the open canvas or the store applies.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedWrite {
    pub project_id: String,
    pub mode: WriteMode,
    /// The note written to; for `create`, the id the new note gets.
    pub note_id: String,
    /// The markdown as sent. The canvas recomputes append/replace from its own, fresher content.
    pub markdown: String,
    /// The content after the write, computed from the STORED note (used by the store path).
    pub next_content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_edited_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// The calling canvas agent's node — a created note is wired to it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caller_node_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum NotesWriteError {
    EmptyMarkdown,
    TooLong { chars: usize },
    NeedProject,
    UnknownProject(String),
    NoteNotFound(String),
    NoTarget,
    AmbiguousTarget(Vec<(String, String)>),
    Conflict { current_edited_at: Option<i64> },
}

impl std::error::Error for NotesWriteError {}

impl std::fmt::Display for NotesWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyMarkdown => write!(f, "markdown is empty — nothing to write"),
            Self::TooLong { chars } => write!(f, "the note would be {chars} characters; the limit is {MAX_NOTE_CHARS}. Create a new note instead."),
            Self::NeedProject => write!(f, "no project: pass projectId (call lotus_notes_read with no projectId to list projects)"),
            Self::UnknownProject(id) => write!(f, "no canvas project '{id}'"),
            Self::NoteNotFound(id) => write!(f, "no note '{id}' in this project — call lotus_notes_read to see the note ids"),
            Self::NoTarget => write!(f, "no note is wired to you: pass noteId, or use mode 'create' for a new note"),
            Self::AmbiguousTarget(notes) => {
                let list: Vec<String> = notes.iter().map(|(id, title)| format!("{id} (\"{title}\")")).collect();
                write!(f, "several notes are wired to you — pass noteId, one of: {}", list.join(", "))
            }
            Self::Conflict { current_edited_at } => write!(
                f,
                "conflict: the note changed since you read it (editedAt is now {}). Read it again with lotus_notes_read, then write.",
                current_edited_at.map(|t| t.to_string()).unwrap_or_else(|| "unset".into())
            ),
        }
    }
}

/// Append keeps the note's own text and adds the new markdown as its own block.
pub fn next_content(mode: WriteMode, current: &str, markdown: &str) -> String {
    match mode {
        WriteMode::Replace | WriteMode::Create => markdown.to_string(),
        WriteMode::Append => {
            let head = current.trim_end();
            if head.is_empty() {
                markdown.trim_start().to_string()
            } else {
                format!("{head}\n\n{}", markdown.trim_start())
            }
        }
    }
}

/// Decide what to write where. `new_id` makes `create` testable.
pub fn resolve_write(
    connection: &Connection,
    req: &NotesWriteRequest,
    author: Option<String>,
    new_id: impl FnOnce() -> String,
) -> Result<ResolvedWrite, Box<dyn std::error::Error + Send + Sync>> {
    let mode = req.mode.unwrap_or(WriteMode::Append);
    if mode != WriteMode::Replace && req.markdown.trim().is_empty() {
        return Err(Box::new(NotesWriteError::EmptyMarkdown));
    }
    let caller = req.caller_pane_id.as_deref().and_then(parse_canvas_pane_id);
    let project_id = req
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .or_else(|| caller.as_ref().map(|c| c.project_id.clone()))
        .ok_or(NotesWriteError::NeedProject)?;
    // Only the caller's OWN board knows which node is the caller.
    let caller_node_id = caller
        .filter(|c| c.project_id == project_id)
        .map(|c| c.node_id);

    let records = match load_snapshot(connection, &project_id)? {
        Some((nodes, edges)) => notes_from_snapshot(&nodes, &edges),
        None if project_summaries(connection)?
            .iter()
            .any(|p| p.id == project_id) =>
        {
            Vec::new()
        }
        None => return Err(Box::new(NotesWriteError::UnknownProject(project_id))),
    };

    let (note_id, current) = match mode {
        WriteMode::Create => (new_id(), String::new()),
        WriteMode::Append | WriteMode::Replace => {
            let target = pick_target(&records, req.note_id.as_deref(), caller_node_id.as_deref())?;
            if let Some(expected) = req.expected_edited_at {
                if target.edited_at != Some(expected) {
                    return Err(Box::new(NotesWriteError::Conflict {
                        current_edited_at: target.edited_at,
                    }));
                }
            }
            (target.id.clone(), target.content.clone())
        }
    };
    let next = next_content(mode, &current, &req.markdown);
    let chars = next.chars().count();
    if chars > MAX_NOTE_CHARS {
        return Err(Box::new(NotesWriteError::TooLong { chars }));
    }
    Ok(ResolvedWrite {
        project_id,
        mode,
        note_id,
        markdown: req.markdown.clone(),
        next_content: next,
        expected_edited_at: req.expected_edited_at,
        author,
        caller_node_id,
    })
}

/// An explicit id wins; otherwise the one note wired to the caller.
fn pick_target<'a>(
    records: &'a [NoteRecord],
    note_id: Option<&str>,
    caller_node_id: Option<&str>,
) -> Result<&'a NoteRecord, NotesWriteError> {
    if let Some(id) = note_id.map(str::trim).filter(|id| !id.is_empty()) {
        return records
            .iter()
            .find(|n| n.id == id)
            .ok_or_else(|| NotesWriteError::NoteNotFound(id.to_string()));
    }
    let Some(caller) = caller_node_id else {
        return Err(NotesWriteError::NoTarget);
    };
    let linked: Vec<&NoteRecord> = records
        .iter()
        .filter(|n| n.linked_node_ids.iter().any(|id| id == caller))
        .collect();
    match linked.as_slice() {
        [] => Err(NotesWriteError::NoTarget),
        [one] => Ok(one),
        many => Err(NotesWriteError::AmbiguousTarget(
            many.iter()
                .map(|n| {
                    (
                        n.id.clone(),
                        crate::notes::derive_note_title(&n.content, n.note_number),
                    )
                })
                .collect(),
        )),
    }
}

fn number(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

/// Apply a resolved write to snapshot JSON. Returns false if an append/replace target vanished.
pub fn apply_to_snapshot(
    nodes: &mut Value,
    edges: &mut Value,
    write: &ResolvedWrite,
    now_ms: i64,
) -> bool {
    if !nodes.is_array() {
        *nodes = json!([]);
    }
    if !edges.is_array() {
        *edges = json!([]);
    }
    let list = nodes.as_array_mut().expect("array");
    if write.mode != WriteMode::Create {
        let Some(node) = list.iter_mut().find(|n| {
            n.get("type").and_then(Value::as_str) == Some("note")
                && n.get("id").and_then(Value::as_str) == Some(write.note_id.as_str())
        }) else {
            return false;
        };
        node["content"] = json!(write.next_content);
        node["editedAt"] = json!(now_ms);
        match &write.author {
            Some(author) => node["editedBy"] = json!(author),
            None => {
                if let Some(map) = node.as_object_mut() {
                    map.remove("editedBy");
                }
            }
        }
        return true;
    }

    // Beside the caller when we know it, else to the right of everything on the board.
    let caller = write.caller_node_id.as_deref().and_then(|id| {
        list.iter()
            .find(|n| n.get("id").and_then(Value::as_str) == Some(id))
    });
    let position = match caller.and_then(|c| c.get("position")) {
        Some(pos) => {
            json!({ "x": number(pos, "x").unwrap_or(0.0) - NEW_NOTE_SIZE.0 - NEW_NOTE_GAP, "y": number(pos, "y").unwrap_or(0.0) })
        }
        None => {
            let right = list
                .iter()
                .filter_map(|n| {
                    Some(
                        number(n.get("position")?, "x")?
                            + n.get("size").and_then(|s| number(s, "w")).unwrap_or(0.0),
                    )
                })
                .fold(f64::NEG_INFINITY, f64::max);
            json!({ "x": if right.is_finite() { right + NEW_NOTE_GAP } else { 0.0 }, "y": 0.0 })
        }
    };
    let note_number = list
        .iter()
        .filter(|n| n.get("type").and_then(Value::as_str) == Some("note"))
        .filter_map(|n| n.get("noteNumber").and_then(Value::as_u64))
        .max()
        .unwrap_or(0)
        + 1;
    let mut node = json!({
        "type": "note",
        "id": write.note_id,
        "position": position,
        "size": { "w": NEW_NOTE_SIZE.0, "h": NEW_NOTE_SIZE.1 },
        "content": write.next_content,
        "noteNumber": note_number,
        "editedAt": now_ms,
    });
    if let Some(author) = &write.author {
        node["editedBy"] = json!(author);
    }
    list.push(node);
    if let Some(caller) = &write.caller_node_id {
        edges.as_array_mut().expect("array").push(json!({
            "id": format!("e-{}", write.note_id),
            "source": write.note_id,
            "target": caller,
            "kind": "context",
        }));
    }
    true
}

/// The store path: no canvas has the project open, so the snapshot is the only copy.
pub fn write_to_store(
    connection: &Connection,
    write: &ResolvedWrite,
    now_ms: i64,
) -> Result<NoteView, Box<dyn std::error::Error + Send + Sync>> {
    let (mut nodes, mut edges) =
        load_snapshot(connection, &write.project_id)?.unwrap_or((Value::Null, Value::Null));
    if !apply_to_snapshot(&mut nodes, &mut edges, write, now_ms) {
        return Err(Box::new(NotesWriteError::NoteNotFound(
            write.note_id.clone(),
        )));
    }
    connection.execute(
        "INSERT INTO codecanvas_snapshots (project_id, nodes_json, edges_json, terminal_counter, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4)
         ON CONFLICT(project_id) DO UPDATE SET nodes_json = excluded.nodes_json, edges_json = excluded.edges_json, updated_at = excluded.updated_at",
        params![write.project_id, nodes.to_string(), edges.to_string(), now_ms],
    )?;
    let note = notes_from_snapshot(&nodes, &edges)
        .into_iter()
        .find(|n| n.id == write.note_id)
        .ok_or_else(|| NotesWriteError::NoteNotFound(write.note_id.clone()))?;
    Ok(note_view(
        note,
        &write.project_id,
        true,
        crate::notes::DEFAULT_MAX_CHARS,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::{notes_from_snapshot, NoteRecord};

    fn store() -> Connection {
        let path = std::env::temp_dir().join(format!(
            "lotus-notes-write-{}-{:x}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let connection = crate::codecanvas_store::open_store(&path).expect("open store");
        connection
            .execute("INSERT INTO codecanvas_projects (id, root_dir, alias, position, updated_at, last_opened_at) VALUES ('cp_1', '/repo/lotus', NULL, 0, 0, 0)", [])
            .expect("project");
        let nodes = json!([
            { "type": "note", "id": "n1", "position": { "x": 0, "y": 0 }, "size": { "w": 440, "h": 520 }, "content": "# TODO\n\nBuatkan pantun", "noteNumber": 1, "editedAt": 100 },
            { "type": "note", "id": "n2", "position": { "x": 0, "y": 600 }, "size": { "w": 440, "h": 520 }, "content": "# Other", "noteNumber": 2 },
            { "type": "agent", "id": "ivo", "position": { "x": 600, "y": 0 }, "size": { "w": 720, "h": 520 } }
        ]);
        let edges = json!([{ "id": "e1", "source": "n1", "target": "ivo", "kind": "context" }]);
        connection
            .execute(
                "INSERT INTO codecanvas_snapshots (project_id, nodes_json, edges_json, terminal_counter, updated_at) VALUES ('cp_1', ?1, ?2, 0, 0)",
                [nodes.to_string(), edges.to_string()],
            )
            .expect("snapshot");
        connection
    }

    fn req(mode: WriteMode, markdown: &str) -> NotesWriteRequest {
        NotesWriteRequest {
            caller_pane_id: Some("canvas:cp_1:ivo".into()),
            mode: Some(mode),
            markdown: markdown.into(),
            ..Default::default()
        }
    }

    fn stored(connection: &Connection) -> Vec<NoteRecord> {
        let (nodes, edges) = load_snapshot(connection, "cp_1").unwrap().unwrap();
        notes_from_snapshot(&nodes, &edges)
    }

    #[test]
    fn appends_as_a_new_block() {
        assert_eq!(
            next_content(WriteMode::Append, "# TODO\n\nline\n\n", "## Pantun\n\na"),
            "# TODO\n\nline\n\n## Pantun\n\na"
        );
        assert_eq!(next_content(WriteMode::Append, "", "\n\nfirst"), "first");
        assert_eq!(next_content(WriteMode::Replace, "old", "new"), "new");
    }

    #[test]
    fn appends_to_the_one_wired_note_and_marks_the_author() {
        let connection = store();
        let write = resolve_write(
            &connection,
            &req(WriteMode::Append, "## Pantun\n\nPergi ke pasar"),
            Some("Ivo".into()),
            || unreachable!(),
        )
        .unwrap();
        assert_eq!(write.note_id, "n1");
        let view = write_to_store(&connection, &write, 500).unwrap();
        assert_eq!(
            view.content.as_deref(),
            Some("# TODO\n\nBuatkan pantun\n\n## Pantun\n\nPergi ke pasar")
        );
        assert_eq!(
            (view.edited_at, view.edited_by.as_deref()),
            (Some(500), Some("Ivo"))
        );
        let other = stored(&connection)
            .into_iter()
            .find(|n| n.id == "n2")
            .unwrap();
        assert_eq!(other.content, "# Other", "only the target changes");
    }

    #[test]
    fn refuses_a_write_on_top_of_a_change_it_has_not_read() {
        let connection = store();
        let stale = NotesWriteRequest {
            expected_edited_at: Some(99),
            ..req(WriteMode::Replace, "x")
        };
        let err = resolve_write(&connection, &stale, None, || unreachable!()).unwrap_err();
        assert!(err.to_string().starts_with("conflict"), "{err}");
        let fresh = NotesWriteRequest {
            expected_edited_at: Some(100),
            ..req(WriteMode::Replace, "x")
        };
        assert!(resolve_write(&connection, &fresh, None, || unreachable!()).is_ok());
    }

    #[test]
    fn creates_a_note_beside_the_agent_wired_to_it() {
        let connection = store();
        let write = resolve_write(
            &connection,
            &req(WriteMode::Create, "# Pantun\n\nbaris"),
            Some("Ivo".into()),
            || "note-new".into(),
        )
        .unwrap();
        let view = write_to_store(&connection, &write, 700).unwrap();
        assert_eq!(
            (view.id.as_str(), view.title.as_str()),
            ("note-new", "Pantun")
        );
        assert_eq!(view.linked_node_ids, vec!["ivo".to_string()]);
        let (nodes, _) = load_snapshot(&connection, "cp_1").unwrap().unwrap();
        let created = nodes
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == "note-new")
            .unwrap();
        assert_eq!(
            created["position"],
            json!({ "x": 600.0 - 440.0 - 80.0, "y": 0.0 })
        );
        assert_eq!(created["noteNumber"], json!(3));
    }

    #[test]
    fn explains_what_to_pass_when_the_target_is_unclear() {
        let connection = store();
        let missing = NotesWriteRequest {
            note_id: Some("nope".into()),
            ..req(WriteMode::Append, "x")
        };
        assert!(
            resolve_write(&connection, &missing, None, || unreachable!())
                .unwrap_err()
                .to_string()
                .contains("no note 'nope'")
        );

        let unwired = NotesWriteRequest {
            caller_pane_id: Some("canvas:cp_1:someone".into()),
            ..req(WriteMode::Append, "x")
        };
        assert!(
            resolve_write(&connection, &unwired, None, || unreachable!())
                .unwrap_err()
                .to_string()
                .contains("no note is wired to you")
        );

        let code_mode = NotesWriteRequest {
            caller_pane_id: Some("p-nova".into()),
            ..req(WriteMode::Append, "x")
        };
        assert!(
            resolve_write(&connection, &code_mode, None, || unreachable!())
                .unwrap_err()
                .to_string()
                .contains("pass projectId")
        );

        let empty = req(WriteMode::Append, "  ");
        assert_eq!(
            resolve_write(&connection, &empty, None, || unreachable!())
                .unwrap_err()
                .to_string(),
            "markdown is empty — nothing to write"
        );
    }

    #[test]
    fn a_code_mode_agent_writes_by_project_and_id() {
        let connection = store();
        let write_req = NotesWriteRequest {
            caller_pane_id: Some("p-nova".into()),
            project_id: Some("cp_1".into()),
            note_id: Some("n2".into()),
            mode: Some(WriteMode::Replace),
            markdown: "# Other\n\nfrom code".into(),
            ..Default::default()
        };
        let write = resolve_write(&connection, &write_req, None, || unreachable!()).unwrap();
        assert_eq!(write.caller_node_id, None);
        let view = write_to_store(&connection, &write, 800).unwrap();
        assert_eq!(view.content.as_deref(), Some("# Other\n\nfrom code"));
        assert_eq!(view.edited_by, None);
    }
}
