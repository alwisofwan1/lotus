//! GitHub Issues as a ticket source (ADR-0048, plans/github-issues-source slice 01): the pure
//! readers, and the `gh`-backed reader driven against a fake `gh` script.

use chrono::{DateTime, Duration, Utc};
use lotus_automation::github::{Gh, GhCli};
use lotus_automation::github_issues::{
    classify_failure, issue_list_paths, keep_issue, next_page_path, parse_issue, parse_issue_comments, parse_issues,
    parse_repos, split_repo, GitHubIssues, IssueState, IssueWindow, IssuesErrorKind,
};

fn at(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

fn issue_json(number: u64, state: &str, closed_at: Option<&str>) -> serde_json::Value {
    serde_json::json!({
        "number": number, "title": format!("Issue {number}"), "state": state,
        "state_reason": if state == "closed" { serde_json::json!("completed") } else { serde_json::Value::Null },
        "html_url": format!("https://github.com/initech/lotus/issues/{number}"),
        "user": { "login": "teammate" }, "body": null, "comments": 2,
        "labels": [{ "name": "bug", "color": "d73a4a" }],
        "assignees": [{ "login": "alwisofwan1" }],
        "created_at": "2026-09-01T10:00:00Z", "updated_at": "2026-10-03T10:00:00Z", "closed_at": closed_at,
    })
}

#[test]
fn an_issue_list_is_read_without_pull_requests() {
    let mut pr = issue_json(3, "open", None);
    pr["pull_request"] = serde_json::json!({ "url": "https://api.github.com/repos/initech/lotus/pulls/3" });
    let body = serde_json::json!([issue_json(1, "open", None), pr, issue_json(2, "closed", Some("2026-10-02T09:00:00Z"))]);

    let issues = parse_issues(&body.to_string()).unwrap();

    assert_eq!(issues.iter().map(|i| i.number).collect::<Vec<_>>(), vec![1, 2], "the pull request is dropped");
    let open = &issues[0];
    assert_eq!(open.state, IssueState::Open);
    assert_eq!(open.state_reason, None);
    assert_eq!(open.body, "", "a null body reads as empty");
    assert_eq!(open.author, "teammate");
    assert_eq!(open.labels[0].name, "bug");
    assert_eq!(open.labels[0].color, "d73a4a");
    assert_eq!(open.assignees, vec!["alwisofwan1"]);
    assert_eq!(open.comments, 2);
    assert_eq!(open.url, "https://github.com/initech/lotus/issues/1");
    let closed = &issues[1];
    assert_eq!(closed.state, IssueState::Closed);
    assert_eq!(closed.state_reason.as_deref(), Some("completed"));
    assert_eq!(closed.closed_at.as_deref(), Some("2026-10-02T09:00:00Z"));
    assert!(parse_issues("not json").is_err());
}

#[test]
fn one_issue_is_read_and_a_pull_request_is_not_an_issue() {
    let issue = parse_issue(&issue_json(7, "open", None).to_string()).unwrap();
    assert_eq!(issue.map(|i| i.number), Some(7));

    let mut pr = issue_json(8, "open", None);
    pr["pull_request"] = serde_json::json!({});
    assert_eq!(parse_issue(&pr.to_string()).unwrap(), None);
}

#[test]
fn open_issues_and_issues_closed_in_the_last_30_days_are_kept() {
    let now = at("2026-10-04T12:00:00Z");
    let read = |state: &str, closed: Option<&str>| parse_issues(&serde_json::json!([issue_json(1, state, closed)]).to_string()).unwrap().remove(0);

    assert!(keep_issue(&read("open", None), now));
    assert!(keep_issue(&read("closed", Some("2026-09-10T12:00:00Z")), now), "closed 24 days ago");
    assert!(!keep_issue(&read("closed", Some("2026-09-01T12:00:00Z")), now), "closed 33 days ago");
    assert!(!keep_issue(&read("closed", None), now), "closed with no date is not kept");
}

#[test]
fn a_full_read_asks_for_open_issues_and_recently_closed_ones() {
    let now = at("2026-10-04T12:00:00Z");
    assert_eq!(
        issue_list_paths("initech/lotus", &IssueWindow::Full, now),
        vec![
            "repos/initech/lotus/issues?state=open&per_page=100",
            "repos/initech/lotus/issues?state=closed&since=2026-09-04T12:00:00Z&per_page=100",
        ]
    );
}

#[test]
fn an_incremental_read_asks_only_for_what_changed_since() {
    let now = at("2026-10-04T12:00:00Z");
    let since = now - Duration::minutes(3);
    assert_eq!(
        issue_list_paths("initech/lotus", &IssueWindow::ChangedSince(since), now),
        vec!["repos/initech/lotus/issues?state=all&since=2026-10-04T11:57:00Z&per_page=100"]
    );
}

#[test]
fn the_next_page_is_the_one_github_links_cursor_included() {
    let link = |v: &str| vec![("link".to_string(), v.to_string())];
    // Shaped like GET repos/cli/cli/issues on 2026-10-04: a page number AND an `after` cursor.
    assert_eq!(
        next_page_path(&link(
            r#"<https://api.github.com/repositories/212613049/issues?state=closed&per_page=100&page=2&after=Y3Vy%3D>; rel="next", <https://api.github.com/repositories/212613049/issues?page=9>; rel="last""#
        )),
        Some("repositories/212613049/issues?state=closed&per_page=100&page=2&after=Y3Vy%3D".to_string())
    );
    assert_eq!(next_page_path(&link(r#"<https://api.github.com/repositories/1/issues?page=1>; rel="prev""#)), None);
    assert_eq!(next_page_path(&link(r#"<https://evil.example/repos/a/b/issues?page=2>; rel="next""#)), None, "never leaves api.github.com");
    assert_eq!(next_page_path(&[]), None);
}

#[test]
fn a_repo_name_that_could_escape_its_path_is_refused() {
    assert_eq!(split_repo("initech/lotus"), Some(("initech", "lotus")));
    assert_eq!(split_repo("o/socket.io-client_2"), Some(("o", "socket.io-client_2")));
    for bad in ["", "lotus", "a/b/c", "../x", "a/..", "a/.", "-a/b", "a/b?state=all", "a/ b", "a/b#1", "a/"] {
        assert_eq!(split_repo(bad), None, "{bad:?}");
    }
}

#[test]
fn issue_comments_are_read_oldest_first() {
    let body = r#"[
      {"id": 2, "user": {"login": "b"}, "body": "second", "created_at": "2026-10-02T00:00:00Z", "html_url": "u2"},
      {"id": 1, "user": {"login": "a"}, "body": null, "created_at": "2026-10-01T00:00:00Z", "html_url": "u1"}
    ]"#;
    let comments = parse_issue_comments(body).unwrap();
    assert_eq!(comments.iter().map(|c| (c.id, c.author.as_str(), c.body.as_str())).collect::<Vec<_>>(), [(1, "a", ""), (2, "b", "second")]);
}

#[test]
fn an_accounts_repos_are_read() {
    let body = r#"[
      {"full_name": "initech/lotus", "description": null, "private": true, "archived": false, "has_issues": true, "pushed_at": "2026-10-04T00:00:00Z"},
      {"full_name": "alwisofwan1/old", "description": "x", "private": false, "archived": true, "has_issues": false, "pushed_at": null}
    ]"#;
    let repos = parse_repos(body).unwrap();
    assert_eq!(repos.len(), 2);
    assert_eq!((repos[0].full_name.as_str(), repos[0].private, repos[0].has_issues), ("initech/lotus", true, true));
    assert_eq!((repos[1].archived, repos[1].has_issues, repos[1].description.as_str()), (true, false, "x"));
}

#[test]
fn failures_are_named_for_source_health() {
    assert_eq!(classify_failure(401, ""), IssuesErrorKind::NoAccess);
    assert_eq!(classify_failure(403, "HTTP 403: Resource not accessible"), IssuesErrorKind::NoAccess);
    assert_eq!(classify_failure(404, "HTTP 404: Not Found"), IssuesErrorKind::NotFound);
    assert_eq!(classify_failure(410, "HTTP 410: Issues are disabled for this repo"), IssuesErrorKind::NotFound);
    assert_eq!(
        classify_failure(0, "error connecting to api.github.com\ncheck your internet connection"),
        IssuesErrorKind::Offline
    );
    assert_eq!(classify_failure(502, "HTTP 502"), IssuesErrorKind::Failed);
    assert_eq!(classify_failure(0, "something odd"), IssuesErrorKind::Failed);
}

// --- The gh-backed reader, against a fake `gh` ------------------------------------------------

/// A `gh` stand-in: `auth token` prints a token for `alwisofwan1` only; `api --include <path>`
/// answers from canned responses. Every path it was asked for is appended to `calls.log`.
fn fake_gh(dir: &std::path::Path) -> String {
    let issue = |n: u64, state: &str, closed: &str| {
        let mut v = issue_json(n, state, if closed.is_empty() { None } else { Some(closed) });
        if n == 99 {
            v["pull_request"] = serde_json::json!({});
        }
        v.to_string()
    };
    let page1 = format!("[{},{}]", issue(1, "open", ""), issue(99, "open", ""));
    let page2 = format!("[{}]", issue(2, "open", ""));
    let closed = format!("[{},{}]", issue(3, "closed", "2026-10-01T00:00:00Z"), issue(4, "closed", "2026-08-01T00:00:00Z"));
    let log = dir.join("calls.log");
    let script = format!(
        r#"#!/bin/sh
if [ "$1" = "auth" ]; then
  if [ "$6" = "alwisofwan1" ]; then echo "gho_FAKE"; exit 0; fi
  echo "no account" >&2; exit 1
fi
path="$3"
echo "$path" >> '{log}'
case "$path" in
  *gone/repo*) printf 'HTTP/2.0 404 Not Found\r\n\r\n{{"message":"Not Found"}}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  *state=open*after=c2) printf 'HTTP/2.0 200 OK\r\n\r\n%s' '{page2}' ;;
  *state=open*) printf 'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/repositories/1/issues?state=open&page=2&after=c2>; rel="next"\r\n\r\n%s' '{page1}' ;;
  *state=closed*) printf 'HTTP/2.0 200 OK\r\n\r\n%s' '{closed}' ;;
  *) printf 'HTTP/2.0 200 OK\r\n\r\n[]' ;;
esac
"#,
        log = log.display()
    );
    let path = dir.join("gh");
    std::fs::write(&path, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.display().to_string()
}

#[tokio::test]
async fn a_full_read_follows_pages_drops_pull_requests_and_old_closed_issues() {
    let dir = tempfile::tempdir().unwrap();
    let cli = GhCli::new(Gh::new(fake_gh(dir.path())));

    let issues = cli.list_issues("alwisofwan1", "initech/lotus", IssueWindow::Full, at("2026-10-04T12:00:00Z")).await.unwrap();

    assert_eq!(issues.iter().map(|i| i.number).collect::<Vec<_>>(), vec![1, 2, 3]);
    let calls = std::fs::read_to_string(dir.path().join("calls.log")).unwrap();
    assert_eq!(calls.lines().count(), 3, "open page 1, open page 2, closed page 1: {calls}");
}

#[tokio::test]
async fn an_account_gh_does_not_know_is_no_login() {
    let dir = tempfile::tempdir().unwrap();
    let cli = GhCli::new(Gh::new(fake_gh(dir.path())));
    let err = cli.list_issues("someone-else", "initech/lotus", IssueWindow::Full, Utc::now()).await.unwrap_err();
    assert_eq!(err.kind, IssuesErrorKind::NoLogin);
}

#[tokio::test]
async fn a_repo_that_is_gone_is_not_found_and_a_bad_repo_is_never_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let cli = GhCli::new(Gh::new(fake_gh(dir.path())));

    let err = cli.list_issues("alwisofwan1", "gone/repo", IssueWindow::Full, Utc::now()).await.unwrap_err();
    assert_eq!(err.kind, IssuesErrorKind::NotFound);

    let err = cli.issue_comments("alwisofwan1", "../etc", 1).await.unwrap_err();
    assert_eq!(err.kind, IssuesErrorKind::Failed);
    let calls = std::fs::read_to_string(dir.path().join("calls.log")).unwrap_or_default();
    assert!(!calls.contains("etc"), "a refused repo makes no call: {calls}");
}
