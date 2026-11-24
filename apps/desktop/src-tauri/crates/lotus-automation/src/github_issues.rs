//! GitHub Issues as a ticket source (ADR-0048): read only, one repo per source, through the same
//! `gh` accounts the review automation uses. Pull requests come back from the issues endpoint
//! too and are dropped. Readers and path builders are pure; [`GhCli`] implements the port.

pub mod sync;

use chrono::{DateTime, Duration, SecondsFormat, Utc};

use crate::github::{api_error, GhCli, GhFailure, GhReply};
use crate::registry::BoxFuture;

/// Closed issues older than this are not loaded (ADR-0048 §7).
pub const CLOSED_WINDOW_DAYS: i64 = 30;
/// Page cap per listing: 5 000 issues. A repo past that shows its newest pages only.
pub const MAX_ISSUE_PAGES: u32 = 50;
/// Page cap for an account's repos and an issue's comments.
pub const MAX_OTHER_PAGES: u32 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IssueLabel {
    pub name: String,
    /// Hex without `#`, as GitHub sends it.
    pub color: String,
}

/// One issue, as a ticket row needs it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Issue {
    pub number: u64,
    pub title: String,
    pub state: IssueState,
    /// `completed`, `not_planned`, `duplicate`, `reopened`, or none.
    pub state_reason: Option<String>,
    pub labels: Vec<IssueLabel>,
    pub assignees: Vec<String>,
    pub author: String,
    pub url: String,
    pub body: String,
    /// How many comments it has; the comments themselves are read when the issue is opened.
    pub comments: u64,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IssueComment {
    pub id: u64,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
}

/// One repo an account can see, for the repo picker.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RepoSummary {
    pub full_name: String,
    pub description: String,
    pub private: bool,
    pub archived: bool,
    pub has_issues: bool,
    pub pushed_at: Option<String>,
}

/// Which issues a listing asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueWindow {
    /// Every open issue, plus those closed in the last [`CLOSED_WINDOW_DAYS`].
    Full,
    /// Issues updated at or after this instant (GitHub's `since`, on `updated_at`).
    ChangedSince(DateTime<Utc>),
}

/// Why a read failed, in the words Source Health needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssuesErrorKind {
    /// gh has no usable login for the account.
    NoLogin,
    /// 401 / 403: the token cannot read this.
    NoAccess,
    /// 404 / 410: the repo is gone, renamed, private to us, or has issues turned off.
    NotFound,
    RateLimited,
    Offline,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct IssuesError {
    pub kind: IssuesErrorKind,
    pub message: String,
}

impl IssuesError {
    pub fn new(kind: IssuesErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

/// `owner/name`, or `None` when either part could leave its place in an API path.
pub fn split_repo(repo: &str) -> Option<(&str, &str)> {
    let (owner, name) = repo.split_once('/')?;
    let name_ok = !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    (crate::github::is_account(owner) && name_ok).then_some((owner, name))
}

fn iso(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// The listing paths for one read (first page). `repo` must have passed [`split_repo`].
pub fn issue_list_paths(repo: &str, window: &IssueWindow, now: DateTime<Utc>) -> Vec<String> {
    match window {
        IssueWindow::Full => vec![
            format!("repos/{repo}/issues?state=open&per_page=100"),
            format!("repos/{repo}/issues?state=closed&since={}&per_page=100", iso(now - Duration::days(CLOSED_WINDOW_DAYS))),
        ],
        IssueWindow::ChangedSince(since) => vec![format!("repos/{repo}/issues?state=all&since={}&per_page=100", iso(*since))],
    }
}

/// The path of the next page, from the `Link` header (docs: "Using pagination in the REST API").
/// GitHub pages issues with a cursor (`after=`), so the link is followed as given rather than
/// counting pages. Only links back to `api.github.com` are followed.
pub fn next_page_path(headers: &[(String, String)]) -> Option<String> {
    headers.iter().filter(|(k, _)| k == "link").flat_map(|(_, v)| v.split(',')).find_map(|part| {
        let (url, rel) = part.split_once(';')?;
        if rel.trim() != r#"rel="next""# {
            return None;
        }
        let path = url.trim().strip_prefix('<')?.strip_suffix('>')?.strip_prefix("https://api.github.com/")?;
        (!path.is_empty() && !path.contains("..")).then(|| path.to_string())
    })
}

/// Open issues always; closed ones only when they were closed within the window. `since`
/// filters on `updated_at`, so a long-closed issue with a new comment comes back and is dropped here.
pub fn keep_issue(issue: &Issue, now: DateTime<Utc>) -> bool {
    match issue.state {
        IssueState::Open => true,
        IssueState::Closed => issue
            .closed_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .is_some_and(|t| t.with_timezone(&Utc) >= now - Duration::days(CLOSED_WINDOW_DAYS)),
    }
}

fn text(v: &serde_json::Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_string()
}

/// `None` for a pull request, or an item without a number.
fn read_issue(v: &serde_json::Value) -> Option<Issue> {
    if !v["pull_request"].is_null() {
        return None;
    }
    Some(Issue {
        number: v["number"].as_u64()?,
        title: text(v, "title"),
        state: if v["state"].as_str() == Some("open") { IssueState::Open } else { IssueState::Closed },
        state_reason: v["state_reason"].as_str().map(str::to_string),
        labels: v["labels"]
            .as_array()
            .map(|ls| ls.iter().map(|l| IssueLabel { name: text(l, "name"), color: text(l, "color") }).collect())
            .unwrap_or_default(),
        assignees: v["assignees"]
            .as_array()
            .map(|a| a.iter().filter_map(|u| u["login"].as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        author: v["user"]["login"].as_str().unwrap_or_default().to_string(),
        url: text(v, "html_url"),
        body: text(v, "body"),
        comments: v["comments"].as_u64().unwrap_or(0),
        created_at: text(v, "created_at"),
        updated_at: text(v, "updated_at"),
        closed_at: v["closed_at"].as_str().map(str::to_string),
    })
}

fn json_array(body: &str, what: &str) -> Result<Vec<serde_json::Value>, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("unreadable {what}: {e}"))?;
    v.as_array().cloned().ok_or_else(|| format!("{what} is not a list"))
}

/// Reads `GET /repos/{repo}/issues`; pull requests are dropped.
pub fn parse_issues(body: &str) -> Result<Vec<Issue>, String> {
    Ok(json_array(body, "issues")?.iter().filter_map(read_issue).collect())
}

/// Reads `GET /repos/{repo}/issues/{n}`; `None` when that number is a pull request.
pub fn parse_issue(body: &str) -> Result<Option<Issue>, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("unreadable issue: {e}"))?;
    Ok(read_issue(&v))
}

