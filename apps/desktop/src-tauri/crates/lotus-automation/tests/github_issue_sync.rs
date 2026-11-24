//! Keeping a GitHub Issues source fresh (plans/github-issues-source slice 02, PLAN G12–G14):
//! incremental or full read, the kept copy, and Source Health — against a fake reader.

use std::sync::Mutex;

use chrono::{DateTime, Utc};
use lotus_automation::github_issues::sync::{
    sync_issues, IssueCopy, IssueLostAccess, IssueSourceHealth, IssueSyncRequest, COPY_FORMAT, OVERLAP_MS, RECONCILE_EVERY_MS,
};
use lotus_automation::github_issues::{
    GitHubIssues, Issue, IssueComment, IssueState, IssueWindow, IssuesError, IssuesErrorKind, RepoSummary,
};
use lotus_automation::BoxFuture;

const T0: i64 = 1_791_000_000_000;

fn issue(number: u64, title: &str) -> Issue {
    Issue {
        number,
        title: title.into(),
        state: IssueState::Open,
        state_reason: None,
        labels: vec![],
        assignees: vec![],
        author: "teammate".into(),
        url: format!("https://github.com/initech/lotus/issues/{number}"),
        body: String::new(),
        comments: 0,
        created_at: "2026-09-01T10:00:00Z".into(),
        updated_at: "2026-10-03T10:00:00Z".into(),
        closed_at: None,
    }
}

/// Answers every listing with `answer`, and remembers the windows it was asked for.
struct FakeIssues {
    answer: Result<Vec<Issue>, IssuesError>,
    asked: Mutex<Vec<IssueWindow>>,
}

impl FakeIssues {
    fn answering(answer: Result<Vec<Issue>, IssuesError>) -> Self {
        Self { answer, asked: Mutex::default() }
    }

    fn asked(&self) -> Vec<IssueWindow> {
        self.asked.lock().unwrap().clone()
    }
}

impl GitHubIssues for FakeIssues {
    fn list_issues(&self, account: &str, repo: &str, window: IssueWindow, _now: DateTime<Utc>) -> BoxFuture<Result<Vec<Issue>, IssuesError>> {
        assert_eq!((account, repo), ("alwisofwan1", "initech/lotus"));
        self.asked.lock().unwrap().push(window);
        let answer = self.answer.clone();
        Box::pin(async move { answer })
    }
    fn issue(&self, _: &str, _: &str, _: u64) -> BoxFuture<Result<Option<Issue>, IssuesError>> {
        unreachable!()
    }
    fn issue_comments(&self, _: &str, _: &str, _: u64) -> BoxFuture<Result<Vec<IssueComment>, IssuesError>> {
        unreachable!()
    }
    fn repos(&self, _: &str) -> BoxFuture<Result<Vec<RepoSummary>, IssuesError>> {
        unreachable!()
    }
}

fn kept(synced: i64, reconciled: i64) -> IssueCopy {
    IssueCopy {
        issues: vec![issue(7, "old seven"), issue(3, "three")],
        synced_at_ms: Some(synced),
        reconciled_at_ms: Some(reconciled),
        format: COPY_FORMAT,
    }
}

fn ms(t: DateTime<Utc>) -> i64 {
    t.timestamp_millis()
}

async fn sync(api: &FakeIssues, kept: Option<IssueCopy>, request: IssueSyncRequest) -> lotus_automation::github_issues::sync::IssuesSynced {
    sync_issues(api, "alwisofwan1", "initech/lotus", kept, request).await
}

#[tokio::test]
async fn the_first_sync_reads_everything_and_keeps_it_newest_first() {
    let api = FakeIssues::answering(Ok(vec![issue(2, "two"), issue(9, "nine")]));
    let out = sync(&api, None, IssueSyncRequest::at(T0)).await;
    assert_eq!(api.asked(), vec![IssueWindow::Full]);
    assert!(out.full);
    assert_eq!(out.health, IssueSourceHealth::Healthy);
    assert_eq!(out.copy.issues.iter().map(|i| i.number).collect::<Vec<_>>(), vec![9, 2]);
    assert_eq!((out.copy.synced_at_ms, out.copy.reconciled_at_ms, out.copy.format), (Some(T0), Some(T0), COPY_FORMAT));
}

#[tokio::test]
async fn a_later_sync_asks_only_for_what_changed_since_the_last_one_minus_two_minutes() {
    let last = T0 - 60_000;
    let api = FakeIssues::answering(Ok(vec![issue(7, "new seven"), issue(11, "eleven")]));
    let out = sync(&api, Some(kept(last, T0 - 5 * 60_000)), IssueSyncRequest::at(T0)).await;
    let [IssueWindow::ChangedSince(since)] = api.asked()[..] else { panic!("asked {:?}", api.asked()) };
    assert_eq!(ms(since), last - OVERLAP_MS);
    assert!(!out.full);
    // Updated in place, new one added, untouched one kept, newest first.
    let titles: Vec<_> = out.copy.issues.iter().map(|i| (i.number, i.title.as_str())).collect();
    assert_eq!(titles, vec![(11, "eleven"), (7, "new seven"), (3, "three")]);
    assert_eq!(out.copy.synced_at_ms, Some(T0));
    assert_eq!(out.copy.reconciled_at_ms, Some(T0 - 5 * 60_000), "an incremental read is not a full one");
}

