//! The emoji a review adds to its Slack request message when it is sent, by the verdict sent.

mod common;

use std::sync::Mutex;

use common::*;
use lotus_automation::pr_review::brief::Verdict;
use lotus_automation::pr_review::{self, slack_reply, PrRef, SendRequest};
use lotus_automation::slack::{ReactionSettings, SentReactions, SlackApi, SlackMessage, StatusReactions};
use lotus_automation::{BoxFuture, Draft, Submitted};
use serde_json::json;

/// Records each reaction added; refuses the names in `refuse` the way Slack does.
#[derive(Default)]
struct Reactions {
    added: Mutex<Vec<(String, String, String)>>,
    refuse: Vec<String>,
}

impl SlackApi for Reactions {
    fn history(&self, _: &str, _: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn replies(&self, _: &str, _: &str, _: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn message(&self, _: &str, _: &str) -> BoxFuture<Result<Option<SlackMessage>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn add_reaction(&self, channel: &str, ts: &str, name: &str) -> BoxFuture<Result<(), String>> {
        if self.refuse.iter().any(|r| r == name) {
            return Box::pin(async { Err("invalid_name".to_string()) });
        }
        self.added.lock().unwrap().push((channel.into(), ts.into(), name.into()));
        Box::pin(async { Ok(()) })
    }
    fn remove_reaction(&self, _: &str, _: &str, _: &str) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn post_reply(&self, _: &str, _: &str, _: &str) -> BoxFuture<Result<String, String>> {
        Box::pin(async { Ok("1.0".to_string()) })
    }
    fn post_message(&self, _: &str, _: &str) -> BoxFuture<Result<String, String>> {
        Box::pin(async { Ok("1.0".to_string()) })
    }
}

const THREAD: &str = "1790000000.000100";
const MESSAGE: &str = "1790000000.000200";

fn settings() -> ReactionSettings {
    let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect();
    ReactionSettings::new(StatusReactions {
        sent: SentReactions { looks_good: v(&["terima-kasih"]), questions: v(&["thinking_face"]), changes_needed: v(&["eyes", "man-bowing"]) },
        ..Default::default()
    })
}

async fn drafted(w: &World) -> Draft {
    let context = json!({ "channel": "C1", "thread_ts": THREAD, "message_ts": MESSAGE, "requester": "U0ENG" });
    let pr = PrRef { repo: REPO.into(), number: 42 };
    let Submitted::Started { run_id } = pr_review::submit_pr(&w.engine, w.github.as_ref(), &w.automation, &pr, Some(context)).await.unwrap() else {
        panic!("expected a run")
    };
    w.engine.drain().await;
    w.store.draft_for_run(&run_id).unwrap().expect("a draft")
}

async fn send(w: &World, draft: &Draft) {
    let req = SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    pr_review::send_draft(&w.store, w.github.as_ref(), req, 2).await.unwrap();
}

#[tokio::test]
async fn a_sent_review_adds_its_verdicts_emoji_to_the_request_message() {
    let w = world(open_pr());
    let slack = Reactions::default();
    let settings = settings();
    let draft = drafted(&w).await;
    send(&w, &draft).await;

    let added = slack_reply::react_after_send(&w.store, Some(&slack), &settings, &draft.id).await;
    let sent = w.store.get_draft(&draft.id).unwrap().unwrap();
    let expected = settings.get().for_sent(slack_reply::sent_verdict(&sent.content));
    assert!(!expected.is_empty());
    assert_eq!(added, expected.len());
    let got = slack.added.lock().unwrap().clone();
    assert_eq!(got, expected.iter().map(|n| ("C1".to_string(), MESSAGE.to_string(), n.clone())).collect::<Vec<_>>(), "on the request message, not the thread root");
    assert!(got.iter().all(|(_, _, n)| n != "eyes"), "the taken emoji is never added again");
}

#[tokio::test]
async fn a_pending_or_discarded_draft_adds_nothing() {
    let w = world(open_pr());
    let slack = Reactions::default();
    let draft = drafted(&w).await;
    assert_eq!(slack_reply::react_after_send(&w.store, Some(&slack), &settings(), &draft.id).await, 0);
    w.store.discard_draft_because(&draft.id, None, 3).unwrap().unwrap();
    assert_eq!(slack_reply::react_after_send(&w.store, Some(&slack), &settings(), &draft.id).await, 0);
    assert!(slack.added.lock().unwrap().is_empty());
}

#[tokio::test]
async fn no_slack_or_no_emoji_chosen_adds_nothing() {
    let w = world(open_pr());
    let slack = Reactions::default();
    let draft = drafted(&w).await;
    send(&w, &draft).await;
    assert_eq!(slack_reply::react_after_send(&w.store, None, &settings(), &draft.id).await, 0);
    assert_eq!(slack_reply::react_after_send(&w.store, Some(&slack), &ReactionSettings::default(), &draft.id).await, 0);
    assert!(slack.added.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_name_slack_refuses_is_kept_for_the_settings_screen_and_the_rest_still_go_on() {
    let w = world(open_pr());
    let draft = drafted(&w).await;
    send(&w, &draft).await;
    let sent = w.store.get_draft(&draft.id).unwrap().unwrap();
    let verdict = slack_reply::sent_verdict(&sent.content);
    let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect::<Vec<String>>();
    let both = v(&["no_such_emoji", "white_check_mark"]);
    let sent_reactions = match verdict {
        Verdict::LooksGood => SentReactions { looks_good: both, ..Default::default() },
        Verdict::Questions => SentReactions { questions: both, ..Default::default() },
        Verdict::ChangesNeeded => SentReactions { changes_needed: both, ..Default::default() },
    };
    let settings = ReactionSettings::new(StatusReactions { sent: sent_reactions, ..Default::default() });
    let slack = Reactions { refuse: vec!["no_such_emoji".into()], ..Default::default() };
    assert_eq!(slack_reply::react_after_send(&w.store, Some(&slack), &settings, &draft.id).await, 1);
    assert!(settings.last_error().unwrap().contains(":no_such_emoji:"));
}

#[test]
fn the_sent_verdict_follows_approve_and_request_changes_over_the_brief() {
    let blocker = json!({ "comments": [{ "path": "a.rs", "line": 1, "body": "x", "severity": "blocker" }] });
    assert_eq!(slack_reply::sent_verdict(&blocker), Verdict::ChangesNeeded, "no kinder than the findings");
    assert_eq!(slack_reply::sent_verdict(&json!({ "approved": true })), Verdict::LooksGood);
    assert_eq!(slack_reply::sent_verdict(&json!({ "changes_requested": true })), Verdict::ChangesNeeded);
    assert_eq!(slack_reply::sent_verdict(&json!({ "reply": { "verdict": "questions", "points": [] } })), Verdict::Questions);
}
