//! A re-review (2026-09-28): the same automation reviewing a PR it already sent a review of, at a
//! new head. It answers what the author asked — is each earlier finding fixed? — and raises new
//! findings only near what changed since, blockers excepted.

mod common;

use common::*;
use lotus_automation::github::{ReviewThread, ThreadReply};
use lotus_automation::pr_review::reply_style::ReplyStyle;
use lotus_automation::pr_review::{self, send_draft, PrReviewLimits, SendRequest};
use lotus_automation::slack::thread_reply_text;
use lotus_automation::{Draft, RunStatus};
use serde_json::{json, Value};

/// The whole PR at `sha2`: the first review's hunk, and a new one at lines 20–21.
const DIFF_AT_SHA2: &str = "\
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,2 +10,3 @@
   const a = 1;
+  const b = safe(input);
   return a;
@@ -20,1 +21,2 @@
   log(a);
+  retry(b);
";

/// What changed from `sha1` to `sha2`.
const SINCE: &str = "\
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -20,1 +21,2 @@
   log(a);
+  retry(b);
";

fn statuses(fixed: &[&str]) -> Value {
    Value::Array(fixed.iter().enumerate().map(|(i, s)| json!({ "finding": i + 1, "status": s })).collect())
}

/// Reviewed and sent at `sha1`, then the author pushed `sha2` and replied under the blocker.
async fn reviewed_then_pushed(second: Value) -> (World, Draft) {
    let w = world_with(open_pr(), Reply::Seq(vec![good_review(), second]), PrReviewLimits::default());
    let first = review(&w).await;
    let draft = w.store.draft_for_run(&first.id).unwrap().unwrap();
    let request = SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    send_draft(&w.store, w.github.as_ref(), request, 10).await.unwrap();

    w.github.pr.lock().unwrap().head_sha = "sha2".into();
    *w.github.diff.lock().unwrap() = DIFF_AT_SHA2.into();
    w.github.compares.lock().unwrap().insert(("sha1".into(), "sha2".into()), SINCE.into());
    w.github.threads.lock().unwrap().insert(
        1,
        vec![ReviewThread {
            comment_id: 500,
            path: "src/app.ts".into(),
            line: 11,
            replies: vec![ThreadReply { author: "doni255".into(), body: "Fixed in sha2, eval is gone.".into() }],
        }],
    );
    let second = review(&w).await;
    let draft = w.store.draft_for_run(&second.id).unwrap().unwrap_or_else(|| panic!("{:?}", second.detail));
    (w, draft)
}

fn clean_rereview() -> Value {
    json!({
        "summary": "All three are addressed.",
        "coverage": "complete",
        "comments": [],
        "previous": statuses(&["fixed", "fixed", "answered"]),
        "reply": { "verdict": "looks-good", "points": [] },
    })
}

#[tokio::test]
async fn manual_rereview_accepts_feedback_at_the_same_head_and_keeps_it_as_data() {
    let w = world_with(open_pr(), Reply::Seq(vec![good_review(), good_review()]), PrReviewLimits::default());
    review(&w).await;
    let result = pr_review::review_again(&w.engine, &w.store, w.github.as_ref(), &w.automation, URL, "Please recheck tenant isolation").await.unwrap();
    assert!(matches!(result, lotus_automation::Submitted::Started { .. }));
    w.engine.drain().await;
    let seen = w.agent.seen.lock().unwrap();
    let start = seen[1].prompt.find("Please recheck tenant isolation").unwrap();
    assert!(seen[1].prompt[..start].rfind("<untrusted-data-").is_some());
}

#[tokio::test]
async fn clarification_at_the_same_head_still_revisits_earlier_findings() {
    let (w, draft) = reviewed_then_pushed(clean_rereview()).await;
    let mut content = draft.content.clone();
    content["previous"][0]["status"] = json!("not-fixed");
    w.store.update_draft_content(&draft.id, &content).unwrap();
    send_draft(&w.store, w.github.as_ref(), SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true }, 20).await.unwrap();
    let pr = pr_review::parse_pr_url(URL).unwrap();
    let context = pr_review::rereview::context(&w.store, w.github.as_ref(), ME, &w.automation.id, &pr, "sha2", None).await.unwrap();
    let context = context.expect("same-head clarification must preserve open findings");
    assert_eq!(context.findings.len(), 1);
    assert_eq!(context.findings[0].body, "eval on user input is remote code execution.");
    let answered = context.answered(&[serde_json::from_value(json!({"finding":1,"status":"answered"})).unwrap()]).unwrap();
    assert_eq!(answered[0]["comment_id"], 500, "the original GitHub thread survives another round");
}

