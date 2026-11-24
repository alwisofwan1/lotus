use serde_json::json;

use super::action::PrReviewConfig;
use super::{parse_pr_url, PrRef};
use crate::engine::{Engine, Submitted};
use crate::github::{GitHub, PullRequest};
use crate::model::Automation;
use crate::store::Store;

#[derive(Debug, thiserror::Error)]
pub enum RunNowError {
    #[error("{0:?} is not a GitHub pull request URL")]
    NotAPullRequestUrl(String),
    #[error("{0} is not a repository this automation watches")]
    RepoNotWatched(String),
    #[error("automation config is invalid: {0}")]
    BadConfig(String),
    /// The PR is closed, merged, a draft or the account's own: no run is worth starting.
    #[error("not reviewable: {0}")]
    NotReviewable(&'static str),
    #[error("GitHub: {0}")]
    GitHub(String),
    #[error(transparent)]
    Engine(#[from] crate::error::Error),
}

/// "Run now" for a PR URL. The unit of work is the PR at its current head
/// commit, so the same commit is not reviewed twice and a new commit is. When the PR was
/// asked about in Slack before (even if that run was skipped), the review
/// keeps that thread, so Send can still reply there.
pub async fn run_now(
    engine: &Engine,
    store: &Store,
    github: &dyn GitHub,
    automation: &Automation,
    url: &str,
) -> Result<Submitted, RunNowError> {
    let pr = parse_pr_url(url).ok_or_else(|| RunNowError::NotAPullRequestUrl(url.to_string()))?;
    let thread = store.pr_thread(&automation.id, &pr_key(&pr))?;
    submit_pr(engine, github, automation, &pr, thread).await
}

/// An explicit new round, including clarification without a new commit. Automatic head triggers
/// still use their original commit-based idempotency; each user click is a separate intention.
pub async fn review_again(
    engine: &Engine, store: &Store, github: &dyn GitHub, automation: &Automation,
    url: &str, feedback: &str,
) -> Result<Submitted, RunNowError> {
    if feedback.chars().count() > 4000 { return Err(RunNowError::BadConfig("review feedback exceeds 4000 characters".into())); }
    let pr = parse_pr_url(url).ok_or_else(|| RunNowError::NotAPullRequestUrl(url.to_string()))?;
    let thread = store.pr_thread(&automation.id, &pr_key(&pr))?;
    submit_round(engine, github, automation, &pr, thread, Some(feedback), None).await
}

/// How a PR is named in the store: `owner/repo#n`, repo lower-cased.
pub fn pr_key(pr: &PrRef) -> String {
    format!("{}#{}", pr.repo.to_ascii_lowercase(), pr.number)
}

/// Submits a review of `pr` at its current head. `slack` (channel, thread,
/// requester) rides along into the draft so a reply can find its thread.
pub async fn submit_pr(
    engine: &Engine,
    github: &dyn GitHub,
    automation: &Automation,
    pr: &PrRef,
    slack: Option<serde_json::Value>,
) -> Result<Submitted, RunNowError> {
    submit_round(engine, github, automation, pr, slack, None, None).await
}

/// A Slack feedback request uses the message identity, so event redelivery never creates another round.
pub async fn submit_round(
    engine: &Engine, github: &dyn GitHub, automation: &Automation, pr: &PrRef,
    slack: Option<serde_json::Value>, feedback: Option<&str>, event_id: Option<&str>,
) -> Result<Submitted, RunNowError> {
    let pr = pr.clone();
    let config: PrReviewConfig =
        serde_json::from_value(automation.action.config.clone()).map_err(|e| RunNowError::BadConfig(e.to_string()))?;
    if !super::repo_is_watched(&config.repos, &pr.repo) {
        return Err(RunNowError::RepoNotWatched(pr.repo));
    }
    let info = github.pull_request(&config.account, &pr).await.map_err(RunNowError::GitHub)?;
    let suffix = feedback.map(|_| event_id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
    let key = match suffix { Some(s) => format!("{}@{}:round:{s}", pr_key(&pr), info.head_sha), None => format!("{}#{}@{}", pr.repo, pr.number, info.head_sha) };
    let mut payload = json!({ "repo": pr.repo, "number": pr.number, "head_sha": info.head_sha, "url": pr.url() });
    if let Some(slack) = slack {
        payload["slack"] = slack;
    }
    if let Some(feedback) = feedback { payload["feedback"] = json!(feedback.chars().take(4000).collect::<String>()); }
    Ok(engine.submit(&automation.id, &key, payload).await?)
}

/// Whether `pr` is worth a run at all, asked before anything shows the request was taken: a
/// Slack mention of a merged PR must not get 👀. Returns the PR as GitHub has it now. The Review
/// button does not use this: it starts a run that skips with the reason, so the user sees why.
pub async fn precheck(github: &dyn GitHub, automation: &Automation, pr: &PrRef) -> Result<PullRequest, RunNowError> {
    let config: PrReviewConfig =
        serde_json::from_value(automation.action.config.clone()).map_err(|e| RunNowError::BadConfig(e.to_string()))?;
    if !super::repo_is_watched(&config.repos, &pr.repo) {
        return Err(RunNowError::RepoNotWatched(pr.repo.clone()));
    }
    let info = github.pull_request(&config.account, pr).await.map_err(RunNowError::GitHub)?;
    match super::action::not_reviewable(&config, &info) {
        Some(reason) => Err(RunNowError::NotReviewable(reason)),
        None => Ok(info),
    }
}
