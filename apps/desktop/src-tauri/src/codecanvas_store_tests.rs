use super::codecanvas_store::*;

fn temp_store() -> (tempfile::TempDir, rusqlite::Connection) {
    let dir = tempfile::tempdir().expect("temp dir");
    let connection = open_store(&dir.path().join("codecanvas.sqlite3")).expect("open store");
    (dir, connection)
}

#[test]
fn opens_empty_index() {
    let (_dir, connection) = temp_store();
    let index = get_index(&connection).expect("index");
    assert!(index.projects.is_empty());
    assert_eq!(index.active_project_id, None);
}

#[test]
fn open_project_reuses_normalized_root() {
    let (_dir, connection) = temp_store();
    let first = open_project(&connection, "/tmp/demo//").expect("first");
    let second = open_project(&connection, "/tmp/demo").expect("second");
    assert_eq!(first.meta.id, second.meta.id);
    assert_eq!(first.meta.root_dir, "/tmp/demo");
    assert_eq!(second.meta.root_dir, "/tmp/demo");
    assert_eq!(get_index(&connection).unwrap().projects.len(), 1);
}

#[test]
fn save_load_and_close_project_snapshot() {
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/app").expect("project");
    let snapshot = CodeCanvasProjectSnapshot {
        meta: project.meta.clone(),
        nodes: serde_json::json!([{ "type": "note", "id": "n1" }]),
        edges: serde_json::json!([{ "id": "e1", "source": "n1", "target": "n1" }]),
        terminal_counter: 7,
    };
    save_project(&connection, &snapshot).expect("save");
    let loaded = load_project(&connection, &project.meta.id)
        .expect("load")
        .expect("snapshot");
    assert_eq!(loaded.terminal_counter, 7);
    assert_eq!(loaded.nodes, snapshot.nodes);
    close_project(&connection, &project.meta.id).expect("close");
    assert!(load_project(&connection, &project.meta.id)
        .unwrap()
        .is_none());
    assert!(get_index(&connection).unwrap().projects.is_empty());
}

#[test]
fn save_load_and_cascade_collaboration_records() {
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/collab").expect("project");
    save_collaboration_record(
        &connection,
        &project.meta.id,
        "swarm-task:task_1",
        "mailbox",
        &serde_json::json!({ "runId": "swarm-task:task_1", "messages": [{ "id": "m1" }] }),
    )
    .expect("save");

    let loaded = load_collaboration_record(
        &connection,
        &project.meta.id,
        "swarm-task:task_1",
        "mailbox",
    )
    .expect("load")
    .expect("record");
    assert_eq!(loaded["messages"][0]["id"], "m1");

    save_collaboration_record(
        &connection,
        &project.meta.id,
        "swarm-task:task_1",
        "mailbox",
        &serde_json::json!({ "runId": "swarm-task:task_1", "messages": [{ "id": "m2" }] }),
    )
    .expect("update");
    let updated = load_collaboration_record(
        &connection,
        &project.meta.id,
        "swarm-task:task_1",
        "mailbox",
    )
    .expect("load updated")
    .expect("record");
    assert_eq!(updated["messages"][0]["id"], "m2");

    close_project(&connection, &project.meta.id).expect("close");
    assert!(load_collaboration_record(
        &connection,
        &project.meta.id,
        "swarm-task:task_1",
        "mailbox"
    )
    .expect("load after close")
    .is_none());
}

#[test]
fn memory_write_list_search_archive_and_cascade() {
    use super::codecanvas_memory::{
        archive_memory_item, list_memory, search_memory, write_memory, MemoryListQuery,
        MemorySearchQuery, WriteMemoryInput,
    };
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/memory").expect("project");
    let pid = project.meta.id.clone();

    let first = write_memory(
        &connection,
        &WriteMemoryInput {
            project_id: pid.clone(),
            scope_kind: "project".into(),
            scope_id: None,
            kind: "decision".into(),
            title: Some("Use SQLite memory".into()),
            body: "Use append-only SQLite rows for project memory.".into(),
            summary: Some("SQLite append-only".into()),
            status: None,
            importance: Some(5),
            tags: vec!["architecture".into()],
            metadata: serde_json::json!({ "sourcePlan": "codecanvas-project-memory" }),
            source: "human".into(),
            actor_id: Some("alwi".into()),
            actor_kind: "human".into(),
            node_id: None,
            run_id: None,
            assignment_key: None,
            session_id: None,
            parent_id: None,
            idempotency_key: Some("decision-sqlite".into()),
            now: Some(100),
        },
    )
    .expect("write first memory");

    let retry = write_memory(
        &connection,
        &WriteMemoryInput {
            idempotency_key: Some("decision-sqlite".into()),
            now: Some(101),
            ..WriteMemoryInput::minimal_project_note(&pid, "Duplicate retry")
        },
    )
    .expect("idempotent retry");
    assert_eq!(retry.id, first.id);

    let evidence = write_memory(
        &connection,
        &WriteMemoryInput {
            scope_kind: "assignment".into(),
            scope_id: Some("run-1:mira".into()),
            kind: "evidence".into(),
            body: "Regression test added for project memory search.".into(),
            run_id: Some("run-1".into()),
            assignment_key: Some("mira".into()),
            idempotency_key: Some("evidence-search".into()),
            now: Some(200),
            ..WriteMemoryInput::minimal_project_note(&pid, "Regression test added")
        },
    )
    .expect("write evidence");

    let listed = list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid.clone(),
            scope_kind: None,
            scope_id: None,
            node_id: None,
            run_id: None,
            assignment_key: None,
            kinds: vec![],
            include_archived: false,
            limit: Some(20),
        },
    )
    .expect("list memory");
    assert_eq!(
        listed
            .iter()
            .map(|item| item.id.as_str())
            .collect::<Vec<_>>(),
        vec![evidence.id.as_str(), first.id.as_str()]
    );

    let hits = search_memory(
        &connection,
        &MemorySearchQuery {
            project_id: pid.clone(),
            query: "regression search".into(),
            scope_kind: None,
            scope_id: None,
            node_id: None,
            run_id: Some("run-1".into()),
            assignment_key: Some("mira".into()),
            kinds: vec!["evidence".into()],
            include_archived: false,
            limit: Some(10),
        },
    )
    .expect("search memory");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].item.id, evidence.id);

    archive_memory_item(&connection, &pid, &evidence.id, 300).expect("archive evidence");
    assert!(list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid.clone(),
            include_archived: false,
            ..MemoryListQuery::default()
        },
    )
    .expect("list hot")
    .iter()
    .all(|item| item.id != evidence.id));
    assert!(list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid.clone(),
            include_archived: true,
            ..MemoryListQuery::default()
        },
    )
    .expect("list with archive")
    .iter()
    .any(|item| item.id == evidence.id));

    close_project(&connection, &pid).expect("close project");
    assert!(list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid,
            include_archived: true,
            ..MemoryListQuery::default()
        },
    )
    .expect("cascade")
    .is_empty());
}