#[tokio::test]
async fn unresolved_findings_survive_a_third_round_without_new_comments() {
    let (w, draft) = reviewed_then_pushed(clean_rereview()).await;
    let mut content = draft.content.clone();
    content["previous"][0]["status"] = json!("not-fixed");
    w.store.update_draft_content(&draft.id, &content).unwrap();
    send_draft(&w.store, w.github.as_ref(), SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true }, 20).await.unwrap();
    let pr = pr_review::parse_pr_url(URL).unwrap();
    let context = pr_review::rereview::context(&w.store, w.github.as_ref(), ME, &w.automation.id, &pr, "sha3", None).await.unwrap().unwrap();
    assert_eq!(context.findings.len(), 1);
    assert_eq!(context.findings[0].comment_id, Some(500));
    assert!(context.prompt("nonce").contains("eval on user input"));
}

#[tokio::test]
async fn the_agent_is_told_what_it_found_last_time_what_the_author_said_and_what_changed_since() {
    let (w, _) = reviewed_then_pushed(clean_rereview()).await;
    let seen = w.agent.seen.lock().unwrap();
    assert!(!seen[0].prompt.contains("last review"), "a first review is not a re-review");
    let prompt = &seen[1].prompt;
    assert!(prompt.contains("You reviewed this pull request before, at sha1"), "{prompt}");
    assert!(prompt.contains("1. [blocker] src/app.ts:11 eval on user input is remote code execution."), "{prompt}");
    assert!(prompt.contains("3. [question] src/other.ts:1 Not in the diff either."), "every finding, off the diff too");
    assert!(prompt.contains("doni255: Fixed in sha2, eval is gone."), "{prompt}");
    assert!(prompt.contains("+  retry(b);"), "the changes since: {prompt}");
    // What the author wrote is data, fenced like the PR's own text.
    let fence = prompt.find("doni255:").unwrap();
    assert!(prompt[..fence].rfind("<untrusted-data-").is_some(), "{prompt}");
    // `previous` is enforced by Lotus, not the schema, so a re-review can still Ask instead.
    assert!(seen[1].schema["properties"]["previous"].is_object(), "{}", seen[1].schema);
    assert!(seen[0].schema["properties"].get("previous").is_none(), "a first review has none to give");
}

#[tokio::test]
async fn every_earlier_finding_gets_a_status_and_a_clean_rereview_can_be_approved() {
    let (w, draft) = reviewed_then_pushed(clean_rereview()).await;
    let previous = draft.content["previous"].as_array().unwrap();
    assert_eq!(previous.len(), 3);
    assert_eq!((previous[0]["status"].as_str(), previous[0]["comment_id"].as_u64()), (Some("fixed"), Some(500)));
    assert_eq!(previous[2]["comment_id"], Value::Null, "an off-diff finding has no thread");
    assert_eq!(draft.content["since_sha"], "sha1");
    let summary = draft.content["summary"].as_str().unwrap();
    assert!(summary.starts_with("## Since the last review (sha1)\n- ✅ Fixed: `src/app.ts:11`"), "{summary}");

    let text = thread_reply_text(&draft.subject, "https://gh/r", &draft.content, Some("U1"), &ReplyStyle::default());
    assert_eq!(text, "<@U1> LGTM ✅ <https://gh/r|orbit-app#42>", "looks good: the LGTM shape, approved or not");

    let request = SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: true, request_changes: false, close_threads: true, post_github: true };
    send_draft(&w.store, w.github.as_ref(), request, 20).await.unwrap();
    assert_eq!(w.github.posted.lock().unwrap()[1].1["event"], "APPROVE");
    assert_eq!(*w.github.thread_replies.lock().unwrap(), vec![(500, "Fixed ✅".to_string())], "only threads we can reach");
}

#[tokio::test]
async fn an_open_finding_keeps_the_review_open_and_is_never_approved() {
    let reply = json!({
        "summary": "One is left.",
        "comments": [],
        "previous": statuses(&["fixed", "not-fixed", "answered"]),
        "reply": { "verdict": "looks-good", "points": ["The L99 check is still missing"] },
    });
    let (w, draft) = reviewed_then_pushed(reply).await;
    let text = thread_reply_text(&draft.subject, "https://gh/r", &draft.content, None, &ReplyStyle::default());
    assert!(text.starts_with("🔧 Changes needed on <https://gh/r|orbit-app#42> · 2/3 resolved · 1 still open"), "{text}");

    let request = SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: true, request_changes: false, close_threads: true, post_github: true };
    assert!(send_draft(&w.store, w.github.as_ref(), request, 20).await.is_err(), "an open finding cannot be approved");
    let request = SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: true, post_github: true };
    send_draft(&w.store, w.github.as_ref(), request, 20).await.unwrap();
    assert_eq!(*w.github.thread_replies.lock().unwrap(), vec![(500, "Fixed ✅".to_string())]);
}

