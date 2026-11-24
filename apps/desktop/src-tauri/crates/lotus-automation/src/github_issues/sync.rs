//! Keeping one GitHub Issues source fresh (ADR-0048 §8–9, PLAN G12–G14).
//!
//! The same shape as Notion's (`notion::sync`): no webhook, so the caller asks for a sync every
//! minute or so, and this decides what to ask GitHub for — the issues updated since the last sync,
//! or every issue when the copy is due a full re-read. A sync that fails returns the kept copy
//! untouched, so a source that fails never empties the list.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{GitHubIssues, Issue, IssueWindow, IssuesError, IssuesErrorKind};

/// How far before the last sync an incremental read reaches back: covers clock drift between here
/// and GitHub, and an issue updated while the last read was paging.
pub const OVERLAP_MS: i64 = 2 * 60_000;

/// How often every issue is read again: an issue that was deleted, transferred or closed more than
/// 30 days ago never comes back from an incremental read, so only a full one drops it.
pub const RECONCILE_EVERY_MS: i64 = 15 * 60_000;

/// When GitHub's rate limit outlasts what the reader waits and says nothing more precise.
pub const DEFAULT_SLOW_DOWN_MS: i64 = 60_000;

/// What an [`IssueCopy`] on disk holds; a copy of another format is read again in full.
pub const COPY_FORMAT: u32 = 1;

/// A source's issues as last read, kept on disk as its last good copy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueCopy {
    /// Newest number first.
    pub issues: Vec<Issue>,
    /// When the last sync that worked started.
    pub synced_at_ms: Option<i64>,
    /// When every issue was last read, rather than only the updated ones.
    pub reconciled_at_ms: Option<i64>,
    #[serde(default)]
    pub format: u32,
}

/// What state a source is in after a sync. The same words, and the same JSON, as Notion's
/// `SourceHealth` (ADR-0045 §5), so Tasks draws both with one banner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum IssueSourceHealth {
    Healthy,
    /// GitHub could not be reached. The copy stays; Retry.
    Offline { message: String },
    /// GitHub's rate limit. Nothing is asked until `retry_at_ms`.
    SlowedDown { retry_at_ms: i64 },
    /// Lotus can no longer read the repo as this account. The copy stays; the person must act.
    LostAccess { why: IssueLostAccess },
    Failed { message: String },
}

/// Why access is lost, which decides what the person is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueLostAccess {
    /// gh has no usable login for the account (logged out, or the account was removed): `gh auth login`.
    Login,
    /// 401 / 403: the account's token may not read this repo.
    Access,
    /// 404 / 410: the repo is gone, renamed, hidden from the account, or has issues turned off.
    Repo,
}

impl IssueSourceHealth {
    /// The health a failed read leaves (PLAN G13).
    pub fn after(error: &IssuesError, now_ms: i64) -> Self {
        let message = error.message.clone();
        match error.kind {
            IssuesErrorKind::NoLogin => Self::LostAccess { why: IssueLostAccess::Login },
            IssuesErrorKind::NoAccess => Self::LostAccess { why: IssueLostAccess::Access },
            IssuesErrorKind::NotFound => Self::LostAccess { why: IssueLostAccess::Repo },
            IssuesErrorKind::RateLimited => Self::SlowedDown { retry_at_ms: now_ms + retry_after_ms(&message).unwrap_or(DEFAULT_SLOW_DOWN_MS) },
            IssuesErrorKind::Offline => Self::Offline { message },
            IssuesErrorKind::Failed => Self::Failed { message },
        }
    }
}

/// The wait in `ratelimit::with_rate_limit`'s "…; try again in N s", in ms.
fn retry_after_ms(message: &str) -> Option<i64> {
    let rest = message.rsplit_once("try again in ")?.1;
    let secs: i64 = rest.strip_suffix(" s")?.trim().parse().ok()?;
    Some(secs.saturating_mul(1000))
}

/// One sync, as the caller asks for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IssueSyncRequest {
    pub now_ms: i64,
    /// Read every issue now, due or not — when the source is opened, or on Refresh.
    pub full: bool,
    /// GitHub asked not to be asked before this; a sync before it asks nothing.
    pub not_before_ms: Option<i64>,
}

impl IssueSyncRequest {
    pub fn at(now_ms: i64) -> Self {
        Self { now_ms, full: false, not_before_ms: None }
    }

    pub fn full(self) -> Self {
        Self { full: true, ..self }
    }

    pub fn not_before(self, retry_at_ms: i64) -> Self {
        Self { not_before_ms: Some(retry_at_ms), ..self }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuesSynced {
    pub copy: IssueCopy,
    pub health: IssueSourceHealth,
    /// True when every issue was read, not only the updated ones.
    pub full: bool,
    /// False when nothing was asked (slowed down).
    pub asked: bool,
}

pub async fn sync_issues(
    api: &dyn GitHubIssues,
    account: &str,
    repo: &str,
    kept: Option<IssueCopy>,
    request: IssueSyncRequest,
) -> IssuesSynced {
    let now = request.now_ms;
    if let Some(retry_at_ms) = request.not_before_ms.filter(|&at| now < at) {
        let health = IssueSourceHealth::SlowedDown { retry_at_ms };
        return IssuesSynced { copy: kept.unwrap_or_default(), health, full: false, asked: false };
    }
    let incremental = kept.as_ref().and_then(|kept| {
        let synced = kept.synced_at_ms?;
        let reconciled = kept.reconciled_at_ms?;
        (!request.full && kept.format == COPY_FORMAT && now - reconciled < RECONCILE_EVERY_MS).then_some(synced)
    });
    let window = match incremental {
        Some(synced) => IssueWindow::ChangedSince(at(synced - OVERLAP_MS)),
        None => IssueWindow::Full,
    };
    let full = incremental.is_none();
    match (api.list_issues(account, repo, window, at(now)).await, kept) {
        (Ok(read), Some(kept)) if !full => IssuesSynced { copy: merged(kept, read, now), health: IssueSourceHealth::Healthy, full, asked: true },
        (Ok(mut read), _) => {
            newest_first(&mut read);
            let copy = IssueCopy { issues: read, synced_at_ms: Some(now), reconciled_at_ms: Some(now), format: COPY_FORMAT };
            IssuesSynced { copy, health: IssueSourceHealth::Healthy, full, asked: true }
        }
        (Err(error), kept) => IssuesSynced { copy: kept.unwrap_or_default(), health: IssueSourceHealth::after(&error, now), full, asked: true },
    }
}

/// `kept` with the updated issues put in place of their old versions, and new ones added.
pub fn merged(mut kept: IssueCopy, updated: Vec<Issue>, now: i64) -> IssueCopy {
    for issue in updated {
        put(&mut kept, issue);
    }
    newest_first(&mut kept.issues);
    kept.synced_at_ms = Some(now);
    kept
}

/// `issue` in place of the kept one with its number, or added.
pub fn put(copy: &mut IssueCopy, issue: Issue) {
    match copy.issues.iter_mut().find(|i| i.number == issue.number) {
        Some(old) => *old = issue,
        None => copy.issues.push(issue),
    }
}

fn newest_first(issues: &mut [Issue]) {
    issues.sort_by(|a, b| b.number.cmp(&a.number));
}

fn at(ms: i64) -> DateTime<Utc> {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default()
}