#[test]
fn memory_write_refuses_oversized_payloads() {
    use super::codecanvas_memory::{write_memory, WriteMemoryInput};
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/memory-limits").expect("project");
    let pid = project.meta.id.clone();

    // An agent writing an unbounded body would ride into every list/search response and the FTS
    // index for the life of the project.
    let huge = "x".repeat(20_000);
    let err = write_memory(
        &connection,
        &WriteMemoryInput {
            body: huge,
            ..WriteMemoryInput::minimal_project_note(&pid, "ignored")
        },
    )
    .expect_err("oversized body is refused");
    assert!(err.to_string().contains("body"), "{err}");

    assert!(write_memory(
        &connection,
        &WriteMemoryInput {
            title: Some("t".repeat(600)),
            ..WriteMemoryInput::minimal_project_note(&pid, "long title")
        },
    )
    .is_err());

    assert!(write_memory(
        &connection,
        &WriteMemoryInput {
            tags: (0..40).map(|index| format!("tag{index}")).collect(),
            ..WriteMemoryInput::minimal_project_note(&pid, "too many tags")
        },
    )
    .is_err());

    // A normal write still goes through untouched.
    write_memory(
        &connection,
        &WriteMemoryInput {
            body: "y".repeat(4_000),
            tags: vec!["ok".into()],
            ..WriteMemoryInput::minimal_project_note(&pid, "normal")
        },
    )
    .expect("a realistic write is unaffected");
}

#[test]
fn memory_restore_undoes_an_archive() {
    use super::codecanvas_memory::{
        archive_memory_item, list_memory, restore_memory_item, write_memory, MemoryListQuery,
        WriteMemoryInput,
    };
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/memory-restore").expect("project");
    let pid = project.meta.id.clone();

    let note = write_memory(
        &connection,
        &WriteMemoryInput {
            now: Some(100),
            ..WriteMemoryInput::minimal_project_note(&pid, "Archived by accident")
        },
    )
    .expect("write note");

    archive_memory_item(&connection, &pid, &note.id, 200).expect("archive");
    restore_memory_item(&connection, &pid, &note.id, 300).expect("restore");

    let hot = list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid,
            include_archived: false,
            ..MemoryListQuery::default()
        },
    )
    .expect("list hot");
    let restored = hot
        .iter()
        .find(|item| item.id == note.id)
        .expect("restored item is hot again");
    assert_eq!(restored.archived_at, None);
    assert_eq!(restored.updated_at, 300);
}

#[test]
fn memory_pin_toggles_the_pinned_tag_without_disturbing_other_tags() {
    use super::codecanvas_memory::{set_memory_pinned, write_memory, WriteMemoryInput};
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/memory-pin").expect("project");
    let pid = project.meta.id.clone();

    let rule = write_memory(
        &connection,
        &WriteMemoryInput {
            kind: "constraint".into(),
            tags: vec!["git".into()],
            now: Some(100),
            ..WriteMemoryInput::minimal_project_note(&pid, "Never bare stash pop")
        },
    )
    .expect("write rule");

    let pinned = set_memory_pinned(&connection, &pid, &rule.id, true, 200).expect("pin");
    assert_eq!(pinned.tags, vec!["git".to_string(), "pinned".to_string()]);
    assert_eq!(pinned.updated_at, 200);

    // Pinning twice must not duplicate the tag.
    let again = set_memory_pinned(&connection, &pid, &rule.id, true, 250).expect("pin again");
    assert_eq!(again.tags, vec!["git".to_string(), "pinned".to_string()]);

    let unpinned = set_memory_pinned(&connection, &pid, &rule.id, false, 300).expect("unpin");
    assert_eq!(unpinned.tags, vec!["git".to_string()]);
}

#[test]
fn memory_pin_rejects_a_missing_item() {
    use super::codecanvas_memory::set_memory_pinned;
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/memory-pin-missing").expect("project");
    assert!(set_memory_pinned(&connection, &project.meta.id, "nope", true, 100).is_err());
}

#[test]
fn memory_fts_rows_are_cascade_cleaned_when_project_deleted() {
    use super::codecanvas_memory::{write_memory, WriteMemoryInput};
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/memory-fts").expect("project");
    let pid = project.meta.id.clone();

    write_memory(
        &connection,
        &WriteMemoryInput::minimal_project_note(&pid, "searchable memory body"),
    )
    .expect("write memory");

    let fts_count = |connection: &rusqlite::Connection| -> i64 {
        connection
            .query_row(
                "SELECT count(*) FROM codecanvas_memory_fts WHERE project_id = ?1",
                [&pid],
                |row| row.get(0),
            )
            .expect("count fts rows")
    };

    assert_eq!(fts_count(&connection), 1, "write should index one FTS row");

    close_project(&connection, &pid).expect("close project");

    assert_eq!(
        fts_count(&connection),
        0,
        "FTS rows must be cascade-cleaned with their memory items, not orphaned",
    );
}