#[tokio::test]
async fn new_findings_stay_near_what_changed_unless_they_block() {
    let reply = json!({
        "summary": "One new thing.",
        "comments": [
            { "path": "src/app.ts", "line": 22, "severity": "should-fix", "body": "retry needs a limit." },
            { "path": "src/app.ts", "line": 12, "severity": "question", "body": "Why keep a?" },
            { "path": "src/app.ts", "line": 11, "severity": "blocker", "body": "safe() still runs input." },
        ],
        "previous": statuses(&["fixed", "fixed", "fixed"]),
        "reply": { "verdict": "changes-needed", "points": [] },
    });
    let (_w, draft) = reviewed_then_pushed(reply).await;
    let lines: Vec<u64> = draft.content["comments"].as_array().unwrap().iter().map(|c| c["line"].as_u64().unwrap()).collect();
    assert_eq!(lines, [22, 11], "near the new changes, or a blocker anywhere");
    let summary = draft.content["summary"].as_str().unwrap();
    assert!(summary.contains("## Outside the changes since the last review\n\n- `src/app.ts:12` **[question]** Why keep a?"), "{summary}");
    let text = thread_reply_text(&draft.subject, "https://gh/r", &draft.content, None, &ReplyStyle::default());
    assert!(text.contains("· 3/3 resolved · 1 new blocker, 1 new should-fix"), "the moved question does not count: {text}");
}

#[tokio::test]
async fn a_rereview_that_skips_an_earlier_finding_fails_the_run() {
    let reply = json!({ "summary": "x", "comments": [], "previous": statuses(&["fixed"]) });
    let w = world_with(open_pr(), Reply::Seq(vec![good_review(), reply]), PrReviewLimits::default());
    let first = review(&w).await;
    let draft = w.store.draft_for_run(&first.id).unwrap().unwrap();
    let request = SendRequest { draft_id: draft.id, edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    send_draft(&w.store, w.github.as_ref(), request, 10).await.unwrap();
    w.github.pr.lock().unwrap().head_sha = "sha2".into();

    let run = review(&w).await;
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.detail.unwrap().contains("every earlier finding"), "names what is missing");
}

#[tokio::test]
async fn after_a_force_push_the_whole_pr_is_in_scope_and_the_agent_is_told_why() {
    let w = world_with(open_pr(), Reply::Seq(vec![good_review(), clean_rereview()]), PrReviewLimits::default());
    let first = review(&w).await;
    let draft = w.store.draft_for_run(&first.id).unwrap().unwrap();
    let request = SendRequest { draft_id: draft.id, edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    send_draft(&w.store, w.github.as_ref(), request, 10).await.unwrap();
    w.github.pr.lock().unwrap().head_sha = "rewritten".into(); // no compare from sha1

    let run = review(&w).await;
    assert_eq!(run.status, RunStatus::Succeeded, "{:?}", run.detail);
    let prompt = w.agent.seen.lock().unwrap()[1].prompt.clone();
    assert!(prompt.contains("sha1 is no longer in the history"), "{prompt}");
}

#[tokio::test]
async fn reviewing_the_same_commit_again_is_a_first_review() {
    let w = world_with(open_pr(), Reply::Seq(vec![good_review(), good_review()]), PrReviewLimits::default());
    let first = review(&w).await;
    let draft = w.store.draft_for_run(&first.id).unwrap().unwrap();
    let request = SendRequest { draft_id: draft.id, edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    send_draft(&w.store, w.github.as_ref(), request, 10).await.unwrap();
    // Asked again at the same head (the Review button after a discard, say).
    let pr = pr_review::parse_pr_url(URL).unwrap();
    pr_review::submit_pr(&w.engine, w.github.as_ref(), &w.automation, &pr, None).await.unwrap();
    w.engine.drain().await;
    assert!(!w.agent.seen.lock().unwrap().last().unwrap().prompt.contains("You reviewed this pull request before"));
}
