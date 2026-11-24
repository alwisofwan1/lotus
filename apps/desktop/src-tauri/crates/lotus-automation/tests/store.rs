use lotus_automation::{NewAutomation, Spec, Store};
use serde_json::json;

fn pr_review_automation(name: &str) -> NewAutomation {
    NewAutomation {
        name: name.to_string(),
        trigger: Spec::new("manual", json!({})),
        action: Spec::new("pr_review", json!({ "repos": ["initech/orbit-app"] })),
        outputs: vec![Spec::new("draft", json!({}))],
    }
}

#[test]
fn room_feedback_is_durable_deduplicated_and_scoped_to_its_automation_and_pr() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rooms.db");
    let store = Store::open(&path).unwrap();
    let a = store.create_automation(pr_review_automation("A"), 1).unwrap();
    let b = store.create_automation(pr_review_automation("B"), 1).unwrap();
    let event = json!({"id":"C1:1.2", "author":"U2", "text":"Fixed, please recheck", "atMs":20});
    assert!(store.record_review_feedback(&a.id, "repo#1", &event).unwrap());
    assert!(!store.record_review_feedback(&a.id, "repo#1", &event).unwrap());
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.review_feedback(&a.id, "repo#1").unwrap(), vec![event]);
    assert!(store.review_feedback(&b.id, "repo#1").unwrap().is_empty());
    assert!(store.review_feedback(&a.id, "repo#2").unwrap().is_empty());
}

#[test]
fn a_saved_automation_survives_reopening_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("automations.db");

    let created = {
        let store = Store::open(&path).unwrap();
        store.create_automation(pr_review_automation("Review PR"), 1_000).unwrap()
    };

    let reopened = Store::open(&path).unwrap();
    let loaded = reopened.get_automation(&created.id).unwrap().expect("automation exists");

    assert_eq!(loaded.name, "Review PR");
    assert_eq!(loaded.action.kind, "pr_review");
    assert_eq!(loaded.action.config, json!({ "repos": ["initech/orbit-app"] }));
    assert_eq!(loaded.outputs.len(), 1);
    assert!(loaded.enabled);
    assert_eq!(loaded.created_at_ms, 1_000);
}

#[test]
fn a_database_written_by_a_newer_lotus_is_refused_not_touched() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.db");
    {
        // Fixture: a file whose schema is ahead of anything this build knows.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 999).unwrap();
    }

    let err = Store::open(&path).err().expect("newer schema must be refused");

    assert!(matches!(err, lotus_automation::Error::SchemaTooNew { found: 999, .. }), "{err}");
}

#[test]
fn only_one_of_many_concurrent_claims_on_the_same_key_wins() {
    use lotus_automation::ClaimOutcome;
    use std::sync::{Arc, Barrier};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.db");
    let automation = Store::open(&path).unwrap().create_automation(pr_review_automation("Review PR"), 1).unwrap();

    const CONTENDERS: usize = 8;
    let barrier = Arc::new(Barrier::new(CONTENDERS));
    let handles: Vec<_> = (0..CONTENDERS)
        .map(|_| {
            // Separate connections, like two processes sharing the file.
            let store = Store::open(&path).unwrap();
            let barrier = Arc::clone(&barrier);
            let automation_id = automation.id.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.claim_run(&automation_id, "initech/orbit-app#42@abc123", 2).unwrap()
            })
        })
        .collect();
    let outcomes: Vec<ClaimOutcome> = handles.into_iter().map(|h| h.join().unwrap()).collect();

    let winners: Vec<_> = outcomes.iter().filter_map(|o| match o {
        ClaimOutcome::Claimed(run) => Some(run.id.clone()),
        ClaimOutcome::Duplicate { .. } => None,
    }).collect();
    assert_eq!(winners.len(), 1, "{outcomes:?}");
    for outcome in &outcomes {
        if let ClaimOutcome::Duplicate { existing_run_id } = outcome {
            assert_eq!(existing_run_id, &winners[0]);
        }
    }
}

fn claimed(outcome: lotus_automation::ClaimOutcome) -> lotus_automation::Run {
    match outcome {
        lotus_automation::ClaimOutcome::Claimed(run) => run,
        other => panic!("expected a claim, got {other:?}"),
    }
}