#[test]
fn native_sources_require_explicit_promotion() {
    use super::codecanvas_memory::{
        list_memory, promote_external_context, write_memory, MemoryListQuery, WriteMemoryInput,
    };
    let (_dir, connection) = temp_store();
    let pid = open_project(&connection, "/tmp/mem-promote")
        .expect("project")
        .meta
        .id;

    // A direct write claiming a native source is refused — native memory is never silently synced.
    let refused = write_memory(
        &connection,
        &WriteMemoryInput {
            source: "claude".into(),
            ..WriteMemoryInput::minimal_project_note(&pid, "leaked native note")
        },
    );
    assert!(
        refused.is_err(),
        "native source must not be writable directly"
    );

    // Promotion is the sanctioned path: it forces kind=external-context and keeps the native source.
    let promoted = promote_external_context(
        &connection,
        &WriteMemoryInput {
            source: "claude".into(),
            kind: "note".into(),
            ..WriteMemoryInput::minimal_project_note(&pid, "promoted from Claude memory")
        },
    )
    .expect("promotion succeeds");
    assert_eq!(promoted.kind, "external-context");
    assert_eq!(promoted.source, "claude");

    // Promotion rejects non-native sources so it stays an import-only door.
    assert!(promote_external_context(
        &connection,
        &WriteMemoryInput::minimal_project_note(&pid, "not native"),
    )
    .is_err());

    let listed = list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid,
            include_archived: false,
            ..MemoryListQuery::default()
        },
    )
    .expect("list");
    assert_eq!(listed.len(), 1, "only the promoted row is stored");
    assert_eq!(listed[0].id, promoted.id);
}

#[test]
fn archive_expired_memory_applies_retention_over_sqlite() {
    use super::codecanvas_memory::{
        archive_expired_memory, list_memory, write_memory, MemoryListQuery, RetentionPolicy,
        WriteMemoryInput,
    };
    let (_dir, connection) = temp_store();
    let pid = open_project(&connection, "/tmp/mem-retention")
        .expect("project")
        .meta
        .id;

    let decision = write_memory(
        &connection,
        &WriteMemoryInput {
            kind: "decision".into(),
            now: Some(0),
            ..WriteMemoryInput::minimal_project_note(&pid, "durable decision")
        },
    )
    .expect("write decision");
    let stale = write_memory(
        &connection,
        &WriteMemoryInput {
            kind: "note".into(),
            now: Some(0),
            ..WriteMemoryInput::minimal_project_note(&pid, "stale note")
        },
    )
    .expect("write stale note");
    let fresh = write_memory(
        &connection,
        &WriteMemoryInput {
            kind: "note".into(),
            now: Some(950),
            ..WriteMemoryInput::minimal_project_note(&pid, "fresh note")
        },
    )
    .expect("write fresh note");

    let policy = RetentionPolicy {
        now: 1000,
        short_ttl_ms: 100,
        evidence_ttl_ms: 500,
        blocker_grace_ms: 50,
        pin_importance: 50,
        keep_latest_per_assignment: 1,
    };
    assert_eq!(
        archive_expired_memory(&connection, &pid, &policy).expect("archive"),
        1,
    );

    let hot: Vec<String> = list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid.clone(),
            include_archived: false,
            limit: Some(50),
            ..MemoryListQuery::default()
        },
    )
    .expect("hot list")
    .into_iter()
    .map(|item| item.id)
    .collect();
    assert!(hot.contains(&decision.id), "durable decision stays hot");
    assert!(hot.contains(&fresh.id), "fresh note stays hot");
    assert!(
        !hot.contains(&stale.id),
        "stale note is archived out of hot path"
    );

    let all: Vec<String> = list_memory(
        &connection,
        &MemoryListQuery {
            project_id: pid.clone(),
            include_archived: true,
            limit: Some(50),
            ..MemoryListQuery::default()
        },
    )
    .expect("full list")
    .into_iter()
    .map(|item| item.id)
    .collect();
    assert!(
        all.contains(&stale.id),
        "archived audit history is preserved"
    );
}

#[test]
fn memory_appends_are_lossless_under_concurrent_writers() {
    use super::codecanvas_memory::{write_memory, WriteMemoryInput};
    let dir = tempfile::tempdir().expect("temp dir");
    let db_path = dir.path().join("codecanvas.sqlite3");
    let setup = open_store(&db_path).expect("open store");
    let pid = open_project(&setup, "/tmp/memory-concurrent")
        .expect("project")
        .meta
        .id;
    drop(setup);

    // Each agent talks to memory through its own connection (the app opens a fresh connection per
    // MCP call). Fan out concurrent writers behind a start barrier so their write-lock windows
    // maximally overlap, then prove not one append is lost or errors out with SQLITE_BUSY.
    let writers = 12usize;
    let per_writer = 40usize;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(writers));
    let handles: Vec<_> = (0..writers)
        .map(|w| {
            let db_path = db_path.clone();
            let pid = pid.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let connection = open_store(&db_path).expect("open store in worker thread");
                barrier.wait();
                for i in 0..per_writer {
                    write_memory(
                        &connection,
                        &WriteMemoryInput::minimal_project_note(&pid, &format!("w{w}-msg{i}")),
                    )
                    .expect("concurrent write must not error");
                }
            })
        })
        .collect();
    for handle in handles {
        handle.join().expect("worker thread panicked");
    }

    // Count rows directly — list_memory clamps to MAX_LIMIT, which would mask total persistence.
    let connection = open_store(&db_path).expect("reopen store");
    let total: i64 = connection
        .query_row(
            "SELECT count(*) FROM codecanvas_memory_items WHERE project_id = ?1",
            [&pid],
            |row| row.get(0),
        )
        .expect("count persisted rows");
    assert_eq!(
        total as usize,
        writers * per_writer,
        "concurrent agent appends must not be lost",
    );
    // The FTS index must have kept lockstep with every concurrent insert as well.
    let fts_total: i64 = connection
        .query_row(
            "SELECT count(*) FROM codecanvas_memory_fts WHERE project_id = ?1",
            [&pid],
            |row| row.get(0),
        )
        .expect("count fts rows");
    assert_eq!(
        fts_total, total,
        "every concurrent insert must be searchable"
    );
}

