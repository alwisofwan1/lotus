//! GitHub, reached only through the `gh` CLI with a per-account token.
//! Invocation builders are pure; the port and its `gh`-backed adapter sit on
//! top of them.

use crate::no_window::NoWindow;
use std::collections::HashMap;

use crate::pr_review::PrRef;
use crate::registry::BoxFuture;

/// Ambient variables that could make `gh` act as someone else.
const STRIPPED_ENV: &[&str] = &["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"];

#[derive(Clone, PartialEq, Eq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

impl std::fmt::Debug for Invocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut keys: Vec<_> = self.env.keys().collect();
        keys.sort();
        f.debug_struct("Invocation")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("env_keys", &keys)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GhRefusal {
    #[error("{0:?} is not a GitHub account name")]
    BadAccount(String),
}

#[derive(Debug, Clone)]
pub struct Gh {
    program: String,
    base_env: HashMap<String, String>,
}

impl Gh {
    pub fn new(program: impl Into<String>) -> Self {
        Self { program: program.into(), base_env: HashMap::new() }
    }

    /// The environment `gh` runs in (a GUI app needs the login shell's
    /// PATH). Token-bearing variables are removed.
    pub fn with_base_env(mut self, env: impl IntoIterator<Item = (String, String)>) -> Self {
        self.base_env = env.into_iter().filter(|(k, _)| !STRIPPED_ENV.contains(&k.as_str())).collect();
        self
    }

    /// `gh auth token --user <account>`: reads that account's token from
    /// gh's keyring without switching the terminal's active account.
    pub fn token_invocation(&self, account: &str) -> Result<Invocation, GhRefusal> {
        if !is_account(account) {
            return Err(GhRefusal::BadAccount(account.to_string()));
        }
        Ok(Invocation {
            program: self.program.clone(),
            args: ["auth", "token", "--hostname", "github.com", "--user", account].map(String::from).to_vec(),
            env: self.base_env.clone(),
        })
    }

    /// True only when gh's own account list is readable and `account` is not on it. `gh auth
    /// logout --user X`, while X is not the active account, takes X off that list but leaves its
    /// token in the keyring, and `gh auth token --user X` still returns it (gh v2.87.3,
    /// `internal/config/config.go` `Logout` / `TokenForUser`). An unreadable list says nothing.
    pub fn is_logged_out(&self, account: &str) -> bool {
        // gh runs with only `base_env`, so its config folder is found there, as gh finds it.
        let env: Vec<(String, String)> = self.base_env.clone().into_iter().collect();
        let Some(dir) = gh_config_dir(&env, cfg!(windows)) else {
            return false;
        };
        let Ok(hosts) = std::fs::read_to_string(dir.join("hosts.yml")) else {
            return false;
        };
        gh_hosts_accounts(&hosts).is_some_and(|accounts| !accounts.iter().any(|a| a == account))
    }

    /// `gh api <args...>` authenticated as the owner of `token`.
    pub fn api_invocation(&self, token: &str, args: &[&str]) -> Invocation {
        let mut env = self.base_env.clone();
        env.insert("GH_TOKEN".into(), token.into());
        env.insert("GH_PROMPT_DISABLED".into(), "1".into());
        env.insert("GH_NO_UPDATE_NOTIFIER".into(), "1".into());
        let mut full = vec!["api".to_string()];
        full.extend(args.iter().map(|a| a.to_string()));
        Invocation { program: self.program.clone(), args: full, env }
    }
}

/// The most a review's GitHub read returns.
pub const READ_LIMIT: usize = 400 * 1024;

/// A REST path a review may read: relative to `api.github.com`, so never a URL to another host, and
/// never a flag to gh. Query strings are allowed (`?per_page=100`).
pub fn check_read_path(path: &str) -> Result<(), String> {
    let path_only = path.split('?').next().unwrap_or_default();
    if !path.starts_with('/') && !path.starts_with("repos/") && !path.starts_with("search/") {
        return Err(format!("{path:?}: give a REST path such as /repos/OWNER/REPO/pulls/1"));
    }
    if path.contains("://") || path.contains(char::is_whitespace) || path_only.contains("..") {
        return Err(format!("{path:?} is not a plain REST path"));
    }
    if path_only.trim_start_matches('/') == "graphql" {
        return Err("GraphQL is not available here; use the REST path".into());
    }
    Ok(())
}