#[test]
fn runs_left_in_flight_by_a_previous_process_are_marked_interrupted_on_startup() {
    use lotus_automation::RunStatus;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.db");
    let (in_flight, waiting, finished) = {
        let store = Store::open(&path).unwrap();
        let a = store.create_automation(pr_review_automation("Review PR"), 1).unwrap();
        let in_flight = claimed(store.claim_run(&a.id, "pr#1@a", 10).unwrap());
        let waiting = claimed(store.claim_run(&a.id, "pr#2@b", 11).unwrap());
        let finished = claimed(store.claim_run(&a.id, "pr#3@c", 12).unwrap());
        store.mark_running(&in_flight.id).unwrap();
        store.mark_running(&finished.id).unwrap();
        store.finish_run(&finished.id, RunStatus::Succeeded, Some("draft ready"), 20).unwrap();
        (in_flight, waiting, finished)
        // Process "quits" here without finishing the other two.
    };

    let store = Store::open(&path).unwrap();
    let reconciled = store.reconcile_interrupted(100).unwrap();

    assert_eq!(reconciled, 2);
    for id in [&in_flight.id, &waiting.id] {
        let run = store.get_run(id).unwrap().unwrap();
        assert_eq!(run.status, RunStatus::Interrupted);
        assert_eq!(run.finished_at_ms, Some(100));
        assert!(run.detail.is_some());
    }
    let untouched = store.get_run(&finished.id).unwrap().unwrap();
    assert_eq!(untouched.status, RunStatus::Succeeded);
    assert_eq!(untouched.detail.as_deref(), Some("draft ready"));
}

/// The v1 schema exactly as slice 01 shipped it — what already sits in
/// `~/.lotus-dev/automations.db`.
const V1_SCHEMA: &str = "
    CREATE TABLE automations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger_json TEXT NOT NULL,
      action_json TEXT NOT NULL, outputs_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER, detail TEXT, UNIQUE (automation_id, idempotency_key));
    CREATE INDEX runs_by_status ON runs(status);
    PRAGMA user_version = 1;
";

#[test]
fn a_v1_database_is_upgraded_in_place_and_can_hold_drafts() {
    use lotus_automation::NewDraft;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(V1_SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO automations VALUES ('a1', 'old', '{\"kind\":\"manual\",\"config\":{}}',
             '{\"kind\":\"pr_review\",\"config\":{}}', '[]', 1, 5)",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO runs VALUES ('r1', 'a1', 'pr#1@a', 'succeeded', 6, 7, NULL)", []).unwrap();
    }

    let store = Store::open(&path).unwrap();

    assert_eq!(store.get_automation("a1").unwrap().unwrap().name, "old");
    let draft = store
        .save_draft(
            NewDraft {
                run_id: "r1".into(),
                automation_id: "a1".into(),
                kind: "pr_review".into(),
                subject: "initech/orbit-app#1".into(),
                content: json!({ "summary": "Looks fine", "comments": [] }),
            },
            8,
        )
        .unwrap();
    let loaded = store.draft_for_run("r1").unwrap().expect("draft saved");
    assert_eq!(loaded, draft);
    assert_eq!(loaded.content["summary"], "Looks fine");
}

#[test]
fn an_automation_can_switch_to_a_slack_trigger_and_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("automations.db")).unwrap();
    let a = store.create_automation(pr_review_automation("Review PR"), 1).unwrap();

    store.set_trigger(&a.id, &Spec::new("slack", json!({ "channels": ["C1"], "team": null }))).unwrap();
    assert_eq!(store.get_automation(&a.id).unwrap().unwrap().trigger.kind, "slack");

    store.set_trigger(&a.id, &Spec::new("manual", json!({}))).unwrap();
    assert_eq!(store.get_automation(&a.id).unwrap().unwrap().trigger.kind, "manual");
    assert!(store.set_trigger("no-such-id", &Spec::new("manual", json!({}))).is_err());
}

#[test]
fn the_slack_cursor_only_moves_forward_comparing_timestamps_as_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("automations.db")).unwrap();

    store.advance_slack_cursor("C1", "10.100000").unwrap();
    store.advance_slack_cursor("C1", "9.500000").unwrap(); // older, arriving late
    assert_eq!(store.slack_cursor("C1").unwrap().as_deref(), Some("10.100000"));

    store.advance_slack_cursor("C1", "10.200000").unwrap();
    assert_eq!(store.slack_cursor("C1").unwrap().as_deref(), Some("10.200000"));
    assert_eq!(store.slack_cursor("C2").unwrap(), None);
}

