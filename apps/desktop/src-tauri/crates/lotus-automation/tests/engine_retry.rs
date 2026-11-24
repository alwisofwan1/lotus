//! Slice 07 (PLAN §2.6 Q27): a failed run is retried twice (30 s, then
//! 60 s); three failed runs in a row pause the automation and say so.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lotus_automation::{
    ActionContext, ActionKind, ActionResult, BoxFuture, Clock, Engine, EngineConfig, NewAutomation, Notifier,
    Registry, RunReport, RunStatus, Spec, Store,
};
use serde_json::json;

struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        500
    }
}

/// Fails its first `fail_first` executions, then succeeds. `skip` makes it skip instead.
struct Flaky {
    calls: Arc<AtomicUsize>,
    fail_first: usize,
    skip: bool,
}
impl ActionKind for Flaky {
    fn kind(&self) -> &str {
        "flaky"
    }
    fn execute(&self, _ctx: ActionContext) -> BoxFuture<ActionResult> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let (fail_first, skip) = (self.fail_first, self.skip);
        Box::pin(async move {
            if skip {
                ActionResult::Skipped { reason: "not for me".into() }
            } else if n < fail_first {
                ActionResult::Failed { error: format!("attempt {} broke", n + 1) }
            } else {
                ActionResult::Succeeded { detail: Some("fine".into()) }
            }
        })
    }
}

#[derive(Default)]
struct Reports(Mutex<Vec<RunReport>>);
impl Notifier for Reports {
    fn run_finished(&self, report: &RunReport) {
        self.0.lock().unwrap().push(report.clone());
    }
}

struct World {
    _dir: tempfile::TempDir,
    store: Arc<Store>,
    engine: Engine,
    automation_id: String,
    calls: Arc<AtomicUsize>,
    reports: Arc<Reports>,
}

fn world(fail_first: usize, skip: bool) -> World {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("automations.db")).unwrap());
    let automation = store
        .create_automation(
            NewAutomation {
                name: "Nightly".into(),
                trigger: Spec::new("manual", json!({})),
                action: Spec::new("flaky", json!({})),
                outputs: vec![],
            },
            1,
        )
        .unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let reports = Arc::new(Reports::default());
    let config = EngineConfig { retry_delays: vec![Duration::ZERO, Duration::ZERO], ..EngineConfig::default() };
    let engine = Engine::new(
        Arc::clone(&store),
        Registry::new().with_action(Flaky { calls: Arc::clone(&calls), fail_first, skip }),
        Arc::new(FixedClock),
        config,
    )
    .with_notifier(reports.clone());
    World { _dir: dir, store, engine, automation_id: automation.id, calls, reports }
}

async fn run(w: &World, key: &str) -> lotus_automation::Run {
    let id = match w.engine.submit(&w.automation_id, key, json!({})).await.unwrap() {
        lotus_automation::Submitted::Started { run_id } => run_id,
        other => panic!("{other:?}"),
    };
    w.engine.drain().await;
    w.store.get_run(&id).unwrap().unwrap()
}

#[test]
fn the_default_retry_waits_are_thirty_then_sixty_seconds_and_three_failures_pause() {
    let config = EngineConfig::default();
    assert_eq!(config.retry_delays, vec![Duration::from_secs(30), Duration::from_secs(60)]);
    assert_eq!(config.pause_after_failures, 3);
}

