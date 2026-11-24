//! The Chief of Staff's PR watcher (ADR-0056, "Watcher runtime"): it keeps looking at a Factory
//! PR after its run completed.
//!
//! The host calls [`PrWatcher::tick`] once a minute. A PR is polled when its repo's
//! `poll_minutes` has passed since its last poll, and every PR at once on the first tick after
//! the app starts (the catch-up). Every read is a conditional GET: an unchanged answer is a 304
//! and costs no rate limit. What is new since the last look is one log entry on the run; a merged
//! or closed PR is noted once and no longer watched.
//!
//! Each review, line comment, PR comment and failing CI check becomes a Feedback Item (CoS 5).
//! An item counts when its author is a requested reviewer, the PR's author, or has write access;
//! bots are dropped, CI always counts, and the rest is shown but never starts work. Counting items
//! wait in an open batch. A submitted review (Request changes or Comment) or a CI run that finishes
//! closes it; loose comments close it after [`QUIET_MINUTES`] with nothing new. The [`Judge`]
//! labels a closed batch's comments. With rounds set up ([`PrWatcher::with_rounds`]) the routing
//! rule ([`route`]) then starts a Revision Run by itself or sends the batch to Needs you (CoS 7);
//! without, every batch goes to Needs you.
//!
//! Only runs in this Mac's store are watched, so a `factory:review` PR another Mac opened is
//! never touched. The watcher never writes to GitHub. Its only engine action is the automatic round
//! (ADR-0056 §5).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::definition::Replies;
use super::alerts::Notifier;
use super::replies::{self, Outgoing};
use super::slack_reply::{self, SlackIdentities};
use super::judge::{judge_context, judge_schema, parse_verdicts, Judge, JudgeRequest, JudgeTask, CONFIDENT};
use super::revision::{ci_only, has_open_round, reconcile_rounds, route, start_round_held, PrEdits, Route, RoundPolicies};
use super::{Fetched, PullRequests, DEFAULT_POLL_MINUTES};
use crate::{
    BatchReason, ChecksState, ChiefEntry, ChiefOfStaffLog, ChiefSignal, Engine, FactoryTicket, FeedbackBatch, FeedbackItem, FeedbackLabel,
    FeedbackSource, GraphRunRecord, ItemStatus, LabelBy, PrOutcome, PrPhase, PrSeen, PrWatch, RoundEnd, RunStore,
};

/// Loose comments close their batch after this long with nothing new.
pub const QUIET_MINUTES: i64 = 10;

/// A read and whether GitHub sent something new (`false` = a 304, the cached copy).
#[derive(Debug, Clone, PartialEq)]
pub struct Read<T> {
    pub changed: bool,
    pub value: T,
}

/// Who wrote a review or comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub login: String,
    /// GitHub says the account is a bot (`user.type == "Bot"`).
    pub bot: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullInfo {
    pub number: u64,
    pub url: String,
    /// "open" or "closed".
    pub state: String,
    pub merged: bool,
    pub draft: bool,
    pub head_sha: String,
    /// The head branch's name.
    pub head_ref: String,
    /// Who opened it: their comments count.
    pub author: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub id: u64,
    pub author: Author,
    /// APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED or PENDING.
    pub state: String,
    pub body: String,
    pub commit_id: String,
}

/// A line comment. A reply names the thread's first comment in `in_reply_to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewComment {
    pub id: u64,
    pub in_reply_to: Option<u64>,
    pub review_id: Option<u64>,
    pub author: Author,
    pub body: String,
    pub path: String,
    pub line: Option<u64>,
}

/// A comment on the PR itself (GitHub keeps them as issue comments).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrComment {
    pub id: u64,
    pub author: Author,
    pub body: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestedReviewers {
    pub users: Vec<String>,
    pub teams: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckRun {
    pub id: u64,
    pub name: String,
    /// queued, in_progress or completed.
    pub status: String,
    /// Set once completed: success, failure, timed_out, cancelled, skipped …
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
}

/// The combined commit status (CI that does not use check runs).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommitStatus {
    /// pending, success or failure.
    pub state: String,
    /// How many statuses it combines; 0 = no such CI.
    pub count: usize,
}

/// One page of each list is read (100 items): more than one PR's feedback holds.
const PAGE: &str = "per_page=100";

/// Typed REST reads over [`PullRequests::get`], each conditional on the ETag of its last answer.
pub struct PrReader {
    prs: Arc<dyn PullRequests>,
    /// `account path` → the last answer and its ETag.
    cache: Mutex<HashMap<String, (String, Value)>>,
}

impl PrReader {
    pub fn new(prs: Arc<dyn PullRequests>) -> Self {
        Self { prs, cache: Mutex::default() }
    }

    async fn read(&self, account: &str, path: &str) -> Result<Read<Value>, String> {
        let key = format!("{account} {path}");
        let etag = self.cache.lock().unwrap_or_else(|p| p.into_inner()).get(&key).map(|(etag, _)| etag.clone());
        match self.prs.get(account, path, etag.as_deref()).await? {
            Fetched::Unchanged => {
                let cached = self.cache.lock().unwrap_or_else(|p| p.into_inner()).get(&key).map(|(_, body)| body.clone());
                cached.map(|value| Read { changed: false, value }).ok_or_else(|| format!("GitHub said {path} is unchanged, but there is no copy of it"))
            }
            Fetched::Changed { etag, body } => {
                let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
                match etag {
                    Some(etag) => cache.insert(key, (etag, body.clone())),
                    None => cache.remove(&key),
                };
                Ok(Read { changed: true, value: body })
            }
        }
    }