#[test]
fn save_list_and_delete_agent_definitions() {
    use super::codecanvas_agents::{delete_agent, list_agents, save_agent, AgentDefinitionRecord};
    let (_dir, connection) = temp_store();
    assert!(list_agents(&connection).expect("list").is_empty());

    let def = AgentDefinitionRecord {
        id: "def-1".into(),
        name: "Frontend Specialist".into(),
        role: Some("UI".into()),
        model: "claude-sonnet-4-6".into(),
        prompt: "build the UI".into(),
        applied_skills: vec!["ship".into()],
        effort: Some("high".into()),
        permission_mode: Some("safe".into()),
        updated_at: 0,
    };
    let saved = save_agent(&connection, &def).expect("save");
    assert!(saved.updated_at > 0);

    let listed = list_agents(&connection).expect("list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "Frontend Specialist");
    assert_eq!(listed[0].applied_skills, vec!["ship".to_string()]);
    assert_eq!(listed[0].effort.as_deref(), Some("high"));
    assert_eq!(listed[0].permission_mode.as_deref(), Some("safe"));

    save_agent(
        &connection,
        &AgentDefinitionRecord {
            name: "Renamed".into(),
            ..def.clone()
        },
    )
    .expect("upsert");
    assert_eq!(list_agents(&connection).expect("list").len(), 1);

    delete_agent(&connection, "def-1").expect("delete");
    assert!(list_agents(&connection).expect("list").is_empty());
}

#[test]
fn migrates_existing_agent_definitions_to_governance_columns() {
    use super::codecanvas_agents::{list_agents, save_agent, AgentDefinitionRecord};
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("codecanvas.sqlite3");
    {
        let connection = rusqlite::Connection::open(&path).expect("raw db");
        connection
            .execute_batch(
                "CREATE TABLE codecanvas_agents (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              role TEXT,
              model TEXT NOT NULL,
              prompt TEXT NOT NULL,
              applied_skills_json TEXT NOT NULL DEFAULT '[]',
              updated_at INTEGER NOT NULL
            );",
            )
            .expect("old schema");
    }
    let connection = open_store(&path).expect("migrate");
    let saved = save_agent(
        &connection,
        &AgentDefinitionRecord {
            id: "def-2".into(),
            name: "Reviewer".into(),
            role: None,
            model: "claude-opus-4-8".into(),
            prompt: "review".into(),
            applied_skills: vec![],
            effort: Some("max".into()),
            permission_mode: Some("full".into()),
            updated_at: 0,
        },
    )
    .expect("save");
    assert_eq!(saved.effort.as_deref(), Some("max"));
    let listed = list_agents(&connection).expect("list");
    assert_eq!(listed[0].effort.as_deref(), Some("max"));
    assert_eq!(listed[0].permission_mode.as_deref(), Some("full"));
}

#[test]
fn append_list_and_prune_agent_runs() {
    use super::codecanvas_runs::{append_agent_run, list_agent_runs, AgentRunRecordRow};
    let (_dir, connection) = temp_store();
    let mk = |id: &str, created: i64| AgentRunRecordRow {
        id: id.into(),
        agent_id: "node-1".into(),
        kind: "run".into(),
        outcome: "completed".into(),
        started_at: created,
        ended_at: created + 100,
        session_id: Some("s".into()),
        graph_run_id: None,
        usage: None,
        actions: vec!["Reading a.ts".into()],
        summary: None,
    };
    // 25 runs for one node; retention caps at 20 (newest kept).
    for i in 0..25 {
        append_agent_run(&connection, &mk(&format!("r{i}"), i)).expect("append");
    }
    let runs = list_agent_runs(&connection, "node-1").expect("list");
    assert_eq!(runs.len(), 20);
    // Different node is isolated.
    assert!(list_agent_runs(&connection, "other")
        .expect("list")
        .is_empty());

    // graph_run_id + usage round-trip (links a node-run to its graph run + token/cost).
    let mut linked = mk("linked", 99);
    linked.graph_run_id = Some("g-1".into());
    linked.usage =
        Some(serde_json::json!({ "inputTokens": 1200, "outputTokens": 340, "costUsd": 0.0123 }));
    append_agent_run(&connection, &linked).expect("append linked");
    let newest = &list_agent_runs(&connection, "node-1").expect("list")[0];
    assert_eq!(newest.graph_run_id.as_deref(), Some("g-1"));
    assert_eq!(
        newest
            .usage
            .as_ref()
            .and_then(|u| u.get("inputTokens"))
            .and_then(|v| v.as_i64()),
        Some(1200)
    );
}

