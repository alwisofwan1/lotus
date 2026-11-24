//! The engine: one actor task owns every run, the shared slot pool and the store writes.
//!
//! Port of `graph-run-session.ts`. The TS session is single-threaded and reacts to one result at a
//! time; the actor keeps exactly that shape (one message at a time, no locks around run state), so
//! the order rules the TS code depends on carry over unchanged:
//! - a failed Critic blocks its descendants BEFORE it is completed, so they are never released;
//! - the cap check runs BEFORE the finished step's slot is freed, so a queued sibling cannot start;
//! - the freed slot is handed on BEFORE newly released steps are submitted (FIFO across runs).
//!
//! Steps run as their own tasks and report back as messages, so nothing here waits on an agent.
//! Nothing here needs a webview either: the UI reads the record and may listen to [`RunEvents`].

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use tokio::sync::{mpsc, oneshot};

use crate::graph::{RunGraph, Scheduler};
use crate::record::{
    derive_status, normalize_budget_cap, raised_budget_cap, run_spend, Checkpoint, ChiefEntry, ChiefOfStaffLog, EngineMeta, FactoryTicket, Gate, GraphRunRecord,
    NodeResult, Outcome, RunBrief, RunStatus, ENGINE_KIND_RUST,
};
use crate::intake::{Intake, IntakeDecision};
use crate::progress::{apply_progress, close_progress, ProgressEvent, ProgressSink};
use crate::slots::SlotPool;
use crate::store::RunStore;

pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// One step handed to a [`StepRunner`].
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub graph_run_id: String,
    pub node_id: String,
    /// The members this step waited for (their reports are its input).
    pub upstream_ids: Vec<String>,
    pub run: Option<RunBrief>,
    /// The ticket of a Factory Run.
    pub factory: Option<FactoryTicket>,
    /// USD the run may still spend before its cap; `None` = no cap. A step with several attempts
    /// stops before an attempt it can no longer pay for.
    pub budget_left: Option<f64>,
    /// Where the step reports its stages; the engine saves them into the record.
    pub progress: ProgressSink,
    /// A Factory Run's questions, answers and spec so far (FI2).
    pub intake: Option<Intake>,
}

/// Runs one step to its end and reports its result. F2 brings the real one (worktree, implementer,
/// Check); the engine only needs this shape.
pub trait StepRunner: Send + Sync {
    /// False = no runner for this node; a run that needs it is refused or fails, never hangs.
    fn can_run(&self, node_id: &str) -> bool;
    /// Checked at start, before anything is written and before the actor hears of the run (so a
    /// slow check never blocks other runs): `Err(why)` refuses it ([`StartError::Refused`]).
    fn admit(&self, _req: &StartRun) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    /// The run was aborted: stop its step if one is running. Must not block.
    fn cancel(&self, _graph_run_id: &str) {}
    fn run(&self, step: Step) -> BoxFuture<NodeResult>;
}

/// Sent after every record write. The record in the store stays the truth: a UI that hears this
/// reads the record again, and a UI that was closed reads it when it opens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunChanged {
    pub id: String,
    pub project_id: String,
    pub status: RunStatus,
}

pub trait RunEvents: Send + Sync {
    fn changed(&self, event: RunChanged);
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Steps in flight at once, across every run.
    pub max_concurrent: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self { max_concurrent: SlotPool::host_limit() }
    }
}

