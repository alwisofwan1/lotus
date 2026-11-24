//! Factory Run (ADR-0049 §1, §4, §7, §9): one ticket → one draft PR.
//!
//! The whole run is ONE step of the engine. [`FactoryRunner`] is its [`crate::StepRunner`]:
//! worktree → implement → the repo's gate (max [`MAX_ATTEMPTS`]) → push → draft PR. Red on the last
//! attempt ends the step as failed with the gate output in [`crate::NodeResult::detail`]
//! (decision A, 2026-10-06: the Automation Ask comes with F4). [`reap`] removes worktrees whose
//! PR is merged or closed, and those of runs that ended without a PR or died with the process.
//!
//! What the repo asks of its factory (gate, agents) is its [`FactoryDefinition`], read from
//! `origin/<base>` by [`read_definition`] (ADR-0051 §2).
//!
//! Side effects outside git go through two ports, so tests use fakes: [`Implementer`] (the agent)
//! and [`PullRequests`] (GitHub). Git and the gate are real processes; tests use a temp repo with
//! a local bare `origin`.

pub mod execution;
pub mod pr_opening;
mod definition;
pub mod edit;
pub mod settings;
mod check_discovery;
pub mod check_trial;
pub mod check_trials;
mod check_trial_process;
pub mod kit;
mod reaper;
pub mod alerts;
pub mod chief;
pub mod judge;
pub mod pr_watch;
pub mod replies;
pub mod revision;
pub mod slack_reply;
mod runner;
mod meta;
pub(crate) mod template;
pub mod test_guard;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{BoxFuture, FactoryTicket};

pub use crate::triage::{IssueComment, IssueContext, LinkedPr};

pub use definition::{built_in, parse_definition, Access, AgentDefinition, ChiefAgent, FactoryDefinition, ParentRules, PrMode, RepoConfig, Replies, ResolvedWorkflow, Revise, Role, Workflow, CHEAP_MODEL, AGENTS_DIR, DEFAULT_MAX_ROUNDS, DEFAULT_POLL_MINUTES, DEFAULT_STALL_MINUTES, FACTORY_FILE};
pub use reaper::{reap, reap_keeping, record_pr_outcome, ReapReport, KEEP_UNPUSHED};
pub use meta::{parent_rules, parse_github_repo, read_meta_definition, sub_repos};
pub use runner::{declined, parse_item_verdicts, revision_prompt, revision_review_prompt, revision_review_schema, implement_prompt, read_definition, read_definition_for, DEFAULT_IMPLEMENT_TIMEOUT, DEFAULT_SPEC_TIMEOUT, read_gate, FactoryConfig, FactoryRunner, DEFAULT_MAX_PARALLEL};

/// Implement attempts per run; red after the last one ends the run (ADR-0049 §7).
pub const MAX_ATTEMPTS: u32 = 2;
/// The label of every PR a Factory Run opens (ADR-0049 §4).
pub const REVIEW_LABEL: &str = "factory:review";
/// The repo's gate declaration, relative to the repo root.
pub const GATE_FILE: &str = FACTORY_FILE;

/// One implement attempt, run by the agent in the worktree with full access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImplementRequest {
    pub graph_run_id: String,
    pub execution: Option<execution::ProcessHandle>,
    pub ticket: FactoryTicket,
    pub worktree: PathBuf,
    /// 1-based.
    pub attempt: u32,
    /// From [`implement_prompt`]; carries the last gate output on a retry.
    pub prompt: String,
    /// Run it on this model (`--model`) instead of the preset's own.
    pub model: Option<String>,
    /// Its skills and MCP servers (FI4); `None` = whatever the agent has on its own.
    pub kit: Option<kit::KitPaths>,
    /// Where the agent's steps go ([`crate::ProgressEvent::Output`]), so a run that works is never
    /// called stalled.
    pub steps: crate::ProgressSink,
}

/// What an attempt cost, also when it failed (ADR-0049 §5e: every attempt counts).
#[derive(Debug, Clone, PartialEq)]
pub struct ImplementOutcome {
    pub result: Result<(), String>,
    pub cost_usd: Option<f64>,
    /// What the agent says it changed, why and how it checked; the draft PR's body carries the
    /// green attempt's.
    pub summary: Option<String>,
    /// The failure was a short outage (network, API 5xx), not the agent's own: the engine tries the
    /// attempt once more by itself (CoS 3). Never set on success.
    pub transient: bool,
}

