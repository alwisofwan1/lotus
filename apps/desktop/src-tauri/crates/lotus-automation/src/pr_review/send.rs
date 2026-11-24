use serde::Deserialize;
use serde_json::Value;

use super::action::{PrReviewConfig, MAX_COMMENTS, MAX_COMMENT_CHARS, MAX_REVIEW_BODY_CHARS};
use super::PrRef;
use crate::github::{approval_request_body, request_changes_body, review_request_body, GitHub, ReviewComment, Severity};
use crate::model::DraftStatus;
use crate::store::Store;

/// The reviewer's edits to a draft. Replaces the draft's summary and comments, and — when given —
/// what the Slack thread is told.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EditedReview {
    pub summary: String,
    pub comments: Vec<ReviewComment>,
    #[serde(default)]
    pub reply: Option<super::brief::Brief>,
}

#[derive(Debug, Clone)]
pub struct SendRequest {
    pub draft_id: String,
    pub edited: Option<EditedReview>,
    /// Send although the PR moved past the reviewed commit.
    pub send_even_if_stale: bool,
    /// The reviewer pressed Approve: posted as an APPROVE review, and only when the review found
    /// nothing the author must act on — every finding a suggestion, a looks-good verdict (ADR-0042).
    pub approve: bool,
    /// Post as "Request changes": only when the review itself holds a blocker or should-fix that is
    /// still open. Auto mode sets it ([`super::auto`]); the agent never can.
    pub request_changes: bool,
    /// Off: nothing is posted to GitHub; the draft is only marked sent, for the Slack reply, with
    /// the PR as its link. Approve needs GitHub.
    pub post_github: bool,
    /// A re-review's: reply ✅ under each earlier finding it found resolved, on its GitHub thread.
    pub close_threads: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SendError {
    #[error("no such draft")]
    NotFound,
    /// An Ask, or another kind's result: never posted to GitHub (PLAN §8 Q21).
    #[error("only a review draft can be sent to GitHub")]
    NotAReview,
    #[error("the draft is {} and cannot be sent", .0.as_str())]
    NotPending(DraftStatus),
    #[error("the pull request moved from {reviewed} to {current} since this review")]
    Stale { reviewed: String, current: String },
    #[error("{0}")]
    Invalid(String),
    #[error("GitHub: {0}")]
    GitHub(String),
    #[error(transparent)]
    Store(#[from] crate::error::Error),
}

/// Posts a pending `pr_review` draft as a COMMENT review, at the commit it
/// reviewed, as the automation's account. Exactly one send can ever win.
pub async fn send_draft(store: &Store, github: &dyn GitHub, req: SendRequest, now_ms: i64) -> Result<String, SendError> {
    let draft = store.get_draft(&req.draft_id)?.ok_or(SendError::NotFound)?;
    if draft.kind != "pr_review" {
        return Err(SendError::NotAReview);
    }
    if draft.status != DraftStatus::Pending {
        return Err(SendError::NotPending(draft.status));
    }
    let automation = store.get_automation(&draft.automation_id)?.ok_or(SendError::NotFound)?;
    let config: PrReviewConfig = serde_json::from_value(automation.action.config)
        .map_err(|e| SendError::Invalid(format!("automation config is invalid: {e}")))?;

    let content = draft.content.clone();
    let text = |key: &str| content[key].as_str().map(str::to_string);
    let pr = PrRef {
        repo: text("repo").ok_or_else(|| SendError::Invalid("draft has no repo".into()))?,
        number: content["number"].as_u64().ok_or_else(|| SendError::Invalid("draft has no PR number".into()))?,
    };
    let reviewed = text("head_sha").ok_or_else(|| SendError::Invalid("draft has no head sha".into()))?;
    let (summary, comments, reply) = match req.edited {
        Some(edit) => (edit.summary, edit.comments, edit.reply.map(|r| super::brief::keep_lead(r, &content["reply"]))),
        None => (
            text("summary").unwrap_or_default(),
            serde_json::from_value(content["comments"].clone())
                .map_err(|e| SendError::Invalid(format!("draft comments are unreadable: {e}")))?,
            None,
        ),
    };
    validate(&summary, &comments)?;
    if let Some(reply) = &reply {
        reply.check().map_err(SendError::Invalid)?;
    }
    if req.approve && !req.post_github {
        return Err(SendError::Invalid("approving needs GitHub: turn GitHub on, or reply in Slack only without approving".into()));
    }
    if req.approve {
        check_approvable(&content, &comments, reply.as_ref())?;
    }
    if req.request_changes {
        if req.approve || !req.post_github {
            return Err(SendError::Invalid("Request changes goes to GitHub, and never with Approve".into()));
        }
        check_must_fix(&content, &comments)?;
    }

    let current = github.pull_request(&config.account, &pr).await.map_err(SendError::GitHub)?.head_sha;
    if current != reviewed && (req.approve || !req.send_even_if_stale) {
        return Err(SendError::Stale { reviewed, current });
    }

    if let Err(status) = store.claim_draft_for_sending(&draft.id)? {
        return Err(SendError::NotPending(status));
    }
    let url = if req.post_github {
        let body = if req.approve {
            approval_request_body(&reviewed, &summary, &comments)
        } else if req.request_changes {
            request_changes_body(&reviewed, &summary, &comments)
        } else {
            review_request_body(&reviewed, &summary, &comments)
        };
        match github.post_review(&config.account, &pr, body).await {
            Ok(url) => url,
            Err(e) => {
                store.release_draft(&draft.id)?;
                return Err(SendError::GitHub(e));
            }
        }
    } else {
        match text("url") {
            Some(url) => url,
            None => {
                store.release_draft(&draft.id)?;
                return Err(SendError::Invalid("draft has no PR url to link from Slack".into()));
            }
        }
    };
    let mut kept: Value = content;
    kept["summary"] = Value::String(summary);
    kept["comments"] = serde_json::to_value(&comments).unwrap_or_default();
    if let Some(reply) = reply {
        kept["reply"] = serde_json::to_value(reply).unwrap_or_default();
    }
    if req.approve {
        kept["approved"] = Value::Bool(true);
    }
    if req.request_changes {
        kept["changes_requested"] = Value::Bool(true);
    }
    if !req.post_github {
        kept["github"] = Value::String("skipped".into());
    }
    if req.close_threads && req.post_github {
        // Best effort: the review is posted whatever happens to a thread reply.
        let (mut closed, mut failed) = (0, 0);
        for p in kept["previous"].as_array().cloned().unwrap_or_default() {
            let (Some(id), Some(reply)) = (p["comment_id"].as_u64(), p["status"].as_str().and_then(super::rereview::closing_reply)) else {
                continue;
            };
            match github.reply_to_comment(&config.account, &pr, id, reply).await {
                Ok(()) => closed += 1,
                Err(e) => {
                    failed += 1;
                    eprintln!("[automation] could not reply on thread {id}: {}", crate::secrets::redact(&e));
                }
            }
        }
        kept["threads_closed"] = serde_json::json!({ "replied": closed, "failed": failed });
    }
    store.mark_draft_sent(&draft.id, &url, &kept, now_ms)?;
    Ok(url)
}

/// Approve only what found nothing the author must act on, however the review was edited: every
/// comment, everything moved off the diff and every earlier finding still open is a suggestion.
/// The engine checks what the panel already hides, so no draft with a blocker, should-fix,
/// question or unrated comment can ever be approved.
fn check_approvable(content: &Value, comments: &[ReviewComment], reply: Option<&super::brief::Brief>) -> Result<(), SendError> {
    if content["coverage"].as_str() != Some("complete") {
        return Err(SendError::Invalid("cannot approve without complete review coverage; send feedback as a comment or run a complete review".into()));
    }
    let mut sent = content.clone();
    sent["comments"] = serde_json::to_value(comments).unwrap_or_default();
    if let Some(reply) = reply {
        sent["reply"] = serde_json::to_value(reply).unwrap_or_default();
    }
    let (brief, severities) = super::brief::of_draft(&sent);
    let only_suggestions = comments.iter().all(|c| c.severity == Some(Severity::Suggestion))
        && severities.iter().all(|s| *s == Severity::Suggestion);
    if !only_suggestions || brief.verdict != super::brief::Verdict::LooksGood {
        return Err(SendError::Invalid(
            "only a review whose findings are all suggestions can approve: remove or downgrade the others, or send it as a comment".into(),
        ));
    }
    Ok(())
}

/// Request changes only for what must change: a blocker or should-fix among the comments as sent,
/// the findings moved off the diff, or an earlier finding still open.
fn check_must_fix(content: &Value, comments: &[ReviewComment]) -> Result<(), SendError> {
    let mut sent = content.clone();
    sent["comments"] = serde_json::to_value(comments).unwrap_or_default();
    let (_, severities) = super::brief::of_draft(&sent);
    if !severities.iter().any(|s| matches!(s, Severity::Blocker | Severity::ShouldFix)) {
        return Err(SendError::Invalid("Request changes needs a blocker or should-fix that is still open".into()));
    }
    Ok(())
}

fn validate(summary: &str, comments: &[ReviewComment]) -> Result<(), SendError> {
    if summary.chars().count() > MAX_REVIEW_BODY_CHARS {
        return Err(SendError::Invalid(format!("the summary is longer than {MAX_REVIEW_BODY_CHARS} characters")));
    }
    if comments.len() > MAX_COMMENTS {
        return Err(SendError::Invalid(format!("more than {MAX_COMMENTS} comments")));
    }
    for c in comments {
        if c.body.trim().is_empty() {
            return Err(SendError::Invalid(format!("the comment on {}:{} is empty", c.path, c.line)));
        }
        if c.body.chars().count() > MAX_COMMENT_CHARS || c.path.trim().is_empty() || c.line == 0 {
            return Err(SendError::Invalid(format!("the comment on {}:{} is not valid", c.path, c.line)));
        }
    }
    Ok(())
}