#[test]
fn a_run_that_ended_without_a_result_can_be_claimed_again_and_stays_in_history() {
    use lotus_automation::RunStatus;

    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("automations.db")).unwrap();
    let automation = store.create_automation(pr_review_automation("Review PR"), 1).unwrap();

    for status in [RunStatus::Skipped, RunStatus::Failed, RunStatus::Interrupted] {
        let key = format!("initech/orbit-app#42@{}", status.as_str());
        let first = claimed(store.claim_run(&automation.id, &key, 2).unwrap());
        store.finish_run(&first.id, status, Some("why"), 3).unwrap();

        let again = claimed(store.claim_run(&automation.id, &key, 4).unwrap());
        assert_ne!(again.id, first.id, "{status:?}");
        assert_eq!(again.idempotency_key, key);
        let old = store.get_run(&first.id).unwrap().expect("the old run is kept in history");
        assert_eq!(old.status, status);
        assert!(old.idempotency_key.starts_with(&key), "{:?}", old.idempotency_key);
    }
}

#[test]
fn a_run_that_is_waiting_running_or_succeeded_still_blocks_its_key() {
    use lotus_automation::{ClaimOutcome, RunStatus};

    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("automations.db")).unwrap();
    let automation = store.create_automation(pr_review_automation("Review PR"), 1).unwrap();

    let queued = claimed(store.claim_run(&automation.id, "a@1", 2).unwrap());
    let running = claimed(store.claim_run(&automation.id, "b@1", 2).unwrap());
    store.mark_running(&running.id).unwrap();
    let done = claimed(store.claim_run(&automation.id, "c@1", 2).unwrap());
    store.finish_run(&done.id, RunStatus::Succeeded, None, 3).unwrap();

    for (key, winner) in [("a@1", queued.id), ("b@1", running.id), ("c@1", done.id)] {
        match store.claim_run(&automation.id, key, 4).unwrap() {
            ClaimOutcome::Duplicate { existing_run_id } => assert_eq!(existing_run_id, winner, "{key}"),
            other => panic!("{key}: expected a duplicate, got {other:?}"),
        }
    }
}

fn store_with_drafts(n: usize) -> (tempfile::TempDir, Store, Vec<String>) {
    use lotus_automation::{ClaimOutcome, NewDraft};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("automations.db")).unwrap();
    let a = store.create_automation(pr_review_automation("a"), 1).unwrap();
    let ids = (0..n)
        .map(|i| {
            let ClaimOutcome::Claimed(run) = store.claim_run(&a.id, &format!("k{i}"), 2).unwrap() else { panic!() };
            let new = NewDraft {
                run_id: run.id,
                automation_id: a.id.clone(),
                kind: "pr_review".into(),
                subject: format!("o/r#{i}"),
                content: json!({ "summary": "s", "comments": [] }),
            };
            store.save_draft(new, 10 + i as i64).unwrap().id
        })
        .collect();
    (dir, store, ids)
}

fn send(store: &Store, id: &str, at_ms: i64) {
    store.claim_draft_for_sending(id).unwrap().unwrap();
    let content = store.get_draft(id).unwrap().unwrap().content;
    store.mark_draft_sent(id, "https://github.com/o/r/pull/1#r", &content, at_ms).unwrap();
}

#[test]
fn sent_reviews_are_listed_most_recently_sent_first_and_pending_ones_are_not() {
    let (_dir, store, ids) = store_with_drafts(3);
    send(&store, &ids[0], 500); // created first, sent last
    send(&store, &ids[1], 100);

    let sent = store.list_sent("pr_review", 10).unwrap();
    let order: Vec<&str> = sent.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(order, vec![ids[0].as_str(), ids[1].as_str()]);
    assert_eq!(sent[0].sent_at_ms, Some(500));
}

#[test]
fn what_happened_in_slack_is_noted_only_on_a_sent_draft() {
    let (_dir, store, ids) = store_with_drafts(2);
    send(&store, &ids[0], 100);

    assert!(store.note_on_sent_draft(&ids[0], "slack_reply", json!("replied")).unwrap());
    assert!(!store.note_on_sent_draft(&ids[1], "slack_reply", json!("replied")).unwrap(), "still pending");
    assert_eq!(store.get_draft(&ids[0]).unwrap().unwrap().content["slack_reply"], "replied");
    assert!(store.get_draft(&ids[1]).unwrap().unwrap().content["slack_reply"].is_null());
}