/// The agent that edits the worktree. The app's adapter runs `CliAgentRunner` with `Access::Full`
/// and the worktree as its folder.
pub trait Implementer: Send + Sync {
    fn implement(&self, request: ImplementRequest) -> BoxFuture<ImplementOutcome>;
}

/// A Factory PR to open: Open or Draft (`draft`, chosen by [`pr_opening::decide`]), always [`REVIEW_LABEL`]; nothing else is ever sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftPr {
    pub repo: String,
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
    /// `gh pr create --draft`. False = opened ready for review.
    pub draft: bool,
}

/// Where a run's PR stands, for the reaper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrState {
    Open,
    Merged,
    Closed,
    /// No PR for this branch.
    Missing,
}

/// One turn of the spec agent (FI2) or of the triage agent (FI3): read-only, in the run's worktree, in one conversation that
/// later turns resume.
#[derive(Debug, Clone, PartialEq)]
pub struct SpecRequest {
    pub graph_run_id: String,
    pub execution: Option<execution::ProcessHandle>,
    pub ticket: FactoryTicket,
    pub worktree: PathBuf,
    /// The delegation preset: the spec agent's own, else the ticket's implementer.
    pub preset: String,
    /// Run it on this model (`--model`) instead of the preset's own.
    pub model: Option<String>,
    pub prompt: String,
    /// [`crate::intake::spec_reply_schema`]: the reply must validate against it.
    pub schema: serde_json::Value,
    pub session_id: String,
    /// Continue `session_id` (`--resume`) rather than start it.
    pub resume: bool,
    /// Its skills and MCP servers (FI4); `None` = none.
    pub kit: Option<kit::KitPaths>,
    /// Where the agent's steps go ([`crate::ProgressEvent::Output`]).
    pub steps: crate::ProgressSink,
}

/// What a spec turn replied and cost (also when it failed).
#[derive(Debug, Clone, PartialEq)]
pub struct SpecOutcome {
    pub reply: Result<serde_json::Value, String>,
    pub cost_usd: Option<f64>,
}

/// The agent that asks the user and writes the spec. The app's adapter runs `CliAgentRunner` with
/// read-only access in the worktree.
pub trait SpecAgent: Send + Sync {
    fn turn(&self, request: SpecRequest) -> BoxFuture<SpecOutcome>;
}

/// GitHub, as the account of the Ticket Source. The app's adapter uses `gh` (never a stored token).
pub trait PullRequests: Send + Sync {
    /// A token for `git push` over HTTPS as `account` (`gh auth token --user`).
    fn push_token(&self, account: &str) -> BoxFuture<Result<String, String>>;
    /// Opens `pr` (a Draft when `pr.draft`) with [`REVIEW_LABEL`]; returns its URL.
    fn open_draft(&self, account: &str, pr: DraftPr) -> BoxFuture<Result<String, String>>;
    /// The state of the PR whose head is `branch` in `repo`.
    fn state(&self, account: &str, repo: &str, branch: &str) -> BoxFuture<Result<PrState, String>>;
    /// The issue's state, labels and comments, and the open PRs that close it (FI3 triage).
    fn issue_context(&self, account: &str, repo: &str, issue: u64) -> BoxFuture<Result<IssueContext, String>>;
    /// The open PRs in `repo` whose title or body names `key` (a Notion ticket id, #168).
    fn prs_mentioning(&self, account: &str, repo: &str, key: &str) -> BoxFuture<Result<Vec<LinkedPr>, String>>;
    /// One REST GET of `path` (`repos/o/r/pulls/1/reviews`) as `account`, sent with
    /// `If-None-Match: etag` when there is one. A 304 is [`Fetched::Unchanged`], not an error. The
    /// Chief of Staff's typed readers ([`pr_watch::PrReader`]) sit on top of it.
    fn get(&self, account: &str, path: &str, etag: Option<&str>) -> BoxFuture<Result<Fetched, String>> {
        let _ = (account, etag);
        let path = path.to_string();
        Box::pin(async move { Err(format!("cannot read {path}: this GitHub port has no REST reads")) })
    }
    /// Replies under the review thread that line comment `comment_id` starts (CoS 9, ADR-0058).
    /// Returns the reply's id: the watcher must not read Lotus's own words as feedback.
    fn reply_in_thread(&self, account: &str, repo: &str, number: u64, comment_id: u64, body: &str) -> BoxFuture<Result<u64, String>> {
        let _ = (account, repo, number, comment_id, body);
        Box::pin(async { Err("this GitHub port cannot post".to_string()) })
    }
    /// Posts a comment on the PR itself. Returns its id.
    fn comment(&self, account: &str, repo: &str, number: u64, body: &str) -> BoxFuture<Result<u64, String>> {
        let _ = (account, repo, number, body);
        Box::pin(async { Err("this GitHub port cannot post".to_string()) })
    }
    /// Asks `reviewers` to review the PR again. Callers pass only people who reviewed it: Lotus
    /// never adds a reviewer. There is no writer that resolves a thread, by design (ADR-0058 §3).
    fn request_review(&self, account: &str, repo: &str, number: u64, reviewers: &[String]) -> BoxFuture<Result<(), String>> {
        let _ = (account, repo, number, reviewers);
        Box::pin(async { Err("this GitHub port cannot request a review".to_string()) })
    }
}