    async fn list<T>(&self, account: &str, path: &str, item: impl Fn(&Value) -> Option<T>) -> Result<Read<Vec<T>>, String> {
        let read = self.read(account, path).await?;
        let items = read.value.as_array().ok_or_else(|| format!("{path}: GitHub sent no list"))?;
        Ok(Read { changed: read.changed, value: items.iter().filter_map(item).collect() })
    }

    pub async fn pull(&self, account: &str, repo: &str, number: u64) -> Result<Read<PullInfo>, String> {
        let path = format!("repos/{repo}/pulls/{number}");
        let read = self.read(account, &path).await?;
        let v = &read.value;
        let info = PullInfo {
            number: v["number"].as_u64().unwrap_or(number),
            url: text(&v["html_url"]),
            state: text(&v["state"]),
            merged: v["merged"].as_bool().unwrap_or(false) || v["merged_at"].is_string(),
            draft: v["draft"].as_bool().unwrap_or(false),
            head_sha: text(&v["head"]["sha"]),
            head_ref: text(&v["head"]["ref"]),
            author: text(&v["user"]["login"]),
        };
        if info.state.is_empty() {
            return Err(format!("{path}: GitHub sent no PR state"));
        }
        Ok(Read { changed: read.changed, value: info })
    }

    pub async fn reviews(&self, account: &str, repo: &str, number: u64) -> Result<Read<Vec<Review>>, String> {
        self.list(account, &format!("repos/{repo}/pulls/{number}/reviews?{PAGE}"), |v| {
            Some(Review { id: v["id"].as_u64()?, author: author(v), state: text(&v["state"]), body: text(&v["body"]), commit_id: text(&v["commit_id"]) })
        })
        .await
    }

    pub async fn review_comments(&self, account: &str, repo: &str, number: u64) -> Result<Read<Vec<ReviewComment>>, String> {
        self.list(account, &format!("repos/{repo}/pulls/{number}/comments?{PAGE}"), |v| {
            Some(ReviewComment {
                id: v["id"].as_u64()?,
                in_reply_to: v["in_reply_to_id"].as_u64(),
                review_id: v["pull_request_review_id"].as_u64(),
                author: author(v),
                body: text(&v["body"]),
                path: text(&v["path"]),
                line: v["line"].as_u64().or_else(|| v["original_line"].as_u64()),
            })
        })
        .await
    }

    pub async fn comments(&self, account: &str, repo: &str, number: u64) -> Result<Read<Vec<PrComment>>, String> {
        self.list(account, &format!("repos/{repo}/issues/{number}/comments?{PAGE}"), |v| {
            Some(PrComment { id: v["id"].as_u64()?, author: author(v), body: text(&v["body"]) })
        })
        .await
    }

    pub async fn requested_reviewers(&self, account: &str, repo: &str, number: u64) -> Result<Read<RequestedReviewers>, String> {
        let read = self.read(account, &format!("repos/{repo}/pulls/{number}/requested_reviewers")).await?;
        let names = |key: &str, field: &str| -> Vec<String> {
            read.value[key].as_array().map(|a| a.iter().map(|u| text(&u[field])).filter(|s| !s.is_empty()).collect()).unwrap_or_default()
        };
        let value = RequestedReviewers { users: names("users", "login"), teams: names("teams", "slug") };
        Ok(Read { changed: read.changed, value })
    }

    pub async fn check_runs(&self, account: &str, repo: &str, sha: &str) -> Result<Read<Vec<CheckRun>>, String> {
        let read = self.read(account, &format!("repos/{repo}/commits/{sha}/check-runs?{PAGE}")).await?;
        let runs = read.value["check_runs"].as_array().map(|runs| {
            runs.iter()
                .filter_map(|v| {
                    Some(CheckRun {
                        id: v["id"].as_u64()?,
                        name: text(&v["name"]),
                        status: text(&v["status"]),
                        conclusion: v["conclusion"].as_str().map(str::to_string),
                        details_url: v["details_url"].as_str().map(str::to_string),
                    })
                })
                .collect()
        });
        Ok(Read { changed: read.changed, value: runs.unwrap_or_default() })
    }

    pub async fn commit_status(&self, account: &str, repo: &str, sha: &str) -> Result<Read<CommitStatus>, String> {
        let read = self.read(account, &format!("repos/{repo}/commits/{sha}/status")).await?;
        let count = read.value["statuses"].as_array().map_or(0, Vec::len);
        Ok(Read { changed: read.changed, value: CommitStatus { state: text(&read.value["state"]), count } })
    }

