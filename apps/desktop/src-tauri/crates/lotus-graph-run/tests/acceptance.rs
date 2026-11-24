//! F1 acceptance (plans/factory-run/issues/F1-rust-run-engine.md), one test or more per ac.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lotus_graph_run::{
    build_run_graph, run_spend, BoxFuture, CanvasEdge, CanvasNode, Engine, EngineConfig, GraphRunRecord, MemoryRunStore,
    NodeResult, RunChanged, RunDependency, RunEvents, RunGraph, RunStatus, RunStore, SqliteRunStore, StartError, StartRun,
    Step, StepRunner, SystemClock,
};
use tokio::sync::Notify;

// ---------- fake runner ----------

#[derive(Clone, Default)]
struct Plan {
    cost: Option<f64>,
    fail: bool,
    /// Waits for `FakeRunner::finish` before reporting.
    hold: bool,
    delay_ms: u64,
}

#[derive(Default)]
struct State {
    calls: Vec<String>,
    current: usize,
    peak: usize,
}

#[derive(Default)]
struct FakeRunner {
    plans: Mutex<HashMap<String, Plan>>,
    state: Arc<Mutex<State>>,
    gates: Mutex<HashMap<String, Arc<Notify>>>,
    started: Notify,
}

impl FakeRunner {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
    fn plan(self: &Arc<Self>, node: &str, plan: Plan) -> Arc<Self> {
        self.plans.lock().unwrap().insert(node.into(), plan);
        Arc::clone(self)
    }
    fn calls(&self) -> Vec<String> {
        self.state.lock().unwrap().calls.clone()
    }
    fn peak(&self) -> usize {
        self.state.lock().unwrap().peak
    }
    fn gate(&self, node: &str) -> Arc<Notify> {
        Arc::clone(self.gates.lock().unwrap().entry(node.into()).or_default())
    }
    fn finish(&self, node: &str) {
        self.gate(node).notify_one();
    }
    async fn wait_started(&self, node: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.started.notified();
                if self.calls().iter().any(|c| c == node) {
                    return;
                }
                notified.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{node} never started; calls = {:?}", self.calls()));
    }
}

impl StepRunner for FakeRunner {
    fn can_run(&self, _node_id: &str) -> bool {
        true
    }
    fn run(&self, step: Step) -> BoxFuture<NodeResult> {
        let plan = self.plans.lock().unwrap().get(&step.node_id).cloned().unwrap_or_default();
        {
            let mut s = self.state.lock().unwrap();
            s.calls.push(step.node_id.clone());
            s.current += 1;
            s.peak = s.peak.max(s.current);
        }
        self.started.notify_waiters();
        let gate = self.gate(&step.node_id);
        let state = Arc::clone(&self.state);
        Box::pin(async move {
            if plan.hold {
                gate.notified().await;
            }
            if plan.delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(plan.delay_ms)).await;
            }
            state.lock().unwrap().current -= 1;
            if plan.fail { NodeResult::failed(plan.cost) } else { NodeResult::completed(plan.cost) }
        })
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<(String, RunStatus)>>);

impl RunEvents for Events {
    fn changed(&self, event: RunChanged) {
        self.0.lock().unwrap().push((event.id, event.status));
    }
}

// ---------- helpers ----------

fn graph(ids: &[&str], deps: &[(&str, &str)]) -> RunGraph {
    RunGraph {
        node_ids: ids.iter().map(|s| s.to_string()).collect(),
        deps: deps.iter().map(|(f, t)| RunDependency { from: f.to_string(), to: t.to_string() }).collect(),
    }
}

fn start_req(g: RunGraph, cap: Option<f64>) -> StartRun {
    StartRun { project_id: "p".into(), graph: g, workflow_id: None, run: None, budget_cap: cap, factory: None }
}

fn engine(store: Arc<dyn RunStore>, runner: Arc<FakeRunner>, limit: usize, events: Option<Arc<dyn RunEvents>>) -> Engine {
    Engine::spawn(store, runner, events, Arc::new(SystemClock), EngineConfig { max_concurrent: limit })
}