#[test]
fn the_newest_slack_thread_a_pr_was_asked_about_in_wins() {
    let (_dir, store, _) = store_with_drafts(0);
    let a = store.list_automations().unwrap().remove(0);
    assert_eq!(store.pr_thread(&a.id, "o/r#1").unwrap(), None);
    store.remember_pr_thread(&a.id, "o/r#1", &json!({ "thread_ts": "1.0" }), 1).unwrap();
    store.remember_pr_thread(&a.id, "o/r#1", &json!({ "thread_ts": "2.0" }), 2).unwrap();
    assert_eq!(store.pr_thread(&a.id, "o/r#1").unwrap(), Some(json!({ "thread_ts": "2.0" })));
}

#[test]
fn a_request_source_remembers_what_it_acted_on_until_the_request_is_gone() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("automations.db")).unwrap();
    let a = store.create_automation(pr_review_automation("Review PR"), 1).unwrap();

    assert!(!store.has_seen(&a.id, "github:o/r#1").unwrap());
    assert!(store.mark_seen(&a.id, "github:o/r#1", 2).unwrap());
    assert!(!store.mark_seen(&a.id, "github:o/r#1", 3).unwrap(), "a second mark is a repeat");
    store.mark_seen(&a.id, "github:o/r#2", 3).unwrap();
    store.mark_seen(&a.id, "C1:10.1", 3).unwrap();

    // o/r#1 is still requested, o/r#2 no longer is; another source's keys are left alone.
    store.forget_seen_except(&a.id, "github:", &["github:o/r#1".to_string()]).unwrap();

    assert!(store.has_seen(&a.id, "github:o/r#1").unwrap());
    assert!(!store.has_seen(&a.id, "github:o/r#2").unwrap());
    assert!(store.has_seen(&a.id, "C1:10.1").unwrap());
}

/// v9 renamed `slack_seen` to `trigger_seen` (any source's requests, not only
/// Slack's) and dropped `reviewer_team` from PR reviews: a GitHub review
/// request no longer gates a review (ADR-0041).
#[test]
fn a_v8_database_keeps_what_slack_saw_and_loses_the_review_team() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("automations.db");
    let id = {
        let store = Store::open(&path).unwrap();
        store.create_automation(pr_review_automation("Review PR"), 1).unwrap().id
    };
    {
        // Fixture: turn the file back into v8 as it shipped.
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "DROP TABLE slack_reply_holds; DROP TABLE run_slack_threads; DROP TABLE slack_retries; DROP TABLE pr_slack_threads; CREATE TABLE pr_slack_threads (automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE, pr TEXT NOT NULL, context_json TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (automation_id, pr)); DROP TABLE slack_thread_cursors; DROP TABLE review_feedback; ALTER TABLE runs DROP COLUMN payload_json; ALTER TABLE runs DROP COLUMN resumed;
             ALTER TABLE trigger_seen RENAME TO slack_seen; PRAGMA user_version = 8;",
        )
        .unwrap();
        conn.execute("INSERT INTO slack_seen VALUES (?1, 'C1:10.1', 5)", [&id]).unwrap();
        conn.execute(
            "INSERT INTO pr_slack_threads VALUES (?1, 'o/r#1', ?2, 7)",
            [&id, &json!({ "channel": "C1", "thread_ts": "10.1", "message_ts": "10.1" }).to_string()],
        )
        .unwrap();
        conn.execute(
            "UPDATE automations SET action_json = ?2 WHERE id = ?1",
            [&id, &json!({ "kind": "pr_review", "config": { "repos": ["o/r"], "reviewer_team": "o/team" } }).to_string()],
        )
        .unwrap();
    }

    let store = Store::open(&path).unwrap();

    assert!(store.has_seen(&id, "C1:10.1").unwrap(), "a Slack message acted on stays acted on");
    assert_eq!(store.prs_in_thread(&id, "C1", "10.1").unwrap().len(), 1, "a PR's Slack thread survives v14");
    assert_eq!(store.pr_thread(&id, "o/r#1").unwrap().unwrap()["thread_ts"], "10.1");
    assert_eq!(store.get_automation(&id).unwrap().unwrap().action.config, json!({ "repos": ["o/r"] }));
}