    /// `admin`, `write`, `read` or `none` (CoS 5's author filter).
    pub async fn permission(&self, account: &str, repo: &str, user: &str) -> Result<Read<String>, String> {
        let read = self.read(account, &format!("repos/{repo}/collaborators/{user}/permission")).await?;
        Ok(Read { changed: read.changed, value: text(&read.value["permission"]) })
    }
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

fn author(v: &Value) -> Author {
    Author { login: text(&v["user"]["login"]), bot: v["user"]["type"].as_str() == Some("Bot") }
}

/// The check runs and the combined status of one commit, as one state. `None` = no CI at all.
pub fn checks_state(runs: &[CheckRun], status: &CommitStatus) -> Option<ChecksState> {
    const RED: [&str; 5] = ["failure", "timed_out", "action_required", "cancelled", "startup_failure"];
    let red = runs.iter().any(|r| r.conclusion.as_deref().is_some_and(|c| RED.contains(&c)))
        || (status.count > 0 && matches!(status.state.as_str(), "failure" | "error"));
    let pending = runs.iter().any(|r| r.status != "completed") || (status.count > 0 && status.state == "pending");
    if red {
        Some(ChecksState::Failing)
    } else if pending {
        Some(ChecksState::Pending)
    } else if !runs.is_empty() || status.count > 0 {
        Some(ChecksState::Passing)
    } else {
        None
    }
}

/// What one tick did.
#[derive(Debug, Default)]
pub struct PrTick {
    /// Runs whose PR was polled.
    pub polled: Vec<String>,
    /// Records this tick wrote (a new note, a new phase): the host says they changed.
    pub changed: Vec<GraphRunRecord>,
    /// Runs whose poll failed, and why. Tried again at their next poll; a failed catch-up at the
    /// next tick.
    pub failed: Vec<(String, String)>,
}

pub struct PrWatcher {
    store: Arc<dyn RunStore>,
    reader: PrReader,
    /// Labels a closed batch. `None`: every comment is unsure.
    judge: Option<Arc<dyn Judge>>,
    /// Run id → Unix ms of its last poll. In memory: after a restart every PR is due at once.
    polled: Mutex<HashMap<String, i64>>,
    caught_up: AtomicBool,
    /// Held while one PR's record is read, changed and saved; a round start holds it too.
    edits: PrEdits,
    /// Starts a round by itself when the routing rule says so. `None`: every batch needs you.
    rounds: Option<(Arc<Engine>, Arc<dyn RoundPolicies>)>,
    /// Drafts and sends the Slack thread reply of a round (CoS 12). `None`: no Slack message.
    slack: Option<(Arc<dyn Notifier>, Arc<dyn SlackIdentities>)>,
}

/// A batch that just closed, before it is routed.
struct Closed {
    batch: u32,
    reason: BatchReason,
    ids: Vec<String>,
}

/// What the routing rule decided for a closed batch.
struct Routed {
    /// The log note: the batch, and the decision with its reason.
    text: String,
    /// Raised to Needs you, or only said.
    raise: bool,
    out_of_rounds: bool,
    /// Cap and `max_rounds` of the round to start.
    start: Option<(f64, u32)>,
    /// How the round came to start, for its log note.
    why: String,
    /// It starts on failing CI alone.
    ci_only: bool,
}

impl PrWatcher {
    pub fn new(store: Arc<dyn RunStore>, prs: Arc<dyn PullRequests>) -> Self {
        Self {
            store,
            reader: PrReader::new(prs),
            judge: None,
            polled: Mutex::default(),
            caught_up: AtomicBool::new(false),
            edits: PrEdits::default(),
            rounds: None,
            slack: None,
        }
    }

    /// Lets a closed batch start its round by itself, through `engine`, when the repo's policy and
    /// the routing rule allow it (CoS 7).
    pub fn with_rounds(mut self, engine: Arc<Engine>, policies: Arc<dyn RoundPolicies>) -> Self {
        self.rounds = Some((engine, policies));
        self
    }

    /// The lock a round start shares with this watcher ([`super::revision::start_round`]).
    pub fn with_edits(mut self, edits: PrEdits) -> Self {
        self.edits = edits;
        self
    }

    /// Drafts a Slack reply in the thread the PR's link was shared in after each round (CoS 12).
    pub fn with_slack(mut self, notifier: Arc<dyn Notifier>, identities: Arc<dyn SlackIdentities>) -> Self {
        self.slack = Some((notifier, identities));
        self
    }

    pub fn with_judge(mut self, judge: Arc<dyn Judge>) -> Self {
        self.judge = Some(judge);
        self
    }

    /// The typed reads, for the rules that come after this watcher (CoS 5).
    pub fn reader(&self) -> &PrReader {
        &self.reader
    }