/// Reads `GET /repos/{repo}/issues/{n}/comments`, oldest first.
pub fn parse_issue_comments(body: &str) -> Result<Vec<IssueComment>, String> {
    let mut comments: Vec<IssueComment> = json_array(body, "issue comments")?
        .iter()
        .filter_map(|c| {
            Some(IssueComment {
                id: c["id"].as_u64()?,
                author: c["user"]["login"].as_str().unwrap_or_default().to_string(),
                body: text(c, "body"),
                created_at: text(c, "created_at"),
                url: text(c, "html_url"),
            })
        })
        .collect();
    comments.sort_by(|a, b| (&a.created_at, a.id).cmp(&(&b.created_at, b.id)));
    Ok(comments)
}

/// Reads `GET /user/repos`.
pub fn parse_repos(body: &str) -> Result<Vec<RepoSummary>, String> {
    Ok(json_array(body, "repos")?
        .iter()
        .filter_map(|r| {
            Some(RepoSummary {
                full_name: r["full_name"].as_str()?.to_string(),
                description: text(r, "description"),
                private: r["private"].as_bool().unwrap_or(false),
                archived: r["archived"].as_bool().unwrap_or(false),
                has_issues: r["has_issues"].as_bool().unwrap_or(true),
                pushed_at: r["pushed_at"].as_str().map(str::to_string),
            })
        })
        .collect())
}

/// Names a failed reply. Rate limits never reach here: [`GhCli`] waits them out or reports them
/// as [`IssuesErrorKind::RateLimited`]. `status` is 0 when gh got no HTTP response.
pub fn classify_failure(status: u16, stderr: &str) -> IssuesErrorKind {
    match status {
        401 | 403 => IssuesErrorKind::NoAccess,
        404 | 410 => IssuesErrorKind::NotFound,
        0 => {
            let s = stderr.to_ascii_lowercase();
            let offline = ["error connecting", "dial tcp", "no such host", "network is unreachable", "connection refused", "i/o timeout"]
                .iter()
                .any(|m| s.contains(m));
            if offline { IssuesErrorKind::Offline } else { IssuesErrorKind::Failed }
        }
        _ => IssuesErrorKind::Failed,
    }
}

