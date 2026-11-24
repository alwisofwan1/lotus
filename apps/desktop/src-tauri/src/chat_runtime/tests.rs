use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::json;

use super::*;

fn runtime() -> (ChatRuntime, String) {
    let rt = ChatRuntime::with_store(Ok(Store::in_memory()));
    let dir = std::env::temp_dir().to_string_lossy().into_owned();
    let id = rt.create_thread(&dir, None, None, None, None, None, None).unwrap().id;
    (rt, id)
}

fn feed(rt: &ChatRuntime, thread_id: &str, event: Value) {
    on_bridge_message(
        &Arc::downgrade(&rt.inner),
        0,
        BridgeMessage::Event {
            thread_id: thread_id.into(),
            event,
        },
    );
}

fn recorder() -> (Arc<Mutex<Vec<Envelope>>>, Sink) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink_seen = Arc::clone(&seen);
    (
        seen,
        Box::new(move |e: &Envelope| {
            sink_seen.lock().push(e.clone());
            true
        }),
    )
}

fn types(envelopes: &[Envelope]) -> Vec<String> {
    envelopes
        .iter()
        .map(|e| store::event_type(&e.event).to_string())
        .collect()
}

#[test]
fn a_late_subscriber_gets_the_history_then_live_events_without_gaps() {
    let (rt, id) = runtime();
    feed(
        &rt,
        &id,
        json!({"type": "turn/started", "turnId": "t1", "input": null}),
    );
    feed(
        &rt,
        &id,
        json!({"type": "item/delta", "turnId": "t1", "itemId": "a", "delta": "hi"}),
    );
    let (seen, sink) = recorder();
    rt.subscribe(&id, 0, sink).unwrap();
    feed(
        &rt,
        &id,
        json!({"type": "turn/completed", "turnId": "t1", "status": "completed", "error": null, "usage": null}),
    );
    let seen = seen.lock();
    assert_eq!(
        seen.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );
    assert_eq!(
        types(&seen),
        vec!["turn/started", "item/delta", "turn/completed"]
    );
}

#[test]
fn a_reconnect_replays_only_what_it_missed_and_finished_turns_lose_their_deltas() {
    let (rt, id) = runtime();
    feed(
        &rt,
        &id,
        json!({"type": "turn/started", "turnId": "t1", "input": null}),
    );
    feed(
        &rt,
        &id,
        json!({"type": "item/delta", "turnId": "t1", "itemId": "a", "delta": "hi"}),
    );
    feed(
        &rt,
        &id,
        json!({"type": "turn/completed", "turnId": "t1", "status": "completed", "error": null, "usage": null}),
    );
    let (seen, sink) = recorder();
    rt.subscribe(&id, 1, sink).unwrap();
    assert_eq!(types(&seen.lock()), vec!["turn/completed"]);
}

#[test]
fn a_closed_subscriber_is_dropped() {
    let (rt, id) = runtime();
    let calls = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&calls);
    rt.subscribe(
        &id,
        0,
        Box::new(move |_| {
            *counter.lock() += 1;
            false
        }),
    )
    .unwrap();
    feed(&rt, &id, json!({"type": "session/configured"}));
    feed(&rt, &id, json!({"type": "session/ended", "error": null}));
    assert_eq!(*calls.lock(), 1);
}

#[test]
fn a_bridge_crash_fails_the_running_turn() {
    let (rt, id) = runtime();
    feed(&rt, &id, json!({"type": "session/configured"}));
    feed(
        &rt,
        &id,
        json!({"type": "turn/started", "turnId": "t1", "input": null}),
    );
    on_bridge_message(
        &Arc::downgrade(&rt.inner),
        0,
        BridgeMessage::Exited {
            error: "boom".into(),
        },
    );
    let (seen, sink) = recorder();
    rt.subscribe(&id, 2, sink).unwrap();
    let seen = seen.lock();
    assert_eq!(types(&seen), vec!["turn/completed", "session/ended"]);
    assert_eq!(seen[0].event["error"], "boom");
    assert!(!rt.inner.core.lock().runs[&id].session_live);
}

#[test]
fn an_old_bridge_exiting_closes_nothing() {
    let (rt, id) = runtime();
    feed(
        &rt,
        &id,
        json!({"type": "turn/started", "turnId": "t1", "input": null}),
    );
    rt.inner.core.lock().bridge_generation = 2;
    on_bridge_message(
        &Arc::downgrade(&rt.inner),
        1,
        BridgeMessage::Exited {
            error: "old".into(),
        },
    );
    assert!(rt.inner.core.lock().runs[&id].active_turn.is_some());
}