    /// One look at every watched Factory PR that is due. `now` is Unix ms.
    pub async fn tick(&self, now: i64) -> Result<PrTick, String> {
        let catch_up = !self.caught_up.load(Ordering::Relaxed);
        let records = self.store.list_completed().map_err(|e| e.to_string())?;
        let mut report = PrTick::default();
        let mut all_answered = true;
        for listed in records {
            let _held = self.edits.lock().await;
            // Read again under the lock: a round may have started since the list was read.
            let Some(record) = self.store.get(&listed.id).map_err(|e| e.to_string())? else { continue };
            // A round that ended goes onto its PR first, whether or not the PR is due.
            let record = if has_open_round(&record) {
                match reconcile_rounds(self.store.as_ref(), &record.id, now) {
                    Ok(Some(saved)) => {
                        report.changed.push(saved.clone());
                        saved
                    }
                    Ok(None) => record,
                    Err(why) => {
                        report.failed.push((record.id.clone(), why));
                        record
                    }
                }
            } else {
                record
            };
            // A round that pushed gets its reply drafts (CoS 9).
            let record = if needs_drafts(&record) {
                match self.draft_replies(record.clone(), now).await {
                    Ok(saved) => {
                        report.changed.push(saved.clone());
                        saved
                    }
                    Err(why) => {
                        report.failed.push((record.id.clone(), why));
                        record
                    }
                }
            } else {
                record
            };
            let Some(target) = watched(&record) else { continue };
            let poll_ms = i64::from(poll_minutes(&record)) * 60_000;
            let last = self.polled.lock().unwrap_or_else(|p| p.into_inner()).get(&record.id).copied();
            if !catch_up && last.is_some_and(|at| now - at < poll_ms) {
                // Not due for GitHub, but loose comments may have gone quiet: that needs no read.
                if quiet_since(&record).is_some_and(|at| now - at >= QUIET_MINUTES * 60_000) {
                    match self.close_quiet(record, now).await {
                        Ok(Some(record)) => report.changed.push(record),
                        Ok(None) => {}
                        Err((id, why)) => report.failed.push((id, why)),
                    }
                }
                continue;
            }
            match self.poll(record, &target, now, catch_up).await {
                Ok((id, changed)) => {
                    self.polled.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), now);
                    report.polled.push(id);
                    report.changed.extend(changed);
                }
                Err((id, why)) => {
                    // Tried again at its next poll, not every minute: GitHub may be limiting us.
                    self.polled.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), now);
                    all_answered = false;
                    report.failed.push((id, why));
                }
            }
        }
        // A catch-up that GitHub did not fully answer runs again at the next tick.
        if all_answered {
            self.caught_up.store(true, Ordering::Relaxed);
        }
        Ok(report)
    }

    /// Drafts the replies of every round that pushed and has none, then raises Needs you, or, under
    /// `replies = "auto-addressed"`, sends what may go by itself. Called with [`PrEdits`] held.
    async fn draft_replies(&self, mut record: GraphRunRecord, now: i64) -> Result<GraphRunRecord, String> {
        let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
        let ticket = meta.factory.clone().ok_or("the run is not a Factory Run")?;
        let watch = meta.pr_watch.as_mut().ok_or("the PR is not watched")?;
        let policy = match &self.rounds {
            Some((_, policies)) => policies.policy(&ticket).await.ok(),
            None => None,
        };
        let (mode, footer) = policy.map_or((Replies::Draft, None), |p| (p.replies, p.reply_footer));
        let mut drafted = Vec::new();
        let mut fallbacks = Vec::new();
        let mut on_slack = Vec::new();
        for at in 0..watch.rounds.len() {
            let round = &watch.rounds[at];
            if round.ended != Some(RoundEnd::Pushed) || round.drafted {
                continue;
            }
            let n = round.round;
            if let Some(why) = replies::draft_round(self.judge.as_deref(), &ticket, watch, at).await {
                fallbacks.push(format!("round {n}: {why}"));
            }
            if let Some((notifier, identities)) = &self.slack {
                on_slack.push((n, slack_reply::draft(notifier.as_ref(), identities.as_ref(), watch, at).await));
            }
            drafted.push(n);
        }
        let log = meta.chief.get_or_insert_with(ChiefOfStaffLog::default);
        for why in &fallbacks {
            log.say(now, format!("Plain replies were drafted instead, {why}."));
        }
        let unknown: Vec<String> = on_slack.into_iter().flat_map(|(n, found)| slack_reply::log_drafted(log, now, n, found)).collect();
        self.store.save(&record).map_err(|e| e.to_string())?;
        if mode == Replies::AutoAddressed {
            for n in &drafted {
                let sent = replies::send_held(self.store.as_ref(), self.reader.prs.as_ref(), self.slack.as_ref().map(|(n, _)| n.as_ref()), &record.id, Outgoing::Auto(*n), footer.as_deref(), now).await;
                record = match sent {
                    Ok((saved, _)) => saved,
                    // send_held saved the failure on the log and raised Needs you.
                    Err(_) => self.store.get(&record.id).map_err(|e| e.to_string())?.ok_or("the run is gone")?,
                };
            }
        }
        let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
        if meta.pr_watch.as_ref().is_some_and(|w| !replies::unsent(w).is_empty()) {
            let rounds: Vec<String> = drafted.iter().map(u32::to_string).collect();
            let text = format!("Round {} replies are drafted: check them and press Send all.", rounds.join(", "));
            replies::raise(meta.chief.get_or_insert_with(ChiefOfStaffLog::default), now, text);
            self.store.save(&record).map_err(|e| e.to_string())?;
        }
        // Asked after "drafted", so the question is the newest Needs-you note.
        if !unknown.is_empty() {
            let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
            slack_reply::ask_who(meta.chief.get_or_insert_with(ChiefOfStaffLog::default), now, &unknown);
            self.store.save(&record).map_err(|e| e.to_string())?;
        }
        Ok(record)
    }

    async fn poll(&self, mut record: GraphRunRecord, target: &Target, now: i64, catch_up: bool) -> Result<(String, Option<GraphRunRecord>), (String, String)> {
        let id = record.id.clone();
        let fail = |why: String| (id.clone(), why);
        let reader = &self.reader;
        let (account, repo, number) = (target.account.as_str(), target.repo.as_str(), target.number);
        let pull = reader.pull(account, repo, number).await.map_err(fail)?.value;
        let before = record.checkpoint.engine.as_ref().and_then(|m| m.pr_watch.clone());
        let mut watch = before.clone().unwrap_or(PrWatch {
            number,
            url: target.url.clone(),
            phase: PrPhase::InReview,
            seen: PrSeen::default(),
            feedback: Vec::new(),
            batches: Vec::new(),
            rounds: Vec::new(),
            max_rounds: None,
            posted: Vec::new(),
            branch: None,
        });
        if !pull.head_ref.is_empty() {
            watch.branch = Some(pull.head_ref.clone());
        }
        let mut news = Vec::new();
        let mut closes = None;
        let mut ended = false;
        if pull.merged || pull.state == "closed" {
            let (phase, outcome) = if pull.merged { (PrPhase::Merged, PrOutcome::Merged) } else { (PrPhase::Closed, PrOutcome::Closed) };
            watch.phase = phase;
            ended = true;
            news.push(if pull.merged { "the PR was merged".to_string() } else { "the PR was closed without a merge".to_string() });
            if let Some(meta) = record.checkpoint.engine.as_mut() {
                meta.pr = Some(outcome);
            }
        } else {
            let reviews = reader.reviews(account, repo, number).await.map_err(fail)?.value;
            let lines = reader.review_comments(account, repo, number).await.map_err(fail)?.value;
            let comments = reader.comments(account, repo, number).await.map_err(fail)?.value;
            let runs = reader.check_runs(account, repo, &pull.head_sha).await.map_err(fail)?.value;
            let status = reader.commit_status(account, repo, &pull.head_sha).await.map_err(fail)?.value;
            let seen = watch.seen.clone();
            // A pending review is the reviewer's draft: GitHub shows it to nobody else yet.
            let new_reviews: Vec<&Review> = reviews.iter().filter(|r| r.id > seen.review && r.state != "PENDING").collect();
            let new_lines: Vec<&ReviewComment> = lines.iter().filter(|c| c.id > seen.review_comment).collect();
            let new_comments: Vec<&PrComment> = comments.iter().filter(|c| c.id > seen.comment).collect();
            if let Some(review) = new_reviews.iter().map(|r| r.id).max() {
                watch.seen.review = review;
            }
            watch.seen.review_comment = lines.iter().map(|c| c.id).max().unwrap_or(0).max(seen.review_comment);
            watch.seen.comment = comments.iter().map(|c| c.id).max().unwrap_or(0).max(seen.comment);
            news.extend(review_news(&new_reviews));
            news.extend(count(new_lines.len(), "line comment"));
            news.extend(count(new_comments.len(), "comment"));
            let checks = checks_state(&runs, &status);
            let checks_finished = checks != seen.checks && matches!(checks, Some(ChecksState::Passing | ChecksState::Failing));
            if checks != seen.checks {
                match checks {
                    Some(ChecksState::Failing) => news.push("checks failing".into()),
                    Some(ChecksState::Passing) if seen.checks.is_some() => news.push("checks passing".into()),
                    _ => {}
                }
                watch.seen.checks = checks;
            }
            if watch.phase.is_ended() {
                // Reopened.
                watch.phase = PrPhase::InReview;
            }

            // Feedback Items. A bot's words are dropped; its checks are not.
            let mut found = Vec::new();
            for r in new_reviews.iter().filter(|r| !r.author.bot && !r.body.trim().is_empty()) {
                found.push(item(format!("review:{}", r.id), FeedbackSource::Review, &r.author.login, &r.body, now));
            }
            for c in new_lines.iter().filter(|c| !c.author.bot) {
                let mut line = item(format!("line:{}", c.id), FeedbackSource::ReviewComment, &c.author.login, &c.body, now);
                (line.path, line.line) = (Some(c.path.clone()).filter(|p| !p.is_empty()), c.line);
                found.push(line);
            }
            for c in new_comments.iter().filter(|c| !c.author.bot) {
                found.push(item(format!("comment:{}", c.id), FeedbackSource::PrComment, &c.author.login, &c.body, now));
            }
            let mut authors: Vec<&str> = found.iter().map(|i| i.author.as_str()).collect();
            authors.extend(new_reviews.iter().filter(|r| !r.author.bot).map(|r| r.author.login.as_str()));
            let counting = self.author_filter(account, repo, number, &pull.author, authors).await.map_err(fail)?;
            for found in &mut found {
                found.counts = counting.contains(&found.author);
            }
            if checks_finished && checks == Some(ChecksState::Failing) {
                found.extend(check_items(&runs, &status, &pull.head_sha, now));
            }
            found.retain(|f| !watch.feedback.iter().any(|old| old.id == f.id) && !watch.posted.contains(&f.id));
            watch.feedback.extend(found);

            // What closes the open batch.
            let review_closes = new_reviews
                .iter()
                .any(|r| matches!(r.state.as_str(), "CHANGES_REQUESTED" | "COMMENTED") && counting.contains(&r.author.login));
            closes = if review_closes {
                Some(BatchReason::Review)
            } else if checks_finished {
                Some(BatchReason::Checks)
            } else if open_items(&watch).map(|i| i.at).max().is_some_and(|at| now - at >= QUIET_MINUTES * 60_000) {
                Some(BatchReason::Quiet)
            } else {
                None
            };
        }
        let ticket = record.checkpoint.engine.as_ref().and_then(|m| m.factory.clone());
        let cap = record.checkpoint.engine.as_ref().and_then(|m| m.budget_cap);
        let routed = match (closes, ticket) {
            (Some(reason), Some(ticket)) => match self.close_batch(&mut watch, &ticket, reason, now).await {
                Some(closed) => Some(self.route_batch(&watch, &ticket, &closed, cap).await),
                None => None,
            },
            _ => None,
        };
        if routed.as_ref().is_some_and(|r| r.out_of_rounds) {
            watch.phase = PrPhase::OutOfRounds;
        }
        if before.as_ref() == Some(&watch) && news.is_empty() {
            return Ok((id, None));
        }
        // The Judge may have taken a while: keep a label the user set in the pane meanwhile.
        keep_user_labels(self.store.as_ref(), &id, &mut watch).map_err(fail)?;
        let meta = record.checkpoint.engine.as_mut().ok_or_else(|| fail("the run has no engine data".into()))?;
        let log = meta.chief.get_or_insert_with(ChiefOfStaffLog::default);
        if !news.is_empty() {
            let lead = if catch_up { "While you were away" } else { "New on the PR" };
            log.say(now, format!("{lead}: {}.", news.join(", ")));
        }
        if let Some(routed) = &routed {
            note_route(log, now, routed);
        }
        if ended && log.is_open(ChiefSignal::Feedback) {
            log.note(ChiefEntry { at: now, signal: Some(ChiefSignal::Feedback), raised: false, text: "The PR ended: its feedback needs nothing more.".into() });
        }
        meta.pr_watch = Some(watch);
        self.store.save(&record).map_err(|e| fail(e.to_string()))?;
        let record = self.start_routed(record, routed.as_ref(), now).await.map_err(fail)?;
        Ok((id, Some(record)))
    }

    /// The logins among `authors` whose words count: the PR's author, a requested reviewer, or
    /// someone with write access. Each is asked about once per poll.
    async fn author_filter(&self, account: &str, repo: &str, number: u64, pr_author: &str, authors: Vec<&str>) -> Result<Vec<String>, String> {
        let mut counting = Vec::new();
        let mut asked: Vec<&str> = Vec::new();
        let mut requested: Option<Vec<String>> = None;
        for login in authors {
            if asked.contains(&login) {
                continue;
            }
            asked.push(login);
            let counts = if login == pr_author {
                true
            } else {
                if requested.is_none() {
                    requested = Some(self.reader.requested_reviewers(account, repo, number).await?.value.users);
                }
                requested.as_ref().is_some_and(|r| r.iter().any(|u| u == login))
                    // GitHub answers no permission for someone outside the repo: that is not write.
                    || matches!(self.reader.permission(account, repo, login).await.map(|r| r.value).as_deref(), Ok("admin" | "maintain" | "write"))
            };
            if counts {
                counting.push(login.to_string());
            }
        }
        Ok(counting)
    }

    /// Closes the open batch: the Judge labels its comments, and every item waits for the user
    /// until the routing rule says otherwise. `None` when nothing was open.
    async fn close_batch(&self, watch: &mut PrWatch, ticket: &FactoryTicket, reason: BatchReason, now: i64) -> Option<Closed> {
        let ids: Vec<String> = open_items(watch).map(|i| i.id.clone()).collect();
        if ids.is_empty() {
            return None;
        }
        let batch = watch.batches.len() as u32 + 1;
        let to_judge: Vec<&FeedbackItem> = watch.feedback.iter().filter(|i| ids.contains(&i.id) && i.source != FeedbackSource::Check).collect();
        let verdicts = if to_judge.is_empty() {
            Ok(HashMap::new())
        } else if let Some(judge) = &self.judge {
            let asked: Vec<&str> = to_judge.iter().map(|i| i.id.as_str()).collect();
            let request = JudgeRequest { task: JudgeTask::Label, ticket: ticket.clone(), items: asked.iter().map(|i| i.to_string()).collect(), context: judge_context(ticket, &watch.url, &to_judge), schema: judge_schema() };
            match judge.judge(request).await {
                Ok(reply) => parse_verdicts(&reply, &asked).map_err(|why| format!("the Judge's reply was not valid: {why}")),
                Err(why) => Err(format!("the Judge failed: {why}")),
            }
        } else {
            Err("no Judge is set up".to_string())
        };
        for item in watch.feedback.iter_mut().filter(|i| ids.contains(&i.id)) {
            item.batch = Some(batch);
            // Waits for the user; a round started by the routing rule takes it.
            item.status = ItemStatus::NeedsYou;
            if item.source == FeedbackSource::Check {
                continue;
            }
            match &verdicts {
                Ok(v) => {
                    let (label, confidence) = v[&item.id];
                    (item.label, item.confidence, item.label_by) = (Some(label), Some(confidence), Some(LabelBy::Model));
                    item.unsure = (confidence < CONFIDENT).then(|| format!("the Judge is not sure ({confidence:.2})"));
                }
                Err(why) => item.unsure = Some(why.clone()),
            }
        }
        watch.batches.push(FeedbackBatch { id: batch, closed_at: now, reason, items: ids.clone() });
        Some(Closed { batch, reason, ids })
    }

    /// The routing rule on a batch that just closed (CoS 7). Without rounds set up, it needs you.
    async fn route_batch(&self, watch: &PrWatch, ticket: &FactoryTicket, closed: &Closed, run_cap: Option<f64>) -> Routed {
        let items: Vec<&FeedbackItem> = watch.feedback.iter().filter(|i| closed.ids.contains(&i.id)).collect();
        let (batch, reason) = (closed.batch, closed.reason);
        let needs_you = |why: Option<String>| {
            let mut text = batch_note(batch, reason, "needs you", &items);
            if let Some(why) = why {
                text.push_str(&format!(" {}.", capital(&why)));
            }
            Routed { text, raise: true, out_of_rounds: false, start: None, why: String::new(), ci_only: false }
        };
        let Some((_, policies)) = &self.rounds else { return needs_you(None) };
        let policy = match policies.policy(ticket).await {
            Ok(policy) => policy,
            Err(why) => return needs_you(Some(format!("no round starts by itself: cannot read the factory's round settings: {why}"))),
        };
        match route(&items, watch, &policy) {
            Route::Start(why) => match policy.cap_usd.or(run_cap) {
                Some(cap) => Routed {
                    text: format!("{} A round starts by itself: {why}.", batch_note(batch, reason, "goes to a round", &items)),
                    raise: false,
                    out_of_rounds: false,
                    start: Some((cap, policy.max_rounds)),
                    why: format!(" by itself ({why})"),
                    ci_only: ci_only(&items),
                },
                None => needs_you(Some("no round starts by itself: the repo has no cap_usd and the PR's run had no cap".into())),
            },
            Route::NeedsYou(why) => needs_you(Some(why)),
            Route::OutOfRounds(why) => {
                let text = format!("{} {}.", batch_note(batch, reason, "is out of rounds", &items), capital(&why));
                Routed { text, raise: true, out_of_rounds: true, start: None, why: String::new(), ci_only: false }
            }
            Route::Nothing(why) => {
                let text = format!("{} {}.", batch_note(batch, reason, "needs nothing", &items), capital(&why));
                Routed { text, raise: false, out_of_rounds: false, start: None, why: String::new(), ci_only: false }
            }
        }
    }

    /// Starts the round the routing rule chose, on the record just saved. A refused start goes to
    /// Needs you with the engine's reason. Needs [`PrEdits`] held by the caller.
    async fn start_routed(&self, record: GraphRunRecord, routed: Option<&Routed>, now: i64) -> Result<GraphRunRecord, String> {
        let (Some((engine, _)), Some(Routed { start: Some((cap, max_rounds)), why, .. })) = (&self.rounds, routed) else { return Ok(record) };
        let ci = routed.is_some_and(|r| r.ci_only);
        match start_round_held(engine, self.store.as_ref(), &record.id, *cap, *max_rounds, now, why, ci).await {
            Ok((_, saved)) => Ok(saved),
            Err(refused) => {
                let mut record = self.store.get(&record.id).map_err(|e| e.to_string())?.ok_or("the run is gone")?;
                let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
                raise_feedback(meta.chief.get_or_insert_with(ChiefOfStaffLog::default), now, format!("The round could not start by itself and needs you: {refused}"));
                self.store.save(&record).map_err(|e| e.to_string())?;
                Ok(record)
            }
        }
    }

    /// The quiet window closed with no GitHub read: the batch closes on what is already stored.
    async fn close_quiet(&self, mut record: GraphRunRecord, now: i64) -> Result<Option<GraphRunRecord>, (String, String)> {
        let id = record.id.clone();
        let Some(meta) = record.checkpoint.engine.as_mut() else { return Ok(None) };
        let (Some(mut watch), Some(ticket)) = (meta.pr_watch.clone(), meta.factory.clone()) else { return Ok(None) };
        let Some(closed) = self.close_batch(&mut watch, &ticket, BatchReason::Quiet, now).await else { return Ok(None) };
        let routed = self.route_batch(&watch, &ticket, &closed, meta.budget_cap).await;
        keep_user_labels(self.store.as_ref(), &id, &mut watch).map_err(|why| (id.clone(), why))?;
        note_route(meta.chief.get_or_insert_with(ChiefOfStaffLog::default), now, &routed);
        if routed.out_of_rounds {
            watch.phase = PrPhase::OutOfRounds;
        }
        meta.pr_watch = Some(watch);
        self.store.save(&record).map_err(|e| (id.clone(), e.to_string()))?;
        let record = self.start_routed(record, Some(&routed), now).await.map_err(|why| (id.clone(), why))?;
        Ok(Some(record))
    }
}