#[test]
fn save_get_list_and_prune_graph_runs() {
    use super::codecanvas_graph_runs::{
        get_graph_run, list_graph_runs, save_graph_run, GraphRunRow,
    };
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/graph").expect("project");
    let pid = project.meta.id.clone();
    let mk = |id: &str, started: i64| GraphRunRow {
        id: id.into(),
        project_id: pid.clone(),
        workflow_id: None,
        status: "running".into(),
        checkpoint: serde_json::json!({ "nodeIds": ["a"], "deps": [], "completed": {}, "failed": [], "pending": ["a"] }),
        started_at: started,
        ended_at: None,
        updated_at: started,
    };
    save_graph_run(&connection, &mk("g1", 1)).expect("save");

    // Upsert updates status + checkpoint, keeps a single row.
    let mut updated = mk("g1", 1);
    updated.status = "completed".into();
    updated.ended_at = Some(9);
    save_graph_run(&connection, &updated).expect("update");
    let got = get_graph_run(&connection, "g1").expect("get").expect("row");
    assert_eq!(got.status, "completed");
    assert_eq!(got.ended_at, Some(9));

    // Retention caps at 20 newest per project.
    for i in 0..25 {
        save_graph_run(&connection, &mk(&format!("r{i}"), 100 + i)).expect("append");
    }
    let runs = list_graph_runs(&connection, &pid).expect("list");
    assert_eq!(runs.len(), 20);
    assert_eq!(runs[0].id, "r24"); // newest first by started_at
    assert!(get_graph_run(&connection, "missing")
        .expect("get")
        .is_none());
}

#[test]
fn save_list_and_get_note_assets() {
    use super::codecanvas_note_assets::{
        delete_note_asset, get_note_asset, import_note_asset_path, list_note_assets,
        referenced_note_asset_ids, save_note_asset, ImportNoteAssetPathInput, NoteAssetRow,
    };
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/note-assets").expect("project");
    let row = NoteAssetRow {
        id: "asset_1".into(),
        project_id: project.meta.id.clone(),
        original_name: "shot.png".into(),
        file_name: "asset_1.png".into(),
        mime: "image/png".into(),
        byte_size: 3,
        created_at: 9,
    };

    save_note_asset(&connection, &row).expect("save");
    let import_source = _dir.path().join("import.png");
    std::fs::write(&import_source, b"PNG").expect("write source image");
    let imported = import_note_asset_path(
        _dir.path(),
        ImportNoteAssetPathInput {
            project_id: project.meta.id.clone(),
            path: import_source.to_string_lossy().into_owned(),
        },
    )
    .expect("import path");
    save_note_asset(&connection, &imported).expect("save imported");
    let list = list_note_assets(&connection, &project.meta.id).expect("list");

    assert_eq!(list.len(), 2);
    assert!(list.iter().any(|asset| asset.original_name == "shot.png"));
    assert!(list
        .iter()
        .any(|asset| asset.original_name == "import.png" && asset.mime == "image/png"));
    assert_eq!(
        get_note_asset(&connection, "asset_1")
            .expect("get")
            .unwrap()
            .mime,
        "image/png"
    );

    let snapshot = CodeCanvasProjectSnapshot {
        meta: project.meta.clone(),
        nodes: serde_json::json!([{ "type": "note", "content": "![shot](lotus-note-asset://asset_1)" }]),
        edges: serde_json::json!([]),
        terminal_counter: 0,
    };
    save_project(&connection, &snapshot).expect("snapshot with note asset ref");
    assert!(referenced_note_asset_ids(&connection, &project.meta.id)
        .expect("refs")
        .contains("asset_1"));
    // Refusing to delete a referenced asset is a no-op, so both assets remain.
    assert!(delete_note_asset(&connection, _dir.path(), "asset_1", false).is_err());
    assert_eq!(
        list_note_assets(&connection, &project.meta.id)
            .expect("still listed")
            .len(),
        2
    );
    assert!(delete_note_asset(&connection, _dir.path(), "asset_1", true)
        .expect("force delete")
        .is_some());
    assert!(get_note_asset(&connection, "asset_1")
        .expect("get deleted")
        .is_none());
}

#[test]
fn prune_unused_note_assets_keeps_referenced_assets_and_project_close_cascades_metadata() {
    use super::codecanvas_note_assets::{
        get_note_asset, list_note_assets, prune_unused_note_assets, save_note_asset, NoteAssetRow,
    };
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/prune-note-assets").expect("project");
    let row = |id: &str| NoteAssetRow {
        id: id.into(),
        project_id: project.meta.id.clone(),
        original_name: format!("{id}.png"),
        file_name: format!("{id}.png"),
        mime: "image/png".into(),
        byte_size: 3,
        created_at: 9,
    };
    save_note_asset(&connection, &row("asset_keep")).expect("keep");
    save_note_asset(&connection, &row("asset_drop")).expect("drop");
    let snapshot = CodeCanvasProjectSnapshot {
        meta: project.meta.clone(),
        nodes: serde_json::json!([{ "type": "note", "content": "![keep](lotus-note-asset://asset_keep)" }]),
        edges: serde_json::json!([]),
        terminal_counter: 0,
    };
    save_project(&connection, &snapshot).expect("snapshot");

    let pruned =
        prune_unused_note_assets(&connection, _dir.path(), &project.meta.id).expect("prune");
    assert_eq!(pruned.deleted.len(), 1);
    assert_eq!(pruned.deleted[0].id, "asset_drop");
    assert!(get_note_asset(&connection, "asset_keep")
        .expect("keep exists")
        .is_some());
    assert!(get_note_asset(&connection, "asset_drop")
        .expect("drop gone")
        .is_none());

    close_project(&connection, &project.meta.id).expect("close");
    assert!(list_note_assets(&connection, &project.meta.id)
        .expect("cascade")
        .is_empty());
}

