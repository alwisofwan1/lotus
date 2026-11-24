//! Where a Factory Run is inside its one step: the stage, the try, and each stage's times and cost.
//!
//! The runner says what it starts and ends ([`ProgressEvent`]); the engine stamps the time with its
//! own clock and saves the record, so every UI hears it through `graph-run://changed`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// The stages of a Factory Run, in order. `building` and `checking` repeat on a retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FactoryStage {
    /// The triage agent reads the ticket and the code and sizes it (FI3). Before the worktree: a
    /// meta-repo run needs it to pick the sub-repo, and every run's branch is named after its `{type}`.
    Triage,
    Worktree,
    /// The spec agent's turn: reading the code, asking, writing the spec (FI2).
    Spec,
    Building,
    Checking,
    /// The review agent checks the change against the spec (FI7).
    Review,
    DraftPr,
    /// A Revision Run pushes its round to the PR's branch (CoS 6).
    Push,
}

/// One stage as it ran. `ended_at` is unset while it runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressStep {
    pub stage: FactoryStage,
    pub attempt: u32,
    pub started_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryProgress {
    /// The stage started last.
    pub stage: FactoryStage,
    /// The try that stage belongs to, from 1.
    pub attempt: u32,
    pub max_attempts: u32,
    pub steps: Vec<ProgressStep>,
    /// What the agent said it did, on the try that passed the check. Not checked by anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// The last step an agent of this run took ("Edited src/a.rs"), and when.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output: Option<AgentOutput>,
    /// The repo's `stall_minutes`, once the run has read its factory definition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_minutes: Option<u32>,
    /// The repo's `poll_minutes`: how often the Chief of Staff looks at the run's PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poll_minutes: Option<u32>,
    /// A Revision Run's verdict on each of its items, once it finished (CoS 6).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<crate::RoundReport>,
    /// How the run's PR was opened (ADR-0063 §7). Absent on a run saved before Open PRs existed:
    /// those were all Drafts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_opening: Option<PrOpened>,
}

/// How a Factory PR was opened: a Draft carries why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrOpened {
    pub draft: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The branch the run pushed (a template may name it): a round pushes to it when GitHub has
    /// not reported the PR's branch yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutput {
    /// Unix ms, stamped by the engine.
    pub at: i64,
    pub text: String,
}

/// The longest step text kept: it is a hint for the user, not a log.
const OUTPUT_CHARS: usize = 200;

impl FactoryProgress {
    /// When the run last showed life: a stage began or ended, or an agent took a step.
    pub fn last_activity(&self) -> Option<i64> {
        let steps = self.steps.iter().map(|s| s.ended_at.unwrap_or(s.started_at));
        steps.chain(self.last_output.as_ref().map(|o| o.at)).max()
    }
}

/// What a runner reports while its step runs.
#[derive(Debug, Clone, PartialEq)]
pub enum ProgressEvent {
    /// A stage starts; the one still open ends now.
    Begin { stage: FactoryStage, attempt: u32, max_attempts: u32 },
    /// The open stage ends, with what it cost when known.
    End { cost_usd: Option<f64> },
    Summary(String),
    /// What the spec agent asked or wrote; the engine keeps it in the run's intake.
    Intake(crate::intake::IntakeUpdate),
    /// An agent took a step ("Edited src/a.rs"): the run is alive.
    Output(String),
    /// The repo's `stall_minutes`, read with its factory definition.
    StallAfter(u32),
    /// The repo's `poll_minutes`, read with its factory definition.
    PollEvery(u32),
    /// What a Revision Run did with each of its items.
    Round(crate::RoundReport),
    /// Triage routed a meta-repo run to a sub-repo (FM8): the engine records it on the run's
    /// ticket, so a step run again, a Revision Run and the board all see the sub-repo.
    Routed { repo: String, checkout: std::path::PathBuf, base: String, account: String },
    /// How the PR is about to open (Open, or Draft and why).
    PrOpening(PrOpened),
}

/// Applies `event` at `now`. Times never go backwards: a stage starts no earlier than the one
/// before it ended, even if the clock does.
pub fn apply_progress(progress: &mut Option<FactoryProgress>, event: ProgressEvent, now: i64) {
    match event {
        ProgressEvent::Begin { stage, attempt, max_attempts } => {
            close_progress(progress, now);
            let p = progress.get_or_insert_with(|| FactoryProgress {
                stage,
                attempt,
                max_attempts,
                steps: Vec::new(),
                summary: None,
                last_output: None,
                stall_minutes: None,
                poll_minutes: None,
                round: None,
                pr_opening: None,
            });
            let floor = p.steps.last().map_or(now, |s| s.ended_at.unwrap_or(s.started_at));
            p.stage = stage;
            p.attempt = attempt;
            p.max_attempts = max_attempts;
            p.steps.push(ProgressStep { stage, attempt, started_at: now.max(floor), ended_at: None, cost_usd: None });
        }
        ProgressEvent::End { cost_usd } => {
            if let Some(step) = open_step(progress) {
                step.ended_at = Some(now.max(step.started_at));
                step.cost_usd = cost_usd;
            }
        }
        ProgressEvent::Summary(text) => {
            if let Some(p) = progress.as_mut() {
                p.summary = Some(text);
            }
        }
        ProgressEvent::Output(text) => {
            if let Some(p) = progress.as_mut() {
                p.last_output = Some(AgentOutput { at: now, text: text.chars().take(OUTPUT_CHARS).collect() });
            }
        }
        ProgressEvent::StallAfter(minutes) => {
            if let Some(p) = progress.as_mut() {
                p.stall_minutes = Some(minutes);
            }
        }
        ProgressEvent::PollEvery(minutes) => {
            if let Some(p) = progress.as_mut() {
                p.poll_minutes = Some(minutes);
            }
        }
        ProgressEvent::Round(report) => {
            if let Some(p) = progress.as_mut() {
                p.round = Some(report);
            }
        }
        
        ProgressEvent::PrOpening(opened) => {
            if let Some(p) = progress.as_mut() {
                p.pr_opening = Some(opened);
            }
        }
        // Not progress: the engine applies these to the run's intake and ticket.
        ProgressEvent::Intake(_) | ProgressEvent::Routed { .. } => {}
    }
}

