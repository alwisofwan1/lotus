//! The Chief of Staff's run watcher (ADR-0056): fixed rules over the run store, no model.
//!
//! Every [`SIGNALS_EVERY`] the host calls [`ChiefOfStaff::tick`]. A tick reads the unfinished
//! Factory Runs, raises a signal on a run that now meets it and clears one that no longer does.
//! Each change is one log entry on the run record, written through the engine
//! ([`Engine::chief_note`]). The watcher never acts on a run: Raise cap and Abort stay the user's
//! (ADR-0056 §5).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::DEFAULT_STALL_MINUTES;
use crate::intake::IntakeState;
use crate::{run_spend, ChiefEntry, ChiefSignal, Engine, FactoryStage, GraphRunRecord, RunStatus, RunStore};

/// How often local run signals are checked ("Where and when the Chief of Staff runs").
pub const SIGNALS_EVERY: Duration = Duration::from_secs(60);

/// What one tick changed: `(run id, signal)`.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChiefTick {
    pub raised: Vec<(String, ChiefSignal)>,
    pub cleared: Vec<(String, ChiefSignal)>,
}

pub struct ChiefOfStaff {
    store: Arc<dyn RunStore>,
    engine: Arc<Engine>,
    /// Runs with a raised signal at the last tick, so one that left the unfinished list (aborted,
    /// finished) is still cleared. Empty after a restart: a stale signal on a finished run is
    /// harmless, because an item shows only while its condition holds.
    watched: Mutex<HashSet<String>>,
}

impl ChiefOfStaff {
    pub fn new(store: Arc<dyn RunStore>, engine: Arc<Engine>) -> Self {
        Self { store, engine, watched: Mutex::default() }
    }

    /// One look at every unfinished Factory Run. `now` is Unix ms: each entry's time, and the
    /// clock the stall rule measures by.
    pub async fn tick(&self, now: i64) -> Result<ChiefTick, String> {
        let records = self.store.list_unfinished().map_err(|e| e.to_string())?;
        let mut report = ChiefTick::default();
        let mut seen = HashSet::new();
        let mut watched = HashSet::new();
        for record in records.iter().filter(|r| is_factory_run(r)) {
            seen.insert(record.id.clone());
            let mut any_open = false;
            for signal in ChiefSignal::ALL {
                let raise = condition(signal, record, now);
                let open = is_open(record, signal);
                let entry = match (&raise, open) {
                    (Some(text), false) => Some(ChiefEntry { at: now, signal: Some(signal), raised: true, text: text.clone() }),
                    (None, true) => Some(ChiefEntry { at: now, signal: Some(signal), raised: false, text: cleared_text(signal, record) }),
                    _ => None,
                };
                let mut now_open = open;
                if let Some(entry) = entry {
                    let raised = entry.raised;
                    if self.note(&record.id, entry, &mut report).await {
                        now_open = raised;
                    }
                }
                any_open |= now_open;
            }
            if any_open {
                watched.insert(record.id.clone());
            }
        }
        // Raised last time, not unfinished now: the run ended, so its signals clear.
        let gone: Vec<String> = self.watched.lock().unwrap_or_else(|p| p.into_inner()).difference(&seen).cloned().collect();
        for id in gone {
            let Ok(Some(record)) = self.store.get(&id) else { continue };
            for signal in open_signals(&record) {
                let entry = ChiefEntry { at: now, signal: Some(signal), raised: false, text: cleared_text(signal, &record) };
                self.note(&id, entry, &mut report).await;
            }
        }
        *self.watched.lock().unwrap_or_else(|p| p.into_inner()) = watched;
        Ok(report)
    }

    async fn note(&self, id: &str, entry: ChiefEntry, report: &mut ChiefTick) -> bool {
        let (signal, raised) = (entry.signal.expect("the run watcher notes signals"), entry.raised);
        match self.engine.chief_note(id, entry).await {
            Ok(true) => {
                if raised { &mut report.raised } else { &mut report.cleared }.push((id.to_string(), signal));
                true
            }
            Ok(false) => false,
            Err(e) => {
                eprintln!("[chief-of-staff] could not note {signal:?} on {id}: {e}");
                false
            }
        }
    }
}

fn is_factory_run(record: &GraphRunRecord) -> bool {
    record.is_rust_owned() && record.checkpoint.engine.as_ref().is_some_and(|meta| meta.factory.is_some())
}

