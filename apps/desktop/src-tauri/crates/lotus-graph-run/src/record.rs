//! The persisted run record and its checkpoint. Port of `graph-run-record.ts`.
//!
//! The JSON shape is the TS `GraphRunRecord` shape, field for field, so the existing UI reads a run
//! this engine wrote without a change. Fields this crate does not know are kept (`extra`).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::graph::{RunDependency, RunGraph};

/// Marks a record as owned by this engine (`checkpoint.engine.kind`). The TS engine must not
/// resume such a record, and this engine resumes no other.
pub const ENGINE_KIND_RUST: &str = "rust";

/// `Paused` = stopped at its budget cap with steps left; `Waiting` = a step waits for the user
/// (Factory Intake: answers or a spec to approve). Neither is over, so `endedAt` stays null.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Paused,
    Waiting,
    Completed,
    Error,
    Cancelled,
}

impl RunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Waiting => "waiting",
            Self::Completed => "completed",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        serde_json::from_value(Value::String(raw.to_string())).ok()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Completed,
    Error,
    Stopped,
    /// The step stopped before spending more than its run's cap allows: not done, not failed. The
    /// node stays `pending`, its cost counts, and the run pauses at its cap (Raise cap continues it).
    Capped,
    /// The step needs the user before it can go on (Factory Intake). Like [`Outcome::Capped`]: the
    /// node stays `pending` and its cost counts; the run is `waiting` until the user decides.
    Waiting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Gate {
    Pass,
    Fail,
}

/// Token/cost accounting of one step (`AgentRunUsage`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

impl Usage {
    /// Two attempts of one step, as one: tokens add up, and the cost is known if either knew it.
    fn plus(&self, other: &Usage) -> Usage {
        let cost_usd = match (self.cost_usd, other.cost_usd) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
        };
        Usage { input_tokens: self.input_tokens + other.input_tokens, output_tokens: self.output_tokens + other.output_tokens, cost_usd }
    }
}

/// Result of one step (`GraphRunNodeResult`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeResult {
    pub outcome: Outcome,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub node_run_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gate: Option<Gate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// What the step wants the user to see: the gate output of a failed Check, the PR URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl NodeResult {
    pub fn completed(cost_usd: Option<f64>) -> Self {
        Self::with(Outcome::Completed, cost_usd)
    }

    pub fn capped(cost_usd: Option<f64>) -> Self {
        Self::with(Outcome::Capped, cost_usd)
    }

    pub fn waiting(cost_usd: Option<f64>) -> Self {
        Self::with(Outcome::Waiting, cost_usd)
    }

    pub fn failed(cost_usd: Option<f64>) -> Self {
        Self::with(Outcome::Error, cost_usd)
    }

    fn with(outcome: Outcome, cost_usd: Option<f64>) -> Self {
        Self {
            outcome,
            session_id: None,
            node_run_id: String::new(),
            gate: None,
            usage: cost_usd.map(|c| Usage { cost_usd: Some(c), ..Usage::default() }),
            detail: None,
        }
    }
}

/// The run's goal, handed to every step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunBrief {
    pub title: String,
    pub brief: String,
}

/// What this engine needs to resume a run with no UI: who owns it, its cap, its goal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineMeta {
    pub kind: String,
    /// USD, whole cents. None = no cap.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_cap: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<RunBrief>,
    /// Why the engine ended the run as `error` without a step failing (cycle, missing runner).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// A restart interrupted Factory work. Ordinary budget/intake decisions cannot replay it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    /// The ticket of a Factory Run (ADR-0049 §1); kept so a resumed run still knows it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory: Option<FactoryTicket>,
    /// Where a Factory Run is inside its step. Absent on runs made before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<crate::FactoryProgress>,
    /// What became of a finished Factory Run's draft PR, once the reaper saw it merged or closed.
    /// Absent while the PR is open, and on every run the reaper has not judged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr: Option<PrOutcome>,
    /// A Factory Run's questions, answers and spec (FI2). Absent until its spec agent first speaks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intake: Option<crate::intake::Intake>,
    /// What the Chief of Staff noticed about this run (ADR-0056 §3). Absent until it first does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chief: Option<ChiefOfStaffLog>,
    /// The Factory PR as the Chief of Staff last saw it (ADR-0056, "Factory PR state"). Absent
    /// until its first look at the PR.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_watch: Option<PrWatch>,
}