/// GitHub Issues as a ticket source reads them. `account` is the gh account every call acts as.
pub trait GitHubIssues: Send + Sync {
    /// Issues of `repo` in `window`, pull requests and long-closed issues dropped.
    fn list_issues(&self, account: &str, repo: &str, window: IssueWindow, now: DateTime<Utc>) -> BoxFuture<Result<Vec<Issue>, IssuesError>>;
    /// One issue; `None` when it does not exist or is a pull request.
    fn issue(&self, account: &str, repo: &str, number: u64) -> BoxFuture<Result<Option<Issue>, IssuesError>>;
    fn issue_comments(&self, account: &str, repo: &str, number: u64) -> BoxFuture<Result<Vec<IssueComment>, IssuesError>>;
    /// Repos `account` can see (owner, collaborator, organization member), recently pushed first.
    fn repos(&self, account: &str) -> BoxFuture<Result<Vec<RepoSummary>, IssuesError>>;
}

fn checked_repo(repo: &str) -> Result<(), IssuesError> {
    split_repo(repo).map(|_| ()).ok_or_else(|| IssuesError::new(IssuesErrorKind::Failed, format!("{repo:?} is not an owner/name repo")))
}

fn from_failure(f: GhFailure) -> IssuesError {
    let kind = match &f {
        GhFailure::NoLogin(_) => IssuesErrorKind::NoLogin,
        GhFailure::RateLimited(_) => IssuesErrorKind::RateLimited,
        GhFailure::NotRun(_) => IssuesErrorKind::Failed,
    };
    IssuesError::new(kind, f.to_string())
}

fn from_reply(out: &GhReply) -> IssuesError {
    IssuesError::new(classify_failure(out.status, &out.stderr), api_error(out))
}

impl GhCli {
    async fn get(&self, account: &str, path: &str) -> Result<GhReply, IssuesError> {
        self.api_typed(account, &[path], None).await.map_err(from_failure)
    }

    /// `path` and every page GitHub links after it, up to `max_pages`, each read with `parse`.
    async fn paged<T>(&self, account: &str, path: &str, max_pages: u32, parse: fn(&str) -> Result<Vec<T>, String>) -> Result<Vec<T>, IssuesError> {
        let mut all = Vec::new();
        let mut next = Some(path.to_string());
        for _ in 0..max_pages {
            let Some(path) = next.take() else { break };
            let out = self.get(account, &path).await?;
            if !out.ok {
                return Err(from_reply(&out));
            }
            all.extend(parse(&String::from_utf8_lossy(&out.body)).map_err(|e| IssuesError::new(IssuesErrorKind::Failed, e))?);
            next = next_page_path(&out.headers);
        }
        Ok(all)
    }
}

impl GitHubIssues for GhCli {
    fn list_issues(&self, account: &str, repo: &str, window: IssueWindow, now: DateTime<Utc>) -> BoxFuture<Result<Vec<Issue>, IssuesError>> {
        let (this, account, repo) = (self.clone(), account.to_string(), repo.to_string());
        Box::pin(async move {
            checked_repo(&repo)?;
            let mut issues: Vec<Issue> = Vec::new();
            for path in issue_list_paths(&repo, &window, now) {
                for issue in this.paged(&account, &path, MAX_ISSUE_PAGES, parse_issues).await? {
                    if keep_issue(&issue, now) && !issues.iter().any(|i| i.number == issue.number) {
                        issues.push(issue);
                    }
                }
            }
            Ok(issues)
        })
    }

    fn issue(&self, account: &str, repo: &str, number: u64) -> BoxFuture<Result<Option<Issue>, IssuesError>> {
        let (this, account, repo) = (self.clone(), account.to_string(), repo.to_string());
        Box::pin(async move {
            checked_repo(&repo)?;
            let out = this.get(&account, &format!("repos/{repo}/issues/{number}")).await?;
            if !out.ok {
                return match from_reply(&out) {
                    e if e.kind == IssuesErrorKind::NotFound => Ok(None),
                    e => Err(e),
                };
            }
            parse_issue(&String::from_utf8_lossy(&out.body)).map_err(|e| IssuesError::new(IssuesErrorKind::Failed, e))
        })
    }

    fn issue_comments(&self, account: &str, repo: &str, number: u64) -> BoxFuture<Result<Vec<IssueComment>, IssuesError>> {
        let (this, account, repo) = (self.clone(), account.to_string(), repo.to_string());
        Box::pin(async move {
            checked_repo(&repo)?;
            let path = format!("repos/{repo}/issues/{number}/comments?per_page=100");
            let mut comments = this.paged(&account, &path, MAX_OTHER_PAGES, parse_issue_comments).await?;
            comments.sort_by(|a, b| (&a.created_at, a.id).cmp(&(&b.created_at, b.id)));
            Ok(comments)
        })
    }

    fn repos(&self, account: &str) -> BoxFuture<Result<Vec<RepoSummary>, IssuesError>> {
        let (this, account) = (self.clone(), account.to_string());
        Box::pin(async move { this.paged(&account, "user/repos?sort=pushed&per_page=100", MAX_OTHER_PAGES, parse_repos).await })
    }
}
