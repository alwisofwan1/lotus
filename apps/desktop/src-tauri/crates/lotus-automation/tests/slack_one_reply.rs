//! One Slack reply per thread (ADR-0052 §8, slice 07): Send all, hold, Reply now, dismiss.

mod common;

use std::sync::Mutex;

use common::*;
use lotus_automation::pr_review::{self, slack_reply, PrRef, SendRequest};
use lotus_automation::slack::{SlackApi, SlackMessage};
use lotus_automation::{BoxFuture, Draft, Submitted};
use serde_json::json;

#[derive(Default)]
struct Posts(Mutex<Vec<(String, String, String)>>);

impl SlackApi for Posts {
    fn history(&self, _: &str, _: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn replies(&self, _: &str, _: &str, _: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn message(&self, _: &str, _: &str) -> BoxFuture<Result<Option<SlackMessage>, String>> {
        Box::pin(async { Ok(None) })
    }
    fn add_reaction(&self, _: &str, _: &str, _: &str) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn remove_reaction(&self, _: &str, _: &str, _: &str) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn post_reply(&self, channel: &str, thread_ts: &str, text: &str) -> BoxFuture<Result<String, String>> {
        self.0.lock().unwrap().push((channel.into(), thread_ts.into(), text.into()));
        Box::pin(async { Ok("1.0".to_string()) })
    }
    fn post_message(&self, _: &str, _: &str) -> BoxFuture<Result<String, String>> {
        Box::pin(async { Ok("1.0".to_string()) })
    }
}

impl Posts {
    fn texts(&self) -> Vec<String> {
        self.0.lock().unwrap().iter().map(|(_, _, t)| t.clone()).collect()
    }
}

const THREAD: &str = "1790000000.000100";

/// Two reviews asked for in one Slack thread (back and front), both drafted.
async fn two_drafts(w: &World) -> (Draft, Draft) {
    let context = json!({ "channel": "C1", "thread_ts": THREAD, "message_ts": THREAD, "requester": "U0ENG" });
    let mut drafts = Vec::new();
    for number in [42, 43] {
        let pr = PrRef { repo: REPO.into(), number };
        let Submitted::Started { run_id } =
            pr_review::submit_pr(&w.engine, w.github.as_ref(), &w.automation, &pr, Some(context.clone())).await.unwrap()
        else {
            panic!("expected a run")
        };
        w.engine.drain().await;
        drafts.push(w.store.draft_for_run(&run_id).unwrap().expect("a draft"));
    }
    let b = drafts.pop().unwrap();
    (drafts.pop().unwrap(), b)
}

async fn send(w: &World, slack: &Posts, draft: &Draft) -> String {
    let req = SendRequest { draft_id: draft.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    let url = pr_review::send_draft(&w.store, w.github.as_ref(), req, 2).await.unwrap();
    slack_reply::reply_after_send(&w.store, Some(slack), &draft.id, &url, None, 2).await
}

#[tokio::test]
async fn send_all_posts_two_github_reviews_and_one_slack_message() {
    let w = world(open_pr());
    let slack = Posts::default();
    let (a, b) = two_drafts(&w).await;

    let group = slack_reply::send_group(&w.store, &a);
    assert_eq!(group, vec![a.id.clone(), b.id.clone()]);
    let mut outcomes = Vec::new();
    for id in &group {
        let draft = w.store.get_draft(id).unwrap().unwrap();
        outcomes.push(send(&w, &slack, &draft).await);
    }
    assert_eq!(w.github.posted.lock().unwrap().len(), 2, "one GitHub review per PR");
    assert_eq!(outcomes, vec!["waiting: 1 of 2 sent", "replied"]);
    let texts = slack.texts();
    assert_eq!(texts.len(), 1, "one Slack message: {texts:?}");
    assert_eq!(texts[0].matches("<@U0ENG>").count(), 1, "one mention: {}", texts[0]);
    assert!(texts[0].starts_with("<@U0ENG> Review selesai untuk 2 PR:\n\n"), "the default group shape: {}", texts[0]);
    assert!(texts[0].contains("orbit-app#42") && texts[0].contains("orbit-app#43"), "{}", texts[0]);
    // The first draft's note no longer says it waits.
    assert_eq!(w.store.get_draft(&a.id).unwrap().unwrap().content["slack_reply"], "replied");
}

#[tokio::test]
async fn one_by_one_the_first_send_holds_and_the_second_posts_one_reply() {
    let w = world(open_pr());
    let slack = Posts::default();
    let (a, b) = two_drafts(&w).await;
    assert_eq!(send(&w, &slack, &a).await, "waiting: 1 of 2 sent");
    assert!(slack.texts().is_empty(), "nothing in Slack yet");
    assert_eq!(send(&w, &slack, &b).await, "replied");
    assert_eq!(slack.texts().len(), 1);
}

#[tokio::test]
async fn reply_now_posts_only_what_was_sent_and_a_later_send_posts_its_own() {
    let w = world(open_pr());
    let slack = Posts::default();
    let (a, b) = two_drafts(&w).await;
    send(&w, &slack, &a).await;
    assert_eq!(slack_reply::reply_now(&w.store, Some(&slack), &a.id, 3).await, "replied");
    let texts = slack.texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("#42") && !texts[0].contains("#43"), "{}", texts[0]);
    assert!(texts[0].starts_with("<@U0ENG>"), "a single review keeps its own reply shape: {}", texts[0]);

    assert_eq!(send(&w, &slack, &b).await, "replied");
    let texts = slack.texts();
    assert_eq!(texts.len(), 2);
    assert!(texts[1].contains("#43") && !texts[1].contains("#42"), "{}", texts[1]);
}

#[tokio::test]
async fn dismissing_the_other_draft_releases_the_held_reply() {
    let w = world(open_pr());
    let slack = Posts::default();
    let (a, b) = two_drafts(&w).await;
    send(&w, &slack, &a).await;
    w.store.discard_draft(&b.id, 3).unwrap().unwrap();
    let b = w.store.get_draft(&b.id).unwrap().unwrap();
    slack_reply::release(&w.store, Some(&slack), &b, 3).await;
    let texts = slack.texts();
    assert_eq!(texts.len(), 1);
    assert!(texts[0].contains("#42") && !texts[0].contains("#43"), "{}", texts[0]);
}

#[tokio::test]
async fn a_review_alone_in_its_thread_replies_at_once_and_slack_down_keeps_it_held() {
    let w = world(open_pr());
    let slack = Posts::default();
    let (a, b) = two_drafts(&w).await;
    w.store.discard_draft(&b.id, 3).unwrap().unwrap();
    let req = SendRequest { draft_id: a.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    let url = pr_review::send_draft(&w.store, w.github.as_ref(), req, 2).await.unwrap();
    assert_eq!(slack_reply::reply_after_send(&w.store, None, &a.id, &url, None, 2).await, "not replied: Slack is not connected");
    // Still held: Reply now posts it once Slack is back.
    assert_eq!(slack_reply::reply_now(&w.store, Some(&slack), &a.id, 3).await, "replied");
    assert_eq!(slack.texts().len(), 1);
}

#[tokio::test]
async fn send_all_leaves_out_a_review_already_being_sent() {
    let w = world(open_pr());
    let (a, b) = two_drafts(&w).await;

    w.store.claim_draft_for_sending(&b.id).unwrap().unwrap();

    assert_eq!(slack_reply::send_group(&w.store, &a), vec![a.id.clone()], "a draft mid-send is not sent twice");
}

#[tokio::test]
async fn the_preview_is_the_message_and_the_edited_text_is_what_gets_posted() {
    let w = world(open_pr());
    let slack = Posts::default();
    let (a, b) = two_drafts(&w).await;

    // Send alone: the other review still holds the message back.
    assert_eq!(slack_reply::preview(&w.store, &a, false).unwrap(), slack_reply::Preview { text: None, waiting: 1 });
    // Send all: the one message for both, PRs linked until they are reviewed.
    let all = slack_reply::preview(&w.store, &a, true).unwrap().text.expect("a message");
    assert!(all.contains("<https://github.com/initech/orbit-app/pull/42|orbit-app#42>"), "{all}");
    assert!(all.contains("orbit-app#43"), "{all}");

    send(&w, &slack, &a).await;
    let last = slack_reply::preview(&w.store, &b, false).unwrap().text.expect("b's send posts the message");
    assert_eq!(last.lines().count(), all.lines().count(), "the same message, whichever way it is sent");
    assert!(last.contains("/pull/42#pullrequestreview-1|orbit-app#42>"), "a sent review links its review: {last}");
    assert!(last.contains("/pull/43|orbit-app#43>"), "{last}");

    // The reviewer rewrites it; the PR link of each review becomes its review link.
    let edited = "<@U0ENG> dua PR selesai: <https://github.com/initech/orbit-app/pull/42|front> & <https://github.com/initech/orbit-app/pull/43|back>";
    let req = SendRequest { draft_id: b.id.clone(), edited: None, send_even_if_stale: false, approve: false, request_changes: false, close_threads: false, post_github: true };
    let url = pr_review::send_draft(&w.store, w.github.as_ref(), req, 3).await.unwrap();
    let edited = slack_reply::check_edited(edited).unwrap();
    assert_eq!(slack_reply::reply_after_send(&w.store, Some(&slack), &b.id, &url, Some(&edited), 3).await, "replied");
    let texts = slack.texts();
    assert_eq!(texts.len(), 1, "{texts:?}");
    assert!(texts[0].starts_with("<@U0ENG> dua PR selesai: <"), "the reviewer's text: {}", texts[0]);
    assert!(!texts[0].contains("/pull/42|") && !texts[0].contains("/pull/43|"), "PR links became review links: {}", texts[0]);

    assert!(slack_reply::check_edited("  ").is_err());
    assert!(slack_reply::check_edited(&"x".repeat(slack_reply::MAX_EDITED_CHARS + 1)).is_err());
}
