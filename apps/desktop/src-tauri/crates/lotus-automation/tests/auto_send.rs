//! 2026-10-14: a review knows what other reviewers already said and does not repeat them, its Slack
//! reply opens with the agent's own line for the round, and auto mode posts it — Request changes,
//! Comment or Approve, picked by Lotus from the findings — clearing our own Request changes once
//! nothing must change.

mod common;

use common::*;
use lotus_automation::github::{Discussion, LineComment, OtherReview};
use lotus_automation::pr_review::auto::{self, Event, Outcome};
use lotus_automation::pr_review::reply_style::ReplyStyle;
use lotus_automation::pr_review::{send_draft, PrReviewLimits, SendRequest};
use lotus_automation::slack::thread_reply_text;
use lotus_automation::DraftStatus;
use serde_json::{json, Value};

fn ditdot_found_it() -> Discussion {
    Discussion {
        reviews: vec![OtherReview {
            id: 77,
            author: "ditdot".into(),
            state: "CHANGES_REQUESTED".into(),
            body: "Adversarial review pass".into(),
            submitted_at: "2026-10-14T07:52:12Z".into(),
            commit: "sha1".into(),
        }],
        comments: vec![LineComment {
            id: 9,
            review_id: Some(77),
            in_reply_to: None,
            author: "ditdot".into(),
            path: "src/app.ts".into(),
            line: Some(11),
            body: "issue (blocking): eval on user input".into(),
            created_at: "2026-10-14T07:52:12Z".into(),
        }],
        conversation: vec![],
    }
}

fn must_fix() -> Value {
    json!({
        "summary": "One risky line.",
        "coverage": "complete",
        "comments": [{ "path": "src/app.ts", "line": 11, "severity": "should-fix", "body": "Validate input first." }],
        "reply": { "verdict": "changes-needed", "points": ["Validate input before use (L11)"], "lead": "One thing before this ships:" },
    })
}

fn clean() -> Value {
    json!({ "summary": "Nothing to add.", "coverage": "complete", "comments": [], "reply": { "verdict": "looks-good", "points": [] } })
}

#[tokio::test]
async fn the_agent_sees_other_reviewers_and_is_told_not_to_repeat_them() {
    let w = world(open_pr());
    *w.github.discussion.lock().unwrap() = ditdot_found_it();
    review(&w).await;
    let prompt = &w.agent.seen.lock().unwrap()[0].prompt;
    assert!(prompt.contains("Never raise a finding another reviewer already raised"), "{prompt}");
    assert!(prompt.contains("ditdot requested changes: Adversarial review pass"), "{prompt}");
    assert!(prompt.contains("ditdot on src/app.ts:11: issue (blocking): eval on user input"), "{prompt}");
    let at = prompt.find("ditdot requested").unwrap();
    assert!(prompt[..at].rfind("<untrusted-data-").is_some(), "other reviewers' text is fenced as data");
    assert!(prompt.contains("Start with intake"), "{prompt}");
}

#[tokio::test]
async fn with_nobody_else_on_the_pr_the_rules_are_left_out() {
    let w = world(open_pr());
    review(&w).await;
    assert!(!w.agent.seen.lock().unwrap()[0].prompt.contains("Never raise a finding another reviewer"));
}

#[tokio::test]
async fn auto_mode_requests_changes_for_a_must_fix_and_the_slack_reply_opens_with_the_lead() {
    let w = world_configured_with(json!({}), None, Reply::Json(must_fix()), PrReviewLimits::default());
    let run = review(&w).await;
    let draft = w.store.draft_for_run(&run.id).unwrap().unwrap();

    let style = ReplyStyle::parse("x\n```slack-reply\n{mention}-san {lead}\n{points}\n```").unwrap().1;
    let text = thread_reply_text(&draft.subject, "https://gh/r", &draft.content, Some("U1"), &style);
    assert_eq!(text, "<@U1>-san One thing before this ships:\n• Validate input before use (L11)");

    let outcome = auto::send(&w.store, w.github.as_ref(), ME, &draft.id, 5).await.unwrap();
    assert!(matches!(outcome, Outcome::Sent { event: Event::RequestChanges, .. }), "{outcome:?}");
    assert_eq!(w.github.posted.lock().unwrap()[0].1["event"], "REQUEST_CHANGES");
    let sent = w.store.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(sent.status, DraftStatus::Sent);
    assert_eq!(sent.content["auto"], "request-changes");
}