/// What one conditional GET returned.
#[derive(Debug, Clone, PartialEq)]
pub enum Fetched {
    /// 304: the same as the copy that `etag` names. Costs no rate limit.
    Unchanged,
    Changed { etag: Option<String>, body: serde_json::Value },
}

/// Written beside each worktree, so the reaper knows what it belongs to after a crash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sidecar {
    pub graph_run_id: String,
    pub repo: String,
    pub account: String,
    pub checkout: PathBuf,
    pub branch: String,
    /// Implement attempts that ran and failed the gate; a step run again continues after them.
    #[serde(default)]
    pub attempts_done: u32,
    /// The gate output of the last of them (the next attempt's prompt carries it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_gate_output: Option<String>,
    /// The worktree was made in full; a step run again during intake keeps it.
    #[serde(default)]
    pub worktree_ready: bool,
    /// The first implement attempt began: a crash in it leaves half an edit, so the worktree starts over.
    #[serde(default)]
    pub implement_started: bool,
    /// The reviewer sent the change back (FI7): what to fix. Set once; a run is sent back only once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// Set on a Revision Run (CoS 6): `branch` is then only the worktree's local branch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub round: Option<SidecarRound>,
}

/// The Factory PR a Revision Run's worktree belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarRound {
    /// The run that opened the PR.
    pub original: String,
    pub round: u32,
    /// The PR's branch on GitHub, which the round pushes to.
    pub pr_branch: String,
}

impl Sidecar {
    /// The branch whose PR this worktree serves: the PR's branch for a round, else its own.
    pub fn pr_branch(&self) -> &str {
        self.round.as_ref().map_or(&self.branch, |r| &r.pr_branch)
    }
}

/// `MISE_TRUSTED_CONFIG_PATHS` for the agent and the gate: the factory root first, then what was
/// already trusted. A fresh worktree's `mise.toml` is otherwise "not trusted", `mise env` fails and
/// the repo's tools (bun, node) are not on PATH (by-hand run #83, 2026-10-06). The config is the
/// repo's own, the same one its checkout already trusts.
pub fn mise_trusted_paths(existing: Option<&str>, root: &Path) -> String {
    match existing.filter(|e| !e.is_empty()) {
        Some(e) => format!("{}:{e}", root.display()),
        None => root.display().to_string(),
    }
}

/// `<root>/<graph_run_id>`: the worktree of one run. `root` is `<Lotus state dir>/factory`.
pub fn worktree_path(root: &Path, graph_run_id: &str) -> PathBuf {
    root.join(graph_run_id)
}

/// `<root>/<graph_run_id>.json`: its [`Sidecar`].
pub fn sidecar_path(root: &Path, graph_run_id: &str) -> PathBuf {
    root.join(format!("{graph_run_id}.json"))
}

/// `factory/<ticket>-<first 8 of the run id>`; the ticket is an issue number or a lowercased
/// Notion id (`tkt-123`), see [`FactoryTicket::slug`].
pub fn branch_name(ticket: impl std::fmt::Display, graph_run_id: &str) -> String {
    let short: String = graph_run_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    format!("factory/{ticket}-{short}")
}