async fn settled(engine: &Engine, id: &str) {
    tokio::time::timeout(Duration::from_secs(10), engine.settled(id)).await.expect("run did not settle");
}

fn record(store: &dyn RunStore, id: &str) -> GraphRunRecord {
    store.get(id).unwrap().expect("record")
}

fn cost(r: &GraphRunRecord) -> f64 {
    run_spend(&r.checkpoint).cost_usd.unwrap_or(0.0)
}

// ---------- ac1 ----------

#[tokio::test]
async fn ac1_two_scoped_runs_never_exceed_the_shared_limit_together() {
    let runner = FakeRunner::new();
    for n in ["a1", "a2", "a3", "b1", "b2", "b3"] {
        runner.plan(n, Plan { delay_ms: 30, ..Plan::default() });
    }
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 2, None);
    let a = e.start(start_req(graph(&["a1", "a2", "a3"], &[]), None)).await.unwrap();
    let b = e.start(start_req(graph(&["b1", "b2", "b3"], &[]), None)).await.unwrap();
    settled(&e, &a).await;
    settled(&e, &b).await;
    assert_eq!(runner.peak(), 2, "peak in flight across both runs");
    assert_eq!(runner.calls().len(), 6);
    assert_eq!(record(&*store, &a).status, RunStatus::Completed);
    assert_eq!(record(&*store, &b).status, RunStatus::Completed);
    let stats = e.stats().await;
    assert_eq!((stats.in_flight, stats.queued), (0, 0));
}