/// GitHub logins: alphanumerics and single hyphens, never leading with one.
pub(crate) fn is_account(account: &str) -> bool {
    !account.is_empty()
        && account.len() <= 39
        && !account.starts_with('-')
        && account.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// gh's config folder, by gh's precedence (go-gh `pkg/config.ConfigDir`): `GH_CONFIG_DIR`,
/// `XDG_CONFIG_HOME/gh`, on Windows `AppData/GitHub CLI`, then `HOME/.config/gh`. Empty values are
/// skipped, as gh skips them. `None` when none is set.
pub fn gh_config_dir(env: &[(String, String)], windows: bool) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    // Windows variable names are case-insensitive.
    let get = |name: &str| env.iter().find(|(k, v)| k.eq_ignore_ascii_case(name) && !v.is_empty()).map(|(_, v)| v.as_str());
    if let Some(dir) = get("GH_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    if let Some(dir) = get("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(dir).join("gh"));
    }
    if windows {
        if let Some(dir) = get("APPDATA") {
            return Some(PathBuf::from(dir).join("GitHub CLI"));
        }
    }
    let home = get("HOME").or_else(|| if windows { get("USERPROFILE") } else { None })?;
    Some(PathBuf::from(home).join(".config").join("gh"))
}

/// The accounts gh is logged in to on github.com, from its `hosts.yml`:
///
/// ```yaml
/// github.com:
///     users:
///         alwisofwan1:
///         masjidubk13:
///     user: alwisofwan1
/// ```
///
/// No `github.com` section is no account (gh removes the host with its last account). `None` when
/// the section is there but has no `users:` map (gh before 2.40) or is not shaped as above: then
/// nothing is known, and the caller must not lock anyone out on it.
pub fn gh_hosts_accounts(hosts: &str) -> Option<Vec<String>> {
    let lines: Vec<(usize, &str)> = hosts
        .lines()
        .map(|line| (line.len() - line.trim_start().len(), line.trim()))
        .filter(|(_, text)| !text.is_empty() && !text.starts_with('#'))
        .collect();
    fn key(text: &str) -> Option<(&str, &str)> {
        text.split_once(':').map(|(k, rest)| (k.trim().trim_matches(|c| c == '"' || c == '\''), rest.trim()))
    }

    let Some(start) = lines.iter().position(|&(indent, text)| indent == 0 && key(text).is_some_and(|(k, _)| k == "github.com")) else {
        return Some(vec![]);
    };
    if !key(lines[start].1).is_some_and(|(_, rest)| rest.is_empty()) {
        return None;
    }
    let host: Vec<(usize, &str)> = lines[start + 1..].iter().copied().take_while(|&(indent, _)| indent > 0).collect();
    let child = host.first()?.0;
    let users = host.iter().position(|&(indent, text)| indent == child && key(text).is_some_and(|(k, _)| k == "users"))?;
    match key(host[users].1)?.1 {
        "{}" => return Some(vec![]),
        "" => {}
        _ => return None,
    }
    let entries: Vec<(usize, &str)> = host[users + 1..].iter().copied().take_while(|&(indent, _)| indent > child).collect();
    let Some(&(user_indent, _)) = entries.first() else {
        return Some(vec![]);
    };
    Some(
        entries
            .iter()
            .filter(|&&(indent, _)| indent == user_indent)
            .filter_map(|&(_, text)| key(text).map(|(k, _)| k.to_string()))
            .collect(),
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

/// The facts about a pull request the review gate and prompt need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub state: PrState,
    pub is_draft: bool,
    pub author: String,
    pub head_sha: String,
    /// The base branch's commit, which a local diff is taken against (ADR-0052 §1).
    pub base_sha: String,
    /// The base branch's name, fetched so `base_sha` is in the checkout.
    pub base_ref: String,
    pub title: String,
    pub body: String,
    /// Logins with a pending review request.
    pub requested_users: Vec<String>,
    /// Teams with a pending review request, as `org/slug`.
    pub requested_teams: Vec<String>,
}

/// One line comment of a review, on the new (RIGHT) side of the diff.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewComment {
    pub path: String,
    pub line: u64,
    /// Absent in drafts made before severities existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
    pub body: String,
}

/// How much a finding matters. Kept as a field in the draft; written at the
/// start of the comment only when it is sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Severity {
    Blocker,
    ShouldFix,
    Question,
    /// An optional improvement: the author may skip it. Never raises the verdict, and never
    /// stops the reviewer from approving (ADR-0042, amended).
    Suggestion,
}

impl Severity {
    pub const ALL: [Severity; 4] = [Severity::Blocker, Severity::ShouldFix, Severity::Question, Severity::Suggestion];

    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Blocker => "blocker",
            Severity::ShouldFix => "should-fix",
            Severity::Question => "question",
            Severity::Suggestion => "suggestion",
        }
    }
}

impl ReviewComment {
    /// The body as GitHub shows it: `**[blocker]** …` when it has a severity
    /// and the body does not start with that tag already.
    pub fn posted_body(&self) -> String {
        match self.severity {
            Some(s) => {
                let tag = format!("**[{}]**", s.as_str());
                if self.body.starts_with(&tag) { self.body.clone() } else { format!("{tag} {}", self.body) }
            }
            None => self.body.clone(),
        }
    }
}