#[tokio::test]
async fn every_issue_is_read_again_after_15_minutes_and_gone_ones_drop() {
    let api = FakeIssues::answering(Ok(vec![issue(7, "seven")]));
    let out = sync(&api, Some(kept(T0 - 60_000, T0 - RECONCILE_EVERY_MS)), IssueSyncRequest::at(T0)).await;
    assert_eq!(api.asked(), vec![IssueWindow::Full]);
    assert!(out.full);
    assert_eq!(out.copy.issues.iter().map(|i| i.number).collect::<Vec<_>>(), vec![7], "#3 was deleted or transferred");
    assert_eq!(out.copy.reconciled_at_ms, Some(T0));
}

#[tokio::test]
async fn opening_or_refresh_reads_everything_even_when_not_due() {
    let api = FakeIssues::answering(Ok(vec![]));
    sync(&api, Some(kept(T0 - 60_000, T0 - 60_000)), IssueSyncRequest::at(T0).full()).await;
    assert_eq!(api.asked(), vec![IssueWindow::Full]);
}

#[tokio::test]
async fn a_copy_of_another_format_is_read_again_in_full() {
    let api = FakeIssues::answering(Ok(vec![]));
    let old = IssueCopy { format: 0, ..kept(T0 - 60_000, T0 - 60_000) };
    sync(&api, Some(old), IssueSyncRequest::at(T0)).await;
    assert_eq!(api.asked(), vec![IssueWindow::Full]);
}

#[tokio::test]
async fn a_failure_never_empties_the_kept_copy() {
    let before = kept(T0 - 60_000, T0 - 60_000);
    for kind in [IssuesErrorKind::NoLogin, IssuesErrorKind::NotFound, IssuesErrorKind::Offline, IssuesErrorKind::Failed] {
        let api = FakeIssues::answering(Err(IssuesError::new(kind, "boom")));
        let out = sync(&api, Some(before.clone()), IssueSyncRequest::at(T0)).await;
        assert_eq!(out.copy, before, "{kind:?}");
        assert_ne!(out.health, IssueSourceHealth::Healthy);
    }
}

#[test]
fn failures_get_the_same_health_words_as_notion() {
    let health = |kind, message: &str| IssueSourceHealth::after(&IssuesError::new(kind, message), T0);
    assert_eq!(health(IssuesErrorKind::NoLogin, "x"), IssueSourceHealth::LostAccess { why: IssueLostAccess::Login });
    assert_eq!(health(IssuesErrorKind::NoAccess, "x"), IssueSourceHealth::LostAccess { why: IssueLostAccess::Access });
    assert_eq!(health(IssuesErrorKind::NotFound, "x"), IssueSourceHealth::LostAccess { why: IssueLostAccess::Repo });
    assert_eq!(health(IssuesErrorKind::Offline, "dial tcp"), IssueSourceHealth::Offline { message: "dial tcp".into() });
    assert_eq!(health(IssuesErrorKind::Failed, "500"), IssueSourceHealth::Failed { message: "500".into() });
    // The wait gh's rate limit named, or a minute when it named none.
    assert_eq!(
        health(IssuesErrorKind::RateLimited, "repos/a/b/issues: rate limited; try again in 900 s"),
        IssueSourceHealth::SlowedDown { retry_at_ms: T0 + 900_000 }
    );
    assert_eq!(
        health(IssuesErrorKind::RateLimited, "repos/a/b/issues: rate limited twice in a row"),
        IssueSourceHealth::SlowedDown { retry_at_ms: T0 + 60_000 }
    );
    // The JSON Tasks reads is Notion's.
    let json = serde_json::to_value(IssueSourceHealth::LostAccess { why: IssueLostAccess::Login }).unwrap();
    assert_eq!(json, serde_json::json!({ "state": "lost_access", "why": "login" }));
    let json = serde_json::to_value(IssueSourceHealth::SlowedDown { retry_at_ms: 5 }).unwrap();
    assert_eq!(json, serde_json::json!({ "state": "slowed_down", "retryAtMs": 5 }));
}

#[tokio::test]
async fn while_slowed_down_nothing_is_asked() {
    let api = FakeIssues::answering(Ok(vec![]));
    let before = kept(T0 - 60_000, T0 - 60_000);
    let out = sync(&api, Some(before.clone()), IssueSyncRequest::at(T0).full().not_before(T0 + 1)).await;
    assert!(api.asked().is_empty());
    assert!(!out.asked);
    assert_eq!(out.copy, before);
    assert_eq!(out.health, IssueSourceHealth::SlowedDown { retry_at_ms: T0 + 1 });
    // Once the time has passed, it asks again.
    let out = sync(&api, Some(before), IssueSyncRequest::at(T0 + 1).not_before(T0 + 1)).await;
    assert!(out.asked);
}

#[test]
fn the_kept_copy_round_trips_through_json() {
    let copy = kept(T0, T0);
    let text = serde_json::to_string(&copy).unwrap();
    assert!(text.contains("\"syncedAtMs\""));
    assert_eq!(serde_json::from_str::<IssueCopy>(&text).unwrap(), copy);
}