#[tokio::test]
async fn ac1_a_slot_freed_by_one_run_starts_the_other_runs_waiting_step() {
    let runner = FakeRunner::new()
        .plan("a1", Plan { hold: true, ..Plan::default() })
        .plan("b1", Plan { hold: true, ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store, runner.clone(), 1, None);
    let a = e.start(start_req(graph(&["a1"], &[]), None)).await.unwrap();
    let b = e.start(start_req(graph(&["b1"], &[]), None)).await.unwrap();
    runner.wait_started("a1").await;
    assert_eq!(runner.calls(), vec!["a1"], "b1 waits for the one slot");
    runner.finish("a1");
    runner.wait_started("b1").await;
    runner.finish("b1");
    settled(&e, &a).await;
    settled(&e, &b).await;
}

// ---------- ac2 ----------

#[tokio::test]
async fn ac2_cap_hit_stops_dispatch_lets_in_flight_finish_and_pauses() {
    // x and y in flight; x reports $1.10 on a $1.00 cap; z (after x) must never start;
    // y finishes and is recorded; only then the run pauses, with no end time.
    let runner = FakeRunner::new()
        .plan("x", Plan { cost: Some(1.10), hold: true, ..Plan::default() })
        .plan("y", Plan { cost: Some(0.05), hold: true, ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 2, None);
    let id = e.start(start_req(graph(&["x", "y", "z"], &[("x", "z")]), Some(1.0))).await.unwrap();
    runner.wait_started("x").await;
    runner.wait_started("y").await;
    runner.finish("x");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(record(&*store, &id).status, RunStatus::Running, "y still in flight");
    runner.finish("y");
    settled(&e, &id).await;
    let r = record(&*store, &id);
    assert_eq!(r.status, RunStatus::Paused);
    assert_eq!(r.ended_at, None);
    assert!(r.checkpoint.completed.contains_key("y"), "the in-flight step's result is kept");
    assert!(!runner.calls().contains(&"z".to_string()));
    assert!((cost(&r) - 1.15).abs() < 1e-9);
}

#[tokio::test]
async fn ac2_queued_steps_are_dropped_at_the_cap() {
    // One slot: a costs the cap; b and c were released by a and must not start.
    let runner = FakeRunner::new().plan("a", Plan { cost: Some(1.0), ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 1, None);
    let id = e.start(start_req(graph(&["a", "b", "c"], &[("a", "b"), ("a", "c")]), Some(1.0))).await.unwrap();
    settled(&e, &id).await;
    assert_eq!(runner.calls(), vec!["a"]);
    assert_eq!(record(&*store, &id).status, RunStatus::Paused);
    let stats = e.stats().await;
    assert_eq!((stats.in_flight, stats.queued), (0, 0));
}

#[tokio::test]
async fn ac2_a_step_already_waiting_for_a_slot_does_not_start_after_the_cap() {
    // One slot, two roots: y waits behind x. x reaches the cap; freeing x's slot must not start y.
    let runner = FakeRunner::new().plan("x", Plan { cost: Some(1.0), hold: true, ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 1, None);
    let id = e.start(start_req(graph(&["x", "y"], &[]), Some(1.0))).await.unwrap();
    runner.wait_started("x").await;
    assert_eq!(e.stats().await.queued, 1);
    runner.finish("x");
    settled(&e, &id).await;
    assert_eq!(runner.calls(), vec!["x"]);
    assert_eq!(record(&*store, &id).status, RunStatus::Paused);
}

#[tokio::test]
async fn ac2_a_run_resumed_at_its_cap_pauses_before_dispatching() {
    // Killed after the cap was reached but before "paused" was written: the record says running.
    let store = Arc::new(MemoryRunStore::new());
    let mut checkpoint = lotus_graph_run::Checkpoint::new(&graph(&["a", "b"], &[("a", "b")]));
    checkpoint.apply_completion("a", NodeResult::completed(Some(2.0)));
    checkpoint.engine =
        Some(lotus_graph_run::EngineMeta { kind: "rust".into(), budget_cap: Some(1.0), run: None, error: None, recovery: None, factory: None, progress: None, pr: None, intake: None, chief: None, pr_watch: None });
    let stuck = GraphRunRecord {
        id: "r".into(),
        project_id: "p".into(),
        workflow_id: None,
        status: RunStatus::Running,
        checkpoint,
        started_at: 1,
        ended_at: None,
        updated_at: 1,
    };
    store.save(&stuck).unwrap();
    let runner = FakeRunner::new();
    let e = engine(store.clone(), runner.clone(), 1, None);
    e.resume_interrupted().await.unwrap();
    settled(&e, "r").await;
    assert!(runner.calls().is_empty());
    assert_eq!(record(&*store, "r").status, RunStatus::Paused);
}

#[tokio::test]
async fn ac2_the_last_step_at_the_cap_completes_the_run() {
    let runner = FakeRunner::new().plan("a", Plan { cost: Some(5.0), ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner, 1, None);
    let id = e.start(start_req(graph(&["a"], &[]), Some(1.0))).await.unwrap();
    settled(&e, &id).await;
    let r = record(&*store, &id);
    assert_eq!(r.status, RunStatus::Completed);
    assert!(r.ended_at.is_some());
}

// ---------- ac3 ----------

#[tokio::test]
async fn ac3_one_raise_cap_is_always_enough_to_dispatch_the_next_step() {
    // Spend is 8x the cap: the old `cap x 1.5` rule needed 6 presses.
    let runner = FakeRunner::new().plan("a", Plan { cost: Some(0.08), ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 2, None);
    let id = e.start(start_req(graph(&["a", "b"], &[("a", "b")]), Some(0.01))).await.unwrap();
    settled(&e, &id).await;
    assert_eq!(record(&*store, &id).status, RunStatus::Paused);

    let cap = e.raise_cap(&id).await.unwrap();
    assert_eq!(cap, 0.12);
    settled(&e, &id).await;
    let r = record(&*store, &id);
    assert_eq!(r.status, RunStatus::Completed);
    assert_eq!(runner.calls(), vec!["a", "b"], "a is not run again");
    assert_eq!(r.checkpoint.engine.as_ref().unwrap().budget_cap, Some(0.12));
}

#[tokio::test]
async fn ac3_raise_cap_is_refused_on_a_run_that_is_not_paused() {
    let runner = FakeRunner::new().plan("a", Plan { hold: true, ..Plan::default() });
    let e = engine(Arc::new(MemoryRunStore::new()), runner.clone(), 1, None);
    let id = e.start(start_req(graph(&["a"], &[]), Some(1.0))).await.unwrap();
    runner.wait_started("a").await;
    assert!(e.raise_cap(&id).await.is_err());
    assert!(e.raise_cap("nope").await.is_err());
    runner.finish("a");
    settled(&e, &id).await;
}

// ---------- ac4 (real process kill: see ac4_kill_mid_run_then_restart_resumes) ----------

const PROBE_DB: &str = "LOTUS_GRAPH_RUN_PROBE_DB";
const PROBE_MARK: &str = "LOTUS_GRAPH_RUN_PROBE_MARK";

/// Runs only as the child of the ac4 test: a -> b -> c, where b never ends. It writes a marker
/// once b has started, then hangs until the parent kills the whole process.
#[tokio::test]
#[ignore = "child process of ac4_kill_mid_run_then_restart_resumes"]
async fn ac4_child_process() {
    let (Ok(db), Ok(mark)) = (std::env::var(PROBE_DB), std::env::var(PROBE_MARK)) else { return };
    struct Hang(String);
    impl StepRunner for Hang {
        fn can_run(&self, _: &str) -> bool {
            true
        }
        fn run(&self, step: Step) -> BoxFuture<NodeResult> {
            let mark = self.0.clone();
            Box::pin(async move {
                if step.node_id == "a" {
                    return NodeResult::completed(Some(0.25));
                }
                std::fs::write(&mark, &step.node_id).unwrap();
                tokio::time::sleep(Duration::from_secs(3600)).await;
                NodeResult::completed(None)
            })
        }
    }
    let store = Arc::new(SqliteRunStore::open(std::path::Path::new(&db)).unwrap());
    let e = Engine::spawn(store, Arc::new(Hang(mark)), None, Arc::new(SystemClock), EngineConfig { max_concurrent: 2 });
    e.start(start_req(graph(&["a", "b", "c"], &[("a", "b"), ("b", "c")]), Some(5.0))).await.unwrap();
    tokio::time::sleep(Duration::from_secs(3600)).await;
}

#[tokio::test]
async fn ac4_kill_mid_run_then_restart_resumes() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("codecanvas.sqlite3");
    let mark = dir.path().join("started");

    // A TS-owned record and a finished Rust run sit beside it; neither may be resumed.
    {
        let store = SqliteRunStore::open(&db).unwrap();
        let mut ts: GraphRunRecord = serde_json::from_value(serde_json::json!({
            "id": "ts-run", "projectId": "p", "status": "running",
            "checkpoint": {"nodeIds": ["q"], "deps": [], "completed": {}, "failed": [], "pending": ["q"], "blocked": []},
            "startedAt": 1, "endedAt": null, "updatedAt": 1
        }))
        .unwrap();
        store.save(&ts).unwrap();
        ts.id = "ts-run-2".into();
        store.save(&ts).unwrap();
    }

    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["ac4_child_process", "--exact", "--ignored", "--nocapture", "--test-threads=1"])
        .env(PROBE_DB, &db)
        .env(PROBE_MARK, &mark)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !mark.exists() {
        assert!(std::time::Instant::now() < deadline, "child never reached step b");
        assert!(child.try_wait().unwrap().is_none(), "child exited early");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    child.kill().unwrap(); // SIGKILL: no destructor, no last write
    child.wait().unwrap();

    let store = Arc::new(SqliteRunStore::open(&db).unwrap());
    let unfinished = store.list_unfinished().unwrap();
    let killed = unfinished.iter().find(|r| r.is_rust_owned()).expect("the killed run's record").clone();
    assert_eq!(killed.status, RunStatus::Running);
    assert!(killed.checkpoint.completed.contains_key("a"));
    assert_eq!(killed.checkpoint.pending, vec!["b", "c"]);

    // Restart: a fresh engine on the same database resumes on its own.
    let runner = FakeRunner::new().plan("b", Plan { cost: Some(0.5), ..Plan::default() });
    let e = engine(store.clone(), runner.clone(), 2, None);
    let resumed = e.resume_interrupted().await.unwrap();
    assert_eq!(resumed, vec![killed.id.clone()], "only the Rust-owned run");
    settled(&e, &killed.id).await;
    let r = record(&*store, &killed.id);
    assert_eq!(runner.calls(), vec!["b", "c"], "a is not run again");
    assert_eq!(r.status, RunStatus::Completed);
    assert!((cost(&r) - 0.75).abs() < 1e-9, "a's cost from before the kill is kept");
    assert_eq!(r.checkpoint.engine.as_ref().unwrap().budget_cap, Some(5.0));
    assert_eq!(record(&*store, "ts-run").status, RunStatus::Running, "the TS run is left alone");
}

#[tokio::test]
async fn ac4_a_paused_run_stays_paused_after_restart_and_raise_cap_resumes_it() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db.sqlite3");
    let id = {
        let store = Arc::new(SqliteRunStore::open(&db).unwrap());
        let runner = FakeRunner::new().plan("a", Plan { cost: Some(2.0), ..Plan::default() });
        let e = engine(store, runner, 1, None);
        let id = e.start(start_req(graph(&["a", "b"], &[("a", "b")]), Some(1.0))).await.unwrap();
        settled(&e, &id).await;
        id
    };
    let store = Arc::new(SqliteRunStore::open(&db).unwrap());
    let runner = FakeRunner::new();
    let e = engine(store.clone(), runner.clone(), 1, None);
    assert_eq!(e.resume_interrupted().await.unwrap(), Vec::<String>::new(), "a paused run waits for the user");
    assert!(runner.calls().is_empty());
    assert_eq!(e.raise_cap(&id).await.unwrap(), 3.0);
    settled(&e, &id).await;
    assert_eq!(runner.calls(), vec!["b"]);
    assert_eq!(record(&*store, &id).status, RunStatus::Completed);
}

#[tokio::test]
async fn factory_restart_requires_recovery_instead_of_dispatching_pending_steps() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("recovery.sqlite3");
    let saved: GraphRunRecord = serde_json::from_value(serde_json::json!({
        "id":"interrupted-factory", "projectId":"p", "status":"running",
        "checkpoint": {"nodeIds":["build"],"deps":[],"completed":{},"failed":[],"pending":["build"],"blocked":[],
            "engine":{"kind":"rust","budgetCap":2,"factory":{"repo":"o/r","issue":7,"title":"Build","body":"","account":"me","checkout":"/checkout","base":"main"}}},
        "startedAt":1,"endedAt":null,"updatedAt":1
    })).unwrap();
    SqliteRunStore::open(&db).unwrap().save(&saved).unwrap();
    let store = Arc::new(SqliteRunStore::open(&db).unwrap());
    let runner = FakeRunner::new().plan("build", Plan { hold: true, ..Plan::default() });
    let e = engine(store.clone(), runner.clone(), 1, None);
    let mut duplicate = start_req(graph(&["build"], &[]), Some(2.0));
    duplicate.factory = saved.checkpoint.engine.as_ref().unwrap().factory.clone();
    assert!(e.start(duplicate).await.is_err(), "startup admission must see persisted unfinished runs before reconciliation");
    assert!(e.resume_interrupted().await.unwrap().is_empty());
    let held = record(&*store, &saved.id);
    assert_eq!(held.status, RunStatus::Paused);
    assert!(serde_json::to_value(&held.checkpoint.engine).unwrap()["recovery"].is_string());
    assert_eq!(held.checkpoint.pending, saved.checkpoint.pending);
    assert!(runner.calls().is_empty());
    assert!(e.raise_cap(&saved.id).await.is_err(), "budget controls cannot bypass recovery");
    assert!(e.decide(&saved.id, lotus_graph_run::intake::IntakeDecision::Approve(None)).await.is_err());
    assert!(e.resume_interrupted().await.unwrap().is_empty());
    e.abort(&saved.id).await.unwrap();
    assert_eq!(record(&*store, &saved.id).status, RunStatus::Cancelled);
    assert!(runner.calls().is_empty());
}

// ---------- ac5 ----------

#[tokio::test]
async fn ac5_a_failed_steps_cost_is_in_the_spend_and_trips_the_cap() {
    // a fails (a Critic saying no) after spending $1.20 on a $1.00 cap. A failed non-gate step
    // still releases its dependents, so b would run if the failed cost were not counted.
    let runner = FakeRunner::new().plan("a", Plan { cost: Some(1.20), fail: true, ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 1, None);
    let id = e.start(start_req(graph(&["a", "b"], &[("a", "b")]), Some(1.0))).await.unwrap();
    settled(&e, &id).await;
    let r = record(&*store, &id);
    assert_eq!(runner.calls(), vec!["a"]);
    assert_eq!(r.status, RunStatus::Paused);
    assert!((cost(&r) - 1.20).abs() < 1e-9);
}

#[tokio::test]
async fn ac5_every_attempt_counts_when_a_failed_step_runs_again() {
    // a fails ($0.60, cap $0.50) -> paused. Raise cap re-runs a (only completed steps are
    // skipped, as in the TS engine); it fails again for $0.70. The spend keeps both attempts.
    let runner = FakeRunner::new().plan("a", Plan { cost: Some(0.60), fail: true, ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 1, None);
    let id = e.start(start_req(graph(&["a", "b"], &[("a", "b")]), Some(0.5))).await.unwrap();
    settled(&e, &id).await;
    runner.plan("a", Plan { cost: Some(0.70), fail: true, ..Plan::default() });
    assert_eq!(e.raise_cap(&id).await.unwrap(), 0.9);
    settled(&e, &id).await;
    let r = record(&*store, &id);
    assert_eq!(runner.calls(), vec!["a", "a"]);
    assert!((cost(&r) - 1.30).abs() < 1e-9, "both failed attempts: {}", cost(&r));
    assert_eq!(r.status, RunStatus::Paused);
}

// ---------- ac6 ----------

#[tokio::test]
async fn ac6_non_members_are_never_dispatched() {
    let nodes = [("a", "agent"), ("b", "agent"), ("outside", "agent")]
        .map(|(id, t)| CanvasNode { id: id.into(), node_type: t.into() });
    let edges = [("a", "b"), ("b", "outside")]
        .map(|(s, t)| CanvasEdge { source: s.into(), target: t.into(), wire_kind: Some("triggers".into()) });
    let scope: HashSet<String> = ["a", "b"].map(String::from).into();
    let runner = FakeRunner::new();
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 4, None);
    let id = e.start(start_req(build_run_graph(&nodes, &edges, Some(&scope)), None)).await.unwrap();
    settled(&e, &id).await;
    assert_eq!(runner.calls(), vec!["a", "b"]);
    assert_eq!(record(&*store, &id).checkpoint.node_ids, vec!["a", "b"]);
}

#[tokio::test]
async fn ac6_a_node_is_in_at_most_one_live_run() {
    let runner = FakeRunner::new().plan("a", Plan { hold: true, ..Plan::default() });
    let e = engine(Arc::new(MemoryRunStore::new()), runner.clone(), 4, None);
    let first = e.start(start_req(graph(&["a", "b"], &[]), None)).await.unwrap();
    runner.wait_started("a").await;
    let err = e.start(start_req(graph(&["c", "a"], &[]), None)).await.unwrap_err();
    assert_eq!(err, StartError::MemberBusy(vec!["a".into()]));
    runner.finish("a");
    settled(&e, &first).await;
    let second = e.start(start_req(graph(&["c", "a"], &[]), None)).await.unwrap();
    runner.finish("a");
    settled(&e, &second).await;
}

#[tokio::test]
async fn ac6_start_refuses_empty_cyclic_and_unrunnable_graphs() {
    struct Picky;
    impl StepRunner for Picky {
        fn can_run(&self, node_id: &str) -> bool {
            node_id != "ghost"
        }
        fn run(&self, _: Step) -> BoxFuture<NodeResult> {
            Box::pin(async { NodeResult::completed(None) })
        }
    }
    let store = Arc::new(MemoryRunStore::new());
    let e = Engine::spawn(store.clone(), Arc::new(Picky), None, Arc::new(SystemClock), EngineConfig { max_concurrent: 1 });
    assert_eq!(e.start(start_req(graph(&[], &[]), None)).await.unwrap_err(), StartError::Empty);
    assert_eq!(
        e.start(start_req(graph(&["a", "b"], &[("a", "b"), ("b", "a")]), None)).await.unwrap_err(),
        StartError::Cycle(vec!["a".into(), "b".into()])
    );
    assert_eq!(
        e.start(start_req(graph(&["a", "ghost"], &[]), None)).await.unwrap_err(),
        StartError::MissingRunner(vec!["ghost".into()])
    );
    assert!(store.all().is_empty(), "a refused start writes no record");
}

// ---------- ac7 ----------

#[tokio::test]
async fn ac7_runs_continue_with_no_ui_connected() {
    // No event sink at all: nothing listens, nothing polls. The run still finishes and is on disk.
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(SqliteRunStore::open(&dir.path().join("db.sqlite3")).unwrap());
    let runner = FakeRunner::new();
    let e = engine(store.clone(), runner.clone(), 2, None);
    let id = e.start(start_req(graph(&["a", "b", "c"], &[("a", "b"), ("b", "c")]), None)).await.unwrap();
    settled(&e, &id).await;
    assert_eq!(runner.calls(), vec!["a", "b", "c"]);
    assert_eq!(record(&*store, &id).status, RunStatus::Completed);
}

#[tokio::test]
async fn ac7_a_connected_ui_hears_each_change_and_reads_the_record() {
    let events = Arc::new(Events::default());
    let runner = FakeRunner::new().plan("a", Plan { cost: Some(2.0), ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner, 1, Some(events.clone()));
    let id = e.start(start_req(graph(&["a", "b"], &[("a", "b")]), Some(1.0))).await.unwrap();
    settled(&e, &id).await;
    let seen = events.0.lock().unwrap().clone();
    assert!(seen.iter().all(|(run, _)| run == &id));
    assert_eq!(seen.first().map(|s| s.1), Some(RunStatus::Running));
    assert_eq!(seen.last().map(|s| s.1), Some(RunStatus::Paused));
    assert_eq!(record(&*store, &id).status, RunStatus::Paused, "the event and the record agree");
}

#[tokio::test]
async fn abort_cancels_the_run_and_frees_its_slots() {
    let runner = FakeRunner::new()
        .plan("a", Plan { hold: true, ..Plan::default() })
        .plan("x", Plan { hold: true, ..Plan::default() });
    let store = Arc::new(MemoryRunStore::new());
    let e = engine(store.clone(), runner.clone(), 1, None);
    let id = e.start(start_req(graph(&["a", "b"], &[("a", "b")]), None)).await.unwrap();
    let other = e.start(start_req(graph(&["x"], &[]), None)).await.unwrap();
    runner.wait_started("a").await;
    e.abort(&id).await.unwrap();
    runner.wait_started("x").await; // a's slot went to the other run
    let r = record(&*store, &id);
    assert_eq!(r.status, RunStatus::Cancelled);
    assert!(r.ended_at.is_some());
    runner.finish("a"); // a late result of an aborted run changes nothing
    runner.finish("x");
    settled(&e, &other).await;
    assert_eq!(record(&*store, &id).status, RunStatus::Cancelled);
    assert!(!runner.calls().contains(&"b".to_string()));
}