/// The `POST /repos/{repo}/pulls/{n}/reviews` body, as a `COMMENT`. Approve and Request changes
/// are their own bodies below, chosen by the reviewer's click or by auto mode's rules from the
/// findings — never by what the agent or the draft says (ADR-0042). Comments anchor to `commit_id`, the commit that
/// was reviewed, so they land on the right lines even if the PR moved since.
pub fn review_request_body(commit_id: &str, body: &str, comments: &[ReviewComment]) -> serde_json::Value {
    serde_json::json!({
        "commit_id": commit_id,
        "body": body,
        "event": "COMMENT",
        "comments": comments
            .iter()
            .map(|c| serde_json::json!({ "path": c.path, "line": c.line, "side": "RIGHT", "body": c.posted_body() }))
            .collect::<Vec<_>>(),
    })
}

/// An approval, its line comments all suggestions: only ever posted when the reviewer pressed
/// Approve on a review that found nothing the author must act on (ADR-0042). The agent has no way
/// to ask for it.
pub fn approval_request_body(commit_id: &str, body: &str, comments: &[ReviewComment]) -> serde_json::Value {
    let mut request = review_request_body(commit_id, body, comments);
    request["event"] = serde_json::json!("APPROVE");
    request
}

/// A "Request changes" review: only ever posted by auto mode, when the review itself found a
/// blocker or should-fix — never because the agent asked for it (ADR-0042, amended 2026-10-14).
pub fn request_changes_body(commit_id: &str, body: &str, comments: &[ReviewComment]) -> serde_json::Value {
    let mut request = review_request_body(commit_id, body, comments);
    request["event"] = serde_json::json!("REQUEST_CHANGES");
    request
}

/// One pull request in a review-request search, as data for a prompt.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PrSummary {
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub author: String,
    pub url: String,
    pub updated_at: String,
}

