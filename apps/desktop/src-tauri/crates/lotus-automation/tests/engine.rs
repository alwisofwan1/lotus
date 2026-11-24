use std::sync::Arc;

use lotus_automation::{
    ActionContext, ActionKind, ActionResult, BoxFuture, Clock, Engine, EngineConfig, NewAutomation, Registry,
    RunStatus, Spec, Store, Submitted,
};
use serde_json::json;

struct FixedClock(i64);
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        self.0
    }
}

/// Test action: echoes the payload's `say` field as its result detail.
struct Echo;
impl ActionKind for Echo {
    fn kind(&self) -> &str {
        "echo"
    }
    fn execute(&self, ctx: ActionContext) -> BoxFuture<ActionResult> {
        Box::pin(async move {
            let said = ctx.payload["say"].as_str().unwrap_or_default().to_string();
            ActionResult::Succeeded { detail: Some(said) }
        })
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    store: Arc<Store>,
    automation_id: String,
}

fn harness(action_kind: &str) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("automations.db")).unwrap());
    let automation = store
        .create_automation(
            NewAutomation {
                name: "test".into(),
                trigger: Spec::new("manual", json!({})),
                action: Spec::new(action_kind, json!({})),
                outputs: vec![],
            },
            1,
        )
        .unwrap();
    Harness { _dir: dir, store, automation_id: automation.id }
}

fn engine(h: &Harness, registry: Registry) -> Engine {
    Engine::new(Arc::clone(&h.store), registry, Arc::new(FixedClock(500)), EngineConfig { retry_delays: vec![], ..EngineConfig::default() })
}

fn started(submitted: Submitted) -> String {
    match submitted {
        Submitted::Started { run_id } => run_id,
        other => panic!("expected a new run, got {other:?}"),
    }
}

#[tokio::test]
async fn run_now_executes_the_action_and_records_its_result() {
    let h = harness("echo");
    let engine = engine(&h, Registry::new().with_action(Echo));

    let run_id = started(engine.submit(&h.automation_id, "manual-1", json!({ "say": "hello" })).await.unwrap());
    engine.drain().await;

    let run = h.store.get_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(run.detail.as_deref(), Some("hello"));
    assert_eq!(run.finished_at_ms, Some(500));
}

/// Test action: counts executions.
struct Counting(Arc<std::sync::atomic::AtomicUsize>);
impl ActionKind for Counting {
    fn kind(&self) -> &str {
        "count"
    }
    fn execute(&self, _ctx: ActionContext) -> BoxFuture<ActionResult> {
        let count = Arc::clone(&self.0);
        Box::pin(async move {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            ActionResult::Succeeded { detail: None }
        })
    }
}

#[tokio::test]
async fn the_same_unit_of_work_submitted_twice_runs_once() {
    let h = harness("count");
    let executions = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let engine = engine(&h, Registry::new().with_action(Counting(Arc::clone(&executions))));

    let first = started(engine.submit(&h.automation_id, "repo#42@abc", json!({})).await.unwrap());
    let second = engine.submit(&h.automation_id, "repo#42@abc", json!({})).await.unwrap();
    engine.drain().await;

    assert_eq!(second, Submitted::Duplicate { existing_run_id: first });
    assert_eq!(executions.load(std::sync::atomic::Ordering::SeqCst), 1);
}