#[tokio::test]
async fn auto_mode_holds_a_partial_review_for_the_reviewer() {
    let mut partial = clean();
    partial["coverage"] = json!("partial");
    let w = world_configured_with(json!({}), None, Reply::Json(partial), PrReviewLimits::default());
    let run = review(&w).await;
    let draft = w.store.draft_for_run(&run.id).unwrap().unwrap();
    let outcome = auto::send(&w.store, w.github.as_ref(), ME, &draft.id, 5).await.unwrap();
    assert_eq!(outcome, Outcome::Held("coverage is partial".into()));
    assert!(w.github.posted.lock().unwrap().is_empty());
    assert_eq!(w.store.get_draft(&draft.id).unwrap().unwrap().status, DraftStatus::Pending);
}

#[tokio::test]
async fn a_question_only_rereview_comments_and_dismisses_our_standing_request_changes() {
    let question = json!({
        "summary": "Fixed; one question left.",
        "coverage": "complete",
        "comments": [],
        "previous": [{ "finding": 1, "status": "fixed" }],
        "reply": { "verdict": "questions", "points": ["Is the retry bounded? (L21)"], "lead": "The input check covers it now." },
    });
    let w = world_configured_with(json!({}), None, Reply::Seq(vec![must_fix(), question]), PrReviewLimits::default());
    let first = review(&w).await;
    let draft = w.store.draft_for_run(&first.id).unwrap().unwrap();
    auto::send(&w.store, w.github.as_ref(), ME, &draft.id, 5).await.unwrap();
    // GitHub now shows our Request changes.
    w.github.discussion.lock().unwrap().reviews.push(OtherReview {
        id: 1,
        author: ME.into(),
        state: "CHANGES_REQUESTED".into(),
        body: "One risky line.".into(),
        submitted_at: "2026-10-14T08:00:00Z".into(),
        commit: "sha1".into(),
    });

    w.github.pr.lock().unwrap().head_sha = "sha2".into();
    let second = review(&w).await;
    let again = w.store.draft_for_run(&second.id).unwrap().unwrap_or_else(|| panic!("{:?}", second.detail));
    // The re-review's own words, when the owner wrote some.
    let style = ReplyStyle::parse("x\n```slack-reply\nfirst\n```\n```slack-reply-rereview\n{lead}\n{points}\n```").unwrap().1;
    let text = thread_reply_text(&again.subject, "https://gh/r", &again.content, None, &style);
    assert_eq!(text, "The input check covers it now.\n• Is the retry bounded? (L21)");

    let outcome = auto::send(&w.store, w.github.as_ref(), ME, &again.id, 6).await.unwrap();
    let Outcome::Sent { event, note, .. } = outcome else { panic!("{outcome:?}") };
    assert_eq!(event, Event::Comment);
    assert_eq!(note.as_deref(), Some("dismissed the earlier Request changes"));
    assert_eq!(*w.github.dismissed.lock().unwrap(), vec![1]);
    assert_eq!(w.github.posted.lock().unwrap()[1].1["event"], "COMMENT");
}

#[tokio::test]
async fn request_changes_is_refused_when_nothing_must_change() {
    let w = world_configured_with(json!({}), None, Reply::Json(clean()), PrReviewLimits::default());
    let run = review(&w).await;
    let draft = w.store.draft_for_run(&run.id).unwrap().unwrap();
    let request = SendRequest {
        draft_id: draft.id.clone(),
        edited: None,
        send_even_if_stale: false,
        approve: false,
        request_changes: true,
        close_threads: false,
        post_github: true,
    };
    let err = send_draft(&w.store, w.github.as_ref(), request, 5).await.unwrap_err();
    assert!(err.to_string().contains("needs a blocker or should-fix"), "{err}");
    assert!(w.github.posted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_clean_complete_review_is_approved_in_auto_mode() {
    let w = world_configured_with(json!({}), None, Reply::Json(clean()), PrReviewLimits::default());
    let run = review(&w).await;
    let draft = w.store.draft_for_run(&run.id).unwrap().unwrap();
    let outcome = auto::send(&w.store, w.github.as_ref(), ME, &draft.id, 5).await.unwrap();
    assert!(matches!(outcome, Outcome::Sent { event: Event::Approve, note: None, .. }), "{outcome:?}");
    assert_eq!(w.github.posted.lock().unwrap()[0].1["event"], "APPROVE");
}