/// Reads a `GET /search/issues` response into pull request summaries.
pub fn parse_search_prs(body: &str) -> Result<Vec<PrSummary>, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("unreadable search: {e}"))?;
    Ok(v["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|i| {
                    let repo = i["repository_url"].as_str()?.split("/repos/").nth(1)?.to_string();
                    Some(PrSummary {
                        repo,
                        number: i["number"].as_u64()?,
                        title: i["title"].as_str().unwrap_or_default().to_string(),
                        author: i["user"]["login"].as_str().unwrap_or_default().to_string(),
                        url: i["html_url"].as_str().unwrap_or_default().to_string(),
                        updated_at: i["updated_at"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// GitHub as the automation engine sees it. `account` is the gh account
/// (= GitHub login) every call acts as.
pub trait GitHub: Send + Sync {
    fn pull_request(&self, account: &str, pr: &PrRef) -> BoxFuture<Result<PullRequest, String>>;
    fn diff(&self, account: &str, pr: &PrRef) -> BoxFuture<Result<String, String>>;
    /// A file's text at `git_ref`, or `None` when it does not exist.
    fn file(&self, account: &str, repo: &str, path: &str, git_ref: &str) -> BoxFuture<Result<Option<String>, String>>;
    /// Open, ready (not draft) PRs that request `account` (or `team`, `org/slug`) as reviewer.
    fn review_requests(&self, account: &str, team: Option<&str>) -> BoxFuture<Result<Vec<PrSummary>, String>>;
    /// Posts a review (body from [`review_request_body`]); returns its URL.
    fn post_review(&self, account: &str, pr: &PrRef, body: serde_json::Value) -> BoxFuture<Result<String, String>>;
    /// The line comments of review `review_id`, each with the replies under it.
    fn review_threads(&self, account: &str, pr: &PrRef, review_id: u64) -> BoxFuture<Result<Vec<ReviewThread>, String>>;
    /// The diff from `base` to `head`; `None` when GitHub no longer knows `base` (a force-push).
    fn compare_diff(&self, account: &str, repo: &str, base: &str, head: &str) -> BoxFuture<Result<Option<String>, String>>;
    /// Replies under line comment `comment_id`.
    fn reply_to_comment(&self, account: &str, pr: &PrRef, comment_id: u64, body: &str) -> BoxFuture<Result<(), String>>;
    /// Everything said on the PR so far, by everyone: reviews, line comments and conversation
    /// comments, so a review neither repeats nor misses another reviewer. Default: nothing.
    fn discussion(&self, _account: &str, _pr: &PrRef) -> BoxFuture<Result<Discussion, String>> {
        Box::pin(async { Ok(Discussion::default()) })
    }
    /// Dismisses review `review_id` (one of `account`'s own "Request changes"), saying `message`.
    fn dismiss_review(&self, _account: &str, _pr: &PrRef, _review_id: u64, _message: &str) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Err("dismissing a review is not supported here".to_string()) })
    }
}

/// What everyone has said on a pull request, oldest first in each list.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Discussion {
    pub reviews: Vec<OtherReview>,
    pub comments: Vec<LineComment>,
    /// The PR's conversation tab.
    pub conversation: Vec<ConversationComment>,
}

/// One submitted review: its verdict and its body (its line comments are in `comments`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OtherReview {
    pub id: u64,
    pub author: String,
    /// `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`.
    pub state: String,
    pub body: String,
    pub submitted_at: String,
    pub commit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LineComment {
    pub id: u64,
    pub review_id: Option<u64>,
    pub in_reply_to: Option<u64>,
    pub author: String,
    pub path: String,
    /// `None`: on a file, or outdated past any line.
    pub line: Option<u64>,
    pub body: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConversationComment {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

/// Reads `GET …/pulls/{n}/reviews`, `GET …/pulls/{n}/comments` and `GET …/issues/{n}/comments`.
/// A review with no body and no state worth saying (a reply-only `COMMENTED` shell) is kept: its
/// line comments point at it.
pub fn parse_discussion(reviews: &str, comments: &str, conversation: &str) -> Result<Discussion, String> {
    let array = |text: &str, what: &str| -> Result<Vec<serde_json::Value>, String> {
        let v: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("unreadable {what}: {e}"))?;
        Ok(v.as_array().cloned().unwrap_or_default())
    };
    let s = |v: &serde_json::Value, key: &str| v[key].as_str().unwrap_or_default().to_string();
    let login = |v: &serde_json::Value| v["user"]["login"].as_str().unwrap_or("someone").to_string();
    let reviews = array(reviews, "reviews")?
        .iter()
        .filter_map(|r| {
            Some(OtherReview {
                id: r["id"].as_u64()?,
                author: login(r),
                state: s(r, "state"),
                body: s(r, "body"),
                submitted_at: s(r, "submitted_at"),
                commit: s(r, "commit_id"),
            })
        })
        .collect();
    let comments = array(comments, "review comments")?
        .iter()
        .filter_map(|c| {
            Some(LineComment {
                id: c["id"].as_u64()?,
                review_id: c["pull_request_review_id"].as_u64(),
                in_reply_to: c["in_reply_to_id"].as_u64(),
                author: login(c),
                path: s(c, "path"),
                line: c["line"].as_u64().or_else(|| c["original_line"].as_u64()),
                body: s(c, "body"),
                created_at: s(c, "created_at"),
            })
        })
        .collect();
    let conversation = array(conversation, "conversation comments")?
        .iter()
        .map(|c| ConversationComment { author: login(c), body: s(c, "body"), created_at: s(c, "created_at") })
        .collect();
    Ok(Discussion { reviews, comments, conversation })
}

/// One line comment of a review we posted, and what was said under it since.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReviewThread {
    pub comment_id: u64,
    pub path: String,
    /// The line it was written on (GitHub's `original_line`: `line` is gone once it is outdated).
    pub line: u64,
    pub replies: Vec<ThreadReply>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThreadReply {
    pub author: String,
    pub body: String,
}

/// Reads `GET /repos/{repo}/pulls/{n}/comments` into the threads of review `review_id`, replies
/// oldest first.
pub fn parse_review_threads(body: &str, review_id: u64) -> Result<Vec<ReviewThread>, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("unreadable review comments: {e}"))?;
    let items = v.as_array().cloned().unwrap_or_default();
    let mut threads: Vec<ReviewThread> = items
        .iter()
        .filter(|c| c["pull_request_review_id"].as_u64() == Some(review_id) && c["in_reply_to_id"].is_null())
        .filter_map(|c| {
            Some(ReviewThread {
                comment_id: c["id"].as_u64()?,
                path: c["path"].as_str()?.to_string(),
                line: c["line"].as_u64().or_else(|| c["original_line"].as_u64())?,
                replies: vec![],
            })
        })
        .collect();
    let mut replies: Vec<&serde_json::Value> = items.iter().filter(|c| c["in_reply_to_id"].is_u64()).collect();
    replies.sort_by_key(|c| c["id"].as_u64());
    for reply in replies {
        if let Some(thread) = threads.iter_mut().find(|t| reply["in_reply_to_id"].as_u64() == Some(t.comment_id)) {
            thread.replies.push(ThreadReply {
                author: reply["user"]["login"].as_str().unwrap_or_default().to_string(),
                body: reply["body"].as_str().unwrap_or_default().to_string(),
            });
        }
    }
    Ok(threads)
}

