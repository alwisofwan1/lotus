//! Automation engine for Lotus: Trigger -> Action -> Output.
//!
//! This crate must never depend on `tauri` (ADR-0038). Every side effect
//! reaches the outside world through a port trait, so the same crate can
//! later run as a standalone daemon.

mod no_window;
pub mod activity;
pub mod agent;
pub mod agent_prompt;
pub mod ask;
pub mod authoring;
pub mod chat;
pub mod checkout;
pub mod failure;
mod engine;
mod error;
pub mod github;
pub mod github_issues;
pub mod google;
pub mod notion;
mod model;
mod ports;
pub mod pane;
pub mod pr_review;
pub mod ratelimit;
mod registry;
mod schema_check;
pub mod schedule;
pub mod scheduler;
pub mod secrets;
pub mod session;
pub mod slack;
pub mod sources;
mod store;
pub mod views;
pub mod workspaces;

pub use engine::{Engine, EngineConfig, RunEvent, Submitted};
pub use error::{Error, Result};
pub use model::{Automation, ClaimOutcome, Draft, DraftStatus, NewAutomation, NewDraft, Run, RunStatus, Spec, ASK_KIND};
pub use store::{Resumable, RunEntry, Store};
pub use ports::{notification_text, Clock, Notifier, RunReport, SystemClock};
pub use registry::{ActionContext, ActionKind, ActionResult, BoxFuture, Registry};