/// Where a Factory PR stands, next to its run's [`RunStatus`]. Board chips and the Chief of Staff
/// strip read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrPhase {
    /// Open, and nobody has acted on its feedback yet.
    InReview,
    /// A Revision Run works on it ([`PrWatch::rounds`] says which round).
    Revising,
    /// A Revision Run pushed its round; the reviewer has the next move.
    WaitingForReview,
    /// A round could not finish (a refused push, a conflict with the base, a failure): a person
    /// fixes it.
    NeedsYou,
    /// It had all its `max_rounds` and new feedback came: only the user goes on from here (CoS 7).
    OutOfRounds,
    Merged,
    Closed,
}

impl PrPhase {
    /// Merged or closed: nothing is watched any more.
    pub fn is_ended(self) -> bool {
        matches!(self, Self::Merged | Self::Closed)
    }
}

/// The Chief of Staff's view of one Factory PR, kept on the run record so it survives a restart.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrWatch {
    pub number: u64,
    pub url: String,
    pub phase: PrPhase,
    /// What it has seen, so the next look knows what is new.
    #[serde(default)]
    pub seen: PrSeen,
    /// Every Feedback Item found on the PR, oldest first (CoS 5).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feedback: Vec<FeedbackItem>,
    /// The batches closed so far, oldest first. An item not in one yet waits for its batch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub batches: Vec<FeedbackBatch>,
    /// Its Revision Runs, oldest first (CoS 6).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rounds: Vec<RevisionRound>,
    /// The repo's `max_rounds` when the last round started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    /// The feedback ids of what Lotus posted (`line:<id>`, `comment:<id>`, CoS 9). It posts as the
    /// user, so the next look skips these instead of reading them as feedback.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub posted: Vec<String>,
    /// The PR's head branch, as GitHub says it. A Factory Workflow template (FM3) makes it differ
    /// from `factory/<ticket>-<run>`; a Revision Run pushes to it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// One Revision Run of a Factory PR (ADR-0057).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionRound {
    /// From 1.
    pub round: u32,
    pub run_id: String,
    pub started_at: i64,
    /// The Feedback Items it works on.
    pub items: Vec<String>,
    /// `None` while it runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<RoundEnd>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// What it pushed, or why it needs a person.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// It started by itself on failing CI alone, with no change asked by a person. A PR gets one
    /// such round: CI that still fails after it goes to the user (CoS 7).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ci_only: bool,
    /// The round summary Lotus would post on the PR (CoS 9). Written once the round pushed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// When the summary was posted (Unix ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_sent: Option<i64>,
    /// Its replies and summary are drafted: done once per round.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub drafted: bool,
    /// When review was asked again from the reviewers whose items it addressed (Unix ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rerequested: Option<i64>,
    /// The reply drafted for the Slack thread the PR's link was shared in (CoS 12). `None`: no
    /// thread shares the PR, so no Slack message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slack: Option<SlackReply>,
}

/// A Slack thread a Factory PR's link was shared in (CoS 12).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackThread {
    pub channel: String,
    /// Without the `#`.
    pub channel_name: String,
    /// The thread's root message.
    pub ts: String,
    pub permalink: String,
}

/// "Round N is pushed … Could you re-review?" in the PR's Slack thread, posted as the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackReply {
    pub thread: SlackThread,
    /// The text without the mentions; Lotus puts the known ones in front when it posts.
    pub text: String,
    /// The reviewers the round asks again.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mention: Vec<SlackMention>,
    /// When it was posted (Unix ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent: Option<i64>,
}