/// `…#pullrequestreview-<id>`, as [`GitHub::post_review`] returns it.
pub fn review_id_from_url(url: &str) -> Option<u64> {
    url.rsplit_once("#pullrequestreview-")?.1.parse().ok()
}

/// Reads the `GET /repos/{repo}/pulls/{n}` response. Teams come back as bare
/// slugs; they are qualified with the repo's org to compare with config.
pub fn parse_pull_request(body: &str, repo: &str) -> Result<PullRequest, String> {
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| format!("unreadable pull request: {e}"))?;
    let text = |pointer: &str| v.pointer(pointer).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let org = repo.split('/').next().unwrap_or_default();
    let state = match (text("/state").as_str(), v["merged"].as_bool().unwrap_or(false)) {
        (_, true) => PrState::Merged,
        ("open", _) => PrState::Open,
        _ => PrState::Closed,
    };
    let head_sha = text("/head/sha");
    if head_sha.is_empty() {
        return Err("pull request response has no head sha".into());
    }
    let list = |key: &str, field: &str| -> Vec<String> {
        v[key]
            .as_array()
            .map(|items| items.iter().filter_map(|i| i[field].as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    Ok(PullRequest {
        state,
        is_draft: v["draft"].as_bool().unwrap_or(false),
        author: text("/user/login"),
        head_sha,
        base_sha: text("/base/sha"),
        base_ref: text("/base/ref"),
        title: text("/title"),
        body: text("/body"),
        requested_users: list("requested_reviewers", "login"),
        requested_teams: list("requested_teams", "slug").into_iter().map(|slug| format!("{org}/{slug}")).collect(),
    })
}

/// The `gh`-backed [`GitHub`]. Not unit-tested (it needs the network and a
/// logged-in gh); its pure parts are, and `examples/review_pr.rs` smokes it.
#[derive(Debug, Clone)]
pub struct GhCli {
    gh: Gh,
}

impl GhCli {
    pub fn new(gh: Gh) -> Self {
        Self { gh }
    }

    async fn token(&self, account: &str) -> Result<String, String> {
        let inv = self.gh.token_invocation(account).map_err(|e| e.to_string())?;
        let no_login = || format!("gh has no usable login for {account}; run `gh auth login` for that account");
        // gh would still hand out the token of an account logged out of it (see `is_logged_out`).
        if self.gh.is_logged_out(account) {
            return Err(no_login());
        }
        let out = run(&inv).await?;
        if !out.status.success() {
            return Err(no_login());
        }
        let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if token.is_empty() {
            return Err(format!("gh returned an empty token for {account}"));
        }
        Ok(token)
    }

    /// A PR review agent's GitHub read (ADR-0052 §3, revised 2026-10-08): `GET <path>` as
    /// `account`, run by Lotus outside the agent's sandbox, so the agent never holds a token that
    /// could write. GET never changes anything on GitHub. The body, cut at [`READ_LIMIT`] bytes.
    pub async fn read_for_review(&self, account: &str, path: &str, paginate: bool) -> Result<String, String> {
        check_read_path(path)?;
        let token = self.token(account).await?;
        let mut args = vec!["--method", "GET"];
        if paginate {
            args.push("--paginate");
        }
        args.push(path);
        let out = run(&self.gh.api_invocation(&token, &args)).await?;
        let mut body = String::from_utf8_lossy(&out.stdout).into_owned();
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("GET {path} failed: {} {}", stderr.trim(), body.chars().take(300).collect::<String>()));
        }
        if body.len() > READ_LIMIT {
            let mut cut = READ_LIMIT;
            while !body.is_char_boundary(cut) {
                cut -= 1;
            }
            body.truncate(cut);
            body.push_str("\n[cut by Lotus at 400 KB: ask for a narrower path, or page with ?per_page=&page=]");
        }
        Ok(body)
    }

    async fn api(&self, account: &str, args: &[&str]) -> Result<GhReply, String> {
        self.api_with(account, args, None).await
    }

    async fn api_with_body(&self, account: &str, args: &[&str], body: &[u8]) -> Result<GhReply, String> {
        self.api_with(account, args, Some(body)).await
    }

    async fn api_with(&self, account: &str, args: &[&str], body: Option<&[u8]>) -> Result<GhReply, String> {
        self.api_typed(account, args, body).await.map_err(|e| e.to_string())
    }

    /// `gh api --include`, so GitHub's rate-limit headers can be read, with
    /// one wait-and-retry when GitHub asks for it. The failure says why, for
    /// callers that report it as a source's health (ADR-0048).
    pub(crate) async fn api_typed(&self, account: &str, args: &[&str], body: Option<&[u8]>) -> Result<GhReply, GhFailure> {
        let token = self.token(account).await.map_err(GhFailure::NoLogin)?;
        let mut full = vec!["--include"];
        full.extend_from_slice(args);
        let inv = self.gh.api_invocation(&token, &full);
        let what = args.iter().rev().find(|a| !a.starts_with('-')).copied().unwrap_or("gh api").to_string();
        let inv = &inv;
        let reply = crate::ratelimit::with_rate_limit(
            &what,
            || async move {
                // Not running gh is not a rate limit: carried through as a value.
                let out = match run_with_stdin(inv, body).await {
                    Ok(out) => out,
                    Err(e) => return Ok(crate::ratelimit::Attempt::Done(Err(e))),
                };
                let reply = GhReply::from_output(out);
                let now_s = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                Ok(match rate_limit_wait(reply.status, &reply.headers, now_s) {
                    Some(wait) => crate::ratelimit::Attempt::Wait(wait),
                    None => crate::ratelimit::Attempt::Done(Ok(reply)),
                })
            },
            tokio::time::sleep,
        )
        .await
        .map_err(GhFailure::RateLimited)?;
        reply.map_err(GhFailure::NotRun)
    }
}