#[test]
fn save_upsert_list_and_get_artifacts() {
    use super::codecanvas_artifacts::{get_artifact, list_artifacts, save_artifact, ArtifactRow};
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/artifacts").expect("project");
    let pid = project.meta.id.clone();
    let mk = |id: &str, key: &str, value: &str, version: i64, updated: i64| ArtifactRow {
        id: id.into(),
        project_id: pid.clone(),
        bus_node_id: "bus-1".into(),
        key: key.into(),
        value: value.into(),
        producer: "Architect".into(),
        version,
        graph_run_id: Some("g-1".into()),
        updated_at: updated,
    };
    save_artifact(&connection, &mk("a1", "Architect", "old", 1, 1)).expect("save");

    // Upsert on (project, bus, key) keeps a single row, bumps version + value.
    save_artifact(&connection, &mk("a2", "Architect", "new", 2, 5)).expect("upsert");
    let list = list_artifacts(&connection, &pid).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].value, "new");
    assert_eq!(list[0].version, 2);
    assert_eq!(list[0].graph_run_id.as_deref(), Some("g-1"));

    // Distinct keys coexist, newest first by updated_at.
    save_artifact(&connection, &mk("b1", "Backend", "api", 1, 9)).expect("save b");
    let list = list_artifacts(&connection, &pid).expect("list");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].key, "Backend"); // updated_at 9 > 5
    assert!(get_artifact(&connection, "missing").expect("get").is_none());
}

// ── Sessions (plans/codecanvas-session-widget/, Slice 01) ────────────────────────────────────────

use super::codecanvas_sessions::{
    delete_session, get_session, list_sessions, upsert_session, CodeCanvasSessionRow,
};

fn session_row(id: &str, project_id: &str, provider: Option<&str>) -> CodeCanvasSessionRow {
    CodeCanvasSessionRow {
        id: id.to_string(),
        project_id: project_id.to_string(),
        node_id: Some(format!("node-{id}")),
        runner: "claude".to_string(),
        provider_session_id: provider.map(str::to_string),
        cwd: "/tmp/demo".to_string(),
        worktree_path: None,
        title: format!("Session {id}"),
        title_source: Some("auto".to_string()),
        status: "resumable".to_string(),
        origin: "manual".to_string(),
        graph_run_id: None,
        pinned: false,
        turn_count: 3,
        last_activity_at: 1_000,
        created_at: 1_000,
        runner_command: None,
        last_prompt: None,
        account: None,
    }
}

/// A row's `runner` is the TYPE, and every user-defined runner arrives as the one word `custom`.
/// Rebuilding a node from the row therefore has nothing to launch unless the command travels with
/// it — pressing "pasang" on such a row threw out of `resolveRunnerCommand` on 2026-09-12
/// (`plans/codecanvas-session-refactor/issues/03`).
#[test]
fn session_remembers_a_custom_runner_command() {
    let (_dir, connection) = temp_store();
    let mut row = session_row("s1", "cp_1", Some("prov-1"));
    row.runner = "custom".to_string();
    row.runner_command = Some("ccs acme".to_string());
    upsert_session(&connection, &row).expect("upsert");

    let loaded = get_session(&connection, "s1").expect("get").expect("present");
    assert_eq!(loaded.runner_command.as_deref(), Some("ccs acme"));
}

/// A node rebuilt from the row must run on the account it ran on, or it bills another (issues/07).
#[test]
fn session_remembers_its_claude_account() {
    let (_dir, connection) = temp_store();
    let mut row = session_row("s1", "cp_1", Some("prov-1"));
    row.account = Some("initech".to_string());
    upsert_session(&connection, &row).expect("upsert");
    let loaded = get_session(&connection, "s1").expect("get").expect("present");
    assert_eq!(loaded.account.as_deref(), Some("initech"));
}

/// The list is unreadable when every row says "sesi baru": the ask is what tells one conversation
/// from another, so it has to survive a restart (2026-09-14).
#[test]
fn session_remembers_its_last_prompt() {
    let (_dir, connection) = temp_store();
    let mut row = session_row("s1", "cp_1", Some("prov-1"));
    row.last_prompt = Some("perbaiki resume yang putus di tengah".to_string());
    upsert_session(&connection, &row).expect("upsert");

    let loaded = get_session(&connection, "s1").expect("get").expect("present");
    assert_eq!(
        loaded.last_prompt.as_deref(),
        Some("perbaiki resume yang putus di tengah")
    );
}

#[test]
fn session_round_trips_every_field() {
    let (_dir, connection) = temp_store();
    let mut row = session_row("s1", "cp_1", Some("prov-1"));
    row.worktree_path = Some("/tmp/wt/feat".to_string());
    row.pinned = true;
    row.graph_run_id = Some("gr-1".to_string());
    row.origin = "graph-run".to_string();
    upsert_session(&connection, &row).expect("upsert");

    let loaded = get_session(&connection, "s1").expect("get").expect("present");
    assert_eq!(loaded, row);
}

#[test]
fn sessions_list_newest_activity_first() {
    let (_dir, connection) = temp_store();
    let mut older = session_row("old", "cp_1", Some("prov-old"));
    older.last_activity_at = 10;
    let mut newer = session_row("new", "cp_1", Some("prov-new"));
    newer.last_activity_at = 99;
    upsert_session(&connection, &older).expect("older");
    upsert_session(&connection, &newer).expect("newer");

    let ids: Vec<String> = list_sessions(&connection, "cp_1")
        .expect("list")
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, vec!["new".to_string(), "old".to_string()]);
}

#[test]
fn sessions_are_scoped_to_their_project() {
    let (_dir, connection) = temp_store();
    upsert_session(&connection, &session_row("a", "cp_1", Some("prov-a"))).expect("a");
    upsert_session(&connection, &session_row("b", "cp_2", Some("prov-b"))).expect("b");

    assert_eq!(list_sessions(&connection, "cp_1").unwrap().len(), 1);
    assert_eq!(list_sessions(&connection, "cp_2").unwrap().len(), 1);
}

