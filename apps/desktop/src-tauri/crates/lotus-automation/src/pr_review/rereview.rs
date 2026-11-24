//! A re-review: this automation already sent a review of the PR, and it is asked again at a new
//! head. The author's question is "is it fixed now?", so the agent gets every earlier finding, what
//! was said under each on GitHub, and the diff since, and answers each finding before anything new.
//! New findings stay near what changed since, blockers excepted: the goalposts do not move.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::prompt::defuse;
use super::{Diff, PrRef};
use crate::github::{review_id_from_url, GitHub, ReviewComment, Severity, ThreadReply};
use crate::store::Store;

const MAX_REPLY_CHARS: usize = 1_000;
const MAX_NOTE_CHARS: usize = 300;
pub const OUTSIDE_HEADING: &str = "## Outside the changes since the last review";
pub const SINCE_HEADING: &str = "## Since the last review";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Fixed,
    /// The author explained it, and the explanation holds.
    Answered,
    NotFixed,
}

impl Status {
    pub const ALL: [Status; 3] = [Status::Fixed, Status::Answered, Status::NotFixed];

    pub fn as_str(self) -> &'static str {
        match self {
            Status::Fixed => "fixed",
            Status::Answered => "answered",
            Status::NotFixed => "not-fixed",
        }
    }

    pub fn resolved(self) -> bool {
        self != Status::NotFixed
    }
}

/// One earlier finding, as the last review sent it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Earlier {
    #[serde(default)]
    pub finding_id: String,
    #[serde(default)]
    pub review_id: Option<u64>,
    pub path: String,
    pub line: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub severity: Option<Severity>,
    pub body: String,
    /// Its line comment on GitHub; `None` for a finding the summary held.
    pub comment_id: Option<u64>,
    #[serde(default)]
    pub replies: Vec<ThreadReply>,
}

/// What a re-review starts from.
#[derive(Debug, Clone)]
pub struct Context {
    /// The head the last review was of.
    pub since_sha: String,
    pub findings: Vec<Earlier>,
    /// The diff since `since_sha`; `None` when GitHub no longer has it (a force-push).
    pub since_diff: Option<String>,
}

/// The agent's answer for one earlier finding (numbered from 1).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Answer {
    pub finding: usize,
    pub status: Status,
    #[serde(default)]
    pub note: Option<String>,
}