#[tokio::test]
async fn a_run_that_fails_once_is_tried_again_and_succeeds() {
    let w = world(1, false);
    let r = run(&w, "k1").await;
    assert_eq!(r.status, RunStatus::Succeeded);
    assert_eq!(w.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_run_that_keeps_failing_is_tried_three_times_and_says_so() {
    let w = world(usize::MAX, false);
    let r = run(&w, "k1").await;
    assert_eq!(r.status, RunStatus::Failed);
    assert_eq!(w.calls.load(Ordering::SeqCst), 3);
    let detail = r.detail.unwrap();
    assert!(detail.contains("attempt 3 broke") && detail.contains("3 attempts"), "{detail}");
}

#[tokio::test]
async fn a_skipped_run_is_not_retried() {
    let w = world(0, true);
    assert_eq!(run(&w, "k1").await.status, RunStatus::Skipped);
    assert_eq!(w.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn three_failed_runs_in_a_row_pause_the_automation_and_the_user_is_told() {
    let w = world(usize::MAX, false);
    run(&w, "k1").await;
    run(&w, "k2").await;
    assert!(w.store.get_automation(&w.automation_id).unwrap().unwrap().enabled, "two failures: still on");
    run(&w, "k3").await;

    assert!(!w.store.get_automation(&w.automation_id).unwrap().unwrap().enabled);
    let reports = w.reports.0.lock().unwrap();
    assert_eq!(reports.iter().map(|r| r.paused).collect::<Vec<_>>(), vec![false, false, true]);
}

#[tokio::test]
async fn a_success_between_failures_breaks_the_streak() {
    let w = world(usize::MAX, false);
    run(&w, "k1").await;
    run(&w, "k2").await;
    // One good run in between (recorded directly: this action always fails).
    let good = match w.store.claim_run(&w.automation_id, "good", 600).unwrap() {
        lotus_automation::ClaimOutcome::Claimed(run) => run,
        other => panic!("{other:?}"),
    };
    w.store.finish_run(&good.id, RunStatus::Succeeded, None, 600).unwrap();
    run(&w, "k3").await;
    assert!(w.store.get_automation(&w.automation_id).unwrap().unwrap().enabled, "the streak was broken");
}

#[tokio::test]
async fn failures_from_before_the_user_turned_it_back_on_do_not_count() {
    let w = world(usize::MAX, false);
    for key in ["k1", "k2", "k3"] {
        run(&w, key).await;
    }
    w.store.set_enabled(&w.automation_id, true).unwrap();
    run(&w, "k4").await;
    assert!(w.store.get_automation(&w.automation_id).unwrap().unwrap().enabled, "one fresh failure is not three");
}

/// Always fails with one fixed error (plans/automation-agent-health P1).
struct FailsWith(&'static str, Arc<AtomicUsize>);
impl ActionKind for FailsWith {
    fn kind(&self) -> &str {
        "flaky"
    }
    fn execute(&self, _ctx: ActionContext) -> BoxFuture<ActionResult> {
        self.1.fetch_add(1, Ordering::SeqCst);
        let error = self.0.to_string();
        Box::pin(async move { ActionResult::Failed { error } })
    }
}

fn failing_with(error: &'static str) -> World {
    let mut w = world(0, false);
    let config = EngineConfig { retry_delays: vec![Duration::ZERO, Duration::ZERO], ..EngineConfig::default() };
    w.engine = Engine::new(Arc::clone(&w.store), Registry::new().with_action(FailsWith(error, Arc::clone(&w.calls))), Arc::new(FixedClock), config)
        .with_notifier(w.reports.clone());
    w
}

#[tokio::test]
async fn a_failure_only_the_user_can_fix_is_not_tried_again() {
    for error in [
        "the agent failed: could not start ccs: No such file or directory (os error 2)",
        "the agent hit a temporary API error: Failed to authenticate: this login reached its time limit. Run `claude auth login`",
    ] {
        let w = failing_with(error);
        let r = run(&w, "k1").await;
        assert_eq!(w.calls.load(Ordering::SeqCst), 1, "{error}");
        assert!(!r.detail.unwrap().contains("attempts"));
    }
}

#[tokio::test]
async fn a_usage_limit_never_pauses_the_automation() {
    let w = failing_with("the agent hit an API error: You've hit your 5-hour limit · resets 3pm (Asia/Jakarta)");
    for key in ["k1", "k2", "k3", "k4"] {
        run(&w, key).await;
    }
    assert!(w.store.get_automation(&w.automation_id).unwrap().unwrap().enabled);
    let reports = w.reports.0.lock().unwrap();
    assert!(reports.iter().all(|r| !r.paused));
}
