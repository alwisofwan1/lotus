mod common;

use common::*;
use lotus_automation::github::{ReviewComment, Severity};
use lotus_automation::pr_review::{send_draft, EditedReview, SendError, SendRequest};
use lotus_automation::{Draft, DraftStatus};
use serde_json::json;

/// A world with one pending draft for PR #42 reviewed at `sha1`.
async fn with_draft() -> (World, Draft) {
    let w = world(open_pr());
    let run = review(&w).await;
    let draft = w.store.draft_for_run(&run.id).unwrap().expect("draft");
    (w, draft)
}

fn request(draft: &Draft) -> SendRequest {
    SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true }
}

#[tokio::test]
async fn sending_posts_the_edited_review_as_a_comment_at_the_reviewed_commit() {
    let (w, draft) = with_draft().await;
    let edited = EditedReview {
        summary: "Edited summary.".into(),
        comments: vec![ReviewComment { path: "src/app.ts".into(), line: 11, severity: None, body: "Edited: please avoid eval.".into() }],
        reply: None,
    };

    let url = send_draft(&w.store, w.github.as_ref(), SendRequest { edited: Some(edited), ..request(&draft) }, 50)
        .await
        .unwrap();

    let posted = w.github.posted.lock().unwrap();
    assert_eq!(posted.len(), 1);
    let (pr, body) = &posted[0];
    assert_eq!((pr.repo.as_str(), pr.number), (REPO, 42));
    assert_eq!(body["event"], "COMMENT");
    assert_eq!(body["commit_id"], "sha1");
    assert_eq!(body["body"], "Edited summary.");
    assert_eq!(body["comments"][0]["body"], "Edited: please avoid eval.");

    let sent = w.store.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(sent.status, DraftStatus::Sent);
    assert_eq!(sent.sent_url.as_deref(), Some(url.as_str()));
    assert_eq!(sent.content["summary"], "Edited summary.", "what was sent is what is kept");
}

#[tokio::test]
async fn a_draft_whose_pull_request_moved_on_is_held_back_until_the_reviewer_insists() {
    let (w, draft) = with_draft().await;
    w.github.pr.lock().unwrap().head_sha = "sha2".into();

    let err = send_draft(&w.store, w.github.as_ref(), request(&draft), 50).await.unwrap_err();
    assert!(matches!(&err, SendError::Stale { reviewed, current } if reviewed == "sha1" && current == "sha2"), "{err}");
    assert!(w.github.posted.lock().unwrap().is_empty());
    assert_eq!(w.store.get_draft(&draft.id).unwrap().unwrap().status, DraftStatus::Pending);

    send_draft(&w.store, w.github.as_ref(), SendRequest { send_even_if_stale: true, ..request(&draft) }, 60)
        .await
        .unwrap();
    let posted = w.github.posted.lock().unwrap();
    assert_eq!(posted[0].1["commit_id"], "sha1", "comments stay anchored to the commit that was reviewed");
}