/// Why a `gh api` call produced no HTTP reply to read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum GhFailure {
    /// No usable token for the account (`gh auth token --user` failed).
    #[error("{0}")]
    NoLogin(String),
    /// GitHub kept asking to wait, or for longer than we sleep.
    #[error("{0}")]
    RateLimited(String),
    /// gh could not be started.
    #[error("{0}")]
    NotRun(String),
}

/// One `gh api --include` result.
#[derive(Debug)]
pub(crate) struct GhReply {
    pub(crate) ok: bool,
    /// 0 when gh failed before any HTTP response (no network, no login).
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
    pub(crate) stderr: String,
}

impl GhReply {
    fn from_output(out: std::process::Output) -> Self {
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        match split_included(&out.stdout) {
            Some((status, headers, body)) => Self { ok: out.status.success(), status, headers, body, stderr },
            None => Self { ok: out.status.success(), status: 0, headers: vec![], body: out.stdout, stderr },
        }
    }
}

/// HTTP status, headers (lowercase names) and body of one response.
pub type Included = (u16, Vec<(String, String)>, Vec<u8>);

/// Splits `gh api --include` output into status, headers (names lowercased)
/// and body. The body may itself hold blank lines (a diff), so only the
/// first blank line ends the headers. `None` if it is not an HTTP response.
pub fn split_included(stdout: &[u8]) -> Option<Included> {
    let text = std::str::from_utf8(stdout).ok()?;
    let (head, body) = match (text.find("\r\n\r\n"), text.find("\n\n")) {
        (Some(crlf), Some(lf)) if crlf < lf => (&text[..crlf], &text[crlf + 4..]),
        (_, Some(lf)) => (&text[..lf], &text[lf + 2..]),
        (Some(crlf), None) => (&text[..crlf], &text[crlf + 4..]),
        (None, None) => (text, ""),
    };
    let mut lines = head.lines();
    let status_line = lines.next()?;
    if !status_line.starts_with("HTTP/") {
        return None;
    }
    let status = status_line.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Some((status, headers, body.as_bytes().to_vec()))
}

/// How long GitHub asks to wait, if this response is a rate limit
/// (docs: "Rate limits for the REST API"): `Retry-After` on a 403/429, or no
/// requests left until `X-RateLimit-Reset`. A 429 that says nothing: 60 s.
pub fn rate_limit_wait(status: u16, headers: &[(String, String)], now_s: u64) -> Option<std::time::Duration> {
    if status != 403 && status != 429 {
        return None;
    }
    let header = |name: &str| headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.trim());
    if let Some(secs) = header("retry-after").and_then(|v| v.parse::<u64>().ok()) {
        return Some(std::time::Duration::from_secs(secs));
    }
    if header("x-ratelimit-remaining") == Some("0") {
        let reset = header("x-ratelimit-reset").and_then(|v| v.parse::<u64>().ok()).unwrap_or(now_s + 60);
        return Some(std::time::Duration::from_secs(reset.saturating_sub(now_s).max(1)));
    }
    (status == 429).then(|| std::time::Duration::from_secs(60))
}

async fn run(inv: &Invocation) -> Result<std::process::Output, String> {
    run_with_stdin(inv, None).await
}

async fn run_with_stdin(inv: &Invocation, stdin: Option<&[u8]>) -> Result<std::process::Output, String> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(&inv.program)
        .no_window()
        .args(&inv.args)
        .env_clear()
        .envs(&inv.env)
        .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not run {}: {e}", inv.program))?;
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(bytes).await.map_err(|e| format!("could not write to {}: {e}", inv.program))?;
    }
    child.wait_with_output().await.map_err(|e| format!("{} did not finish: {e}", inv.program))
}