#[test]
fn a_turn_left_open_by_a_previous_run_is_closed_on_load() {
    let (rt, id) = runtime();
    feed(
        &rt,
        &id,
        json!({"type": "turn/started", "turnId": "t1", "input": null}),
    );
    rt.inner.core.lock().runs.clear(); // as after a Lotus restart
    let (seen, sink) = recorder();
    rt.subscribe(&id, 0, sink).unwrap();
    assert_eq!(
        types(&seen.lock()),
        vec!["turn/started", "turn/completed", "session/ended"]
    );
}

#[test]
fn a_remote_thread_is_not_closed_on_load_because_its_host_outlives_lotus() {
    let (rt, id) = runtime();
    let machine = RemoteMachine { host: "vps".into(), user: None, port: None, workspace_id: "ws".into(), pane_id: Some("ss-1".into()), cursor: None };
    rt.inner.core.lock().store().unwrap().set_machine(&id, &machine).unwrap();
    feed(&rt, &id, json!({"type": "turn/started", "turnId": "t1", "input": null}));
    rt.inner.core.lock().runs.clear(); // as after a Lotus restart
    let (seen, sink) = recorder();
    rt.subscribe(&id, 0, sink).unwrap();
    assert_eq!(types(&seen.lock()), vec!["turn/started"]);
}

#[tokio::test]
async fn only_a_waiting_approval_can_be_answered() {
    let (rt, id) = runtime();
    let error = rt
        .resolve_interaction(&id, "i1", Decision::Allow { answers: None, remember: false })
        .await
        .unwrap_err();
    assert!(error.contains("no longer waiting"), "{error}");
    feed(
        &rt,
        &id,
        json!({"type": "interaction/requested", "turnId": null, "interaction": {"id": "i1"}}),
    );
    // Waiting, but no live bridge in this test.
    assert_eq!(
        rt.resolve_interaction(&id, "i1", Decision::Allow { answers: None, remember: false })
            .await
            .unwrap_err(),
        "the chat session has ended"
    );
}

#[tokio::test]
async fn a_starting_session_does_not_hold_up_another_threads_controls() {
    let (rt, a) = runtime();
    let b = rt
        .create_thread(&std::env::temp_dir().to_string_lossy(), None, None, None, None, None, None)
        .unwrap()
        .id;
    feed(&rt, &a, json!({"type": "session/configured"}));
    feed(
        &rt,
        &a,
        json!({"type": "interaction/requested", "interaction": {"id": "i1"}}),
    );
    // Thread B is mid-start: its bridge is spawning and its session is starting.
    let _spawning = rt.inner.spawning.lock().await;
    let b_lock = Arc::clone(rt.inner.starting.lock().entry(b).or_default());
    let _b_starting = b_lock.lock().await;

    let quick = std::time::Duration::from_millis(200);
    let interrupt = tokio::time::timeout(quick, rt.interrupt(&a)).await;
    let stop = tokio::time::timeout(quick, rt.stop_thread(&a)).await;
    let approval = tokio::time::timeout(
        quick,
        rt.resolve_interaction(&a, "i1", Decision::Allow { answers: None, remember: false }),
    )
    .await;
    assert_eq!(interrupt, Ok(Ok(())));
    assert_eq!(stop, Ok(Ok(())));
    assert_eq!(
        approval,
        Ok(Err("the chat session has ended".to_string()))
    );
}

#[test]
fn creating_a_thread_checks_its_inputs() {
    let (rt, _) = runtime();
    assert!(rt
        .create_thread("/definitely/not/here", None, None, None, None, None, None)
        .unwrap_err()
        .contains("not a folder"));
    let dir = std::env::temp_dir().to_string_lossy().into_owned();
    assert!(rt
        .create_thread(&dir, None, Some("yolo".into()), None, None, None, None)
        .unwrap_err()
        .contains("permission mode"));
    assert!(rt
        .create_thread(&dir, None, None, Some("gemini".into()), None, None, None)
        .unwrap_err()
        .contains("unknown runner"));
    // The new-chat screen's id, so its pasted files are already in the chat's folder.
    let staged = uuid::Uuid::new_v4().to_string();
    assert_eq!(rt.create_thread(&dir, None, None, None, None, None, Some(staged.clone())).unwrap().id, staged);
    assert!(rt.create_thread(&dir, None, None, None, None, None, Some(staged)).unwrap_err().contains("already exists"));
    assert!(rt
        .create_thread(&dir, None, None, None, None, None, Some("../x".into()))
        .unwrap_err()
        .contains("not a chat id"));
    assert!(rt
        .subscribe("nope", 0, Box::new(|_| true))
        .unwrap_err()
        .contains("unknown thread"));
}