/// Sets an item's label as the user chose it in the pane. The record, for the host to emit.
pub fn set_feedback_label(store: &dyn RunStore, run_id: &str, item_id: &str, label: FeedbackLabel) -> Result<GraphRunRecord, String> {
    let mut record = store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let item = record
        .checkpoint
        .engine
        .as_mut()
        .and_then(|m| m.pr_watch.as_mut())
        .and_then(|w| w.feedback.iter_mut().find(|i| i.id == item_id))
        .ok_or_else(|| format!("the run has no feedback item {item_id}"))?;
    (item.label, item.confidence, item.label_by, item.unsure) = (Some(label), None, Some(LabelBy::You), None);
    store.save(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Copies into `watch` every label the user set on the stored record since the watcher read it,
/// so a save after a slow Judge call never drops the user's edit.
fn keep_user_labels(store: &dyn RunStore, run_id: &str, watch: &mut PrWatch) -> Result<(), String> {
    let stored = store.get(run_id).map_err(|e| e.to_string())?;
    let Some(stored) = stored.as_ref().and_then(|r| r.checkpoint.engine.as_ref()).and_then(|m| m.pr_watch.as_ref()) else { return Ok(()) };
    for edited in stored.feedback.iter().filter(|i| i.label_by == Some(LabelBy::You)) {
        if let Some(item) = watch.feedback.iter_mut().find(|i| i.id == edited.id) {
            (item.label, item.confidence, item.label_by, item.unsure) = (edited.label, None, Some(LabelBy::You), None);
        }
    }
    Ok(())
}

fn item(id: String, source: FeedbackSource, author: &str, body: &str, at: i64) -> FeedbackItem {
    FeedbackItem {
        id,
        source,
        author: author.to_string(),
        counts: false,
        body: body.trim().to_string(),
        path: None,
        line: None,
        url: None,
        at,
        label: None,
        confidence: None,
        label_by: None,
        unsure: None,
        status: ItemStatus::New,
        batch: None,
        reply: None,
        reply_sent: None,
        why: None,
        amendment: None,
    }
}

/// One item per failing check run; the combined status when no check run failed. A rule
/// labels them: CI that fails asks for a change.
fn check_items(runs: &[CheckRun], status: &CommitStatus, sha: &str, at: i64) -> Vec<FeedbackItem> {
    const RED: [&str; 5] = ["failure", "timed_out", "action_required", "cancelled", "startup_failure"];
    let ci = |id: String, name: &str, body: String, url: Option<String>| FeedbackItem {
        counts: true,
        url,
        label: Some(FeedbackLabel::Change),
        confidence: Some(1.0),
        label_by: Some(LabelBy::Rule),
        ..item(id, FeedbackSource::Check, name, &body, at)
    };
    let mut items: Vec<FeedbackItem> = runs
        .iter()
        .filter_map(|r| {
            let conclusion = r.conclusion.as_deref().filter(|c| RED.contains(c))?;
            Some(ci(format!("check:{}", r.id), &r.name, format!("{} ended: {conclusion}.", r.name), r.details_url.clone()))
        })
        .collect();
    if items.is_empty() && status.count > 0 && matches!(status.state.as_str(), "failure" | "error") {
        items.push(ci(format!("status:{sha}"), "CI", format!("The commit status is {}.", status.state), None));
    }
    items
}

/// Items that count and wait for their batch.
fn open_items(watch: &PrWatch) -> impl Iterator<Item = &FeedbackItem> {
    watch.feedback.iter().filter(|i| i.counts && i.batch.is_none())
}

/// When the newest open item came, if any wait.
fn quiet_since(record: &GraphRunRecord) -> Option<i64> {
    let watch = record.checkpoint.engine.as_ref()?.pr_watch.as_ref()?;
    open_items(watch).map(|i| i.at).max()
}

/// "Feedback batch 2 needs you (a review): 3 items, 2 change, 1 question, 1 unsure."
fn batch_note(batch: u32, reason: BatchReason, what_now: &str, items: &[&FeedbackItem]) -> String {
    let why = match reason {
        BatchReason::Review => "a review".to_string(),
        BatchReason::Checks => "CI finished".to_string(),
        BatchReason::Quiet => format!("{QUIET_MINUTES} quiet minutes"),
    };
    let mut labels: Vec<String> = Vec::new();
    for label in FeedbackLabel::ALL {
        let n = items.iter().filter(|i| i.label == Some(label) && i.unsure.is_none()).count();
        if n > 0 {
            labels.push(format!("{n} {}", label.name()));
        }
    }
    let unsure = items.iter().filter(|i| i.unsure.is_some()).count();
    if unsure > 0 {
        labels.push(format!("{unsure} unsure"));
    }
    let what = count(items.len(), "item").unwrap_or_default();
    format!("Feedback batch {batch} {what_now} ({why}): {what}, {}.", labels.join(", "))
}

fn capital(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|c| c.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

/// The routing decision in the log: raised when it needs the user, else only said.
fn note_route(log: &mut ChiefOfStaffLog, at: i64, routed: &Routed) {
    if routed.raise {
        raise_feedback(log, at, routed.text.clone());
    } else {
        log.say(at, routed.text.clone());
    }
}

/// Every batch is its own note, so the newest raise always says which batch waits.
fn raise_feedback(log: &mut ChiefOfStaffLog, at: i64, text: String) {
    log.log.push(ChiefEntry { at, signal: Some(ChiefSignal::Feedback), raised: true, text });
    if !log.is_open(ChiefSignal::Feedback) {
        log.open.push(ChiefSignal::Feedback);
    }
}

/// "2 reviews (1 asks for changes)".
fn review_news(reviews: &[&Review]) -> Option<String> {
    let mut text = count(reviews.len(), "review")?;
    let changes = reviews.iter().filter(|r| r.state == "CHANGES_REQUESTED").count();
    if changes > 0 {
        text.push_str(&format!(" ({changes} asks for changes)"));
    }
    Some(text)
}

fn count(n: usize, what: &str) -> Option<String> {
    match n {
        0 => None,
        1 => Some(format!("1 {what}")),
        n => Some(format!("{n} {what}s")),
    }
}

/// The PR of a completed Factory Run that is still watched.
struct Target {
    account: String,
    repo: String,
    number: u64,
    url: String,
}

fn watched(record: &GraphRunRecord) -> Option<Target> {
    if !record.is_rust_owned() {
        return None;
    }
    let meta = record.checkpoint.engine.as_ref()?;
    let ticket = meta.factory.as_ref()?;
    // A round pushes to its PR; the run that opened the PR watches it.
    if ticket.revision.is_some() {
        return None;
    }
    if meta.pr.is_some() || meta.pr_watch.as_ref().is_some_and(|w| w.phase.is_ended()) {
        return None;
    }
    // The run's one step returns its PR's URL as its detail.
    let url = record.checkpoint.completed.values().find_map(|r| r.detail.clone().filter(|d| pr_number(d).is_some()))?;
    Some(Target { account: ticket.account.clone(), repo: ticket.repo.clone(), number: pr_number(&url)?, url })
}

/// `https://github.com/o/r/pull/12` → 12.
fn pr_number(url: &str) -> Option<u64> {
    let (_, tail) = url.trim_end_matches('/').rsplit_once("/pull/")?;
    tail.parse().ok()
}

fn poll_minutes(record: &GraphRunRecord) -> u32 {
    let progress = record.checkpoint.engine.as_ref().and_then(|m| m.progress.as_ref());
    progress.and_then(|p| p.poll_minutes).unwrap_or(DEFAULT_POLL_MINUTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(status: &str, conclusion: Option<&str>) -> CheckRun {
        CheckRun { id: 1, name: "ci".into(), status: status.into(), conclusion: conclusion.map(str::to_string), details_url: None }
    }

    #[test]
    fn checks_roll_up_red_before_pending_before_green() {
        let none = CommitStatus::default();
        assert_eq!(checks_state(&[], &none), None);
        assert_eq!(checks_state(&[run("completed", Some("success"))], &none), Some(ChecksState::Passing));
        assert_eq!(checks_state(&[run("completed", Some("success")), run("in_progress", None)], &none), Some(ChecksState::Pending));
        assert_eq!(checks_state(&[run("in_progress", None), run("completed", Some("failure"))], &none), Some(ChecksState::Failing));
        // GitHub's combined status says "pending" with no statuses at all: that is no CI.
        assert_eq!(checks_state(&[], &CommitStatus { state: "pending".into(), count: 0 }), None);
        assert_eq!(checks_state(&[run("completed", Some("success"))], &CommitStatus { state: "failure".into(), count: 1 }), Some(ChecksState::Failing));
    }

    #[test]
    fn a_pr_url_gives_its_number() {
        assert_eq!(pr_number("https://github.com/acme/widgets/pull/9"), Some(9));
        assert_eq!(pr_number("https://github.com/acme/widgets/pull/9/"), Some(9));
        assert_eq!(pr_number("FAILED: gate"), None);
    }
}

fn needs_drafts(record: &GraphRunRecord) -> bool {
    let watch = record.checkpoint.engine.as_ref().and_then(|m| m.pr_watch.as_ref());
    watch.is_some_and(|w| !w.phase.is_ended() && replies::needs_drafts(w))
}