pub(crate) fn api_error(out: &GhReply) -> String {
    // gh prints the HTTP status and GitHub's message; never the token.
    out.stderr.lines().next().unwrap_or("gh api failed").chars().take(300).collect()
}

impl GitHub for GhCli {
    fn pull_request(&self, account: &str, pr: &PrRef) -> BoxFuture<Result<PullRequest, String>> {
        let (this, account, pr) = (self.clone(), account.to_string(), pr.clone());
        Box::pin(async move {
            let path = format!("repos/{}/pulls/{}", pr.repo, pr.number);
            let out = this.api(&account, &[&path]).await?;
            if !out.ok {
                return Err(api_error(&out));
            }
            parse_pull_request(&String::from_utf8_lossy(&out.body), &pr.repo)
        })
    }

    fn diff(&self, account: &str, pr: &PrRef) -> BoxFuture<Result<String, String>> {
        let (this, account, pr) = (self.clone(), account.to_string(), pr.clone());
        Box::pin(async move {
            let path = format!("repos/{}/pulls/{}", pr.repo, pr.number);
            let out = this.api(&account, &["-H", "Accept: application/vnd.github.v3.diff", &path]).await?;
            if !out.ok {
                return Err(api_error(&out));
            }
            Ok(String::from_utf8_lossy(&out.body).into_owned())
        })
    }

    fn file(&self, account: &str, repo: &str, path: &str, git_ref: &str) -> BoxFuture<Result<Option<String>, String>> {
        let (this, account) = (self.clone(), account.to_string());
        let endpoint = format!("repos/{repo}/contents/{path}?ref={git_ref}");
        Box::pin(async move {
            let out = this.api(&account, &["-H", "Accept: application/vnd.github.raw+json", &endpoint]).await?;
            if out.ok {
                return Ok(Some(String::from_utf8_lossy(&out.body).into_owned()));
            }
            if out.status == 404 || out.stderr.contains("HTTP 404") {
                return Ok(None);
            }
            Err(api_error(&out))
        })
    }

    fn post_review(&self, account: &str, pr: &PrRef, body: serde_json::Value) -> BoxFuture<Result<String, String>> {
        let (this, account, pr) = (self.clone(), account.to_string(), pr.clone());
        Box::pin(async move {
            let path = format!("repos/{}/pulls/{}/reviews", pr.repo, pr.number);
            let out = this.api_with_body(&account, &["-X", "POST", &path, "--input", "-"], body.to_string().as_bytes()).await?;
            if !out.ok {
                return Err(api_error(&out));
            }
            let v: serde_json::Value = serde_json::from_slice(&out.body).map_err(|e| format!("unreadable review response: {e}"))?;
            Ok(v["html_url"].as_str().unwrap_or_default().to_string())
        })
    }

    fn review_requests(&self, account: &str, team: Option<&str>) -> BoxFuture<Result<Vec<PrSummary>, String>> {
        let (this, account, team) = (self.clone(), account.to_string(), team.map(str::to_string));
        Box::pin(async move {
            let mut queries = vec![format!("is:pr is:open archived:false draft:false review-requested:{account}")];
            if let Some(team) = &team {
                queries.push(format!("is:pr is:open archived:false draft:false team-review-requested:{team}"));
            }
            let mut all: Vec<PrSummary> = Vec::new();
            for q in queries {
                let q = format!("q={q}");
                let out = this.api(&account, &["-X", "GET", "search/issues", "-f", &q, "-f", "per_page=50"]).await?;
                if !out.ok {
                    return Err(api_error(&out));
                }
                for pr in parse_search_prs(&String::from_utf8_lossy(&out.body))? {
                    if !all.iter().any(|p| p.url == pr.url) {
                        all.push(pr);
                    }
                }
            }
            Ok(all)
        })
    }

    fn review_threads(&self, account: &str, pr: &PrRef, review_id: u64) -> BoxFuture<Result<Vec<ReviewThread>, String>> {
        let (this, account, pr) = (self.clone(), account.to_string(), pr.clone());
        Box::pin(async move {
            // One page: a thread past the 100th comment of a PR is not seen.
            let path = format!("repos/{}/pulls/{}/comments?per_page=100", pr.repo, pr.number);
            let out = this.api(&account, &[&path]).await?;
            if !out.ok {
                return Err(api_error(&out));
            }
            parse_review_threads(&String::from_utf8_lossy(&out.body), review_id)
        })
    }

    fn compare_diff(&self, account: &str, repo: &str, base: &str, head: &str) -> BoxFuture<Result<Option<String>, String>> {
        let (this, account, path) = (self.clone(), account.to_string(), format!("repos/{repo}/compare/{base}...{head}"));
        Box::pin(async move {
            let out = this.api(&account, &["-H", "Accept: application/vnd.github.v3.diff", &path]).await?;
            match out.status {
                404 | 422 => Ok(None),
                _ if !out.ok => Err(api_error(&out)),
                _ => Ok(Some(String::from_utf8_lossy(&out.body).into_owned())),
            }
        })
    }

