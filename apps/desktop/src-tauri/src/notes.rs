//! Notes as a module-neutral read model (ADR-0047).
//!
//! A note's durable home is the CodeCanvas snapshot (`codecanvas_snapshots.nodes_json`). Reading it
//! here — from the store, not from the canvas UI — is what lets any mode use notes: a Canvas agent
//! reads the notes wired to it, and a Code or Chat agent reads a project's notes, even when no
//! canvas is mounted. The canvas autosaves about a second after an edit, so this is that fresh.
//!
//! Kept free of axum/Tauri so the whole read path is unit-testable; `mcp_notes.rs` is the HTTP
//! adapter. New note actions (search, write) belong beside `read_notes`, behind the same route.

use std::collections::{BTreeSet, HashMap};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codecanvas_store::CodeCanvasStoreResult;

pub const DEFAULT_LIMIT: usize = 20;
pub const MAX_LIMIT: usize = 100;
pub const DEFAULT_MAX_CHARS: usize = 20_000;
/// Same cap as the TS `deriveNoteTitle` — a title is a label, never a paragraph.
const TITLE_MAX: usize = 120;
/// The runtime scope a canvas with no project uses (`canvas-runtime-scope.ts`). Not a project.
const DEFAULT_RUNTIME_PROJECT: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteScope {
    /// Notes wired to the calling canvas agent (either wire direction).
    Linked,
    /// Every note in one project.
    Project,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct NotesReadQuery {
    /// `LOTUS_PANE_ID` of the calling agent. A canvas agent's is `canvas:<project>:<node>`.
    #[serde(default)]
    pub caller_pane_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub scope: Option<NoteScope>,
    #[serde(default)]
    pub note_ids: Option<Vec<String>>,
    /// Case-insensitive substring over title and content.
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub include_content: Option<bool>,
    #[serde(default)]
    pub max_chars: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteView {
    pub id: String,
    pub project_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<i64>,
    /// Display name of the agent that wrote the last change; absent when the user did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub edited_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cover_uri: Option<String>,
    pub tasks: TaskProgress,
    /// Nodes this note is wired to, either direction.
    pub linked_node_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// True when `content` was cut at `maxChars`.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub note_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum NotesReadOutcome {
    #[serde(rename_all = "camelCase")]
    Notes {
        scope: NoteScope,
        project_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        caller_node_id: Option<String>,
        /// Matches before `limit` was applied.
        total_matched: usize,
        notes: Vec<NoteView>,
        #[serde(skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
    },
    /// No project could be resolved (a Code or Chat caller that named none): pick one and ask again.
    #[serde(rename_all = "camelCase")]
    ChooseProject {
        projects: Vec<ProjectSummary>,
        hint: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanvasCaller {
    pub project_id: String,
    pub node_id: String,
}

/// `canvas:<project>:<node>` → the project and node. `None` for any other pane (Code, Chat, shells)
/// and for the project-less `canvas:default` scope.
pub fn parse_canvas_pane_id(pane_id: &str) -> Option<CanvasCaller> {
    let rest = pane_id.trim().strip_prefix("canvas:")?;
    let (project_id, node_id) = rest.rsplit_once(':')?;
    if project_id.is_empty() || node_id.is_empty() || project_id == DEFAULT_RUNTIME_PROJECT {
        return None;
    }
    Some(CanvasCaller {
        project_id: project_id.to_string(),
        node_id: node_id.to_string(),
    })
}

fn first_meaningful_line(content: &str) -> &str {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
}

/// Mirrors `deriveNoteTitle` (services/nodes/note-title.ts): the first line with Markdown markers
/// stripped, else `Note N` / `Note`. The two must agree, or an agent and the UI name a note apart.
pub fn derive_note_title(content: &str, note_number: Option<u64>) -> String {
    let mut line = first_meaningful_line(content);
    let hashes = line.chars().take_while(|ch| *ch == '#').count();
    if (1..=6).contains(&hashes) && line[hashes..].starts_with(char::is_whitespace) {
        line = line[hashes..].trim_start();
    } else if let Some(rest) = line.strip_prefix('>') {
        line = rest.trim_start();
    } else if let Some(rest) = line.strip_prefix(['-', '*', '+']) {
        if rest.starts_with(char::is_whitespace) {
            let rest = rest.trim_start();
            line = ["[ ]", "[x]", "[X]"]
                .iter()
                .find_map(|box_| rest.strip_prefix(box_))
                .map(str::trim_start)
                .unwrap_or(rest);
        }
    }
    let cleaned: String = line
        .chars()
        .filter(|ch| !matches!(ch, '*' | '_' | '`' | '~'))
        .collect();
    let cleaned = cleaned.trim();
    if !cleaned.chars().any(char::is_alphanumeric) {
        return match note_number {
            Some(n) => format!("Note {n}"),
            None => "Note".to_string(),
        };
    }
    cleaned.chars().take(TITLE_MAX).collect()
}

/// Checklist progress, the same rule as `noteTaskProgress`: `- [ ]` / `* [x]` / `+ [X]` items.
pub fn task_progress(content: &str) -> TaskProgress {
    let mut done = 0;
    let mut total = 0;
    for line in content.lines() {
        let line = line.trim_start_matches([' ', '\t']);
        let Some(rest) = line.strip_prefix(['-', '*', '+']) else {
            continue;
        };
        let rest = rest.trim_start_matches([' ', '\t']);
        if rest.len() == line.len() - 1 {
            continue; // no whitespace after the bullet
        }
        match rest.get(..3) {
            Some("[ ]") => total += 1,
            Some("[x]") | Some("[X]") => {
                total += 1;
                done += 1;
            }
            _ => {}
        }
    }
    TaskProgress { done, total }
}

/// One note as stored, before any filter or truncation.
#[derive(Debug, Clone, PartialEq)]
pub struct NoteRecord {
    pub id: String,
    pub content: String,
    pub note_number: Option<u64>,
    pub edited_at: Option<i64>,
    pub edited_by: Option<String>,
    pub cover_uri: Option<String>,
    pub linked_node_ids: Vec<String>,
}

/// The notes in one snapshot, with every wire that touches each one. Malformed entries are skipped:
/// the snapshot codec already repairs them on load, and a reader must never fail on one bad node.
pub fn notes_from_snapshot(nodes: &Value, edges: &Value) -> Vec<NoteRecord> {
    let mut links: HashMap<&str, BTreeSet<&str>> = HashMap::new();
    if let Some(edges) = edges.as_array() {
        for edge in edges {
            let (Some(source), Some(target)) = (
                edge.get("source").and_then(Value::as_str),
                edge.get("target").and_then(Value::as_str),
            ) else {
                continue;
            };
            links.entry(source).or_default().insert(target);
            links.entry(target).or_default().insert(source);
        }
    }
    let Some(nodes) = nodes.as_array() else {
        return Vec::new();
    };
    nodes
        .iter()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("note"))
        .filter_map(|node| {
            let id = node.get("id").and_then(Value::as_str)?;
            Some(NoteRecord {
                id: id.to_string(),
                content: node
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                note_number: node.get("noteNumber").and_then(Value::as_u64),
                edited_at: node
                    .get("editedAt")
                    .and_then(Value::as_f64)
                    .map(|ms| ms as i64),
                edited_by: node
                    .get("editedBy")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                cover_uri: node
                    .get("coverUri")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                linked_node_ids: links
                    .get(id)
                    .map(|set| set.iter().map(|s| s.to_string()).collect())
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        Some((byte, _)) => (text[..byte].to_string(), true),
        None => (text.to_string(), false),
    }
}

/// The agent-facing view of one note. Shared by read and write, so a write answers in the same
/// shape a read returns.
pub(crate) fn note_view(
    note: NoteRecord,
    project_id: &str,
    include_content: bool,
    max_chars: usize,
) -> NoteView {
    let (content, truncated) = if include_content {
        truncate_chars(&note.content, max_chars)
    } else {
        (String::new(), false)
    };
    NoteView {
        title: derive_note_title(&note.content, note.note_number),
        tasks: task_progress(&note.content),
        id: note.id,
        project_id: project_id.to_string(),
        edited_at: note.edited_at,
        edited_by: note.edited_by,
        cover_uri: note.cover_uri,
        linked_node_ids: note.linked_node_ids,
        content: include_content.then_some(content),
        truncated,
    }
}

/// Applies scope, ids, query, ordering (newest edit first), limit and truncation.
pub fn select_notes(
    records: Vec<NoteRecord>,
    project_id: &str,
    scope: NoteScope,
    caller_node_id: Option<&str>,
    query: &NotesReadQuery,
) -> (usize, Vec<NoteView>) {
    let ids: Option<BTreeSet<&str>> = query
        .note_ids
        .as_ref()
        .map(|ids| ids.iter().map(String::as_str).collect());
    let needle = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(str::to_lowercase);
    let mut matched: Vec<NoteRecord> = records
        .into_iter()
        .filter(|note| match scope {
            NoteScope::Linked => caller_node_id
                .is_some_and(|caller| note.linked_node_ids.iter().any(|id| id == caller)),
            NoteScope::Project => true,
        })
        .filter(|note| {
            ids.as_ref()
                .is_none_or(|ids| ids.contains(note.id.as_str()))
        })
        .filter(|note| {
            needle.as_ref().is_none_or(|needle| {
                note.content.to_lowercase().contains(needle)
                    || derive_note_title(&note.content, note.note_number)
                        .to_lowercase()
                        .contains(needle)
            })
        })
        .collect();
    matched.sort_by(|a, b| {
        b.edited_at
            .unwrap_or(i64::MIN)
            .cmp(&a.edited_at.unwrap_or(i64::MIN))
            .then_with(|| a.id.cmp(&b.id))
    });
    let total = matched.len();
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let include_content = query.include_content.unwrap_or(true);
    let max_chars = query.max_chars.unwrap_or(DEFAULT_MAX_CHARS).max(1);
    let views = matched
        .into_iter()
        .take(limit)
        .map(|note| note_view(note, project_id, include_content, max_chars))
        .collect();
    (total, views)
}

pub(crate) fn load_snapshot(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Option<(Value, Value)>> {
    let row: Option<(String, String)> = connection
        .query_row(
            "SELECT nodes_json, edges_json FROM codecanvas_snapshots WHERE project_id = ?1",
            [project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(nodes, edges)| {
        (
            serde_json::from_str(&nodes).unwrap_or(Value::Null),
            serde_json::from_str(&edges).unwrap_or(Value::Null),
        )
    }))
}

pub(crate) fn project_summaries(
    connection: &Connection,
) -> CodeCanvasStoreResult<Vec<ProjectSummary>> {
    let mut statement = connection.prepare(
        "SELECT p.id, p.alias, p.root_dir, s.nodes_json
         FROM codecanvas_projects p LEFT JOIN codecanvas_snapshots s ON s.project_id = p.id
         ORDER BY p.last_opened_at DESC",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
        ))
    })?;
    let mut projects = Vec::new();
    for row in rows {
        let (id, alias, root_dir, nodes) = row?;
        let nodes: Value = nodes
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or(Value::Null);
        let note_count = notes_from_snapshot(&nodes, &Value::Null).len();
        let name = alias
            .filter(|alias| !alias.trim().is_empty())
            .unwrap_or_else(|| {
                root_dir
                    .rsplit(['/', '\\'])
                    .find(|part| !part.is_empty())
                    .unwrap_or(&root_dir)
                    .to_string()
            });
        projects.push(ProjectSummary {
            id,
            name,
            note_count,
        });
    }
    Ok(projects)
}

/// Errors a caller can fix by changing the request.
#[derive(Debug, PartialEq, Eq)]
pub enum NotesReadError {
    LinkedNeedsCanvasCaller,
    UnknownProject(String),
}

impl std::error::Error for NotesReadError {}

impl std::fmt::Display for NotesReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LinkedNeedsCanvasCaller => write!(
                f,
                "scope 'linked' reads the notes wired to a canvas agent, and this caller is not one. Use scope 'project' with a projectId."
            ),
            Self::UnknownProject(id) => write!(f, "no canvas project '{id}'. Call without projectId to list projects."),
        }
    }
}

/// The `read` action. Scope defaults to `linked` for a canvas agent and `project` otherwise; the
/// project defaults to the caller's own. With no project at all, the projects are listed instead.
pub fn read_notes(
    connection: &Connection,
    query: &NotesReadQuery,
) -> Result<NotesReadOutcome, Box<dyn std::error::Error + Send + Sync>> {
    let caller = query
        .caller_pane_id
        .as_deref()
        .and_then(parse_canvas_pane_id);
    let scope = query.scope.unwrap_or(if caller.is_some() {
        NoteScope::Linked
    } else {
        NoteScope::Project
    });
    if scope == NoteScope::Linked && caller.is_none() {
        return Err(Box::new(NotesReadError::LinkedNeedsCanvasCaller));
    }
    let explicit = query
        .project_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    // A linked read is about the CALLER's wires, so it always reads the caller's own board.
    let project_id = match (scope, &caller) {
        (NoteScope::Linked, Some(caller)) => Some(caller.project_id.clone()),
        _ => explicit.or_else(|| caller.as_ref().map(|c| c.project_id.clone())),
    };
    let Some(project_id) = project_id else {
        return Ok(NotesReadOutcome::ChooseProject {
            projects: project_summaries(connection)?,
            hint: "Pass one of these ids as projectId to read its notes.".to_string(),
        });
    };
    let (nodes, edges) = match load_snapshot(connection, &project_id)? {
        Some(snapshot) => snapshot,
        // A project that exists but was never saved has no notes yet; one that does not exist is
        // a mistake the caller should hear about.
        None if project_summaries(connection)?
            .iter()
            .any(|p| p.id == project_id) =>
        {
            (Value::Null, Value::Null)
        }
        None => return Err(Box::new(NotesReadError::UnknownProject(project_id))),
    };
    let caller_node_id = caller.as_ref().map(|c| c.node_id.as_str());
    let (total_matched, notes) = select_notes(
        notes_from_snapshot(&nodes, &edges),
        &project_id,
        scope,
        caller_node_id,
        query,
    );
    let hint = (scope == NoteScope::Linked && total_matched == 0).then(|| {
        "No notes are wired to you. Use scope 'project' to read every note on this canvas."
            .to_string()
    });
    Ok(NotesReadOutcome::Notes {
        scope,
        project_id,
        caller_node_id: caller.map(|c| c.node_id),
        total_matched,
        notes,
        hint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_only_canvas_agent_panes() {
        assert_eq!(
            parse_canvas_pane_id("canvas:cp_1:agent-9"),
            Some(CanvasCaller {
                project_id: "cp_1".into(),
                node_id: "agent-9".into()
            })
        );
        assert_eq!(parse_canvas_pane_id("canvas:default:agent-9"), None);
        assert_eq!(parse_canvas_pane_id("canvas:cp_1"), None);
        assert_eq!(parse_canvas_pane_id("p-nova"), None);
    }

    #[test]
    fn derives_the_same_title_as_the_ui() {
        assert_eq!(
            derive_note_title("# Design spec\n\nbody", Some(4)),
            "Design spec"
        );
        assert_eq!(derive_note_title("- [x] **ship** it", None), "ship it");
        assert_eq!(derive_note_title("> quoted", None), "quoted");
        assert_eq!(derive_note_title("###", Some(2)), "Note 2");
        assert_eq!(derive_note_title("", None), "Note");
    }

    #[test]
    fn counts_checklist_items() {
        assert_eq!(
            task_progress("- [x] a\n- [ ] b\n* [X] c\nplain"),
            TaskProgress { done: 2, total: 3 }
        );
        assert_eq!(
            task_progress("-[ ] not a task"),
            TaskProgress { done: 0, total: 0 }
        );
    }

    fn board() -> (Value, Value) {
        let nodes = json!([
            { "type": "note", "id": "n1", "content": "# TODO\n\nlorem", "editedAt": 200.0 },
            { "type": "note", "id": "n2", "content": "# Spec\n\n- [x] a\n- [ ] b", "editedAt": 300.0, "coverUri": "lotus-note-asset://asset_1" },
            { "type": "note", "id": "n3", "content": "unwired" },
            { "type": "agent", "id": "zia" },
            { "type": "note" }
        ]);
        let edges = json!([
            { "id": "e1", "source": "n1", "target": "zia" },
            { "id": "e2", "source": "zia", "target": "n2" }
        ]);
        (nodes, edges)
    }

    #[test]
    fn linked_scope_reads_wires_in_either_direction_newest_first() {
        let (nodes, edges) = board();
        let (total, notes) = select_notes(
            notes_from_snapshot(&nodes, &edges),
            "cp_1",
            NoteScope::Linked,
            Some("zia"),
            &NotesReadQuery::default(),
        );
        assert_eq!(total, 2);
        assert_eq!(
            notes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["n2", "n1"]
        );
        assert_eq!(notes[0].title, "Spec");
        assert_eq!(notes[0].tasks, TaskProgress { done: 1, total: 2 });
        assert_eq!(
            notes[0].cover_uri.as_deref(),
            Some("lotus-note-asset://asset_1")
        );
        assert_eq!(notes[1].content.as_deref(), Some("# TODO\n\nlorem"));
    }

    #[test]
    fn project_scope_filters_by_query_ids_and_limit_and_truncates() {
        let (nodes, edges) = board();
        let records = notes_from_snapshot(&nodes, &edges);
        assert_eq!(records.len(), 3, "the note without an id is skipped");

        let by_query = NotesReadQuery {
            query: Some("LOREM".into()),
            ..Default::default()
        };
        let (_, notes) = select_notes(records.clone(), "cp_1", NoteScope::Project, None, &by_query);
        assert_eq!(
            notes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["n1"]
        );

        let by_id = NotesReadQuery {
            note_ids: Some(vec!["n3".into()]),
            max_chars: Some(3),
            ..Default::default()
        };
        let (_, notes) = select_notes(records.clone(), "cp_1", NoteScope::Project, None, &by_id);
        assert_eq!(notes[0].content.as_deref(), Some("unw"));
        assert!(notes[0].truncated);

        let listing = NotesReadQuery {
            limit: Some(1),
            include_content: Some(false),
            ..Default::default()
        };
        let (total, notes) = select_notes(records, "cp_1", NoteScope::Project, None, &listing);
        assert_eq!((total, notes.len()), (3, 1));
        assert_eq!(notes[0].content, None);
    }

    fn store_with_board() -> Connection {
        let dir = std::env::temp_dir().join(format!("lotus-notes-test-{}", std::process::id()));
        let path = dir.join(format!("{}.db", uuid_like()));
        let connection = crate::codecanvas_store::open_store(&path).expect("open store");
        let (nodes, edges) = board();
        connection
            .execute(
                "INSERT INTO codecanvas_projects (id, root_dir, alias, position, updated_at, last_opened_at) VALUES ('cp_1', '/repo/lotus', NULL, 0, 0, 0)",
                [],
            )
            .expect("project");
        connection
            .execute(
                "INSERT INTO codecanvas_snapshots (project_id, nodes_json, edges_json, terminal_counter, updated_at) VALUES ('cp_1', ?1, ?2, 0, 0)",
                [nodes.to_string(), edges.to_string()],
            )
            .expect("snapshot");
        connection
    }

    fn uuid_like() -> String {
        format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )
    }

    #[test]
    fn a_canvas_agent_reads_its_wired_notes_by_default() {
        let connection = store_with_board();
        let query = NotesReadQuery {
            caller_pane_id: Some("canvas:cp_1:zia".into()),
            ..Default::default()
        };
        let NotesReadOutcome::Notes { scope, notes, .. } =
            read_notes(&connection, &query).expect("read")
        else {
            panic!("expected notes");
        };
        assert_eq!(scope, NoteScope::Linked);
        assert_eq!(notes.len(), 2);
    }

    #[test]
    fn a_code_or_chat_caller_without_a_project_gets_the_project_list() {
        let connection = store_with_board();
        let NotesReadOutcome::ChooseProject { projects, .. } =
            read_notes(&connection, &NotesReadQuery::default()).expect("read")
        else {
            panic!("expected a project list");
        };
        assert_eq!(
            projects,
            vec![ProjectSummary {
                id: "cp_1".into(),
                name: "lotus".into(),
                note_count: 3
            }]
        );

        let named = NotesReadQuery {
            project_id: Some("cp_1".into()),
            ..Default::default()
        };
        let NotesReadOutcome::Notes {
            scope,
            total_matched,
            ..
        } = read_notes(&connection, &named).expect("read")
        else {
            panic!("expected notes");
        };
        assert_eq!((scope, total_matched), (NoteScope::Project, 3));
    }

    #[test]
    fn rejects_requests_the_caller_can_fix() {
        let connection = store_with_board();
        let linked = NotesReadQuery {
            scope: Some(NoteScope::Linked),
            ..Default::default()
        };
        let err = read_notes(&connection, &linked).expect_err("not a canvas caller");
        assert!(err.to_string().contains("scope 'linked'"));

        let unknown = NotesReadQuery {
            project_id: Some("nope".into()),
            ..Default::default()
        };
        let err = read_notes(&connection, &unknown).expect_err("unknown project");
        assert!(err.to_string().contains("no canvas project 'nope'"));
    }
}