/// Why `signal` holds for the run now, in the user's words; `None` = it does not.
fn condition(signal: ChiefSignal, record: &GraphRunRecord, now: i64) -> Option<String> {
    let meta = record.checkpoint.engine.as_ref()?;
    // A run held for recovery is paused (or waiting) too, but only its own signal applies.
    if meta.recovery.is_some() {
        return (signal == ChiefSignal::RecoveryRequired).then(|| {
            "The app stopped while this run worked. Nothing was replayed: check its worktree, then abort it.".to_string()
        });
    }
    match signal {
        ChiefSignal::RecoveryRequired | ChiefSignal::Feedback => None,
        ChiefSignal::WaitingOnYou => (record.status == RunStatus::Waiting).then(|| waiting_text(meta.intake.as_ref())),
        ChiefSignal::PausedAtCap => (record.status == RunStatus::Paused).then(|| paused_text(record)),
        ChiefSignal::Stalled => {
            // No progress at all: queued for a place, not stalled.
            let progress = meta.progress.as_ref().filter(|_| record.status == RunStatus::Running)?;
            let last = progress.last_activity().unwrap_or(record.started_at);
            let minutes = progress.stall_minutes.unwrap_or(DEFAULT_STALL_MINUTES);
            let idle = (now - last) / 60_000;
            // The stage is named: a long gate or build shows no agent step and may still be fine.
            let stage = stage_label(progress.stage);
            (idle >= i64::from(minutes)).then(|| match &progress.last_output {
                Some(output) => format!("Stalled {idle} min in {stage}. Last output: {}", output.text),
                None => format!("Stalled {idle} min in {stage}, no agent output yet."),
            })
        }
        ChiefSignal::BudgetBurn => {
            let cap = meta.budget_cap.filter(|c| *c > 0.0)?;
            let spent = spent_now(record)?;
            let burning = record.status != RunStatus::Paused && spent >= cap * BURN_SHARE;
            burning.then(|| format!("Spent {} of {} ({:.0}%).", usd(spent), usd(cap), spent / cap * 100.0))
        }
    }
}

fn stage_label(stage: FactoryStage) -> &'static str {
    match stage {
        FactoryStage::Worktree => "Worktree",
        FactoryStage::Triage => "Triage",
        FactoryStage::Spec => "Spec",
        FactoryStage::Building => "Building",
        FactoryStage::Checking => "Checking (the repo's gate)",
        FactoryStage::Review => "Review",
        FactoryStage::DraftPr => "Draft PR",
        FactoryStage::Push => "Push to the PR",
    }
}

/// What the run has spent so far. The record counts a step's cost only once the step ends, so
/// during a step it is the stage costs in the progress (each agent turn reports its own).
fn spent_now(record: &GraphRunRecord) -> Option<f64> {
    let settled = run_spend(&record.checkpoint).cost_usd;
    let stages = record.checkpoint.engine.as_ref()?.progress.as_ref().map(|p| p.steps.iter().filter_map(|s| s.cost_usd).sum::<f64>());
    match (settled, stages) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// Spend past this share of the cap raises [`ChiefSignal::BudgetBurn`].
const BURN_SHARE: f64 = 0.8;

fn waiting_text(intake: Option<&crate::intake::Intake>) -> String {
    match intake.map(crate::intake::Intake::state) {
        Some(IntakeState::WaitingForAnswers) => "Waiting for your answers to the spec agent's questions.".into(),
        Some(IntakeState::WaitingForApproval) => "Waiting for you to approve the spec.".into(),
        Some(IntakeState::TriageBlocked) => "Triage stopped this ticket: continue it or abort.".into(),
        _ => "Waiting for you.".into(),
    }
}

fn is_open(record: &GraphRunRecord, signal: ChiefSignal) -> bool {
    record.checkpoint.engine.as_ref().and_then(|meta| meta.chief.as_ref()).is_some_and(|chief| chief.is_open(signal))
}

fn open_signals(record: &GraphRunRecord) -> Vec<ChiefSignal> {
    record.checkpoint.engine.as_ref().and_then(|meta| meta.chief.as_ref()).map(|chief| chief.open.clone()).unwrap_or_default()
}

fn usd(amount: f64) -> String {
    format!("${amount:.2}")
}

/// "Paused at the cap: spent $0.60 of $0.50."
fn paused_text(record: &GraphRunRecord) -> String {
    let cap = record.checkpoint.engine.as_ref().and_then(|meta| meta.budget_cap);
    let spend = run_spend(&record.checkpoint);
    let spent = spend.cost_usd.map_or_else(|| "an unknown amount".to_string(), usd);
    let mut text = match cap {
        Some(cap) => format!("Paused at the cap: spent {spent} of {}.", usd(cap)),
        None => format!("Paused at the cap: spent {spent}."),
    };
    if spend.unknown_cost_steps > 0 {
        text.push_str(&format!(" {} step(s) reported no cost.", spend.unknown_cost_steps));
    }
    text
}

fn cleared_text(signal: ChiefSignal, record: &GraphRunRecord) -> String {
    let cap = record.checkpoint.engine.as_ref().and_then(|meta| meta.budget_cap);
    match record.status {
        RunStatus::Running | RunStatus::Waiting | RunStatus::Paused => match signal {
            ChiefSignal::PausedAtCap => match cap {
                Some(cap) => format!("Running again with a cap of {}.", usd(cap)),
                None => "Running again.".to_string(),
            },
            ChiefSignal::WaitingOnYou => "Answered: the run goes on.".to_string(),
            ChiefSignal::Stalled => "Working again.".to_string(),
            ChiefSignal::BudgetBurn if record.status == RunStatus::Paused => "Reached the cap.".to_string(),
            ChiefSignal::BudgetBurn => match cap {
                Some(cap) => format!("Back under 80% with a cap of {}.", usd(cap)),
                None => "No cap any more.".to_string(),
            },
            ChiefSignal::RecoveryRequired => "Recovered.".to_string(),
            ChiefSignal::Feedback => "Feedback handled.".to_string(),
        },
        RunStatus::Cancelled => "Aborted.".to_string(),
        other => format!("The run ended ({}).", other.as_str()),
    }
}