/// Ends the open stage, if any: the step finished, failed, paused or was aborted.
pub fn close_progress(progress: &mut Option<FactoryProgress>, now: i64) {
    if let Some(step) = open_step(progress) {
        step.ended_at = Some(now.max(step.started_at));
    }
}

fn open_step(progress: &mut Option<FactoryProgress>) -> Option<&mut ProgressStep> {
    progress.as_mut()?.steps.last_mut().filter(|s| s.ended_at.is_none())
}

/// Where a runner sends its [`ProgressEvent`]s. The default goes nowhere (a step run by hand).
#[derive(Clone, Default)]
pub struct ProgressSink(Option<Arc<dyn Fn(ProgressEvent) + Send + Sync>>);

impl ProgressSink {
    pub fn new(send: impl Fn(ProgressEvent) + Send + Sync + 'static) -> Self {
        Self(Some(Arc::new(send)))
    }

    pub fn send(&self, event: ProgressEvent) {
        if let Some(send) = &self.0 {
            send(event);
        }
    }
}

impl std::fmt::Debug for ProgressSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() { "ProgressSink" } else { "ProgressSink(none)" })
    }
}

/// A sink is plumbing, not data: two steps are equal whatever their sinks.
impl PartialEq for ProgressSink {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}
impl Eq for ProgressSink {}

#[cfg(test)]
mod tests {
    use super::*;
    use FactoryStage::*;

    fn begin(stage: FactoryStage, attempt: u32) -> ProgressEvent {
        ProgressEvent::Begin { stage, attempt, max_attempts: 2 }
    }

    #[test]
    fn a_new_stage_ends_the_open_one() {
        let mut p = None;
        apply_progress(&mut p, begin(Worktree, 1), 10);
        apply_progress(&mut p, begin(Building, 1), 20);
        let p = p.unwrap();
        assert_eq!(p.stage, Building);
        assert_eq!(p.steps.len(), 2);
        assert_eq!(p.steps[0].ended_at, Some(20));
        assert_eq!(p.steps[1].started_at, 20);
        assert_eq!(p.steps[1].ended_at, None);
    }

    #[test]
    fn end_records_the_cost_of_the_open_stage() {
        let mut p = None;
        apply_progress(&mut p, begin(Building, 1), 10);
        apply_progress(&mut p, ProgressEvent::End { cost_usd: Some(0.3) }, 50);
        let step = &p.unwrap().steps[0];
        assert_eq!((step.ended_at, step.cost_usd), (Some(50), Some(0.3)));
    }

    #[test]
    fn times_never_go_backwards_when_the_clock_does() {
        let mut p = None;
        apply_progress(&mut p, begin(Building, 1), 100);
        apply_progress(&mut p, ProgressEvent::End { cost_usd: None }, 90);
        apply_progress(&mut p, begin(Checking, 1), 80);
        let steps = p.unwrap().steps;
        assert_eq!(steps[0].ended_at, Some(100));
        assert_eq!(steps[1].started_at, 100);
    }

    #[test]
    fn close_ends_the_open_stage_and_nothing_else() {
        let mut p = None;
        close_progress(&mut p, 5);
        assert!(p.is_none());
        apply_progress(&mut p, begin(Checking, 2), 10);
        close_progress(&mut p, 30);
        close_progress(&mut p, 99);
        assert_eq!(p.unwrap().steps[0].ended_at, Some(30));
    }

    #[test]
    fn it_reads_and_writes_the_shape_the_ui_reads() {
        let mut p = None;
        apply_progress(&mut p, begin(DraftPr, 2), 7);
        apply_progress(&mut p, ProgressEvent::Summary("Added ok.txt".into()), 8);
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["stage"], "draft-pr");
        assert_eq!(json["maxAttempts"], 2);
        assert_eq!(json["steps"][0]["startedAt"], 7);
        assert!(json["steps"][0].get("endedAt").is_none());
        assert_eq!(json["summary"], "Added ok.txt");
        let back: Option<FactoryProgress> = serde_json::from_value(json).unwrap();
        assert_eq!(back, p);
    }
}