/// The re-review context for `pr` at `head`, when this automation sent a review of it at another
/// head. A first review (or the same commit again) gets `None`.
pub async fn context(
    store: &Store,
    github: &dyn GitHub,
    account: &str,
    automation_id: &str,
    pr: &PrRef,
    head: &str,
    local: Option<(&super::Prefetch, &std::path::Path)>,
) -> Result<Option<Context>, String> {
    let Some(last) = store.last_sent_review(automation_id, &pr.repo, pr.number).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let since_sha = last.content["head_sha"].as_str().unwrap_or_default().to_string();
    if since_sha.is_empty() {
        return Ok(None);
    }
    let sent: Vec<ReviewComment> = serde_json::from_value(last.content["comments"].clone()).unwrap_or_default();
    let off_diff: Vec<ReviewComment> = serde_json::from_value(last.content["off_diff_comments"].clone()).unwrap_or_default();
    let review_id = last.sent_url.as_deref().and_then(review_id_from_url);
    let threads = match review_id {
        Some(id) => github.review_threads(account, pr, id).await?,
        None => vec![],
    };
    let mut findings = Vec::new();
    for (i, (c, on_github)) in sent.iter().map(|c| (c, true)).chain(off_diff.iter().map(|c| (c, false))).enumerate() {
        let thread = on_github.then(|| threads.iter().find(|t| t.path == c.path && t.line == c.line)).flatten();
        findings.push(Earlier {
            finding_id: format!("{}:{i}", last.id),
            review_id,
            path: c.path.clone(),
            line: c.line,
            severity: c.severity,
            body: c.body.clone(),
            comment_id: thread.map(|t| t.comment_id),
            replies: thread.map(|t| t.replies.clone()).unwrap_or_default(),
        });
    }
    // An unresolved inherited finding stays in the ledger even when no new inline comment repeats it.
    for p in last.content["previous"].as_array().into_iter().flatten().filter(|p| p["status"] == "not-fixed") {
        let mut f: Earlier = serde_json::from_value(p.clone()).map_err(|e| format!("unreadable prior finding: {e}"))?;
        if f.finding_id.is_empty() {
            f.finding_id = format!("{}:{}:{}", last.id, f.path, f.line);
        }
        if let Some(id) = f.review_id.filter(|id| Some(*id) != review_id) {
            if let Some(thread) = github.review_threads(account, pr, id).await?.into_iter().find(|t| Some(t.comment_id) == f.comment_id) {
                f.replies = thread.replies;
            }
        }
        match findings.iter_mut().find(|old| old.finding_id == f.finding_id || (old.path == f.path && old.line == f.line && old.body == f.body)) {
            Some(repeated) => *repeated = f,
            None => findings.push(f),
        }
    }
    if findings.is_empty() {
        return Ok(None);
    }
    let since_diff = if since_sha == head {
        Some(String::new())
    } else {
        // Locally first: GitHub's compare `.diff` refuses a big range (HTTP 406), as the PR's does.
        let local = match local {
            Some((prefetch, checkout)) => match prefetch.since_diff(checkout, &since_sha, head).await {
                Ok(text) => Some(text),
                Err(e) => {
                    eprintln!("[automation] local re-review diff of {}#{}: {e}; asking GitHub", pr.repo, pr.number);
                    None
                }
            },
            None => None,
        };
        match local {
            Some(text) => Some(text),
            None => github.compare_diff(account, &pr.repo, &since_sha, head).await?,
        }
    };
    Ok(Some(Context { since_sha, findings, since_diff }))
}

impl Context {
    /// What the agent is told, placed before the output rules. The findings are its own, but the
    /// replies and the diff were written by other people, so they sit inside the fence.
    pub fn prompt(&self, nonce: &str) -> String {
        let mut out = format!(
            "You reviewed this pull request before, at {sha}. Revisit the findings against the current code and feedback. First, for every \
             earlier finding below, say in previous whether it is fixed, answered (the author's reply explains it and \
             the explanation holds against the code), or not-fixed, with a short note. Then add new findings only on \
             lines near what changed since {sha}; a new finding elsewhere counts only as a blocker. \
             Earlier findings:\n",
            sha = self.since_sha
        );
        out.push_str(&format!("<untrusted-data-{nonce}>\n"));
        for (i, f) in self.findings.iter().enumerate() {
            let severity = f.severity.map_or("finding", Severity::as_str);
            out.push_str(&format!("{}. [{severity}] {}:{} {}\n", i + 1, defuse(&f.path), f.line, defuse(&f.body.trim().replace('\n', " "))));
        }
        for (i, f) in self.findings.iter().enumerate().filter(|(_, f)| !f.replies.is_empty()) {
            out.push_str(&format!("Replies under earlier finding {}:\n", i + 1));
            for r in &f.replies {
                let body: String = r.body.chars().take(MAX_REPLY_CHARS).collect();
                out.push_str(&format!("{}: {}\n", defuse(&r.author), defuse(&body)));
            }
        }
        match &self.since_diff {
            Some(diff) => out.push_str(&format!("The changes since {}:\n{}\n", self.since_sha, defuse(diff))),
            None => out.push_str(&format!(
                "{} is no longer in the history (a force-push), so every line of the pull request counts as changed.\n",
                self.since_sha
            )),
        }
        out.push_str(&format!("</untrusted-data-{nonce}>\n"));
        out
    }