/// A reviewer by GitHub login, with their Slack member ID once known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackMention {
    pub github: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slack: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RoundEnd {
    /// Its commits are on the PR branch (or it had nothing to change).
    Pushed,
    /// It stopped without pushing: a person fixes it.
    NeedsYou,
}

/// What a Revision Run revises: the Factory PR, the original run and the round's items. Carried
/// on its ticket, so the runner and a resumed run know it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionOf {
    /// The Factory Run that opened the PR; its record keeps the PR's state.
    pub original: String,
    pub pr_url: String,
    pub pr_number: u64,
    /// The PR's head branch on GitHub. The round starts from `origin/<branch>` and pushes to it.
    pub branch: String,
    /// From 1.
    pub round: u32,
    /// The approved spec with its Amendments; `None` when the original run had no spec.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<String>,
    pub items: Vec<RoundItem>,
}

/// A Feedback Item as a round's agents read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundItem {
    pub id: String,
    pub author: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<FeedbackLabel>,
}

/// What a finished round says about each of its items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundReport {
    pub round: u32,
    /// The head it pushed; `None` when it changed nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    pub items: Vec<ItemVerdict>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemVerdict {
    pub id: String,
    /// Addressed, NotAddressed or Declined.
    pub status: ItemStatus,
    pub why: String,
}

/// Where a Feedback Item came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeedbackSource {
    /// The text of a submitted review.
    Review,
    /// A line comment.
    ReviewComment,
    /// A comment on the PR itself.
    PrComment,
    /// A failing CI check. Its label comes from a rule, never from the model.
    Check,
}

/// What a Feedback Item asks for (ADR-0056, "Feedback Items and batching").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FeedbackLabel {
    Change,
    Nit,
    Question,
    SpecChange,
    None,
}

impl FeedbackLabel {
    pub const ALL: [FeedbackLabel; 5] = [Self::Change, Self::Nit, Self::Question, Self::SpecChange, Self::None];

    pub fn name(self) -> &'static str {
        match self {
            Self::Change => "change",
            Self::Nit => "nit",
            Self::Question => "question",
            Self::SpecChange => "spec-change",
            Self::None => "none",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|l| l.name() == name)
    }
}

/// Who set an item's label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LabelBy {
    /// A fixed rule: a failing CI check is a change.
    Rule,
    /// The Judge.
    Model,
    /// The user, in the Chief of Staff pane.
    You,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ItemStatus {
    New,
    InRound,
    Addressed,
    NotAddressed,
    Declined,
    NeedsYou,
    /// A spec change the user declined: out of this PR's scope. Its reply waits for Send (CoS 8).
    OutOfScope,
}

/// One thing a reviewer or CI said on a Factory PR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackItem {
    /// `review:<id>`, `line:<id>`, `comment:<id>`, `check:<id>` or `status:<sha>`.
    pub id: String,
    pub source: FeedbackSource,
    /// The GitHub login, or the check's name.
    pub author: String,
    /// Passes the author filter: a requested reviewer, the PR's author, someone with write
    /// access, or CI. Other items are shown and never start work.
    pub counts: bool,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// When the watcher first saw it (Unix ms).
    pub at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<FeedbackLabel>,
    /// The model's confidence in `label`, 0 to 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_by: Option<LabelBy>,
    /// Why the label is missing or not trusted ("the judge sent no valid JSON").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unsure: Option<String>,
    pub status: ItemStatus,
    /// The batch it closed in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub batch: Option<u32>,
    /// The reply Lotus would post: drafted after its round, by Decline, or typed by the user.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    /// When `reply` was posted (Unix ms). A new draft clears it (CoS 9).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_sent: Option<i64>,
    /// What its last round said about it: why it was declined, or not addressed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// A spec change the user accepted: the number of the Amendment it added (CoS 8). The next
    /// round works on it like a change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amendment: Option<u32>,
}