#[test]
fn upsert_updates_in_place_without_duplicating() {
    let (_dir, connection) = temp_store();
    upsert_session(&connection, &session_row("s1", "cp_1", None)).expect("insert");

    let mut updated = session_row("s1", "cp_1", Some("prov-1"));
    updated.title = "Renamed".to_string();
    updated.title_source = Some("manual".to_string());
    updated.turn_count = 42;
    upsert_session(&connection, &updated).expect("update");

    let rows = list_sessions(&connection, "cp_1").expect("list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].title, "Renamed");
    assert_eq!(rows[0].turn_count, 42);
    assert_eq!(rows[0].provider_session_id.as_deref(), Some("prov-1"));
}

/// Two agents launched in the same cwd can capture the same fresh transcript id. The storage layer
/// must refuse the second claim rather than file one conversation under two nodes (issue 07).
#[test]
fn one_provider_session_id_cannot_be_claimed_twice_in_a_project() {
    let (_dir, connection) = temp_store();
    upsert_session(&connection, &session_row("first", "cp_1", Some("shared-id"))).expect("first");

    let clash = upsert_session(&connection, &session_row("second", "cp_1", Some("shared-id")));
    assert!(clash.is_err(), "the second claim must be rejected");

    // The loser of the race must not have left a partial row behind.
    assert_eq!(list_sessions(&connection, "cp_1").unwrap().len(), 1);
}

/// The same CLI session id CAN legitimately appear in two different projects (two boards over the
/// same directory), so the uniqueness is scoped to the project, not global.
#[test]
fn the_same_provider_id_is_allowed_in_another_project() {
    let (_dir, connection) = temp_store();
    upsert_session(&connection, &session_row("a", "cp_1", Some("shared-id"))).expect("a");
    upsert_session(&connection, &session_row("b", "cp_2", Some("shared-id"))).expect("b");
    assert_eq!(list_sessions(&connection, "cp_2").unwrap().len(), 1);
}

/// Many sessions may still be waiting for their id; NULL never collides with NULL.
#[test]
fn sessions_without_a_provider_id_do_not_collide() {
    let (_dir, connection) = temp_store();
    upsert_session(&connection, &session_row("a", "cp_1", None)).expect("a");
    upsert_session(&connection, &session_row("b", "cp_1", None)).expect("b");
    assert_eq!(list_sessions(&connection, "cp_1").unwrap().len(), 2);
}

/// Closing a project removes it from the rail. It must not destroy the conversations that happened
/// inside it — the table deliberately has no foreign key to codecanvas_projects (issue 09).
#[test]
fn closing_a_project_keeps_its_sessions() {
    let (_dir, connection) = temp_store();
    let project = open_project(&connection, "/tmp/demo").expect("open");
    upsert_session(
        &connection,
        &session_row("s1", &project.meta.id, Some("prov-1")),
    )
    .expect("session");

    close_project(&connection, &project.meta.id).expect("close");

    let rows = list_sessions(&connection, &project.meta.id).expect("list");
    assert_eq!(rows.len(), 1, "sessions must survive closing the project");

    // And reopening the same root dir yields the same deterministic id, so the list comes back.
    let reopened = open_project(&connection, "/tmp/demo").expect("reopen");
    assert_eq!(reopened.meta.id, project.meta.id);
    assert_eq!(list_sessions(&connection, &reopened.meta.id).unwrap().len(), 1);
}

#[test]
fn delete_session_removes_only_its_own_row() {
    let (_dir, connection) = temp_store();
    upsert_session(&connection, &session_row("a", "cp_1", Some("prov-a"))).expect("a");
    upsert_session(&connection, &session_row("b", "cp_1", Some("prov-b"))).expect("b");

    delete_session(&connection, "a").expect("delete");

    let ids: Vec<String> = list_sessions(&connection, "cp_1")
        .unwrap()
        .into_iter()
        .map(|s| s.id)
        .collect();
    assert_eq!(ids, vec!["b".to_string()]);
}

/// A database created before this table existed must gain it on open, not error.
#[test]
fn session_table_is_added_to_an_older_database() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("codecanvas.sqlite3");
    {
        let bare = rusqlite::Connection::open(&path).expect("bare open");
        bare.execute_batch("CREATE TABLE leftover (id TEXT PRIMARY KEY);")
            .expect("older schema");
    }
    let connection = open_store(&path).expect("migrate");
    upsert_session(&connection, &session_row("s1", "cp_1", Some("prov-1"))).expect("usable");
    assert_eq!(list_sessions(&connection, "cp_1").unwrap().len(), 1);
}

// ── Project location (VPS connector, tiket 01) ────────────────────────────────

fn ssh_location(host: &str, user: Option<&str>, port: Option<u16>) -> CodeCanvasProjectLocation {
    CodeCanvasProjectLocation::Ssh {
        host: host.to_string(),
        user: user.map(str::to_string),
        port,
        label: None,
    }
}

/// Writes a database in the pre-location shape: `root_dir` UNIQUE, no machine columns, with one
/// project and the snapshot that hangs off it. This is what every existing install looks like.
fn legacy_store(path: &std::path::Path) -> String {
    let connection = rusqlite::Connection::open(path).expect("open legacy");
    connection
        .execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE codecanvas_projects (
              id TEXT PRIMARY KEY,
              root_dir TEXT NOT NULL UNIQUE,
              alias TEXT,
              position INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              last_opened_at INTEGER NOT NULL
            );
            CREATE TABLE codecanvas_snapshots (
              project_id TEXT PRIMARY KEY,
              schema_version INTEGER NOT NULL DEFAULT 1,
              nodes_json TEXT NOT NULL,
              edges_json TEXT NOT NULL,
              terminal_counter INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY(project_id) REFERENCES codecanvas_projects(id) ON DELETE CASCADE
            );
            INSERT INTO codecanvas_projects (id, root_dir, alias, position, updated_at, last_opened_at)
            VALUES ('cp_legacy', '/tmp/legacy', 'Legacy', 0, 10, 10);
            INSERT INTO codecanvas_snapshots (project_id, nodes_json, edges_json, terminal_counter, updated_at)
            VALUES ('cp_legacy', '[{\"id\":\"n1\"}]', '[]', 3, 10);
            ",
        )
        .expect("legacy schema");
    "cp_legacy".to_string()
}