    /// Where a new finding may sit: near the changes since, or anywhere after a force-push.
    pub fn in_scope(&self, since: Option<&Diff>, c: &ReviewComment) -> bool {
        c.severity == Some(Severity::Blocker) || since.is_none_or(|d| d.is_commentable(&c.path, c.line))
    }

    /// The agent's answers, one per earlier finding, joined to them for the draft.
    pub fn answered(&self, answers: &[Answer]) -> Result<Vec<Value>, String> {
        let n = self.findings.len();
        let mut seen = vec![None; n];
        for a in answers {
            let slot = a.finding.checked_sub(1).and_then(|i| seen.get_mut(i)).ok_or_else(|| format!("finding {} does not exist", a.finding))?;
            if slot.is_some() {
                return Err(format!("finding {} is answered twice", a.finding));
            }
            if a.note.as_ref().is_some_and(|t| t.chars().count() > MAX_NOTE_CHARS) {
                return Err(format!("the note on finding {} is longer than {MAX_NOTE_CHARS} characters", a.finding));
            }
            *slot = Some(a);
        }
        if seen.iter().any(Option::is_none) {
            return Err(format!("previous must answer every earlier finding (1 to {n})"));
        }
        Ok(self
            .findings
            .iter()
            .zip(seen)
            .map(|(f, a)| {
                let a = a.expect("checked above");
                json!({
                    "finding_id": f.finding_id, "review_id": f.review_id, "replies": f.replies,
                    "path": f.path, "line": f.line, "severity": f.severity, "body": f.body,
                    "comment_id": f.comment_id, "status": a.status, "note": a.note,
                })
            })
            .collect())
    }

    /// The summary's first part, for GitHub: how each earlier finding stands.
    pub fn summary_section(&self, previous: &[Value]) -> String {
        let mut out = format!("{SINCE_HEADING} ({})\n", self.since_sha);
        for p in previous {
            let label = match p["status"].as_str() {
                Some("fixed") => "✅ Fixed",
                Some("answered") => "💬 Answered",
                _ => "❌ Still open",
            };
            let first = p["body"].as_str().unwrap_or_default().trim().lines().next().unwrap_or_default().to_string();
            out.push_str(&format!("- {label}: `{}:{}` {first}", p["path"].as_str().unwrap_or_default(), p["line"]));
            if let Some(note) = p["note"].as_str().filter(|n| !n.trim().is_empty()) {
                out.push_str(&format!(" — {}", note.trim()));
            }
            out.push('\n');
        }
        out
    }
}

pub fn schema() -> Value {
    json!({
        "type": "array",
        "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["finding", "status"],
            "properties": {
                "finding": { "type": "integer", "minimum": 1 },
                "status": { "type": "string", "enum": Status::ALL.map(Status::as_str) },
                "note": { "type": "string", "maxLength": MAX_NOTE_CHARS }
            }
        }
    })
}

/// What an earlier finding stands at, from a draft's `previous`: its severity when still open.
pub fn open_severities(content: &Value) -> Vec<Severity> {
    content["previous"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| p["status"].as_str() == Some(Status::NotFixed.as_str()))
        .map(|p| serde_json::from_value(p["severity"].clone()).unwrap_or(Severity::ShouldFix))
        .collect()
}

/// `(resolved, total)` of a re-review's earlier findings; `None` for a first review.
pub fn progress(content: &Value) -> Option<(usize, usize)> {
    let previous = content["previous"].as_array().filter(|p| !p.is_empty())?;
    let resolved = previous.iter().filter(|p| p["status"].as_str() != Some(Status::NotFixed.as_str())).count();
    Some((resolved, previous.len()))
}

/// The thread reply that closes a resolved finding on GitHub.
pub fn closing_reply(status: &str) -> Option<&'static str> {
    match status {
        "fixed" => Some("Fixed ✅"),
        "answered" => Some("Thanks, that answers it ✅"),
        _ => None,
    }
}