#[derive(Debug, Clone)]
pub struct StartRun {
    pub project_id: String,
    pub graph: RunGraph,
    /// `run-node:<id>` for a Run Node, as the TS engine files it.
    pub workflow_id: Option<String>,
    pub run: Option<RunBrief>,
    /// USD. Kept in whole cents; under a cent or invalid = no cap.
    pub budget_cap: Option<f64>,
    /// Set for a Factory Run: the ticket it works on.
    pub factory: Option<FactoryTicket>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StartError {
    #[error("refused: {0}")]
    Refused(String),
    #[error("the run has no runnable nodes")]
    Empty,
    #[error("dependency cycle between {0:?}")]
    Cycle(Vec<String>),
    #[error("no runner for {0:?}")]
    MissingRunner(Vec<String>),
    #[error("already in another run: {0:?}")]
    MemberBusy(Vec<String>),
    #[error("store: {0}")]
    Store(String),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecisionError {
    #[error("no live or paused run {0}")]
    UnknownRun(String),
    #[error("the run is not paused at its cap")]
    NotPaused,
    #[error("the run is not waiting for you")]
    NotWaiting,
    #[error("{0}")]
    Invalid(String),
    #[error("store: {0}")]
    Store(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineStats {
    pub in_flight: usize,
    pub queued: usize,
    pub live_runs: usize,
}

enum Msg {
    Start(StartRun, oneshot::Sender<Result<String, StartError>>),
    StepDone { run_id: String, node_id: String, result: NodeResult },
    Progress { run_id: String, node_id: String, event: ProgressEvent },
    RaiseCap(String, oneshot::Sender<Result<f64, DecisionError>>),
    Abort(String, oneshot::Sender<Result<(), DecisionError>>),
    Decide(String, IntakeDecision, oneshot::Sender<Result<(), DecisionError>>),
    Resume(oneshot::Sender<Result<Vec<String>, String>>),
    WhenSettled(String, oneshot::Sender<()>),
    Stats(oneshot::Sender<EngineStats>),
    Chief(String, ChiefEntry, oneshot::Sender<Result<bool, DecisionError>>),
}

/// Handle to the engine. Cheap to share behind an `Arc`; dropping the last one stops the actor
/// once its in-flight steps report (their results are then discarded).
pub struct Engine {
    tx: mpsc::UnboundedSender<Msg>,
    runner: Arc<dyn StepRunner>,
}

impl Engine {
    /// Starts the actor on the current tokio runtime.
    pub fn spawn(
        store: Arc<dyn RunStore>,
        runner: Arc<dyn StepRunner>,
        events: Option<Arc<dyn RunEvents>>,
        clock: Arc<dyn Clock>,
        config: EngineConfig,
    ) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let actor = Actor {
            store,
            runner: Arc::clone(&runner),
            events,
            clock,
            done_tx: tx.downgrade(),
            pool: SlotPool::new(config.max_concurrent),
            runs: HashMap::new(),
            waiters: HashMap::new(),
        };
        tokio::spawn(actor.run(rx));
        Self { tx, runner }
    }

    pub async fn start(&self, req: StartRun) -> Result<String, StartError> {
        // Outside the actor: admitting may take a network round trip.
        self.runner.admit(&req).await.map_err(StartError::Refused)?;
        self.ask(|reply| Msg::Start(req, reply)).await.unwrap_or_else(|| Err(StartError::Store("engine stopped".into())))
    }

    /// Raise cap: `max(cap, spent) × 1.5` in whole cents, then continue from the checkpoint.
    /// Only for a run paused at its cap. Returns the new cap.
    pub async fn raise_cap(&self, id: &str) -> Result<f64, DecisionError> {
        let id = id.to_string();
        self.ask(|reply| Msg::RaiseCap(id, reply)).await.unwrap_or_else(|| Err(DecisionError::Store("engine stopped".into())))
    }

    /// Ends a live or paused run as `cancelled`. A running step is told to stop
    /// ([`StepRunner::cancel`]); whatever it reports is discarded and its slot goes to other runs now.
    pub async fn abort(&self, id: &str) -> Result<(), DecisionError> {
        let id = id.to_string();
        let ended = self
            .ask(|reply| Msg::Abort(id.clone(), reply))
            .await
            .unwrap_or_else(|| Err(DecisionError::Store("engine stopped".into())));
        if ended.is_ok() {
            self.runner.cancel(&id);
        }
        ended
    }

    /// The user's answer, approval, send-back or saved spec for a run `waiting` for them (FI2).
    /// All but a saved spec continue the run; a saved spec keeps it waiting, for its approval.
    pub async fn decide(&self, id: &str, decision: IntakeDecision) -> Result<(), DecisionError> {
        let id = id.to_string();
        self.ask(|reply| Msg::Decide(id, decision, reply)).await.unwrap_or_else(|| Err(DecisionError::Store("engine stopped".into())))
    }

    /// Reconciles unfinished records: interrupted Factory work is held for inspection; other
    /// Rust running runs continue. Ordinary pauses/intake waits remain explicit user decisions.
    /// Records of the TS engine are left alone.
    /// Returns the ids that continued.
    pub async fn resume_interrupted(&self) -> Result<Vec<String>, String> {
        self.ask(Msg::Resume).await.unwrap_or_else(|| Err("engine stopped".into()))
    }

    /// Resolves once the run is not live: finished, failed, cancelled, paused, or unknown.
    pub async fn settled(&self, id: &str) {
        let id = id.to_string();
        let _ = self.ask(|reply| Msg::WhenSettled(id, reply)).await;
    }

    /// Writes one Chief of Staff note on a run's record (ADR-0056 §3): through the actor, so it is
    /// never lost to the engine's own copy of a live or paused run. True when it changed the record;
    /// false when the signal already was raised (or cleared).
    pub async fn chief_note(&self, id: &str, entry: ChiefEntry) -> Result<bool, DecisionError> {
        let id = id.to_string();
        self.ask(|reply| Msg::Chief(id, entry, reply)).await.unwrap_or_else(|| Err(DecisionError::Store("engine stopped".into())))
    }

    pub async fn stats(&self) -> EngineStats {
        self.ask(Msg::Stats).await.unwrap_or(EngineStats { in_flight: 0, queued: 0, live_runs: 0 })
    }

    async fn ask<T>(&self, msg: impl FnOnce(oneshot::Sender<T>) -> Msg) -> Option<T> {
        let (reply, answer) = oneshot::channel();
        self.tx.send(msg(reply)).ok()?;
        answer.await.ok()
    }
}

/// Whether an unfinished run `old` holds the ticket `new` wants to start: the same repo and
/// ticket, or (a meta-repo run, AC-11) the same ticket anywhere under the same workspace, however
/// triage routed either.
fn same_ticket_target(old: &FactoryTicket, new: &FactoryTicket) -> bool {
    if old.reference().eq_ignore_ascii_case(&new.reference()) && old.repo.eq_ignore_ascii_case(&new.repo) {
        return true;
    }
    let (Some(a), Some(b)) = (old.workspace.as_deref(), new.workspace.as_deref()) else { return false };
    let key = |t: &FactoryTicket| t.notion.as_ref().map(|n| n.key.to_ascii_lowercase());
    a == b && key(old).is_some() && key(old) == key(new)
}

struct Run {
    record: GraphRunRecord,
    scheduler: Scheduler,
    members: HashSet<String>,
    /// False once paused at the cap: kept only so Raise cap and Abort can find it.
    live: bool,
    /// The cap was reached: nothing new is dispatched; the run pauses when its last step reports.
    capped: bool,
    /// A step waits for the user: nothing new is dispatched; the run waits once nothing runs.
    waiting: bool,
}

struct Actor {
    store: Arc<dyn RunStore>,
    runner: Arc<dyn StepRunner>,
    events: Option<Arc<dyn RunEvents>>,
    clock: Arc<dyn Clock>,
    /// Weak, so the actor does not keep its own channel open forever.
    done_tx: mpsc::WeakUnboundedSender<Msg>,
    pool: SlotPool,
    runs: HashMap<String, Run>,
    waiters: HashMap<String, Vec<oneshot::Sender<()>>>,
}

impl Actor {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Msg>) {
        while let Some(msg) = rx.recv().await {
            match msg {
                Msg::Start(req, reply) => {
                    let _ = reply.send(self.start(req));
                }
                Msg::StepDone { run_id, node_id, result } => self.step_done(&run_id, &node_id, result),
                Msg::Progress { run_id, node_id, event } => self.progress(&run_id, &node_id, event),
                Msg::RaiseCap(id, reply) => {
                    let _ = reply.send(self.raise_cap(&id));
                }
                Msg::Abort(id, reply) => {
                    let _ = reply.send(self.abort(&id));
                }
                Msg::Decide(id, decision, reply) => {
                    let _ = reply.send(self.decide(&id, decision));
                }
                Msg::Resume(reply) => {
                    let _ = reply.send(self.resume_interrupted());
                }
                Msg::WhenSettled(id, reply) => {
                    if self.runs.get(&id).is_some_and(|r| r.live) {
                        self.waiters.entry(id).or_default().push(reply);
                    } else {
                        let _ = reply.send(());
                    }
                }
                Msg::Chief(id, entry, reply) => {
                    let _ = reply.send(self.chief_note(&id, entry));
                }
                Msg::Stats(reply) => {
                    let _ = reply.send(EngineStats {
                        in_flight: self.pool.in_flight(),
                        queued: self.pool.queued(),
                        live_runs: self.runs.values().filter(|r| r.live).count(),
                    });
                }
            }
        }
    }

    // ---------- starting ----------

    fn start(&mut self, req: StartRun) -> Result<String, StartError> {
        let graph = req.graph;
        if graph.node_ids.is_empty() {
            return Err(StartError::Empty);
        }
        if let Some(ticket) = &req.factory {
            // Startup reconciliation is asynchronous: persisted unfinished work owns its ticket
            // even before it appears in the actor's in-memory runs.
            let unfinished = self.store.list_unfinished().map_err(|_| StartError::Refused("Cannot verify unfinished Factory runs; start was refused".into()))?;
            if unfinished.iter().filter(|r| r.is_rust_owned()).any(|r| r.checkpoint.engine.as_ref().and_then(|meta| meta.factory.as_ref()).is_some_and(|old| same_ticket_target(old, ticket))) {
                return Err(StartError::Refused("This ticket has an unfinished Factory run. Inspect or finish it before starting another".into()));
            }
        }
        // A node belongs to at most one run: a live or paused run still owns its members.
        let mut busy: Vec<String> =
            graph.node_ids.iter().filter(|id| self.runs.values().any(|r| r.members.contains(*id))).cloned().collect();
        if !busy.is_empty() {
            busy.sort();
            return Err(StartError::MemberBusy(busy));
        }
        let mut scheduler = Scheduler::new(&graph, &[]);
        let roots = scheduler.start();
        if roots.is_empty() {
            return Err(StartError::Cycle(scheduler.pending()));
        }
        let missing: Vec<String> = graph.node_ids.iter().filter(|id| !self.runner.can_run(id)).cloned().collect();
        if !missing.is_empty() {
            return Err(StartError::MissingRunner(missing));
        }

        let now = self.clock.now_ms();
        let mut checkpoint = Checkpoint::new(&graph);
        checkpoint.engine = Some(EngineMeta {
            kind: ENGINE_KIND_RUST.into(),
            budget_cap: req.budget_cap.and_then(normalize_budget_cap),
            run: req.run,
            error: None,
            recovery: None,
            factory: req.factory,
            progress: None,
            pr: None,
            intake: None,
            chief: None,
            pr_watch: None,
        });
        let record = GraphRunRecord {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: req.project_id,
            workflow_id: req.workflow_id,
            status: RunStatus::Running,
            checkpoint,
            started_at: now,
            ended_at: None,
            updated_at: now,
        };
        self.store.save(&record).map_err(|e| StartError::Store(e.to_string()))?;
        self.emit(&record);
        let id = record.id.clone();
        self.insert_live(record, scheduler);
        self.begin(&id, roots);
        Ok(id)
    }

    /// Continues an authorized stored run from its checkpoint: completed steps are not dispatched again
    /// (failed ones are, as in the TS engine).
    fn resume(&mut self, mut record: GraphRunRecord) {
        let graph = record.checkpoint.graph();
        let seed: Vec<String> = record.checkpoint.completed.keys().cloned().collect();
        let mut scheduler = Scheduler::new(&graph, &seed);
        let roots = scheduler.start();
        let now = self.clock.now_ms();
        if scheduler.is_done() {
            let status = derive_status(&record.checkpoint);
            record.status = status;
            record.ended_at = (status != RunStatus::Running).then_some(now);
            record.updated_at = now;
            self.save(&record);
            return;
        }
        let problem = if roots.is_empty() {
            Some(format!("dependency cycle between {:?}", scheduler.pending()))
        } else {
            let missing: Vec<String> = scheduler.pending().into_iter().filter(|id| !self.runner.can_run(id)).collect();
            (!missing.is_empty()).then(|| format!("no runner for {missing:?}"))
        };
        if let Some(problem) = problem {
            Self::set_error(&mut record, &problem);
            record.status = RunStatus::Error;
            record.ended_at = Some(now);
            record.updated_at = now;
            self.save(&record);
            return;
        }
        record.status = RunStatus::Running;
        record.ended_at = None;
        record.updated_at = now;
        self.save(&record);
        let id = record.id.clone();
        self.insert_live(record, scheduler);
        self.begin(&id, roots);
    }

    fn insert_live(&mut self, record: GraphRunRecord, scheduler: Scheduler) {
        let members = record.checkpoint.node_ids.iter().cloned().collect();
        self.runs.insert(record.id.clone(), Run { record, scheduler, members, live: true, capped: false, waiting: false });
    }

    fn begin(&mut self, run_id: &str, roots: Vec<String>) {
        // Resumed without enough headroom: stop again before anything starts.
        if self.over_budget(run_id) {
            self.pause(run_id);
            return;
        }
        for node in roots {
            if !self.is_live(run_id) {
                return;
            }
            self.submit(run_id, &node);
        }
    }

    // ---------- dispatch ----------

    fn submit(&mut self, run_id: &str, node_id: &str) {
        if self.pool.submit(run_id, node_id) {
            self.start_step(run_id, node_id);
        }
    }

    /// The slot is already claimed. A step that cannot start gives it back and fails its run.
    fn start_step(&mut self, run_id: &str, node_id: &str) {
        let Some(run) = self.runs.get(run_id) else {
            self.pool.refuse(run_id, node_id);
            return;
        };
        if !self.runner.can_run(node_id) {
            self.pool.refuse(run_id, node_id);
            self.fail(run_id, &format!("no runner for [\"{node_id}\"]"));
            return;
        }
        let step = Step {
            graph_run_id: run_id.to_string(),
            node_id: node_id.to_string(),
            upstream_ids: run.record.checkpoint.deps.iter().filter(|d| d.to == node_id).map(|d| d.from.clone()).collect(),
            run: run.record.checkpoint.engine.as_ref().and_then(|e| e.run.clone()),
            factory: run.record.checkpoint.engine.as_ref().and_then(|e| e.factory.clone()),
            budget_left: Self::budget_left(&run.record.checkpoint),
            intake: run.record.checkpoint.engine.as_ref().and_then(|e| e.intake.clone()),
            progress: {
                let (tx, run_id, node_id) = (self.done_tx.clone(), run_id.to_string(), node_id.to_string());
                ProgressSink::new(move |event| {
                    if let Some(tx) = tx.upgrade() {
                        let _ = tx.send(Msg::Progress { run_id: run_id.clone(), node_id: node_id.clone(), event });
                    }
                })
            },
        };
        let future = self.runner.run(step);
        let done = self.done_tx.clone();
        let (run_id, node_id) = (run_id.to_string(), node_id.to_string());
        tokio::spawn(async move {
            let result = future.await;
            if let Some(tx) = done.upgrade() {
                let _ = tx.send(Msg::StepDone { run_id, node_id, result });
            }
        });
    }

    /// Hands every free slot to the oldest waiting step of any run.
    fn drain(&mut self) {
        while let Some((run_id, node_id)) = self.pool.next_ready() {
            self.start_step(&run_id, &node_id);
        }
    }

    // ---------- results ----------

    /// A step said where it is. Saved (and so announced) at once; ignored once the run is no longer
    /// live, so a late report cannot reopen an aborted run.
    fn progress(&mut self, run_id: &str, node_id: &str, event: ProgressEvent) {
        let now = self.clock.now_ms();
        let Some(run) = self.runs.get_mut(run_id) else { return };
        if !run.live || !run.members.contains(node_id) {
            return;
        }
        let Some(meta) = run.record.checkpoint.engine.as_mut() else { return };
        match event {
            ProgressEvent::Intake(update) => meta.intake.get_or_insert_with(Intake::default).apply(update, now),
            ProgressEvent::Routed { repo, checkout, base, account } => {
                if let Some(ticket) = meta.factory.as_mut().filter(|t| t.workspace.is_some()) {
                    ticket.repo = repo;
                    ticket.checkout = checkout;
                    ticket.base = base;
                    ticket.account = account;
                }
            }
            event => apply_progress(&mut meta.progress, event, now),
        }
        run.record.updated_at = now;
        let snapshot = run.record.clone();
        self.save(&snapshot);
    }

    fn step_done(&mut self, run_id: &str, node_id: &str, result: NodeResult) {
        let now = self.clock.now_ms();
        let Some(run) = self.runs.get_mut(run_id) else { return }; // aborted or failed meanwhile
        if !run.live || !run.members.contains(node_id) {
            return;
        }
        // Block BEFORE completing: completing first would release the gated descendants.
        let stopped_at_cap = result.outcome == Outcome::Capped;
        let waits = result.outcome == Outcome::Waiting;
        let blocked = if result.gate == Some(Gate::Fail) { run.scheduler.block(node_id) } else { Vec::new() };
        // A capped or waiting step is not finished: nothing it gates is released, and it runs again later.
        let released = if stopped_at_cap || waits { Vec::new() } else { run.scheduler.complete(node_id) };
        Self::close_stage(&mut run.record, now);
        run.record.checkpoint.apply_completion(node_id, result);
        run.record.checkpoint.apply_gate_block(&blocked);
        let status = derive_status(&run.record.checkpoint);
        run.record.status = status;
        run.record.ended_at = (status != RunStatus::Running).then_some(now);
        run.record.updated_at = now;
        let snapshot = run.record.clone();
        self.save(&snapshot);

        // A step waiting for the user stops the run's dispatch like the cap does; the cap is checked
        // again when the user's decision continues the run.
        if waits && !self.runs[run_id].waiting {
            self.runs.get_mut(run_id).expect("live run").waiting = true;
            self.pool.drop_queued(run_id);
        }
        // Cap check BEFORE the slot is freed: the step queued behind this one must not start.
        if !waits && !self.runs[run_id].capped && (stopped_at_cap || self.over_budget(run_id)) {
            self.runs.get_mut(run_id).expect("live run").capped = true;
            self.pool.drop_queued(run_id);
        }
        // Free the slot first, so whatever waited for it starts before the newly released steps.
        self.pool.release(run_id, node_id);
        self.drain();
        if !self.is_live(run_id) {
            return; // a dispatch above failed this run
        }
        if !self.runs[run_id].capped && !self.runs[run_id].waiting {
            for node in released.iter() {
                if !self.is_live(run_id) {
                    return;
                }
                self.submit(run_id, node);
            }
            if !self.is_live(run_id) {
                return;
            }
        }
        let run = &self.runs[run_id];
        if run.scheduler.is_done() {
            self.settle(run_id);
            return;
        }
        let (in_flight, queued) = (self.pool.in_flight_of(run_id), self.pool.queued_of(run_id));
        if run.waiting {
            if in_flight == 0 {
                self.wait(run_id);
            }
            return;
        }
        if run.capped {
            if in_flight == 0 {
                self.pause(run_id);
            }
            return;
        }
        // Only a run with nothing running and nothing waiting for a slot can be stuck; otherwise
        // a normal fan-in or a step queued behind the limit would read as a cycle.
        if released.is_empty() && in_flight == 0 && queued == 0 && run.scheduler.has_cycle() {
            let pending = run.scheduler.pending();
            self.fail(run_id, &format!("dependency cycle between {pending:?}"));
        }
    }

    // ---------- endings ----------

    /// Stopped at the cap with nothing in flight: resumable, so no end time.
    fn pause(&mut self, run_id: &str) {
        let now = self.clock.now_ms();
        let Some(run) = self.runs.get_mut(run_id) else { return };
        run.live = false;
        run.capped = false;
        run.record.status = RunStatus::Paused;
        run.record.ended_at = None;
        run.record.updated_at = now;
        let snapshot = run.record.clone();
        self.save(&snapshot);
        self.pool.clear(run_id);
        self.drain();
        self.notify(run_id);
    }

    /// A step waits for the user with nothing in flight: not over, so no end time.
    fn wait(&mut self, run_id: &str) {
        let now = self.clock.now_ms();
        let Some(run) = self.runs.get_mut(run_id) else { return };
        run.live = false;
        run.waiting = false;
        run.capped = false;
        run.record.status = RunStatus::Waiting;
        run.record.ended_at = None;
        run.record.updated_at = now;
        let snapshot = run.record.clone();
        self.save(&snapshot);
        self.pool.clear(run_id);
        self.drain();
        self.notify(run_id);
    }

    fn fail(&mut self, run_id: &str, problem: &str) {
        let now = self.clock.now_ms();
        let Some(mut run) = self.runs.remove(run_id) else { return };
        Self::close_stage(&mut run.record, now);
        Self::set_error(&mut run.record, problem);
        run.record.status = RunStatus::Error;
        run.record.ended_at = Some(now);
        run.record.updated_at = now;
        self.save(&run.record);
        self.pool.clear(run_id);
        self.drain();
        self.notify(run_id);
    }

    /// Every member is done or gated off; the record already holds its derived status.
    fn settle(&mut self, run_id: &str) {
        self.runs.remove(run_id);
        self.pool.clear(run_id);
        self.drain();
        self.notify(run_id);
    }

    /// The step is over, however it ended: its open stage ends now.
    fn close_stage(record: &mut GraphRunRecord, now: i64) {
        if let Some(meta) = record.checkpoint.engine.as_mut() {
            close_progress(&mut meta.progress, now);
        }
    }

    fn set_error(record: &mut GraphRunRecord, problem: &str) {
        if let Some(meta) = record.checkpoint.engine.as_mut() {
            meta.error = Some(problem.to_string());
        }
    }

    // ---------- decisions ----------

    fn raise_cap(&mut self, id: &str) -> Result<f64, DecisionError> {
        let mut record = match self.runs.get(id) {
            Some(run) if run.live => return Err(DecisionError::NotPaused),
            Some(run) => run.record.clone(),
            // Not loaded yet (no resume_interrupted since the restart): read it from the store.
            None => match self.store.get(id).map_err(|e| DecisionError::Store(e.to_string()))? {
                Some(r) if r.is_rust_owned() && r.status == RunStatus::Paused => r,
                Some(r) if r.is_rust_owned() && matches!(r.status, RunStatus::Running | RunStatus::Waiting) => {
                    return Err(DecisionError::NotPaused)
                }
                _ => return Err(DecisionError::UnknownRun(id.to_string())),
            },
        };
        if record.checkpoint.engine.as_ref().is_some_and(|meta| meta.recovery.is_some()) {
            return Err(DecisionError::Invalid("This Factory run requires recovery inspection, not a budget increase".into()));
        }
        let spent = run_spend(&record.checkpoint).cost_usd;
        let meta = record.checkpoint.engine.get_or_insert_with(|| EngineMeta {
            kind: ENGINE_KIND_RUST.into(),
            budget_cap: None,
            run: None,
            error: None,
            recovery: None,
            factory: None,
            progress: None,
            pr: None,
            intake: None,
            chief: None,
            pr_watch: None,
        });
        let cap = raised_budget_cap(meta.budget_cap.unwrap_or(0.0), spent);
        meta.budget_cap = Some(cap);
        self.runs.remove(id);
        self.resume(record);
        Ok(cap)
    }

    fn decide(&mut self, id: &str, decision: IntakeDecision) -> Result<(), DecisionError> {
        let mut record = match self.runs.get(id) {
            Some(run) if run.live || run.record.status != RunStatus::Waiting => return Err(DecisionError::NotWaiting),
            Some(run) => run.record.clone(),
            None => match self.store.get(id).map_err(|e| DecisionError::Store(e.to_string()))? {
                Some(r) if r.is_rust_owned() && r.status == RunStatus::Waiting => r,
                Some(r) if r.is_rust_owned() => return Err(DecisionError::NotWaiting),
                _ => return Err(DecisionError::UnknownRun(id.to_string())),
            },
        };
        let now = self.clock.now_ms();
        let continues = decision.continues_the_run();
        let meta = record.checkpoint.engine.as_mut().ok_or(DecisionError::NotWaiting)?;
        if meta.recovery.is_some() {
            return Err(DecisionError::Invalid("This Factory run requires recovery inspection before intake decisions".into()));
        }
        let ticket = meta.factory.clone().ok_or(DecisionError::NotWaiting)?;
        meta.intake.get_or_insert_with(Intake::default).decide(decision, &ticket, now).map_err(DecisionError::Invalid)?;
        record.updated_at = now;
        if !continues {
            self.save(&record);
            if let Some(run) = self.runs.get_mut(id) {
                run.record = record;
            }
            return Ok(());
        }
        self.runs.remove(id);
        self.resume(record);
        Ok(())
    }

    /// Notes go on the engine's own copy when it holds the run, else on the stored record. They
    /// change nothing else: not the status, not `updated_at`.
    fn chief_note(&mut self, id: &str, entry: ChiefEntry) -> Result<bool, DecisionError> {
        let mut record = match self.runs.get(id) {
            Some(run) => run.record.clone(),
            None => match self.store.get(id).map_err(|e| DecisionError::Store(e.to_string()))? {
                Some(r) if r.is_rust_owned() => r,
                _ => return Err(DecisionError::UnknownRun(id.to_string())),
            },
        };
        let meta = record.checkpoint.engine.as_mut().ok_or_else(|| DecisionError::UnknownRun(id.to_string()))?;
        if !meta.chief.get_or_insert_with(ChiefOfStaffLog::default).note(entry) {
            return Ok(false);
        }
        self.save(&record);
        if let Some(run) = self.runs.get_mut(id) {
            run.record = record;
        }
        Ok(true)
    }

    fn abort(&mut self, id: &str) -> Result<(), DecisionError> {
        let now = self.clock.now_ms();
        let Some(mut run) = self.runs.remove(id) else {
            return Err(DecisionError::UnknownRun(id.to_string()));
        };
        Self::close_stage(&mut run.record, now);
        run.record.status = RunStatus::Cancelled;
        run.record.ended_at = Some(now);
        run.record.updated_at = now;
        self.save(&run.record);
        self.pool.clear(id);
        self.drain();
        self.notify(id);
        Ok(())
    }

    fn resume_interrupted(&mut self) -> Result<Vec<String>, String> {
        let records = self.store.list_unfinished().map_err(|e| e.to_string())?;
        let mut resumed = Vec::new();
        for mut record in records.into_iter().filter(GraphRunRecord::is_rust_owned) {
            if self.runs.contains_key(&record.id) {
                continue;
            }
            if record.status == RunStatus::Running && record.checkpoint.engine.as_ref().is_some_and(|meta| meta.factory.is_some()) {
                let now = self.clock.now_ms();
                Self::close_stage(&mut record, now);
                record.checkpoint.engine.as_mut().expect("Factory owner").recovery = Some("The app stopped before this Factory run finished. No steps were replayed. Inspect its worktree, processes and branch PR before continuing; automatic resume is disabled.".into());
                record.status = RunStatus::Paused;
                record.ended_at = None;
                record.updated_at = now;
                self.store.save(&record).map_err(|e| e.to_string())?;
                self.emit(&record);
            }
            match record.status {
                RunStatus::Paused | RunStatus::Waiting => {
                    let graph = record.checkpoint.graph();
                    let seed: Vec<String> = record.checkpoint.completed.keys().cloned().collect();
                    let scheduler = Scheduler::new(&graph, &seed);
                    let id = record.id.clone();
                    self.insert_live(record, scheduler);
                    self.runs.get_mut(&id).expect("just inserted").live = false;
                }
                _ => {
                    resumed.push(record.id.clone());
                    self.resume(record);
                }
            }
        }
        Ok(resumed)
    }

    // ---------- helpers ----------

    fn is_live(&self, run_id: &str) -> bool {
        self.runs.get(run_id).is_some_and(|r| r.live)
    }

    /// Cap minus what the run has spent; `None` = no cap.
    fn budget_left(checkpoint: &Checkpoint) -> Option<f64> {
        let cap = checkpoint.engine.as_ref().and_then(|e| e.budget_cap)?;
        Some((cap - run_spend(checkpoint).cost_usd.unwrap_or(0.0)).max(0.0))
    }

    fn over_budget(&self, run_id: &str) -> bool {
        let Some(run) = self.runs.get(run_id) else { return false };
        let Some(cap) = run.record.checkpoint.engine.as_ref().and_then(|e| e.budget_cap) else { return false };
        run_spend(&run.record.checkpoint).cost_usd.unwrap_or(0.0) >= cap
    }

    fn save(&self, record: &GraphRunRecord) {
        if let Err(e) = self.store.save(record) {
            eprintln!("[graph-run] could not save run {}: {e}", record.id);
        }
        self.emit(record);
    }

    fn emit(&self, record: &GraphRunRecord) {
        if let Some(events) = &self.events {
            events.changed(RunChanged { id: record.id.clone(), project_id: record.project_id.clone(), status: record.status });
        }
    }

    fn notify(&mut self, run_id: &str) {
        for waiter in self.waiters.remove(run_id).unwrap_or_default() {
            let _ = waiter.send(());
        }
    }
}