#[test]
fn migration_keeps_every_saved_board() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("codecanvas.sqlite3");
    let project_id = legacy_store(&path);

    let connection = open_store(&path).expect("migrated store");

    let boards: i64 = connection
        .query_row("SELECT COUNT(*) FROM codecanvas_snapshots", [], |row| {
            row.get(0)
        })
        .expect("count snapshots");
    assert_eq!(boards, 1, "dropping the old table must not cascade");

    let snapshot = load_project(&connection, &project_id)
        .expect("load")
        .expect("project still there");
    assert_eq!(snapshot.meta.root_dir, "/tmp/legacy");
    assert_eq!(snapshot.meta.alias.as_deref(), Some("Legacy"));
    assert_eq!(snapshot.terminal_counter, 3);
    assert_eq!(
        snapshot.meta.location,
        Some(CodeCanvasProjectLocation::Local),
        "a row written before machines existed is a local project"
    );
}

#[test]
fn migrated_local_project_keeps_the_id_its_board_is_filed_under() {
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("codecanvas.sqlite3");
    let connection = open_store(&path).expect("store");
    let before = open_project(&connection, "/tmp/stable").expect("open").meta.id;
    drop(connection);

    let connection = open_store(&path).expect("reopen");
    let after = open_project(&connection, "/tmp/stable").expect("reopen project").meta.id;
    assert_eq!(before, after);
    assert_eq!(get_index(&connection).unwrap().projects.len(), 1);
}

#[test]
fn two_machines_may_hold_the_same_path() {
    let (_dir, connection) = temp_store();
    let local = open_project(&connection, "/root/app").expect("local");
    let vps_a = open_project_at(&connection, "/root/app", &ssh_location("devbox-vps", Some("root"), None))
        .expect("vps a");
    let vps_b = open_project_at(&connection, "/root/app", &ssh_location("staging", Some("deploy"), Some(2222)))
        .expect("vps b");

    let ids = [&local.meta.id, &vps_a.meta.id, &vps_b.meta.id];
    assert_eq!(
        std::collections::HashSet::from(ids).len(),
        3,
        "same path on three machines is three projects"
    );
    assert_eq!(get_index(&connection).unwrap().projects.len(), 3);
}

#[test]
fn the_same_machine_and_path_is_one_project() {
    let (_dir, connection) = temp_store();
    let first = open_project_at(&connection, "/srv/api", &ssh_location("devbox-vps", Some("root"), Some(22)))
        .expect("first");
    let again = open_project_at(&connection, "/srv/api//", &ssh_location("DEVBOX-VPS", Some("Root"), Some(22)))
        .expect("again");
    assert_eq!(
        first.meta.id, again.meta.id,
        "host and user are compared case-insensitively, like the SSH transport pool does"
    );
    assert_eq!(get_index(&connection).unwrap().projects.len(), 1);
}

#[test]
fn a_machine_survives_save_and_reload() {
    let (_dir, connection) = temp_store();
    let location = ssh_location("devbox-vps", Some("root"), Some(2202));
    let opened = open_project_at(&connection, "/srv/devbox/api", &location).expect("open");
    assert_eq!(opened.meta.location.as_ref(), Some(&location));

    let mut snapshot = opened.clone();
    snapshot.terminal_counter = 7;
    save_project(&connection, &snapshot).expect("save");

    let reloaded = load_project(&connection, &opened.meta.id)
        .expect("load")
        .expect("present");
    assert_eq!(reloaded.meta.location.as_ref(), Some(&location));
    assert_eq!(reloaded.terminal_counter, 7);
    assert_eq!(reloaded.meta.root_dir, "/srv/devbox/api");
}

/// Two machines may record the same provider session id, and neither may claim the other's.
///
/// The partial UNIQUE index is on `(project_id, provider_session_id)` — and `project_id` already
/// carries the machine since tiket 01, so this needs no schema change. That is worth a test rather
/// than a comment: the guarantee lives in two files that do not mention each other, and a future
/// change to project ids would break it silently.
#[test]
fn the_same_session_id_on_two_machines_does_not_collide() {
    let (_dir, connection) = temp_store();
    let a = open_project_at(&connection, "/srv/api", &ssh_location("host-a", Some("root"), None))
        .expect("project a");
    let b = open_project_at(&connection, "/srv/api", &ssh_location("host-b", Some("root"), None))
        .expect("project b");
    assert_ne!(a.meta.id, b.meta.id);

    let shared_id = "01912f3e-same-on-both";
    for project in [&a.meta.id, &b.meta.id] {
        let row = session_row(&format!("s_{project}"), project, Some(shared_id));
        crate::codecanvas_sessions::upsert_session(&connection, &row).expect("upsert");
    }

    for project in [&a.meta.id, &b.meta.id] {
        let rows = crate::codecanvas_sessions::list_sessions(&connection, project).expect("list");
        assert_eq!(rows.len(), 1, "each machine keeps its own row");
        assert_eq!(rows[0].provider_session_id.as_deref(), Some(shared_id));
    }
}

/// A local project and a remote one with the same path are different projects, so a transcript id
/// captured on one can never be attributed to the other.
#[test]
fn a_local_session_never_claims_a_remote_transcript() {
    let (_dir, connection) = temp_store();
    let local = open_project(&connection, "/srv/api").expect("local");
    let remote = open_project_at(&connection, "/srv/api", &ssh_location("devbox-vps", Some("root"), None))
        .expect("remote");
    assert_ne!(local.meta.id, remote.meta.id);

    let row = session_row("s_local", &local.meta.id, Some("shared-id"));
    crate::codecanvas_sessions::upsert_session(&connection, &row).expect("upsert local");

    assert_eq!(
        crate::codecanvas_sessions::list_sessions(&connection, &remote.meta.id)
            .expect("list remote")
            .len(),
        0,
        "the remote project must not see the local machine's session"
    );
}