#[test]
fn decisions_parse_from_the_frontend_shape() {
    assert!(matches!(
        serde_json::from_value(json!({"behavior": "allow"})),
        Ok(Decision::Allow { answers: None, remember: false })
    ));
    assert!(matches!(
        serde_json::from_value(json!({"behavior": "allow", "answers": {"Which colour?": "Blue"}})),
        Ok(Decision::Allow { answers: Some(a), .. }) if a["Which colour?"] == "Blue"
    ));
    assert!(matches!(
        serde_json::from_value(json!({"behavior": "allow", "remember": true})),
        Ok(Decision::Allow { remember: true, .. })
    ));
    assert!(matches!(
        serde_json::from_value(json!({"behavior": "deny", "message": "no"})),
        Ok(Decision::Deny { .. })
    ));
    assert!(serde_json::from_value::<Decision>(json!({"behavior": "deny"})).is_err());
}

/// Live: a real bridge and a real Claude turn, with the user's own login. Run by hand:
/// `cargo test --lib chat_runtime::tests::live -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls Claude"]
async fn live_turn_through_the_real_bridge() {
    let rt = ChatRuntime::with_store(Ok(Store::in_memory()));
    let dir = tempfile::tempdir().unwrap();
    let thread = rt
        .create_thread(&dir.path().to_string_lossy(), Some("haiku".into()), None, None, None, None, None)
        .unwrap();
    let (seen, sink) = recorder();
    rt.subscribe(&thread.id, 0, sink).unwrap();

    let done = || {
        types(&seen.lock())
            .iter()
            .filter(|t| *t == "turn/completed")
            .count()
    };
    for (n, prompt) in [
        "Reply with exactly the word PONG.",
        "Reply with exactly the word AGAIN.",
    ]
    .iter()
    .enumerate()
    {
        rt.send(&thread.id, prompt, &format!("live-{n}"), Vec::new())
            .await
            .unwrap();
        for _ in 0..600 {
            if done() > n {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }
    rt.stop_thread(&thread.id).await.unwrap();
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    let seen = seen.lock();
    let kinds = types(&seen);
    eprintln!("{kinds:?}");
    let seqs: Vec<u64> = seen.iter().map(|e| e.seq).collect();
    assert!(
        seqs.windows(2).all(|w| w[1] > w[0]),
        "seq must only grow: {seqs:?}"
    );
    assert_eq!(kinds.iter().filter(|t| *t == "turn/completed").count(), 2);
    assert!(seen.iter().any(
        |e| e.event["type"] == "session/configured" && e.event["authSource"] == "accountLogin"
    ));
    assert_eq!(kinds.last().map(String::as_str), Some("session/ended"));
    let replay = rt
        .inner
        .core
        .lock()
        .store()
        .unwrap()
        .events_after(&thread.id, 0)
        .unwrap();
    assert!(
        replay
            .iter()
            .all(|e| store::event_type(&e.event) != "item/delta"),
        "finished turns keep no deltas"
    );
}

#[tokio::test]
async fn a_model_picked_without_a_session_is_recorded_and_kept_for_the_next_start() {
    let (rt, id) = runtime();
    let (seen, sink) = recorder();
    rt.subscribe(&id, 0, sink).unwrap();
    rt.set_model(&id, "sonnet", None, "Sonnet 5.5").await.unwrap();
    assert_eq!(seen.lock()[0].event["type"], "session/modelChanged");
    assert_eq!(seen.lock()[0].event["label"], "Sonnet 5.5");
    let record = rt.list_threads().unwrap().into_iter().find(|t| t.id == id).unwrap();
    assert_eq!(record.model.as_deref(), Some("sonnet"));
    assert!(rt.set_model(&id, " ", None, "").await.is_err());
}

#[test]
fn imports_codechat_history_once() {
    let dir = std::env::temp_dir().join(format!("lotus-import-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("codechat.sqlite3");
    // The columns of CodeChat's schema (codechat_store.rs, deleted in 07p) the importer reads.
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        r#"CREATE TABLE sessions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, workspace_path TEXT,
             session_mode TEXT NOT NULL, runtime_config_json TEXT, updated_at INTEGER NOT NULL);
           CREATE TABLE messages (session_id TEXT NOT NULL, message_id TEXT NOT NULL, role TEXT NOT NULL,
             parts_json TEXT NOT NULL, message_json TEXT NOT NULL, created_at INTEGER NOT NULL, position INTEGER NOT NULL,
             PRIMARY KEY (session_id, message_id));
           INSERT INTO sessions (id, kind, title, workspace_path, session_mode, runtime_config_json, updated_at)
             VALUES ('s1', 'template', 'Old chat', '/w', 'ask', '{"agentId":"claude","model":"sonnet"}', 20),
                    ('empty', 'template', 'Nothing', NULL, 'ask', NULL, 30);
           INSERT INTO messages (session_id, message_id, role, parts_json, message_json, created_at, position)
             VALUES ('s1', 'u', 'user', '[{"type":"text","text":"hi"}]', '{}', 10, 0),
                    ('s1', 'a', 'assistant', '[{"type":"text","text":"hello"}]', '{}', 11, 1);"#,
    )
    .unwrap();
    drop(conn);
    let rt = ChatRuntime::with_store(Ok(Store::in_memory()));
    assert_eq!(rt.import_codechat(&path, true).unwrap(), ImportReport { pending: 1, imported: 0 });
    assert!(rt.list_threads().unwrap().is_empty());
    assert_eq!(rt.import_codechat(&path, false).unwrap(), ImportReport { pending: 1, imported: 1 });
    assert_eq!(rt.import_codechat(&path, false).unwrap(), ImportReport { pending: 0, imported: 0 });
    let threads = rt.list_threads().unwrap();
    assert_eq!(threads.len(), 1);
    let t = &threads[0];
    assert_eq!((t.title.as_deref(), t.cwd.as_str(), t.imported_from.as_deref(), t.updated_at), (Some("Old chat"), "/w", Some("s1"), 20));
    let mut core = rt.inner.core.lock();
    let events = core.store().unwrap().events_after(&t.id, 0).unwrap();
    assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(events[1].event["item"]["text"], json!("hello"));
    drop(core);
    assert_eq!(rt.import_codechat(&dir.join("missing.sqlite3"), false).unwrap(), ImportReport::default());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_rail_hears_a_turn_start_and_end_and_sees_when_it_started() {
    let (rt, id) = runtime();
    let told = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&told);
    rt.on_rail_change(move || *counter.lock() += 1);
    feed(&rt, &id, json!({"type": "turn/started", "turnId": "t1", "input": null}));
    let started = rt.list_threads().unwrap()[0].turn_started_at;
    assert!(started.is_some_and(|at| at > 0));
    feed(&rt, &id, json!({"type": "message/delta", "turnId": "t1", "text": "hi"}));
    feed(&rt, &id, json!({"type": "turn/completed", "turnId": "t1", "status": "completed", "error": null, "usage": null}));
    assert_eq!(*told.lock(), 2, "a delta does not move the rail");
    assert_eq!(rt.list_threads().unwrap()[0].turn_started_at, None);
}

#[test]
fn another_agent_reads_a_chat_page_by_page() {
    let (rt, id) = runtime();
    for (turn, ask, answer) in [("t1", "first", "one"), ("t2", "second", "two")] {
        feed(&rt, &id, json!({"type": "turn/started", "turnId": turn, "input": {"text": ask}}));
        feed(&rt, &id, json!({"type": "item/completed", "turnId": turn, "item": {"id": turn, "kind": "agentMessage", "text": answer}}));
        feed(&rt, &id, json!({"type": "turn/completed", "turnId": turn, "status": "completed", "error": null, "usage": null}));
    }
    let page = rt.transcript(&id, 1, 2).unwrap();
    assert_eq!(page["total"], json!(4));
    assert_eq!(page["from"], json!(1));
    assert_eq!(page["runner"], json!("claude"));
    assert_eq!(
        page["messages"],
        json!([{"role": "assistant", "content": "one"}, {"role": "user", "content": "second"}])
    );
    assert_eq!(rt.transcript(&id, 9, 2).unwrap()["messages"], json!([]));
    assert!(rt.transcript("nope", 0, 2).is_err());
}

#[test]
fn a_handoff_seed_points_an_agent_at_the_chat_and_an_api_agent_gets_the_text() {
    let (rt, id) = runtime();
    for (turn, ask, answer) in [("t1", "fix the login", "Done, see auth.rs"), ("t2", "now add a test", "Added login.test.ts")] {
        feed(&rt, &id, json!({"type": "turn/started", "turnId": turn, "input": {"text": ask}}));
        feed(&rt, &id, json!({"type": "item/completed", "turnId": turn, "item": {"id": turn, "kind": "agentMessage", "text": answer}}));
        feed(&rt, &id, json!({"type": "turn/completed", "turnId": turn, "status": "completed", "error": null, "usage": null}));
    }
    let seed = rt.handoff_seed(&id, "codex").unwrap();
    assert!(seed.starts_with(&format!("<lotus-handoff chat=\"{id}\" from=\"claude\">")));
    assert!(seed.trim_end().ends_with("</lotus-handoff>"));
    assert!(seed.contains("lotus_chat_read"));
    assert!(seed.contains("Added login.test.ts") && seed.contains("now add a test"));
    assert!(!seed.contains("User: fix the login"), "only the last turn; the rest is read with the tool");

    let api = rt.handoff_seed(&id, "api").unwrap();
    assert!(api.contains("User: fix the login") && api.contains("Added login.test.ts"));
    assert!(!api.contains("lotus_chat_read"), "the API agent has no tools");
}

#[test]
fn a_handoff_seed_does_not_become_the_title() {
    assert_eq!(
        store::title_of("<lotus-handoff chat=\"a\" from=\"claude\">\nUser: old\n</lotus-handoff>\n\nship it\nplease"),
        Some("ship it".into())
    );
}

#[test]
fn concise_replies_is_off_unless_set_true() {
    assert!(!concise_replies(&json!({})));
    assert!(!concise_replies(&json!({"chat": {"conciseReplies": "yes"}})));
    assert!(concise_replies(&json!({"chat": {"titleModel": "x", "conciseReplies": true}})));
}

#[test]
fn a_fork_copies_the_chat_through_a_turn_and_branches_its_session_there() {
    let (rt, id) = runtime();
    rt.rename_thread(&id, "Fix the flaky test").unwrap();
    feed(&rt, &id, json!({ "type": "session/configured", "providerSessionId": "s-orig" }));
    for (turn, point) in [("t1", Some("u1")), ("t2", None)] {
        feed(&rt, &id, json!({ "type": "turn/started", "turnId": turn, "input": { "text": "hi" } }));
        feed(&rt, &id, json!({ "type": "turn/completed", "turnId": turn, "status": "completed", "error": null, "usage": null, "forkPoint": point }));
    }

    assert_eq!(rt.fork(&id, "t2").unwrap_err(), "Lotus did not record a fork point for this turn");
    assert_eq!(rt.fork(&id, "nope").unwrap_err(), "that turn has not finished");

    let fork = rt.fork(&id, "t1").unwrap();
    assert_eq!(fork.title.as_deref(), Some("Fix the flaky test (fork)"));
    assert_eq!(fork.parent_id.as_deref(), Some(id.as_str()));
    assert_eq!(fork.provider_session_id.as_deref(), Some("s-orig"));
    let events = rt.inner.core.lock().store().unwrap().events_after(&fork.id, 0).unwrap();
    assert_eq!(
        types(&events),
        ["session/configured", "turn/started", "turn/completed", "thread/forked"]
    );
    assert_eq!(events[3].event["turn"], 1);
    let fork_at = |rt: &ChatRuntime| rt.inner.core.lock().store().unwrap().fork_at(&fork.id).unwrap();
    assert_eq!(fork_at(&rt).as_deref(), Some("u1"));

    // The same session restarting keeps the fork point; the fork's own session drops it.
    feed(&rt, &fork.id, json!({ "type": "session/configured", "providerSessionId": "s-orig" }));
    assert_eq!(fork_at(&rt).as_deref(), Some("u1"));
    feed(&rt, &fork.id, json!({ "type": "session/configured", "providerSessionId": "s-fork" }));
    assert_eq!(fork_at(&rt), None);
}

#[tokio::test]
async fn an_edited_message_rewinds_the_chat_to_the_turn_before_it() {
    let (rt, id) = runtime();
    feed(&rt, &id, json!({ "type": "session/configured", "providerSessionId": "s1" }));
    for (turn, text, point) in [("t1", "first", "u1"), ("t2", "second", "u2"), ("t3", "third", "u3")] {
        feed(&rt, &id, json!({ "type": "turn/started", "turnId": turn, "input": { "text": text } }));
        feed(&rt, &id, json!({ "type": "item/completed", "turnId": turn, "item": { "kind": "agentMessage", "text": format!("re {text}") } }));
        feed(&rt, &id, json!({ "type": "turn/completed", "turnId": turn, "status": "completed", "error": null, "usage": null, "forkPoint": point }));
    }
    let session = |rt: &ChatRuntime| {
        let mut core = rt.inner.core.lock();
        let store = core.store().unwrap();
        (store.thread(&id).unwrap().unwrap().provider_session_id, store.fork_at(&id).unwrap())
    };

    assert_eq!(rt.rewind(&id, "nope").await.unwrap_err(), "that message is no longer in this chat");
    rt.rewind(&id, "t2").await.unwrap();
    // The session branches where t1 ended; t2 and t3 are gone from the conversation, not the store.
    assert_eq!(session(&rt), (Some("s1".into()), Some("u1".into())));
    let texts: Vec<Value> = rt.transcript(&id, 0, 10).unwrap()["messages"].as_array().unwrap().iter().map(|m| m["content"].clone()).collect();
    assert_eq!(texts, [json!("first"), json!("re first")]);
    assert_eq!(rt.rewind(&id, "t3").await.unwrap_err(), "that message is no longer in this chat");

    // Editing the first message starts a fresh session.
    rt.rewind(&id, "t1").await.unwrap();
    assert_eq!(session(&rt), (None, None));
    assert_eq!(rt.transcript(&id, 0, 10).unwrap()["total"], 0);
}

#[tokio::test]
async fn only_a_fork_that_has_not_worked_yet_moves_to_a_worktree() {
    let (rt, id) = runtime();
    feed(&rt, &id, json!({ "type": "turn/started", "turnId": "t1", "input": { "text": "hi" } }));
    feed(&rt, &id, json!({ "type": "turn/completed", "turnId": "t1", "status": "completed", "error": null, "usage": null, "forkPoint": "u1" }));
    assert_eq!(rt.fork_to_worktree(&id).await.unwrap_err(), "only a fork can move to a worktree");

    let fork = rt.fork(&id, "t1").unwrap();
    // No snapshot was taken in this test, so it stops before touching git.
    assert_eq!(rt.fork_to_worktree(&fork.id).await.unwrap_err(), "Lotus took no snapshot of the folder when that turn ended");
    feed(&rt, &fork.id, json!({ "type": "turn/started", "turnId": "t2", "input": { "text": "go" } }));
    feed(&rt, &fork.id, json!({ "type": "turn/completed", "turnId": "t2", "status": "completed", "error": null, "usage": null }));
    assert_eq!(rt.fork_to_worktree(&fork.id).await.unwrap_err(), "this fork has already worked in the shared folder");
}

#[test]
fn a_resumed_chat_is_handed_only_the_messages_that_may_name_an_outside_path() {
    let envelopes: Vec<store::Envelope> = [
        json!({"type": "turn/started", "input": {"text": "read `/x/notes.md`", "clientRequestId": "a"}}),
        json!({"type": "turn/started", "input": {"text": "plain words", "clientRequestId": "b"}}),
        json!({"type": "turn/started", "input": {"text": "", "clientRequestId": "c", "attachments": [
            {"kind": "image", "path": "/p/shot.png", "name": "shot.png"},
            {"kind": "file", "path": "/p/spec.pdf", "name": "spec.pdf"}]}}),
        json!({"type": "item/completed", "item": {"kind": "userMessage", "text": "also `/y/`", "clientRequestId": "d"}}),
        json!({"type": "item/completed", "item": {"kind": "agentMessage", "text": "see `/z/`"}}),
    ]
    .into_iter()
    .enumerate()
    .map(|(i, event)| store::Envelope { thread_id: "t".into(), seq: i as u64, at: 0, event })
    .collect();
    assert_eq!(
        outside_path_inputs(&envelopes),
        vec![
            json!({"text": "read `/x/notes.md`", "attachments": []}),
            json!({"text": "", "attachments": [{"kind": "file", "path": "/p/spec.pdf", "name": "spec.pdf"}]}),
            json!({"text": "also `/y/`", "attachments": []}),
        ]
    );
}

#[tokio::test]
async fn a_lead_acts_only_on_its_own_children_and_never_grants_a_permission() {
    let (rt, lead) = runtime();
    let dir = std::env::temp_dir().to_string_lossy().into_owned();
    let child = rt.create_thread(&dir, None, None, None, None, None, None).unwrap().id;
    let stranger = rt.create_thread(&dir, None, None, None, None, None, None).unwrap().id;
    rt.inner.core.lock().store().unwrap().set_parent(&child, &lead).unwrap();
    let act = |chat: &str, action: &str, extra: Value| {
        let mut req = json!({ "parentId": lead, "chatId": chat, "action": action });
        req.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value::<ChatChildRequest>(req).unwrap()
    };

    let error = rt.child_action(act(&stranger, "tell", json!({ "text": "hi" }))).await.unwrap_err();
    assert!(error.contains("not delegated by this chat"), "{error}");

    feed(&rt, &child, json!({"type": "session/configured"}));
    feed(
        &rt,
        &child,
        json!({"type": "interaction/requested", "turnId": null, "interaction": {"id": "p1", "kind": "toolPermission", "toolName": "Bash"}}),
    );
    let error = rt
        .child_action(act(&child, "answer", json!({ "interactionId": "p1", "answers": { "q": "yes" } })))
        .await
        .unwrap_err();
    assert!(error.contains("only the user can grant it"), "{error}");
    let error = rt
        .child_action(act(&child, "answer", json!({ "interactionId": "gone", "answers": { "q": "yes" } })))
        .await
        .unwrap_err();
    assert!(error.contains("no longer waiting"), "{error}");
}

#[test]
fn a_discard_takes_its_own_verifiers_but_not_a_stranger_in_the_worktree() {
    let t = |id: &str, parent: Option<&str>, shares: bool| (id.to_string(), parent.map(str::to_string), shares);
    let tree = vec![t("lead", None, false), t("child", Some("lead"), true), t("verify", Some("child"), true), t("sibling", Some("lead"), false)];
    assert_eq!(own_worktree_chats(&tree, "child"), Some(vec!["verify".to_string()]));
    let mut shared = tree.clone();
    shared.push(t("stranger", None, true));
    assert_eq!(own_worktree_chats(&shared, "child"), None);
}

#[tokio::test]
async fn a_remote_thread_keeps_its_machine_and_refuses_what_needs_this_macs_files() {
    let (rt, _) = runtime();
    let machine = RemoteMachine {
        host: "devbox-vps".into(),
        user: None,
        port: None,
        workspace_id: "w1".into(),
        pane_id: None,
        cursor: None,
    };
    // The folder is on the machine, so it is not checked here.
    let record = rt
        .create_remote_thread(machine.clone(), "/home/x/proj", None, None, None, None, None)
        .unwrap();
    assert_eq!(rt.machine_of(&record.id).unwrap(), Some(machine.clone()));
    assert!(rt
        .create_remote_thread(machine, "/p", None, None, Some("api".into()), None, None)
        .unwrap_err()
        .contains("claude or codex"));
    assert!(rt.fork_to_worktree(&record.id).await.unwrap_err().contains("devbox-vps"));
    // No links attached: a send says so instead of starting a local session.
    assert!(rt.send(&record.id, "hi", "c1", vec![]).await.unwrap_err().contains("not ready"));
    // Stream trouble reaches the rail's list, and stopping (detach) clears it.
    rt.set_trouble(&record.id, Some("down"));
    let listed = |rt: &ChatRuntime| rt.list_threads().unwrap().into_iter().find(|t| t.id == record.id).unwrap().link;
    assert_eq!(listed(&rt), Some("down"));
    assert!(rt.change_diff(&record.id, "a", false).unwrap_err().contains("devbox-vps"));
    // Stopping only stops following; the agent on the machine keeps running.
    rt.stop_thread(&record.id).await.unwrap();
    assert_eq!(listed(&rt), None);
}