/// Why a batch closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BatchReason {
    /// A review was submitted (Request changes or Comment).
    Review,
    /// A CI run finished.
    Checks,
    /// Loose comments, then quiet for the window.
    Quiet,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackBatch {
    /// 1, 2, 3 … per PR.
    pub id: u32,
    /// Unix ms.
    pub closed_at: i64,
    pub reason: BatchReason,
    /// Its item ids.
    pub items: Vec<String>,
}

/// The newest item of each kind seen on the PR. GitHub ids only grow, so a larger id is new.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSeen {
    #[serde(default)]
    pub review: u64,
    #[serde(default)]
    pub review_comment: u64,
    #[serde(default)]
    pub comment: u64,
    /// The checks on the head commit, as last seen. `None` = no checks yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checks: Option<ChecksState>,
}

/// All of a commit's check runs and statuses, rolled into one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChecksState {
    Pending,
    Passing,
    Failing,
}

/// The Chief of Staff's notes on one run: every entry it wrote, and the signals still raised.
/// Kept on the run record so it survives a restart. Written only through the engine.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChiefOfStaffLog {
    #[serde(default)]
    pub log: Vec<ChiefEntry>,
    /// Raised and not cleared yet. A raised signal is a Needs-you item while its condition holds.
    #[serde(default)]
    pub open: Vec<ChiefSignal>,
}

/// What the Chief of Staff watches a run for (ADR-0056, "Run supervision").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChiefSignal {
    /// Waits on the user's intake answer, spec approval or triage decision.
    WaitingOnYou,
    /// Stopped at its budget cap; Raise cap or Abort is the user's.
    PausedAtCap,
    /// Running, with no new stage or agent step for the repo's `stall_minutes`.
    Stalled,
    /// The app stopped while the run worked; it waits for the user to inspect it (no Resume in v1).
    RecoveryRequired,
    /// Spent 80% of its cap or more, before the pause.
    BudgetBurn,
    /// A batch of PR feedback waits for the user (CoS 5). Raised by the PR watcher, not by the
    /// run supervision in [`ChiefSignal::ALL`].
    Feedback,
}

impl ChiefSignal {
    pub const ALL: [ChiefSignal; 5] =
        [Self::WaitingOnYou, Self::PausedAtCap, Self::Stalled, Self::RecoveryRequired, Self::BudgetBurn];
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChiefEntry {
    /// Unix ms.
    pub at: i64,
    /// The signal raised or cleared; `None` for a note that is no signal ("While you were away").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<ChiefSignal>,
    /// True when the signal was raised, false when it cleared.
    pub raised: bool,
    /// Why, in words the user reads ("Paused at the cap: spent $0.60 of $0.50.").
    pub text: String,
}

impl ChiefOfStaffLog {
    /// Raises or clears `entry.signal`. False (and nothing written) when it already is.
    /// A note with no signal is always written.
    pub fn note(&mut self, entry: ChiefEntry) -> bool {
        let Some(signal) = entry.signal else {
            self.log.push(entry);
            return true;
        };
        let open = self.open.contains(&signal);
        if open == entry.raised {
            return false;
        }
        if entry.raised {
            self.open.push(signal);
        } else {
            self.open.retain(|s| *s != signal);
        }
        self.log.push(entry);
        true
    }

    /// Writes a note that is no signal.
    pub fn say(&mut self, at: i64, text: impl Into<String>) {
        self.log.push(ChiefEntry { at, signal: None, raised: false, text: text.into() });
    }

    pub fn is_open(&self, signal: ChiefSignal) -> bool {
        self.open.contains(&signal)
    }

    /// The newest note that raised `signal`: why it needs the user, and since when.
    pub fn raised_by(&self, signal: ChiefSignal) -> Option<&ChiefEntry> {
        self.log.iter().rev().find(|e| e.signal == Some(signal) && e.raised)
    }
}

/// How a Factory Run's draft PR ended. Written by the app, never sent to GitHub.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrOutcome {
    Merged,
    Closed,
}