#[tokio::test]
async fn a_draft_is_never_sent_twice() {
    let (w, draft) = with_draft().await;
    send_draft(&w.store, w.github.as_ref(), request(&draft), 50).await.unwrap();

    let err = send_draft(&w.store, w.github.as_ref(), request(&draft), 60).await.unwrap_err();

    assert!(matches!(err, SendError::NotPending(DraftStatus::Sent)), "{err}");
    assert_eq!(w.github.posted.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn when_github_refuses_the_draft_stays_pending_so_it_can_be_sent_again() {
    let (w, draft) = with_draft().await;
    *w.github.fail_post.lock().unwrap() = Some("HTTP 422: line must be part of the diff".into());

    let err = send_draft(&w.store, w.github.as_ref(), request(&draft), 50).await.unwrap_err();
    assert!(matches!(&err, SendError::GitHub(msg) if msg.contains("422")), "{err}");
    assert_eq!(w.store.get_draft(&draft.id).unwrap().unwrap().status, DraftStatus::Pending);

    *w.github.fail_post.lock().unwrap() = None;
    send_draft(&w.store, w.github.as_ref(), request(&draft), 60).await.unwrap();
    assert_eq!(w.store.get_draft(&draft.id).unwrap().unwrap().status, DraftStatus::Sent);
}

#[tokio::test]
async fn an_edit_that_breaks_the_review_limits_is_refused_before_anything_is_posted() {
    let (w, draft) = with_draft().await;
    for edited in [
        EditedReview { summary: "x".repeat(60_001), comments: vec![], reply: None },
        EditedReview {
            summary: "ok".into(),
            comments: vec![ReviewComment { path: "src/app.ts".into(), line: 11, severity: None, body: "   ".into() }],
            reply: None,
        },
    ] {
        let err = send_draft(&w.store, w.github.as_ref(), SendRequest { edited: Some(edited), ..request(&draft) }, 50)
            .await
            .unwrap_err();
        assert!(matches!(err, SendError::Invalid(_)), "{err}");
    }
    assert!(w.github.posted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_severity_is_written_at_the_start_of_the_comment_when_sent() {
    let (w, draft) = with_draft().await;
    let comment = |severity| ReviewComment { path: "src/app.ts".into(), line: 11, severity, body: "Avoid eval.".into() };
    let edited = EditedReview {
        // Longer than an agent's summary may be: findings off the diff were folded into it.
        summary: "x".repeat(5_000),
        comments: vec![
            comment(Some(Severity::Blocker)),
            comment(Some(Severity::ShouldFix)),
            comment(None),
            // Already tagged by hand: not tagged twice.
            ReviewComment { body: "**[blocker]** Avoid eval.".into(), ..comment(Some(Severity::Blocker)) },
        ],
        reply: None,
    };

    send_draft(&w.store, w.github.as_ref(), SendRequest { edited: Some(edited), ..request(&draft) }, 50).await.unwrap();

    let posted = w.github.posted.lock().unwrap();
    let bodies: Vec<&str> = posted[0].1["comments"].as_array().unwrap().iter().map(|c| c["body"].as_str().unwrap()).collect();
    assert_eq!(bodies, ["**[blocker]** Avoid eval.", "**[should-fix]** Avoid eval.", "Avoid eval.", "**[blocker]** Avoid eval."]);
    let kept = w.store.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(kept.content["comments"][0]["body"], "Avoid eval.", "the draft keeps the severity as a field, not in the text");
    assert_eq!(kept.content["comments"][0]["severity"], "blocker");
}

#[tokio::test]
async fn a_discarded_draft_cannot_be_sent() {
    let (w, draft) = with_draft().await;
    w.store.discard_draft(&draft.id, 50).unwrap().unwrap();

    let err = send_draft(&w.store, w.github.as_ref(), request(&draft), 60).await.unwrap_err();

    assert!(matches!(err, SendError::NotPending(DraftStatus::Discarded)), "{err}");
    assert!(w.github.posted.lock().unwrap().is_empty());
    let _ = json!({});
}

#[tokio::test]
async fn a_send_cut_off_by_a_restart_leaves_the_draft_sendable_again() {
    let (w, draft) = with_draft().await;
    w.store.claim_draft_for_sending(&draft.id).unwrap().unwrap(); // the process "dies" here

    w.store.reconcile_interrupted(99).unwrap();

    assert_eq!(w.store.get_draft(&draft.id).unwrap().unwrap().status, DraftStatus::Pending);
}

#[tokio::test]
async fn two_sends_racing_for_the_same_draft_post_it_once() {
    let (w, draft) = with_draft().await;

    let (a, b) = tokio::join!(
        send_draft(&w.store, w.github.as_ref(), request(&draft), 50),
        send_draft(&w.store, w.github.as_ref(), request(&draft), 50),
    );

    assert_eq!(w.github.posted.lock().unwrap().len(), 1, "a double click must not post two reviews");
    assert!(a.is_ok() != b.is_ok(), "exactly one send wins: {a:?} / {b:?}");
}

#[tokio::test]
async fn the_reviewers_slack_points_are_sent_as_edited_and_never_reach_github() {
    use lotus_automation::pr_review::brief::{Brief, Verdict};
    let (w, draft) = with_draft().await;
    let brief = Brief { verdict: Verdict::ChangesNeeded, points: vec!["Avoid eval on user input (L11)".into()], lead: None };
    let edited = EditedReview { summary: "Edited summary.".into(), comments: vec![], reply: Some(brief.clone()) };

    send_draft(&w.store, w.github.as_ref(), SendRequest { edited: Some(edited), ..request(&draft) }, 50).await.unwrap();

    let kept = w.store.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(kept.content["reply"], serde_json::to_value(&brief).unwrap());
    let posted = w.github.posted.lock().unwrap()[0].1.to_string();
    assert!(!posted.contains("Avoid eval on user input"), "{posted}");

    // Too many points are refused like any other broken edit.
    let (w, draft) = with_draft().await;
    let three = Brief { verdict: Verdict::ChangesNeeded, points: vec!["a".into(), "b".into(), "c".into()], lead: None };
    let edited = EditedReview { summary: "ok".into(), comments: vec![], reply: Some(three) };
    let err = send_draft(&w.store, w.github.as_ref(), SendRequest { edited: Some(edited), ..request(&draft) }, 50).await.unwrap_err();
    assert!(matches!(err, SendError::Invalid(_)), "{err}");
    assert!(w.github.posted.lock().unwrap().is_empty());
}

// ---------- approve (ADR-0042): only the reviewer's own press, only a clean review ----------

fn clean() -> EditedReview {
    use lotus_automation::pr_review::brief::{Brief, Verdict};
    EditedReview { summary: "LGTM.".into(), comments: vec![], reply: Some(Brief { verdict: Verdict::LooksGood, points: vec![], lead: None }) }
}

/// A draft whose review found nothing, moved off the diff included.
async fn clean_draft() -> (World, Draft) {
    let (w, draft) = with_draft().await;
    let mut content = draft.content.clone();
    content["off_diff_severities"] = json!([]);
    content["coverage"] = json!("complete");
    w.store.update_draft_content(&draft.id, &content).unwrap();
    let draft = w.store.get_draft(&draft.id).unwrap().unwrap();
    (w, draft)
}

#[tokio::test]
async fn a_clean_review_the_reviewer_approves_is_posted_as_an_approval() {
    let (w, draft) = clean_draft().await;
    let req = SendRequest { edited: Some(clean()), approve: true, request_changes: false, ..request(&draft) };

    send_draft(&w.store, w.github.as_ref(), req, 50).await.unwrap();

    let posted = w.github.posted.lock().unwrap()[0].1.clone();
    assert_eq!(posted, json!({ "commit_id": "sha1", "body": "LGTM.", "event": "APPROVE", "comments": [] }));
    let kept = w.store.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(kept.content["approved"], true, "the Slack reply says LGTM from this");
}

#[tokio::test]
async fn approval_requires_known_complete_coverage_even_when_no_finding_remains() {
    for coverage in [json!(null), json!("partial"), json!("blocked")] {
        let (w, draft) = clean_draft().await;
        let mut content = draft.content.clone();
        content["coverage"] = coverage;
        w.store.update_draft_content(&draft.id, &content).unwrap();
        let err = send_draft(&w.store, w.github.as_ref(), SendRequest { edited: Some(clean()), approve: true, request_changes: false, ..request(&draft) }, 50).await.unwrap_err();
        assert!(matches!(err, SendError::Invalid(ref m) if m.contains("coverage")));
        assert!(w.github.posted.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn stale_override_can_never_approve_a_newer_head() {
    let (w, draft) = clean_draft().await;
    w.github.pr.lock().unwrap().head_sha = "sha2".into();
    let err = send_draft(&w.store, w.github.as_ref(), SendRequest {
        edited: Some(clean()), approve: true, request_changes: false, send_even_if_stale: true, ..request(&draft)
    }, 50).await.unwrap_err();
    assert!(matches!(err, SendError::Stale { .. }));
    assert!(w.github.posted.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_approval_is_refused_while_anything_was_found_and_nothing_is_posted() {
    use lotus_automation::pr_review::brief::{Brief, Verdict};
    let finding = ReviewComment { path: "src/app.ts".into(), line: 11, severity: Some(Severity::Question), body: "Why?".into() };
    let no_severity = ReviewComment { severity: None, ..finding.clone() };
    let cases = [
        EditedReview { comments: vec![finding], ..clean() },
        EditedReview { comments: vec![no_severity], ..clean() },
        EditedReview { reply: Some(Brief { verdict: Verdict::ChangesNeeded, points: vec![], lead: None }), ..clean() },
    ];
    for edited in cases {
        let (w, draft) = clean_draft().await;
        let req = SendRequest { edited: Some(edited.clone()), approve: true, request_changes: false, ..request(&draft) };
        let err = send_draft(&w.store, w.github.as_ref(), req, 50).await.unwrap_err();
        assert!(matches!(err, SendError::Invalid(ref m) if m.contains("approve")), "{edited:?}: {err}");
        assert!(w.github.posted.lock().unwrap().is_empty());
        assert_eq!(w.store.get_draft(&draft.id).unwrap().unwrap().status, DraftStatus::Pending);
    }

    // A finding the agent put off the diff still counts, though no comment is left.
    let (w, draft) = with_draft().await; // the world's review moved a should-fix and a question off the diff
    let req = SendRequest { edited: Some(clean()), approve: true, request_changes: false, ..request(&draft) };
    assert!(send_draft(&w.store, w.github.as_ref(), req, 50).await.is_err());
}

#[tokio::test]
async fn approving_with_only_suggestions_posts_them_on_the_approval() {
    let (w, draft) = clean_draft().await;
    let idea = ReviewComment { path: "src/app.ts".into(), line: 11, severity: Some(Severity::Suggestion), body: "Could be a const.".into() };
    let req = SendRequest { edited: Some(EditedReview { comments: vec![idea], ..clean() }), approve: true, ..request(&draft) };

    send_draft(&w.store, w.github.as_ref(), req, 50).await.unwrap();

    let posted = w.github.posted.lock().unwrap()[0].1.clone();
    assert_eq!(posted["event"], "APPROVE");
    assert_eq!(
        posted["comments"],
        json!([{ "path": "src/app.ts", "line": 11, "side": "RIGHT", "body": "**[suggestion]** Could be a const." }])
    );
}

#[tokio::test]
async fn a_suggestion_moved_off_the_diff_does_not_stop_an_approval_but_a_should_fix_does() {
    for (off_diff, approves) in [(json!(["suggestion"]), true), (json!(["suggestion", "should-fix"]), false)] {
        let (w, draft) = clean_draft().await;
        let mut content = draft.content.clone();
        content["off_diff_severities"] = off_diff.clone();
        w.store.update_draft_content(&draft.id, &content).unwrap();
        let req = SendRequest { edited: Some(clean()), approve: true, request_changes: false, ..request(&draft) };
        assert_eq!(send_draft(&w.store, w.github.as_ref(), req, 50).await.is_ok(), approves, "{off_diff}");
    }
}

// ---------- Slack only: GitHub switched off ----------

#[tokio::test]
async fn with_github_off_nothing_is_posted_and_the_draft_is_sent_with_the_pr_as_its_link() {
    let (w, draft) = with_draft().await;
    let pr_url = draft.content["url"].as_str().expect("draft has the PR url").to_string();

    let url = send_draft(&w.store, w.github.as_ref(), SendRequest { post_github: false, ..request(&draft) }, 50).await.unwrap();

    assert_eq!(url, pr_url);
    assert!(w.github.posted.lock().unwrap().is_empty());
    let kept = w.store.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(kept.status, DraftStatus::Sent);
    assert_eq!(kept.content["github"], "skipped");
}

#[tokio::test]
async fn with_github_off_approve_is_refused() {
    let (w, draft) = clean_draft().await;
    let req = SendRequest { edited: Some(clean()), approve: true, request_changes: false, post_github: false, ..request(&draft) };
    let err = send_draft(&w.store, w.github.as_ref(), req, 50).await.unwrap_err();
    assert!(matches!(err, SendError::Invalid(ref m) if m.contains("GitHub")), "{err}");
    assert_eq!(w.store.get_draft(&draft.id).unwrap().unwrap().status, DraftStatus::Pending);
}

#[tokio::test]
async fn with_github_off_a_moved_pr_is_still_held_back() {
    let (w, draft) = with_draft().await;
    w.github.pr.lock().unwrap().head_sha = "sha2".into();
    let err = send_draft(&w.store, w.github.as_ref(), SendRequest { post_github: false, ..request(&draft) }, 50).await.unwrap_err();
    assert!(matches!(err, SendError::Stale { .. }));
}

#[tokio::test]
async fn a_discard_keeps_the_reviewers_reason_for_the_retro() {
    let (w, draft) = with_draft().await;
    w.store.discard_draft_because(&draft.id, Some("Too noisy"), 50).unwrap().unwrap();
    let kept = w.store.get_draft(&draft.id).unwrap().unwrap();
    assert_eq!(kept.status, DraftStatus::Discarded);
    assert_eq!(kept.content["discard_reason"], "Too noisy");
    assert_eq!(kept.content["head_sha"], draft.content["head_sha"], "the rest of the draft stays");

    // Without a reason nothing is added, and a second discard says what the draft is.
    let (w, draft) = with_draft().await;
    w.store.discard_draft_because(&draft.id, Some("  "), 50).unwrap().unwrap();
    assert!(w.store.get_draft(&draft.id).unwrap().unwrap().content.get("discard_reason").is_none());
    assert_eq!(w.store.discard_draft_because(&draft.id, Some("x"), 51).unwrap(), Err(DraftStatus::Discarded));
}