/// Test action: holds its slot until the test opens the gate, tracking how
/// many executions overlap.
struct Gated {
    gate: Arc<tokio::sync::Semaphore>,
    running: Arc<std::sync::atomic::AtomicUsize>,
    peak: Arc<std::sync::atomic::AtomicUsize>,
}
impl ActionKind for Gated {
    fn kind(&self) -> &str {
        "gated"
    }
    fn execute(&self, _ctx: ActionContext) -> BoxFuture<ActionResult> {
        use std::sync::atomic::Ordering::SeqCst;
        let (gate, running, peak) = (Arc::clone(&self.gate), Arc::clone(&self.running), Arc::clone(&self.peak));
        Box::pin(async move {
            let now = running.fetch_add(1, SeqCst) + 1;
            peak.fetch_max(now, SeqCst);
            gate.acquire().await.unwrap().forget();
            running.fetch_sub(1, SeqCst);
            ActionResult::Succeeded { detail: None }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn no_more_than_two_runs_execute_at_once() {
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    let h = harness("gated");
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let engine = engine(
        &h,
        Registry::new().with_action(Gated { gate: Arc::clone(&gate), running: Arc::clone(&running), peak: Arc::clone(&peak) }),
    );

    let mut run_ids = Vec::new();
    for pr in 0..5 {
        run_ids.push(started(engine.submit(&h.automation_id, &format!("repo#{pr}@sha"), json!({})).await.unwrap()));
    }
    // Let the engine start as much as it is allowed to.
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while running.load(SeqCst) < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("two runs should start");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(running.load(SeqCst), 2, "a third run started while two were in flight");

    gate.add_permits(5);
    engine.drain().await;

    assert_eq!(peak.load(SeqCst), 2);
    for id in run_ids {
        assert_eq!(h.store.get_run(&id).unwrap().unwrap().status, RunStatus::Succeeded);
    }
}

struct Panics;
impl ActionKind for Panics {
    fn kind(&self) -> &str {
        "panics"
    }
    fn execute(&self, _ctx: ActionContext) -> BoxFuture<ActionResult> {
        Box::pin(async move { panic!("boom") })
    }
}

#[tokio::test]
async fn an_action_that_crashes_leaves_a_failed_run_not_a_stuck_one() {
    let h = harness("panics");
    let engine = engine(&h, Registry::new().with_action(Panics));

    let run_id = started(engine.submit(&h.automation_id, "k", json!({})).await.unwrap());
    engine.drain().await;

    let run = h.store.get_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.detail.unwrap().contains("crashed"));
}

#[tokio::test]
async fn an_automation_whose_action_kind_is_not_registered_fails_with_a_readable_reason() {
    let h = harness("pr_review");
    let engine = engine(&h, Registry::new().with_action(Echo));

    let run_id = started(engine.submit(&h.automation_id, "k", json!({})).await.unwrap());
    engine.drain().await;

    let run = h.store.get_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.detail.unwrap().contains("pr_review"));
}

#[tokio::test]
async fn submitting_to_an_automation_that_does_not_exist_is_an_error() {
    let h = harness("echo");
    let engine = engine(&h, Registry::new().with_action(Echo));

    let err = engine.submit("no-such-id", "k", json!({})).await.unwrap_err();

    assert!(matches!(err, lotus_automation::Error::UnknownAutomation(_)), "{err}");
}

/// Test action: stops to ask the user (PLAN §8 Q19 — the Ask lives in the engine, for any kind).
struct Asker;
impl ActionKind for Asker {
    fn kind(&self) -> &str {
        "asker"
    }
    fn execute(&self, _ctx: ActionContext) -> BoxFuture<ActionResult> {
        Box::pin(async move {
            ActionResult::Asked {
                subject: "Ticket runner".into(),
                question: "Approve these seams?\n\n- RLS on `jobs`".into(),
                choices: vec!["Approve".into(), "Reject".into()],
                origin: serde_json::Value::Null,
            }
        })
    }
}

#[tokio::test]
async fn a_run_that_asks_ends_as_asked_and_its_ask_waits_for_the_user() {
    let h = harness("asker");
    let engine = engine(&h, Registry::new().with_action(Asker));

    let run_id = started(engine.submit(&h.automation_id, "manual-1", json!({})).await.unwrap());
    engine.drain().await;

    let run = h.store.get_run(&run_id).unwrap().unwrap();
    assert_eq!(run.status, RunStatus::Asked);
    assert_eq!(run.detail.as_deref(), Some("asked: Approve these seams?"));
    let ask = h.store.draft_for_run(&run_id).unwrap().expect("the Ask is kept");
    assert_eq!(ask.kind, "ask");
    assert_eq!(ask.status, lotus_automation::DraftStatus::Pending, "it waits in the Inbox");
    assert_eq!(ask.content["question"], "Approve these seams?\n\n- RLS on `jobs`");
    assert_eq!(ask.content["choices"], json!(["Approve", "Reject"]));

    // Dismiss: closed, and no run starts.
    assert!(h.store.discard_draft(&ask.id, 600).unwrap().is_ok());
    assert_eq!(h.store.get_draft(&ask.id).unwrap().unwrap().status, lotus_automation::DraftStatus::Discarded);
    assert_eq!(h.store.list_runs(10).unwrap().len(), 1);
}

/// Test action: asks once, with what it worked on as the Ask's origin; records every payload.
#[derive(Default, Clone)]
struct AskerWithOrigin(Arc<std::sync::Mutex<Vec<serde_json::Value>>>);
impl ActionKind for AskerWithOrigin {
    fn kind(&self) -> &str {
        "asker"
    }
    fn execute(&self, ctx: ActionContext) -> BoxFuture<ActionResult> {
        self.0.lock().unwrap().push(ctx.payload.clone());
        Box::pin(async move {
            ActionResult::Asked { subject: "o/r#1".into(), question: "Which ticket?".into(), choices: vec![], origin: json!({ "repo": "o/r", "number": 1 }) }
        })
    }
}

/// PLAN §8 Q19: what an asking run worked on is kept with its Ask, reaches its Follow-up Run, and
/// stays with a chain — for any action kind.
#[tokio::test]
async fn an_asks_origin_is_kept_and_handed_to_its_follow_up() {
    let h = harness("asker");
    let seen = AskerWithOrigin::default();
    let engine = engine(&h, Registry::new().with_action(seen.clone()));
    let run_id = started(engine.submit(&h.automation_id, "manual-1", json!({})).await.unwrap());
    engine.drain().await;
    let ask = h.store.draft_for_run(&run_id).unwrap().unwrap();
    assert_eq!(ask.content["origin"], json!({ "repo": "o/r", "number": 1 }));

    let follow_up = lotus_automation::ask::answer_ask(&h.store, &engine, &ask.id, None, "TKT-7").await.unwrap();
    engine.drain().await;
    assert_eq!(seen.0.lock().unwrap()[1]["follow_up"]["origin"], json!({ "repo": "o/r", "number": 1 }));
    let next = h.store.draft_for_run(&follow_up).unwrap().unwrap();
    assert_eq!(next.content["origin"], json!({ "repo": "o/r", "number": 1 }), "the chain's next Ask keeps it");
}

// ---------- resume after a shutdown (2026-09-28) ----------

/// A run the last process claimed and never finished: queued with its payload, as the engine leaves it.
fn cut_off(h: &Harness, key: &str, payload: serde_json::Value) -> String {
    let lotus_automation::ClaimOutcome::Claimed(run) = h.store.claim_run(&h.automation_id, key, 100).unwrap() else { panic!() };
    h.store.set_run_payload(&run.id, &payload).unwrap();
    run.id
}

#[tokio::test]
async fn the_engine_keeps_each_runs_payload_so_it_can_be_run_again() {
    let h = harness("echo");
    let e = engine(&h, Registry::new().with_action(Echo));
    let id = started(e.submit(&h.automation_id, "k1", json!({ "say": "hi" })).await.unwrap());
    e.drain().await;
    assert_eq!(h.store.run_payload(&id).unwrap(), Some(json!({ "say": "hi" })));
}

#[tokio::test]
async fn a_run_cut_off_by_a_shutdown_runs_again_once_at_the_next_start() {
    let h = harness("echo");
    let first = cut_off(&h, "pr#1@sha", json!({ "say": "again" }));

    let resumable = h.store.reconcile_for_resume(200).unwrap();
    let e = engine(&h, Registry::new().with_action(Echo));
    assert_eq!(e.resume(resumable).await, 1);
    e.drain().await;

    let runs = h.store.list_runs(10).unwrap();
    let again = runs.iter().find(|r| r.run.id != first).expect("a new run");
    assert_eq!(again.run.status, RunStatus::Succeeded);
    assert_eq!(again.run.detail.as_deref(), Some("again"), "the same payload");
    assert_eq!(again.run.idempotency_key, "pr#1@sha");
    assert_eq!(h.store.get_run(&first).unwrap().unwrap().status, RunStatus::Interrupted, "history is kept");

    // Cut off again: not resumed a second time, so a run that kills Lotus cannot loop.
    h.store.mark_running(&again.run.id).unwrap();
    assert!(h.store.reconcile_for_resume(300).unwrap().is_empty());
}

#[tokio::test]
async fn a_run_is_not_resumed_when_its_automation_is_off_or_would_open_a_pane() {
    let h = harness("echo");
    cut_off(&h, "k-off", json!({}));
    h.store.set_enabled(&h.automation_id, false).unwrap();
    let e = engine(&h, Registry::new().with_action(Echo));
    assert_eq!(e.resume(h.store.reconcile_for_resume(200).unwrap()).await, 0);

    // A pane would open by itself as Lotus starts: that waits for the user instead.
    let pane = harness("echo");
    let a = pane.store.get_automation(&pane.automation_id).unwrap().unwrap();
    pane.store
        .replace_definition(
            &a.id,
            NewAutomation { name: a.name, trigger: a.trigger, action: Spec::new("echo", json!({ "open_pane": true })), outputs: vec![] },
        )
        .unwrap();
    cut_off(&pane, "k-pane", json!({}));
    let e = engine(&pane, Registry::new().with_action(Echo));
    assert_eq!(e.resume(pane.store.reconcile_for_resume(200).unwrap()).await, 0);
}

/// Test action: runs with the same lane as its payload's `lane`, holding its slot until the gate
/// opens, and records which lanes overlapped.
struct Laned {
    gate: Arc<tokio::sync::Semaphore>,
    running: Arc<std::sync::Mutex<Vec<String>>>,
    overlap: Arc<std::sync::atomic::AtomicBool>,
}
impl ActionKind for Laned {
    fn kind(&self) -> &str {
        "laned"
    }
    fn lane(&self, _automation: &lotus_automation::Automation, payload: &serde_json::Value) -> Option<String> {
        payload["lane"].as_str().map(str::to_string)
    }
    fn execute(&self, ctx: ActionContext) -> BoxFuture<ActionResult> {
        let (gate, running, overlap) = (Arc::clone(&self.gate), Arc::clone(&self.running), Arc::clone(&self.overlap));
        Box::pin(async move {
            let lane = ctx.payload["lane"].as_str().unwrap_or_default().to_string();
            {
                let mut now = running.lock().unwrap();
                if now.contains(&lane) {
                    overlap.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                now.push(lane.clone());
            }
            gate.acquire().await.unwrap().forget();
            running.lock().unwrap().retain(|l| l != &lane);
            ActionResult::Succeeded { detail: None }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_run_waiting_for_its_lane_does_not_hold_a_slot_other_work_needs() {
    let h = harness("laned");
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let running = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let overlap = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let engine = engine(
        &h,
        Registry::new().with_action(Laned { gate: Arc::clone(&gate), running: Arc::clone(&running), overlap: Arc::clone(&overlap) }),
    );

    // Two rounds of one PR, then another PR. Two slots in all.
    started(engine.submit(&h.automation_id, "a1", json!({ "lane": "pr-a" })).await.unwrap());
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    started(engine.submit(&h.automation_id, "a2", json!({ "lane": "pr-a" })).await.unwrap());
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    started(engine.submit(&h.automation_id, "b1", json!({ "lane": "pr-b" })).await.unwrap());

    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while running.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the other PR should start while the first PR's second round waits");
    assert_eq!(*running.lock().unwrap(), vec!["pr-a".to_string(), "pr-b".to_string()]);

    gate.add_permits(3);
    engine.drain().await;
    assert!(!overlap.load(std::sync::atomic::Ordering::SeqCst), "two runs of one lane ran at once");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_action_kind_with_its_own_pool_runs_up_to_its_limit_and_says_which_runs_wait() {
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
    let h = harness("gated");
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let running = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let engine = Engine::new(
        Arc::clone(&h.store),
        Registry::new().with_action(Gated { gate: Arc::clone(&gate), running: Arc::clone(&running), peak: Arc::clone(&peak) }),
        Arc::new(FixedClock(500)),
        EngineConfig { retry_delays: vec![], pools: vec![("gated".into(), 3)], ..EngineConfig::default() },
    );
    let mut events = engine.subscribe();

    let mut run_ids = Vec::new();
    for pr in 0..4 {
        run_ids.push(started(engine.submit(&h.automation_id, &format!("repo#{pr}@sha"), json!({})).await.unwrap()));
    }
    let queued: Vec<bool> = run_ids.iter().map(|id| engine.is_queued(id)).collect();
    assert_eq!(queued, vec![false, false, false, true], "three start at once, the fourth waits");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while running.load(SeqCst) < 3 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("three runs should start");
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert_eq!(running.load(SeqCst), 3, "a fourth run started past the pool's limit");

    gate.add_permits(4);
    engine.drain().await;
    assert_eq!(peak.load(SeqCst), 3);
    assert!(!engine.is_queued(&run_ids[3]));

    let mut seen = Vec::new();
    while let Ok(event) = events.try_recv() {
        seen.push(event);
    }
    for id in &run_ids {
        assert!(seen.contains(&lotus_automation::RunEvent::Started { run_id: id.clone() }));
        assert!(seen.contains(&lotus_automation::RunEvent::Finished { run_id: id.clone(), status: RunStatus::Succeeded, quiet: false }));
    }
}