/// One ticket a Factory Run turns into one draft PR. Read only: Lotus writes nothing to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryTicket {
    /// `owner/name` on GitHub.
    pub repo: String,
    /// The issue number; the PR says `Closes #<issue>`. 0 for a Notion ticket.
    #[serde(default)]
    pub issue: u64,
    pub title: String,
    pub body: String,
    /// The gh account of the Ticket Source; every GitHub call acts as it.
    pub account: String,
    /// The user's checkout of `repo`. Only read: the run works in its own worktree.
    pub checkout: std::path::PathBuf,
    /// The branch the PR targets and the worktree starts from, e.g. `main`.
    pub base: String,
    /// The delegation preset id the implementer runs as (Lotus settings `delegation.presets`).
    #[serde(default)]
    pub implementer: String,
    /// What the issue's previous run reported when it stopped without a PR (Try again), so the new
    /// run does not repeat it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_failure: Option<String>,
    /// Set when the ticket is a Notion page, not a GitHub issue (#168). The code still lives in
    /// `repo`; `body` holds the page and its properties, read once when the run started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notion: Option<NotionTicket>,
    /// Set on a Revision Run (CoS 6): the PR it revises and the round's items.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<RevisionOf>,
    /// Set when the run was started in a meta-repo (FM8): the folder it was started in. Until
    /// triage picks the sub-repo, `checkout` is this folder and `repo` is only its name; the
    /// engine then records the sub-repo's checkout, GitHub repo and base here (the folder stays).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<std::path::PathBuf>,
    /// A meta-repo run: the gh account of each connected GitHub source, by `owner/name` (any
    /// case). Triage's sub-repo is only known mid-run, so the account is picked from this then
    /// ([`Self::account_for`]); `account` above is the fallback.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub repo_accounts: std::collections::BTreeMap<String, String>,
}

impl FactoryTicket {
    /// The gh account of the connected source for GitHub repo `repo`, if there is one.
    pub fn account_for(&self, repo: &str) -> Option<&str> {
        self.repo_accounts.iter().find(|(name, _)| name.eq_ignore_ascii_case(repo)).map(|(_, account)| account.as_str())
    }
}

/// A Notion ticket a Factory Run builds. Lotus only reads it: nothing is ever written to Notion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionTicket {
    /// The ticket's id, `<PREFIX>-<n>`, e.g. `TKT-123`.
    pub key: String,
    pub page_id: String,
    /// The page's link; the PR body points at it.
    pub url: String,
}

impl NotionTicket {
    /// Whether `key` is `<letters and digits>-<n>` and `url` is an https link.
    pub fn check(&self) -> Result<(), String> {
        let valid_key = self.key.split_once('-').is_some_and(|(prefix, n)| {
            prefix.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
                && prefix.chars().all(|c| c.is_ascii_alphanumeric())
                && !n.is_empty()
                && n.chars().all(|c| c.is_ascii_digit())
        });
        if !valid_key {
            return Err(format!("\"{}\" is not a Notion ticket id like TKT-123", self.key));
        }
        if !self.url.starts_with("https://") {
            return Err(format!("the Notion ticket {} has no https link", self.key));
        }
        Ok(())
    }
}

impl FactoryTicket {
    /// A meta-repo run whose sub-repo triage has not picked yet: it still works in the folder it
    /// was started in.
    pub fn is_unrouted(&self) -> bool {
        self.workspace.as_deref().is_some_and(|w| w == self.checkout)
    }

    /// `#12`, or `TKT-123` for a Notion ticket.
    pub fn label(&self) -> String {
        match &self.notion {
            Some(notion) => notion.key.clone(),
            None => format!("#{}", self.issue),
        }
    }

    /// `owner/name#12`, or `TKT-123` for a Notion ticket.
    pub fn reference(&self) -> String {
        match &self.notion {
            Some(notion) => notion.key.clone(),
            None => format!("{}#{}", self.repo, self.issue),
        }
    }

    /// What names the ticket in a branch: `12`, or `tkt-123`.
    pub fn slug(&self) -> String {
        match &self.notion {
            Some(notion) => notion.key.to_ascii_lowercase(),
            None => self.issue.to_string(),
        }
    }

