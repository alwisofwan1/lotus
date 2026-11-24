//! Graph Run engine for Lotus (ADR-0049 §6).
//!
//! Runs the member nodes of a Run Node in dependency order, draws every step from ONE slot pool
//! shared by all runs, stops dispatching at the budget cap, checkpoints after every step, and
//! resumes on its own after a restart. It needs no webview: the UI reads the run record and sends
//! decisions (Raise cap, Abort).
//!
//! Behaviour is a port of the TS engine (`canvas-run-scheduler.ts`, `graph-run-session.ts`,
//! `graph-run-slots.ts`, `graph-run-record.ts`), which stays in place for free-form runs
//! (PlanNode, replay). This crate must never depend on `tauri`: every side effect goes through a
//! port trait ([`StepRunner`], [`RunStore`], [`RunEvents`], [`Clock`]).

mod no_window;
mod engine;
pub mod factory;
mod graph;
pub mod intake;
mod progress;
mod record;
pub mod handoff;
pub mod review;
mod slots;
mod store;
pub mod triage;
mod untrusted;

pub use engine::{
    Clock, Engine, EngineConfig, EngineStats, RunChanged, RunEvents, StartError, StartRun, Step, StepRunner,
    SystemClock, DecisionError, BoxFuture,
};
pub use intake::{Amendment, Answer, Clarification, Intake, IntakeDecision, IntakeState, IntakeTurn, IntakeUpdate, Question, SpecDoc};
pub use graph::{build_run_graph, descendants_of, is_runnable_node_type, CanvasEdge, CanvasNode, RunDependency, RunGraph, Scheduler};
pub use record::{
    derive_status, raised_budget_cap, run_spend, Checkpoint, ChecksState, ChiefEntry, ChiefOfStaffLog, ChiefSignal, EngineMeta, FactoryTicket, Gate, NotionTicket, GraphRunRecord, NodeResult, Outcome, PrOutcome, PrPhase, PrSeen, PrWatch, BatchReason, FeedbackBatch, FeedbackItem, FeedbackLabel, FeedbackSource, ItemStatus, ItemVerdict, LabelBy, RevisionOf, RevisionRound, RoundEnd, SlackMention, SlackReply, SlackThread, RoundItem, RoundReport, RunBrief,
    RunSpend, RunStatus, Usage, ENGINE_KIND_RUST,
};
pub use progress::{apply_progress, close_progress, AgentOutput, FactoryProgress, FactoryStage, PrOpened, ProgressEvent, ProgressSink, ProgressStep};
pub use slots::SlotPool;
pub use store::{MemoryRunStore, RunStore, SqliteRunStore, StoreError, KEEPS_OPEN_FACTORY_PR, RUN_RETENTION};