    fn reply_to_comment(&self, account: &str, pr: &PrRef, comment_id: u64, body: &str) -> BoxFuture<Result<(), String>> {
        let (this, account, pr) = (self.clone(), account.to_string(), pr.clone());
        let payload = serde_json::json!({ "body": body }).to_string();
        Box::pin(async move {
            let path = format!("repos/{}/pulls/{}/comments/{comment_id}/replies", pr.repo, pr.number);
            let out = this.api_with_body(&account, &["-X", "POST", &path, "--input", "-"], payload.as_bytes()).await?;
            if !out.ok {
                return Err(api_error(&out));
            }
            Ok(())
        })
    }

    fn discussion(&self, account: &str, pr: &PrRef) -> BoxFuture<Result<Discussion, String>> {
        let (this, account, pr) = (self.clone(), account.to_string(), pr.clone());
        Box::pin(async move {
            // One page each: past the 100th item of a list the oldest are what a review needs least.
            let mut texts = Vec::new();
            for path in [
                format!("repos/{}/pulls/{}/reviews?per_page=100", pr.repo, pr.number),
                format!("repos/{}/pulls/{}/comments?per_page=100", pr.repo, pr.number),
                format!("repos/{}/issues/{}/comments?per_page=100", pr.repo, pr.number),
            ] {
                let out = this.api(&account, &[&path]).await?;
                if !out.ok {
                    return Err(api_error(&out));
                }
                texts.push(String::from_utf8_lossy(&out.body).into_owned());
            }
            parse_discussion(&texts[0], &texts[1], &texts[2])
        })
    }

    fn dismiss_review(&self, account: &str, pr: &PrRef, review_id: u64, message: &str) -> BoxFuture<Result<(), String>> {
        let (this, account, pr) = (self.clone(), account.to_string(), pr.clone());
        let payload = serde_json::json!({ "message": message, "event": "DISMISS" }).to_string();
        Box::pin(async move {
            let path = format!("repos/{}/pulls/{}/reviews/{review_id}/dismissals", pr.repo, pr.number);
            let out = this.api_with_body(&account, &["-X", "PUT", &path, "--input", "-"], payload.as_bytes()).await?;
            if !out.ok {
                return Err(api_error(&out));
            }
            Ok(())
        })
    }
}

/// A gh login for github.com, as `gh auth login` recorded it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct GhAccount {
    pub login: String,
    /// The account `gh` uses when none is named.
    pub active: bool,
}

/// Reads the github.com accounts from gh's `hosts.yml`. Only the account
/// names and the active marker are read; token lines are never looked at.
pub fn parse_gh_hosts(text: &str) -> Vec<GhAccount> {
    let indent = |line: &str| line.len() - line.trim_start().len();
    let mut in_host = false;
    let mut users_indent: Option<usize> = None;
    let mut child_indent: Option<usize> = None;
    let mut logins: Vec<String> = Vec::new();
    let mut active: Option<String> = None;
    for line in text.lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let depth = indent(line);
        let item = line.trim();
        if depth == 0 {
            in_host = item == "github.com:";
            users_indent = None;
            continue;
        }
        if !in_host {
            continue;
        }
        if let Some(u) = users_indent {
            if depth > u {
                let first = *child_indent.get_or_insert(depth);
                if depth == first {
                    if let Some(login) = item.strip_suffix(':') {
                        logins.push(login.trim().to_string());
                    }
                }
                continue;
            }
            users_indent = None;
        }
        if item == "users:" {
            users_indent = Some(depth);
            child_indent = None;
        } else if let Some(user) = item.strip_prefix("user:") {
            active = Some(user.trim().to_string());
        }
    }
    logins
        .into_iter()
        .filter(|login| is_account(login))
        .map(|login| GhAccount { active: active.as_deref() == Some(login.as_str()), login })
        .collect()
}

#[cfg(test)]
mod read_path_tests {
    use super::check_read_path;

    #[test]
    fn a_review_reads_rest_paths_only() {
        for ok in ["/repos/acme/acme-api/pulls/3019/files?per_page=100", "repos/a/b/issues/1/comments", "/search/issues?q=x"] {
            assert!(check_read_path(ok).is_ok(), "{ok}");
        }
        for bad in ["--method=POST", "-XPOST", "https://evil.example/x", "/repos/a/../../x", "/graphql", "graphql", "/repos/a b", ""] {
            assert!(check_read_path(bad).is_err(), "{bad}");
        }
    }
}