    /// How an agent's prompt names the ticket.
    pub fn describe(&self) -> String {
        match &self.notion {
            Some(notion) => format!("Notion ticket {} (the code is in the GitHub repo {})", notion.key, self.repo),
            None => format!("GitHub issue #{} of {}", self.issue, self.repo),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub node_ids: Vec<String>,
    pub deps: Vec<RunDependency>,
    #[serde(default)]
    pub completed: BTreeMap<String, NodeResult>,
    #[serde(default)]
    pub failed: Vec<String>,
    /// What failed steps spent. Unlike the TS engine, every attempt of a step adds to it, so a
    /// step that fails, is resumed and fails again keeps the cost of both attempts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_usage: Option<BTreeMap<String, Usage>>,
    /// Why each failed step failed, from its last attempt ([`NodeResult::detail`]): the gate
    /// output of a red Check (decision A, F2), so the Run Node shows it after a restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_detail: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub pending: Vec<String>,
    #[serde(default)]
    pub blocked: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<EngineMeta>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Checkpoint {
    /// Fresh checkpoint: every node pending.
    pub fn new(graph: &RunGraph) -> Self {
        Self {
            node_ids: graph.node_ids.clone(),
            deps: graph.deps.clone(),
            completed: BTreeMap::new(),
            failed: Vec::new(),
            failed_usage: None,
            failed_detail: None,
            pending: graph.node_ids.clone(),
            blocked: Vec::new(),
            engine: None,
            extra: Map::new(),
        }
    }

    pub fn graph(&self) -> RunGraph {
        RunGraph { node_ids: self.node_ids.clone(), deps: self.deps.clone() }
    }

    /// Records a step result: out of `pending`, into `completed` or `failed`.
    pub fn apply_completion(&mut self, node_id: &str, result: NodeResult) {
        if matches!(result.outcome, Outcome::Capped | Outcome::Waiting) {
            self.apply_capped(node_id, result);
            return;
        }
        self.pending.retain(|id| id != node_id);
        if result.outcome == Outcome::Completed {
            self.forget_failure_detail(node_id);
            self.completed.insert(node_id.to_string(), result);
            return;
        }
        if !self.failed.iter().any(|id| id == node_id) {
            self.failed.push(node_id.to_string());
        }
        match result.detail {
            Some(detail) => {
                self.failed_detail.get_or_insert_with(BTreeMap::new).insert(node_id.to_string(), detail);
            }
            // A re-run's failure says nothing: the old reason would be a stale one.
            None => self.forget_failure_detail(node_id),
        }
        if let Some(usage) = result.usage {
            let map = self.failed_usage.get_or_insert_with(BTreeMap::new);
            let total = map.get(node_id).map_or(usage.clone(), |prior| prior.plus(&usage));
            map.insert(node_id.to_string(), total);
        }
    }

    /// A step that stopped at the cap or waits for the user: it stays `pending` (it runs again
    /// after Raise cap or the user's decision), and what it spent is kept beside the failed steps'
    /// so `run_spend` sees it.
    fn apply_capped(&mut self, node_id: &str, result: NodeResult) {
        if !self.pending.iter().any(|id| id == node_id) {
            self.pending.push(node_id.to_string());
        }
        if let Some(usage) = result.usage {
            let map = self.failed_usage.get_or_insert_with(BTreeMap::new);
            let total = map.get(node_id).map_or(usage.clone(), |prior| prior.plus(&usage));
            map.insert(node_id.to_string(), total);
        }
    }

    fn forget_failure_detail(&mut self, node_id: &str) {
        if let Some(map) = self.failed_detail.as_mut() {
            map.remove(node_id);
            if map.is_empty() {
                self.failed_detail = None;
            }
        }
    }

    /// Moves a failed Critic's descendants out of `pending` into `blocked`.
    pub fn apply_gate_block(&mut self, blocked_ids: &[String]) {
        if blocked_ids.is_empty() {
            return;
        }
        let to_block: HashSet<&String> = blocked_ids.iter().collect();
        self.pending.retain(|id| !to_block.contains(id));
        for id in blocked_ids {
            if !self.blocked.contains(id) {
                self.blocked.push(id.clone());
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRunRecord {
    pub id: String,
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    pub status: RunStatus,
    pub checkpoint: Checkpoint,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub updated_at: i64,
}

impl GraphRunRecord {
    pub fn is_rust_owned(&self) -> bool {
        self.checkpoint.engine.as_ref().is_some_and(|e| e.kind == ENGINE_KIND_RUST)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RunSpend {
    /// Sum of known costs, completed and failed steps; None when no step reported one.
    pub cost_usd: Option<f64>,
    /// Finished steps with no known cost; the cap cannot see them.
    pub unknown_cost_steps: usize,
}

/// What a run has spent so far. A failed step without usage is not "cost unknown": a rejected
/// Human Gate fails that way and costs nothing.
pub fn run_spend(checkpoint: &Checkpoint) -> RunSpend {
    let costs: Vec<Option<f64>> = checkpoint.completed.values().map(|r| r.usage.as_ref().and_then(|u| u.cost_usd)).collect();
    let failed: Vec<Option<f64>> = checkpoint.failed_usage.iter().flat_map(|m| m.values()).map(|u| u.cost_usd).collect();
    let known: Vec<f64> = costs.iter().chain(failed.iter()).flatten().copied().collect();
    RunSpend {
        cost_usd: if known.is_empty() { None } else { Some(known.iter().sum()) },
        unknown_cost_steps: costs.iter().chain(failed.iter()).filter(|c| c.is_none()).count(),
    }
}

/// Terminal once nothing is pending: error if any node failed or was gated off, else completed.
pub fn derive_status(checkpoint: &Checkpoint) -> RunStatus {
    if !checkpoint.pending.is_empty() {
        RunStatus::Running
    } else if !checkpoint.failed.is_empty() || !checkpoint.blocked.is_empty() {
        RunStatus::Error
    } else {
        RunStatus::Completed
    }
}

/// USD → cents, with float noise stripped first (`0.08 * 1.5 * 100` is 12.000000000000002).
fn to_cents(usd: f64) -> f64 {
    (usd * 100.0 * 1e6).round() / 1e6
}

/// A cap in whole cents: positive and finite, else (or under a cent) no cap. `normalizeBudgetCap`.
pub fn normalize_budget_cap(value: f64) -> Option<f64> {
    if !value.is_finite() {
        return None;
    }
    let cents = to_cents(value).round();
    (cents > 0.0).then(|| cents / 100.0)
}

/// The cap Raise cap writes: `max(cap, spent) × 1.5`, rounded UP to whole cents, so one press is
/// always enough to dispatch the next step (`raisedBudgetCap`).
pub fn raised_budget_cap(cap: f64, spent: Option<f64>) -> f64 {
    (to_cents(cap.max(spent.unwrap_or(0.0)) * 1.5)).ceil() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cp(ids: &[&str]) -> Checkpoint {
        Checkpoint::new(&RunGraph { node_ids: ids.iter().map(|s| s.to_string()).collect(), deps: vec![] })
    }

    #[test]
    fn spend_counts_completed_and_failed_costs() {
        let mut c = cp(&["a", "b", "h"]);
        c.apply_completion("a", NodeResult::completed(Some(0.6)));
        c.apply_completion("b", NodeResult::failed(Some(0.5)));
        c.apply_completion("h", NodeResult::failed(None));
        let spend = run_spend(&c);
        assert!((spend.cost_usd.unwrap() - 1.1).abs() < 1e-9);
        assert_eq!(spend.unknown_cost_steps, 0);
        assert_eq!(derive_status(&c), RunStatus::Error);
    }

    #[test]
    fn every_failed_attempt_of_a_step_adds_up() {
        let mut c = cp(&["a"]);
        c.apply_completion("a", NodeResult::failed(Some(0.3)));
        c.apply_completion("a", NodeResult::failed(Some(0.2)));
        c.apply_completion("a", NodeResult::completed(Some(0.1)));
        assert!((run_spend(&c).cost_usd.unwrap() - 0.6).abs() < 1e-9);
    }

    #[test]
    fn a_rerun_that_completes_or_fails_without_detail_drops_the_old_failure_detail() {
        let detail = |d: &str| {
            let mut r = NodeResult::failed(Some(0.1));
            r.detail = Some(d.to_string());
            r
        };
        let mut c = cp(&["a", "b"]);
        c.apply_completion("a", detail("gate red"));
        c.apply_completion("b", detail("other"));
        assert_eq!(c.failed_detail.as_ref().unwrap()["a"], "gate red");
        c.apply_completion("a", NodeResult::completed(Some(0.1)));
        c.apply_completion("b", NodeResult::failed(Some(0.1)));
        let left = c.failed_detail.clone().unwrap_or_default();
        assert!(!left.contains_key("a") && !left.contains_key("b"), "{left:?}");
    }

    #[test]
    fn a_capped_step_stays_pending_and_its_cost_counts() {
        let mut c = cp(&["a"]);
        c.apply_completion("a", NodeResult::capped(Some(0.6)));
        assert_eq!(c.pending, vec!["a".to_string()]);
        assert!(c.failed.is_empty() && c.completed.is_empty());
        assert_eq!(derive_status(&c), RunStatus::Running);
        c.apply_completion("a", NodeResult::capped(Some(0.2)));
        assert!((run_spend(&c).cost_usd.unwrap() - 0.8).abs() < 1e-9);
        assert_eq!(serde_json::to_value(Outcome::Capped).unwrap(), "capped");
    }

    #[test]
    fn a_completed_step_without_cost_is_unknown() {
        let mut c = cp(&["a"]);
        c.apply_completion("a", NodeResult::completed(None));
        assert_eq!(run_spend(&c), RunSpend { cost_usd: None, unknown_cost_steps: 1 });
    }

    #[test]
    fn raised_cap_matches_the_ts_rule() {
        assert_eq!(raised_budget_cap(0.01, Some(0.08)), 0.12);
        assert_eq!(raised_budget_cap(1.0, Some(1.1)), 1.65);
        assert_eq!(raised_budget_cap(1.0, Some(0.5)), 1.5);
        assert_eq!(raised_budget_cap(1.0, None), 1.5);
        assert_eq!(raised_budget_cap(0.0734, None), 0.12); // 0.1101 rounds up
        for spent in [0.01, 0.37, 1.0, 8.0, 123.456] {
            assert!(raised_budget_cap(0.01, Some(spent)) > spent);
        }
    }

    #[test]
    fn caps_are_whole_cents() {
        assert_eq!(normalize_budget_cap(0.113906), Some(0.11));
        assert_eq!(normalize_budget_cap(0.004), None);
        assert_eq!(normalize_budget_cap(-1.0), None);
        assert_eq!(normalize_budget_cap(f64::NAN), None);
    }

    #[test]
    fn a_ts_record_round_trips_and_keeps_unknown_fields() {
        let raw = serde_json::json!({
            "id": "r1", "projectId": "p", "workflowId": "run-node:n1", "status": "paused",
            "checkpoint": {
                "nodeIds": ["a", "b"], "deps": [{"from": "a", "to": "b"}],
                "completed": {"a": {"outcome": "completed", "sessionId": null, "nodeRunId": "x",
                                    "usage": {"inputTokens": 1, "outputTokens": 2, "costUsd": 0.5}}},
                "failed": [], "pending": ["b"], "blocked": [], "futureField": 7
            },
            "startedAt": 1, "endedAt": null, "updatedAt": 2
        });
        let record: GraphRunRecord = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(record.status, RunStatus::Paused);
        assert!(!record.is_rust_owned());
        assert_eq!(serde_json::to_value(&record).unwrap(), raw);
    }
}
