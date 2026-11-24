//! Auto mode (ADR-0042, amended 2026-10-14): a finished review is posted without Send. What it
//! posts is Lotus's call from the review's findings, never the agent's: the agent reads text the
//! PR's author wrote, so a review it was talked into must not be able to approve on its own.
//!
//! - a blocker or should-fix of its own (new, or an earlier one still open) → Request changes;
//! - a looks-good verdict whose findings are all suggestions, with complete coverage → Approve;
//! - anything else (questions) → Comment;
//! - coverage not complete, or nothing to say → held: the draft waits for Send as before.
//!
//! A "Request changes" from this account stays on the PR until this account approves or it is
//! dismissed, so once nothing must change any more and the review only comments, the standing one
//! is dismissed: a fixed PR is never left blocked on us.

use serde_json::Value;

use super::brief::{self, Verdict};
use super::send::{send_draft, SendError, SendRequest};
use super::PrRef;
use crate::github::{GitHub, Severity};
use crate::store::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    Approve,
    RequestChanges,
    Comment,
}

impl Event {
    pub fn as_str(self) -> &'static str {
        match self {
            Event::Approve => "approve",
            Event::RequestChanges => "request-changes",
            Event::Comment => "comment",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Post(Event),
    /// Left for the reviewer, and why.
    Hold(String),
}

/// What auto mode does with a review draft's `content`.
pub fn decide(content: &Value) -> Decision {
    match content["coverage"].as_str() {
        Some("complete") => {}
        Some(other) => return Decision::Hold(format!("coverage is {other}")),
        None => return Decision::Hold("coverage is unknown".into()),
    }
    if content["summary"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Decision::Hold("the review has no summary".into());
    }
    let (brief, severities) = brief::of_draft(content);
    if severities.iter().any(|s| matches!(s, Severity::Blocker | Severity::ShouldFix)) {
        return Decision::Post(Event::RequestChanges);
    }
    if brief.verdict == Verdict::LooksGood && severities.iter().all(|s| *s == Severity::Suggestion) {
        return Decision::Post(Event::Approve);
    }
    Decision::Post(Event::Comment)
}

/// What one auto send came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Sent { url: String, event: Event, note: Option<String> },
    Held(String),
}

/// Decides and posts draft `draft_id` as `account`. A held draft, a PR that moved, or a send
/// refused stays pending for the reviewer; the reason comes back as `Held`.
pub async fn send(store: &Store, github: &dyn GitHub, account: &str, draft_id: &str, now_ms: i64) -> Result<Outcome, String> {
    let draft = store.get_draft(draft_id).map_err(|e| e.to_string())?.ok_or("no such draft")?;
    let event = match decide(&draft.content) {
        Decision::Post(event) => event,
        Decision::Hold(reason) => return Ok(Outcome::Held(reason)),
    };
    let request = SendRequest {
        draft_id: draft_id.to_string(),
        edited: None,
        send_even_if_stale: false,
        approve: event == Event::Approve,
        request_changes: event == Event::RequestChanges,
        close_threads: true,
        post_github: true,
    };
    let url = match send_draft(store, github, request, now_ms).await {
        Ok(url) => url,
        Err(SendError::Stale { current, .. }) => {
            return Ok(Outcome::Held(format!("the PR moved to {} during the review", &current[..current.len().min(7)])));
        }
        Err(e) => return Ok(Outcome::Held(e.to_string())),
    };
    let _ = store.note_on_sent_draft(draft_id, "auto", Value::String(event.as_str().into()));
    let note = match event {
        Event::Comment => clear_request_changes(github, account, &pr_of(&draft.content)).await,
        _ => None,
    };
    Ok(Outcome::Sent { url, event, note })
}

/// Dismisses this account's standing "Request changes" on `pr`, after a review that found nothing
/// that must change. Returns what happened, for the run's detail; `None` when there was none.
pub async fn clear_request_changes(github: &dyn GitHub, account: &str, pr: &PrRef) -> Option<String> {
    let discussion = match github.discussion(account, pr).await {
        Ok(d) => d,
        Err(e) => return Some(format!("could not check for an old Request changes: {e}")),
    };
    let id = super::others::standing_request_changes(&discussion, account)?;
    let message = "Everything that had to change is fixed; what is left is questions only.";
    Some(match github.dismiss_review(account, pr, id, message).await {
        Ok(()) => "dismissed the earlier Request changes".into(),
        Err(e) => format!("the earlier Request changes still stands (dismiss failed: {e})"),
    })
}

fn pr_of(content: &Value) -> PrRef {
    PrRef { repo: content["repo"].as_str().unwrap_or_default().to_string(), number: content["number"].as_u64().unwrap_or_default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn content(coverage: &str, verdict: &str, severities: &[&str]) -> Value {
        let comments: Vec<Value> =
            severities.iter().map(|s| json!({ "path": "a.rs", "line": 1, "severity": s, "body": "x" })).collect();
        json!({ "coverage": coverage, "summary": "s", "comments": comments, "reply": { "verdict": verdict, "points": [] } })
    }

    #[test]
    fn must_fix_requests_changes_whatever_the_agent_says() {
        assert_eq!(decide(&content("complete", "looks-good", &["should-fix"])), Decision::Post(Event::RequestChanges));
        assert_eq!(decide(&content("complete", "questions", &["blocker", "question"])), Decision::Post(Event::RequestChanges));
    }

    #[test]
    fn only_a_clean_complete_review_approves() {
        assert_eq!(decide(&content("complete", "looks-good", &[])), Decision::Post(Event::Approve));
        assert_eq!(decide(&content("complete", "looks-good", &["suggestion"])), Decision::Post(Event::Approve));
        assert_eq!(decide(&content("complete", "questions", &[])), Decision::Post(Event::Comment), "the agent can hold back an approval");
        assert_eq!(decide(&content("complete", "looks-good", &["question"])), Decision::Post(Event::Comment));
    }

    #[test]
    fn incomplete_coverage_is_held() {
        assert!(matches!(decide(&content("partial", "looks-good", &[])), Decision::Hold(_)));
        let mut c = content("complete", "looks-good", &[]);
        c.as_object_mut().unwrap().remove("coverage");
        assert!(matches!(decide(&c), Decision::Hold(_)));
    }

    #[test]
    fn an_earlier_finding_still_open_counts() {
        let mut c = content("complete", "looks-good", &[]);
        c["previous"] = json!([{ "path": "a.rs", "line": 1, "severity": "should-fix", "body": "x", "status": "not-fixed" }]);
        assert_eq!(decide(&c), Decision::Post(Event::RequestChanges));
    }
}
