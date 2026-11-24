mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use common::*;
use lotus_automation::pr_review;
use lotus_automation::slack::{SlackApi, SlackListener, SlackMessage};
use lotus_automation::{BoxFuture, NewAutomation, Spec};
use serde_json::{json, Value};

const SLACK_ME: &str = "U0REVIEWER1";
const CHANNEL: &str = "C0CHANNEL01";
const PR_URL: &str = "https://github.com/initech/orbit-app/pull/42";

#[derive(Default)]
struct FakeSlack {
    /// channel → messages, oldest first.
    history: Mutex<HashMap<String, Vec<SlackMessage>>>,
    reactions: Mutex<Vec<(String, String, String)>>,
    removed: Mutex<Vec<(String, String, String)>>,
    replies: Mutex<Vec<(String, String, String)>>,
    history_calls: Mutex<Vec<(String, String)>>,
    /// thread_ts → its replies, oldest first.
    threads: Mutex<HashMap<String, Vec<SlackMessage>>>,
    replies_calls: Mutex<Vec<(String, String, String)>>,
}

impl SlackApi for FakeSlack {
    fn history(&self, channel: &str, oldest: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        self.history_calls.lock().unwrap().push((channel.into(), oldest.into()));
        let found: Vec<SlackMessage> = self
            .history
            .lock()
            .unwrap()
            .get(channel)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|m| ts(&m.ts) > ts(oldest))
            .collect();
        Box::pin(async move { Ok(found) })
    }
    fn replies(&self, channel: &str, thread_ts: &str, oldest: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        self.replies_calls.lock().unwrap().push((channel.into(), thread_ts.into(), oldest.into()));
        let found: Vec<SlackMessage> = self
            .threads
            .lock()
            .unwrap()
            .get(thread_ts)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|m| ts(&m.ts) > ts(oldest))
            .collect();
        Box::pin(async move { Ok(found) })
    }
    fn message(&self, channel: &str, at: &str) -> BoxFuture<Result<Option<SlackMessage>, String>> {
        let found = self
            .history
            .lock()
            .unwrap()
            .get(channel)
            .and_then(|list| list.iter().find(|m| m.ts == at).cloned());
        Box::pin(async move { Ok(found) })
    }
    fn add_reaction(&self, channel: &str, at: &str, name: &str) -> BoxFuture<Result<(), String>> {
        self.reactions.lock().unwrap().push((channel.into(), at.into(), name.into()));
        Box::pin(async { Ok(()) })
    }
    fn remove_reaction(&self, channel: &str, at: &str, name: &str) -> BoxFuture<Result<(), String>> {
        self.removed.lock().unwrap().push((channel.into(), at.into(), name.into()));
        Box::pin(async { Ok(()) })
    }
    fn post_reply(&self, channel: &str, thread_ts: &str, text: &str) -> BoxFuture<Result<String, String>> {
        self.replies.lock().unwrap().push((channel.into(), thread_ts.into(), text.into()));
        Box::pin(async { Ok("1799999999.000001".to_string()) })
    }
    fn post_message(&self, channel: &str, text: &str) -> BoxFuture<Result<String, String>> {
        self.replies.lock().unwrap().push((channel.into(), String::new(), text.into()));
        Box::pin(async { Ok("1799999999.000002".to_string()) })
    }
}

fn ts(value: &str) -> f64 {
    value.parse().unwrap_or(0.0)
}

fn slack_message(ts: &str, user: &str, text: &str) -> SlackMessage {
    SlackMessage { channel: CHANNEL.into(), user: Some(user.into()), text: text.into(), ts: ts.into(), thread_ts: None, subtype: None }
}

fn message_event(ts: &str, text: &str) -> Value {
    json!({ "type": "message", "channel": CHANNEL, "user": "U0SLACKUSR1", "text": text, "ts": ts })
}

fn eyes_event(ts: &str) -> Value {
    json!({ "type": "reaction_added", "user": SLACK_ME, "reaction": "eyes",
            "item": { "type": "message", "channel": CHANNEL, "ts": ts } })
}

struct Setup {
    w: World,
    slack: Arc<FakeSlack>,
    listener: SlackListener,
    automation_id: String,
}

/// The common world plus a Slack-triggered automation watching CHANNEL.
fn setup() -> Setup {
    setup_in(world(open_pr()))
}

fn setup_in(w: World) -> Setup {
    let automation = w
        .store
        .create_automation(
            NewAutomation {
                name: "Review from Slack".into(),
                trigger: Spec::new("slack", json!({ "channels": [CHANNEL], "team": "S0TEAM" })),
                action: w.automation.action.clone(),
                outputs: vec![Spec::new("draft", json!({}))],
            },
            1,
        )
        .unwrap();
    let slack = Arc::new(FakeSlack::default());
    let listener = SlackListener::new(Arc::clone(&w.store), w.github.clone(), slack.clone(), SLACK_ME.into());
    Setup { w, slack, listener, automation_id: automation.id }
}

#[tokio::test]
async fn a_reply_in_the_known_thread_is_kept_and_the_requesters_ask_can_rereview_without_a_pr_url() {
    let s = setup();
    let root = "1790000000.000100";
    s.listener.handle_event(&s.w.engine, &message_event(root, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    let mut reply = message_event("1790000001.000100", "Fixed tenant isolation");
    reply["thread_ts"] = json!(root);
    s.listener.handle_event(&s.w.engine, &reply).await;
    assert_eq!(s.w.store.review_feedback(&s.automation_id, "initech/orbit-app#42").unwrap().len(), 1);
    assert_eq!(s.w.agent.seen.lock().unwrap().len(), 1, "ordinary replies only update the room");
    reply["ts"] = json!("1790000002.000100");
    reply["text"] = json!(format!("<@{SLACK_ME}> please review again"));
    s.listener.handle_event(&s.w.engine, &reply).await;
    s.listener.handle_event(&s.w.engine, &reply).await;
    s.w.engine.drain().await;
    assert_eq!(s.w.agent.seen.lock().unwrap().len(), 2, "one new round despite redelivery and unchanged SHA");
    assert!(s.w.agent.seen.lock().unwrap()[1].prompt.contains("Fixed tenant isolation"));
}

#[tokio::test]
async fn catching_up_counts_the_messages_the_socket_never_delivered() {
    let s = setup();
    let request = format!("<@{SLACK_ME}> {PR_URL}");
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await, 0, "the first catch-up only sets the cursor");

    // Delivered live: the cursor moves past it, so the check that follows finds nothing.
    s.listener.handle_event(&s.w.engine, &message_event("1790000010.000001", "lunch?")).await;
    s.slack.history.lock().unwrap().get_mut(CHANNEL).unwrap().push(slack_message("1790000010.000001", "U0SLACKUSR1", "lunch?"));
    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_000_300_000).await, 0);

    // Taken by another connection to the same Slack app (the 2026-10-07 incident): only history has it.
    s.slack.history.lock().unwrap().get_mut(CHANNEL).unwrap().push(slack_message("1790000400.000001", "U0SLACKUSR1", &request));
    // Still inside the grace window: its live event may be in flight, so it is reviewed but not counted.
    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_000_410_000).await, 0);
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 1, "the missed request is reviewed by the check");

    s.slack.history.lock().unwrap().get_mut(CHANNEL).unwrap().push(slack_message("1790000500.000001", "U0SLACKUSR1", "ping"));
    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_000_900_000).await, 1);
}

fn reply(ts: &str, thread: &str, text: &str) -> SlackMessage {
    SlackMessage { thread_ts: Some(thread.into()), ..slack_message(ts, "U0SLACKUSR1", text) }
}

#[tokio::test]
async fn a_thread_reply_the_socket_missed_is_caught_up_once_and_counted() {
    let s = setup();
    let root = "1790000000.000100";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;
    s.listener.handle_event(&s.w.engine, &message_event(root, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    s.slack.history.lock().unwrap().get_mut(CHANNEL).unwrap().push(slack_message(root, "U0SLACKUSR1", &format!("<@{SLACK_ME}> {PR_URL}")));

    // Another connection took both replies; a later top-level message came live and moved the channel cursor past them.
    s.slack.threads.lock().unwrap().insert(root.into(), vec![
        reply("1790000100.000100", root, "Fixed tenant isolation"),
        reply("1790000200.000100", root, &format!("<@{SLACK_ME}> please review again")),
    ]);
    s.listener.handle_event(&s.w.engine, &message_event("1790000300.000100", "lunch?")).await;

    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_000_900_000).await, 2, "both replies were missed live");
    s.w.engine.drain().await;
    assert_eq!(s.w.store.review_feedback(&s.automation_id, "initech/orbit-app#42").unwrap().len(), 2);
    assert_eq!(s.w.agent.seen.lock().unwrap().len(), 2, "the re-review asked for in the reply runs");
    assert!(s.w.agent.seen.lock().unwrap()[1].prompt.contains("Fixed tenant isolation"));
    assert_eq!(s.slack.replies_calls.lock().unwrap().last().unwrap().2, root, "a new thread is read from its request on");

    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_001_200_000).await, 0);
    s.w.engine.drain().await;
    assert_eq!(s.w.agent.seen.lock().unwrap().len(), 2, "a caught-up reply is not acted on again");
    assert_eq!(s.slack.replies_calls.lock().unwrap().last().unwrap().2, "1790000200.000100", "the thread resumes after its newest reply");
}

#[tokio::test]
async fn a_live_thread_reply_is_not_counted_as_missed() {
    let s = setup();
    let root = "1790000000.000100";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;
    s.listener.handle_event(&s.w.engine, &message_event(root, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    let mut live = message_event("1790000100.000100", "Fixed tenant isolation");
    live["thread_ts"] = json!(root);
    s.listener.handle_event(&s.w.engine, &live).await;
    s.slack.threads.lock().unwrap().insert(root.into(), vec![reply("1790000100.000100", root, "Fixed tenant isolation")]);
    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_000_900_000).await, 0);
}

/// Found 2026-10-19: Lotus posts the review reply as me, and that live reply did not move the
/// thread cursor, so every sent review came back as "1 message reached Lotus only through the check".
#[tokio::test]
async fn my_own_live_thread_reply_is_not_counted_as_missed() {
    let s = setup();
    let root = "1790000000.000100";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;
    s.listener.handle_event(&s.w.engine, &message_event(root, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    let mut mine = message_event("1790000100.000100", "LGTM :white_check_mark:");
    mine["thread_ts"] = json!(root);
    mine["user"] = json!(SLACK_ME);
    s.listener.handle_event(&s.w.engine, &mine).await;
    s.slack.threads.lock().unwrap().insert(root.into(), vec![SlackMessage {
        thread_ts: Some(root.into()),
        ..slack_message("1790000100.000100", SLACK_ME, "LGTM :white_check_mark:")
    }]);
    assert_eq!(s.listener.catch_up(&s.w.engine, 1_790_000_900_000).await, 0);
    assert!(s.w.store.review_feedback(&s.automation_id, "initech/orbit-app#42").unwrap().is_empty(), "my own reply is still not feedback");
}

/// How many 👀 Lotus added: the request was taken in hand.
fn eyes_on(s: &Setup) -> usize {
    s.slack.reactions.lock().unwrap().iter().filter(|(_, _, name)| name == "eyes").count()
}

fn runs_of(s: &Setup) -> Vec<lotus_automation::RunEntry> {
    s.w.store.list_runs(100).unwrap().into_iter().filter(|r| r.run.automation_id == s.automation_id).collect()
}

#[tokio::test]
async fn a_live_request_starts_a_review_and_marks_the_message_with_eyes() {
    let s = setup();
    s.listener
        .handle_event(&s.w.engine, &message_event("1790000000.000100", &format!("<@{SLACK_ME}> pls {PR_URL}")))
        .await;
    s.w.engine.drain().await;

    let runs = runs_of(&s);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run.idempotency_key, "initech/orbit-app#42@sha1");
    assert_eq!(
        *s.slack.reactions.lock().unwrap(),
        vec![(CHANNEL.to_string(), "1790000000.000100".to_string(), "eyes".to_string())]
    );
    assert!(s.slack.replies.lock().unwrap().is_empty(), "nothing is said in Slack until the reviewer presses Send");
}

#[tokio::test]
async fn lotus_own_eyes_reaction_coming_back_as_an_event_starts_nothing() {
    let s = setup();
    let at = "1790000000.000100";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, "U0SLACKUSR1", PR_URL)]);
    s.listener.handle_event(&s.w.engine, &message_event(at, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    s.w.github.pr.lock().unwrap().head_sha = "sha2".into();
    s.w.github.pr.lock().unwrap().is_draft = false; // a lookup now WOULD start a second run

    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await; // Slack echoes Lotus's own 👀
    s.w.engine.drain().await;

    assert_eq!(runs_of(&s).len(), 1);
    assert_eq!(eyes_on(&s), 1);
}

#[tokio::test]
async fn an_event_slack_delivers_twice_is_handled_once() {
    let s = setup();
    let event = message_event("1790000000.000100", &format!("<@{SLACK_ME}> {PR_URL}"));
    s.listener.handle_event(&s.w.engine, &event).await;
    s.w.github.pr.lock().unwrap().head_sha = "sha2".into();
    s.w.github.pr.lock().unwrap().is_draft = false;
    s.listener.handle_event(&s.w.engine, &event).await; // a Slack retry
    s.w.engine.drain().await;

    assert_eq!(runs_of(&s).len(), 1);
    assert_eq!(eyes_on(&s), 1);
}

#[tokio::test]
async fn my_eyes_on_a_message_without_a_mention_reviews_its_pull_requests() {
    let s = setup();
    let at = "1790000000.000200";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, "U0SLACKUSR1", PR_URL)]);

    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await;
    s.w.engine.drain().await;

    assert_eq!(runs_of(&s).len(), 1);
}

#[tokio::test]
async fn a_pull_request_outside_the_watched_repositories_is_left_alone() {
    let s = setup();
    let text = format!("<@{SLACK_ME}> {PR_URL} and https://github.com/elsewhere/other/pull/1");
    s.listener.handle_event(&s.w.engine, &message_event("1790000000.000300", &text)).await;
    s.w.engine.drain().await;

    assert_eq!(runs_of(&s).len(), 1, "only the watched repository's PR is reviewed");
}

#[tokio::test]
async fn catching_up_reviews_what_was_missed_exactly_once_and_never_old_history() {
    let s = setup();
    let request = format!("<@{SLACK_ME}> {PR_URL}");
    s.slack
        .history
        .lock()
        .unwrap()
        .insert(
            CHANNEL.into(),
            // An OLD request for a different PR: it must never be picked up.
            vec![slack_message("1700000000.000001", "U0SLACKUSR1", &format!("<@{SLACK_ME}> https://github.com/initech/orbit-app/pull/41"))],
        );

    // First start ever: history from before Lotus watched is not reviewed; the position is saved.
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 0);

    // While Lotus was off, a request arrived.
    s.slack
        .history
        .lock()
        .unwrap()
        .get_mut(CHANNEL)
        .unwrap()
        .push(slack_message("1790000100.000001", "U0SLACKUSR1", &request));
    s.listener.catch_up(&s.w.engine, 1_790_000_200_000).await;
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 1);

    s.w.github.pr.lock().unwrap().head_sha = "sha2".into();
    s.w.github.pr.lock().unwrap().is_draft = false;
    s.listener.catch_up(&s.w.engine, 1_790_000_300_000).await;
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 1, "a caught-up message is not reviewed again");
    let calls = s.slack.history_calls.lock().unwrap();
    assert_eq!(calls.last().unwrap().1, "1790000100.000001", "catch-up resumes after the newest message seen");
}

#[tokio::test]
async fn the_draft_remembers_where_in_slack_the_request_came_from() {
    let s = setup();
    let mut event = message_event("1790000000.000400", &format!("<@{SLACK_ME}> {PR_URL}"));
    event["thread_ts"] = json!("1789000000.000001");
    s.listener.handle_event(&s.w.engine, &event).await;
    s.w.engine.drain().await;

    let run = &runs_of(&s)[0];
    let draft = s.w.store.draft_for_run(&run.run.id).unwrap().expect("draft");
    assert_eq!(
        draft.content["slack"],
        json!({ "channel": CHANNEL, "thread_ts": "1789000000.000001", "message_ts": "1790000000.000400", "requester": "U0SLACKUSR1" })
    );
}

#[tokio::test]
async fn after_send_the_reply_goes_to_the_request_thread_and_tags_the_requester() {
    use lotus_automation::slack::reply_in_thread;
    let s = setup();
    let mut event = message_event("1790000000.000500", &format!("<@{SLACK_ME}> {PR_URL}"));
    event["thread_ts"] = json!("1789000000.000001");
    s.listener.handle_event(&s.w.engine, &event).await;
    s.w.engine.drain().await;
    let draft = s.w.store.draft_for_run(&runs_of(&s)[0].run.id).unwrap().unwrap();

    let replied = reply_in_thread(s.slack.as_ref(), &draft, "https://github.com/initech/orbit-app/pull/42#pullrequestreview-1", &Default::default())
        .await
        .unwrap();

    assert!(replied);
    let replies = s.slack.replies.lock().unwrap();
    let (channel, thread, text) = &replies[0];
    assert_eq!((channel.as_str(), thread.as_str()), (CHANNEL, "1789000000.000001"));
    assert!(text.contains("<https://github.com/initech/orbit-app/pull/42#pullrequestreview-1|"), "{text}");
    assert!(text.contains("<@U0SLACKUSR1>"), "{text}");
}

#[tokio::test]
async fn a_draft_that_did_not_come_from_slack_has_no_thread_to_reply_to() {
    use lotus_automation::slack::reply_in_thread;
    let s = setup();
    let run = review(&s.w).await; // "Run now", not Slack
    let draft = s.w.store.draft_for_run(&run.id).unwrap().unwrap();

    assert!(!reply_in_thread(s.slack.as_ref(), &draft, "https://x", &Default::default()).await.unwrap());
    assert!(s.slack.replies.lock().unwrap().is_empty());
}

#[tokio::test]
async fn lotus_own_eyes_never_makes_another_automation_review_a_message_that_did_not_ask_it() {
    let s = setup();
    // A second automation in the same channel that only reacts to my 👀 (no team; the message mentions a team it does not watch).
    s.w.store
        .create_automation(
            NewAutomation {
                name: "Other".into(),
                trigger: Spec::new("slack", json!({ "channels": [CHANNEL], "team": null })),
                action: s.w.automation.action.clone(),
                outputs: vec![],
            },
            2,
        )
        .unwrap();
    let at = "1790000000.000600";
    let text = format!("<!subteam^S0TEAM> {PR_URL}");
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, "U0SLACKUSR1", &text)]);
    s.listener.handle_event(&s.w.engine, &message_event(at, &text)).await; // only the S0TEAM automation matches
    s.w.engine.drain().await;
    let before = s.w.store.list_runs(100).unwrap().len();

    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await; // Lotus's own 👀 echoes back
    s.w.engine.drain().await;

    assert_eq!(s.w.store.list_runs(100).unwrap().len(), before, "the echo must not start the other automation");
}

#[tokio::test]
async fn my_eyes_reviews_a_pull_request_github_did_not_ask_me_to_review() {
    let s = setup();
    s.w.github.pr.lock().unwrap().requested_users = vec![];
    let at = "1790000000.000400";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, "U0SLACKUSR1", PR_URL)]);

    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await;
    s.w.engine.drain().await;

    let runs = runs_of(&s);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run.status, lotus_automation::RunStatus::Succeeded, "{:?}", runs[0].run.detail);
    assert!(s.slack.reactions.lock().unwrap().is_empty(), "the message already has my :eyes:");
}

#[tokio::test]
async fn an_automation_that_also_watches_github_still_listens_in_slack() {
    let s = setup();
    let trigger = s.w.store.get_automation(&s.automation_id).unwrap().unwrap().trigger;
    let both = lotus_automation::sources::with_source(&trigger, "github", Some(json!({}))).unwrap();
    s.w.store.set_trigger(&s.automation_id, &both).unwrap();

    s.listener.handle_event(&s.w.engine, &message_event("1790000000.000460", &format!("<!subteam^S0TEAM> {PR_URL}"))).await;
    s.w.engine.drain().await;

    assert_eq!(runs_of(&s).len(), 1);
}

/// 2026-09-28: "@team-orbit please review" was skipped because GitHub listed
/// no reviewer — the team request was gone once other members approved.
#[tokio::test]
async fn a_team_mention_is_reviewed_though_github_requests_no_one() {
    let s = setup();
    {
        let mut pr = s.w.github.pr.lock().unwrap();
        pr.requested_users = vec![];
        pr.requested_teams = vec![];
    }
    let at = "1790000000.000450";
    s.listener.handle_event(&s.w.engine, &message_event(at, &format!("Hi <!subteam^S0TEAM> {PR_URL}"))).await;
    s.w.engine.drain().await;

    let runs = runs_of(&s);
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run.status, lotus_automation::RunStatus::Succeeded, "{:?}", runs[0].run.detail);
}

#[tokio::test]
async fn a_mention_of_a_draft_gets_nothing_and_is_reviewed_when_i_put_eyes_on_it() {
    let s = setup();
    s.w.github.pr.lock().unwrap().is_draft = true;
    let at = "1790000000.000500";
    let text = format!("<@{SLACK_ME}> {PR_URL}");
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, "U0SLACKUSR1", &text)]);

    s.listener.handle_event(&s.w.engine, &message_event(at, &text)).await;
    s.w.engine.drain().await;
    s.listener.settle().await;
    assert!(runs_of(&s).is_empty(), "a draft is checked before any run starts");
    assert!(s.slack.reactions.lock().unwrap().is_empty(), "a colleague's request gets no mark when nothing will happen");

    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await; // my 👀, put by hand on the draft
    s.w.engine.drain().await;
    s.listener.settle().await;
    assert_eq!(runs_of(&s)[0].run.status, lotus_automation::RunStatus::Skipped, "I asked, so the run says why it skipped");
    assert_eq!(names(&s.slack.reactions), vec![SKIPPED], "and the skip mark shows it on the message");
    s.w.github.pr.lock().unwrap().is_draft = false;

    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await; // my 👀 again, now the PR is ready
    s.w.engine.drain().await;
    let runs = runs_of(&s);
    assert_eq!(runs.len(), 2);
    assert_eq!(runs[0].run.status, lotus_automation::RunStatus::Succeeded, "{:?}", runs[0].run.detail);
}

/// 2026-09-25: a mention was skipped, the PR moved on, and the reviewer used
/// the Review button. The draft had no Slack thread, so Send said nothing in
/// Slack. The thread a PR was asked about in is now kept whatever the run did.
#[tokio::test]
async fn the_review_button_keeps_the_slack_thread_of_an_earlier_skipped_request() {
    use lotus_automation::slack::reply_in_thread;
    let s = setup();
    s.w.github.pr.lock().unwrap().is_draft = true;
    let mut event = message_event("1790000000.000600", &format!("<@{SLACK_ME}> {PR_URL}"));
    event["thread_ts"] = json!("1789000000.000001");
    s.listener.handle_event(&s.w.engine, &event).await;
    s.w.engine.drain().await;
    assert!(runs_of(&s).is_empty(), "the draft is turned away before any run, yet its thread is kept");

    s.w.github.pr.lock().unwrap().head_sha = "sha2".into();
    s.w.github.pr.lock().unwrap().is_draft = false;
    let automation = s.w.store.get_automation(&s.automation_id).unwrap().unwrap();
    let submitted = pr_review::run_now(&s.w.engine, &s.w.store, s.w.github.as_ref(), &automation, PR_URL).await.unwrap();
    let lotus_automation::Submitted::Started { run_id } = submitted else { panic!("{submitted:?}") };
    s.w.engine.drain().await;

    let draft = s.w.store.draft_for_run(&run_id).unwrap().expect("draft");
    assert_eq!(draft.content["slack"]["thread_ts"], json!("1789000000.000001"));
    assert!(reply_in_thread(s.slack.as_ref(), &draft, "https://github.com/x/y/pull/1#r", &Default::default()).await.unwrap());
    assert_eq!(s.slack.replies.lock().unwrap()[0].1, "1789000000.000001");
}

#[tokio::test]
async fn the_review_button_on_a_pr_never_asked_about_in_slack_has_no_thread() {
    let s = setup();
    let automation = s.w.store.get_automation(&s.automation_id).unwrap().unwrap();
    let submitted = pr_review::run_now(&s.w.engine, &s.w.store, s.w.github.as_ref(), &automation, PR_URL).await.unwrap();
    let lotus_automation::Submitted::Started { run_id } = submitted else { panic!("{submitted:?}") };
    s.w.engine.drain().await;

    let draft = s.w.store.draft_for_run(&run_id).unwrap().expect("draft");
    assert!(draft.content["slack"].is_null());
}

#[tokio::test]
async fn my_eyes_on_a_thread_reply_continues_the_registered_pr_without_a_url() {
    let s = setup();
    let root = "1790000000.000100";
    s.listener.handle_event(&s.w.engine, &message_event(root, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    let at = "1790000001.000100";
    let mut reply = slack_message(at, "U0SLACKUSR1", "Please recheck the fix");
    reply.thread_ts = Some(root.into());
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![reply]);
    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await;
    s.w.engine.drain().await;
    assert_eq!(s.w.agent.seen.lock().unwrap().len(), 2);
    assert_eq!(s.w.store.review_feedback(&s.automation_id, "initech/orbit-app#42").unwrap().len(), 1);
}

#[tokio::test]
async fn a_request_github_could_not_take_is_tried_again_at_the_next_catch_up_and_reviewed_once() {
    let s = setup();
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;

    *s.w.github.fail_pull_request.lock().unwrap() = 1;
    s.listener.handle_event(&s.w.engine, &message_event("1790000010.000001", &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    assert!(runs_of(&s).is_empty(), "GitHub was down");
    assert!(s.slack.reactions.lock().unwrap().is_empty(), "no 👀 for a request that did not start");
    assert_eq!(s.w.store.slack_retries().unwrap().len(), 1);

    s.listener.catch_up(&s.w.engine, 1_790_000_300_000).await;
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 1, "the kept request is reviewed once GitHub is back");
    assert_eq!(eyes_on(&s), 1);
    assert!(s.w.store.slack_retries().unwrap().is_empty());

    s.listener.catch_up(&s.w.engine, 1_790_000_600_000).await;
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 1, "and only once");
}

#[tokio::test]
async fn a_request_that_keeps_failing_is_given_up_after_six_attempts() {
    let s = setup();
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;

    *s.w.github.fail_pull_request.lock().unwrap() = 100;
    s.listener.handle_event(&s.w.engine, &message_event("1790000010.000001", &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    for check in 1..=4 {
        s.listener.catch_up(&s.w.engine, 1_790_000_000_000 + check * 300_000).await;
        assert_eq!(s.w.store.slack_retries().unwrap()[0].2, 1 + check as u32);
    }
    s.listener.catch_up(&s.w.engine, 1_790_001_800_000).await;
    assert!(s.w.store.slack_retries().unwrap().is_empty(), "the sixth failure ends it");
    assert_eq!(*s.w.github.fail_pull_request.lock().unwrap(), 94, "six GitHub calls in all");
}

#[tokio::test]
async fn the_quick_channel_check_leaves_retries_to_the_full_check() {
    let s = setup();
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;

    *s.w.github.fail_pull_request.lock().unwrap() = 100;
    s.listener.handle_event(&s.w.engine, &message_event("1790000010.000001", &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    for minute in 1..=4 {
        s.listener.catch_up_channels(&s.w.engine, 1_790_000_000_000 + minute * 60_000).await;
    }
    assert_eq!(s.w.store.slack_retries().unwrap()[0].2, 1, "quick checks do not spend retry attempts");
    assert_eq!(*s.w.github.fail_pull_request.lock().unwrap(), 99, "one GitHub call: the live one");
}

#[tokio::test]
async fn a_request_for_a_repository_not_watched_is_not_tried_again() {
    let s = setup();
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![]);
    s.listener.catch_up(&s.w.engine, 1_790_000_000_000).await;

    s.listener
        .handle_event(&s.w.engine, &message_event("1790000010.000001", &format!("<@{SLACK_ME}> https://github.com/someone/else/pull/7")))
        .await;
    assert!(s.w.store.slack_retries().unwrap().is_empty());
    assert!(runs_of(&s).is_empty());
}

#[tokio::test]
async fn a_second_engineer_asking_in_another_thread_gets_eyes_and_their_thread_is_kept() {
    let s = setup();
    let (first, second) = ("1790000000.000100", "1790000050.000100");
    s.listener.handle_event(&s.w.engine, &message_event(first, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.listener.handle_event(&s.w.engine, &message_event(second, &format!("<@{SLACK_ME}> can you check {PR_URL}"))).await;
    s.w.engine.drain().await;
    s.listener.settle().await;

    assert_eq!(runs_of(&s).len(), 1, "one review of the commit");
    let eyes: Vec<String> =
        s.slack.reactions.lock().unwrap().iter().filter(|(_, _, n)| n == "eyes").map(|(_, ts, _)| ts.clone()).collect();
    assert_eq!(eyes, vec![first.to_string(), second.to_string()], "both requesters see it is in hand");
    assert_eq!(s.w.store.prs_in_thread(&s.automation_id, CHANNEL, first).unwrap().len(), 1, "the first thread is still read");
    assert_eq!(s.w.store.prs_in_thread(&s.automation_id, CHANNEL, second).unwrap().len(), 1);
    assert!(s.slack.replies.lock().unwrap().is_empty(), "nothing is written in the user's name");
}

#[tokio::test]
async fn a_review_skipped_because_the_pr_moved_puts_a_skip_mark_on_its_request() {
    let s = setup();
    *s.w.github.move_on_diff.lock().unwrap() = Some("sha-moved".into());
    let at = "1790000000.000100";
    s.listener.handle_event(&s.w.engine, &message_event(at, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    s.listener.settle().await;

    assert_eq!(runs_of(&s)[0].run.status, lotus_automation::RunStatus::Skipped);
    assert!(s.slack.reactions.lock().unwrap().contains(&(
        CHANNEL.to_string(),
        at.to_string(),
        "black_right_pointing_double_triangle_with_vertical_bar".to_string()
    )));
    assert!(s.slack.replies.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_request_past_the_three_review_slots_shows_an_hourglass_until_it_starts() {
    let limits = lotus_automation::pr_review::PrReviewLimits {
        agent_timeout: std::time::Duration::from_millis(300),
        ..Default::default()
    };
    let s = setup_in(world_with(open_pr(), Reply::Hang, limits));
    for n in 1..=4 {
        let url = format!("https://github.com/initech/orbit-app/pull/{n}");
        s.listener.handle_event(&s.w.engine, &message_event(&format!("179000000{n}.000100"), &format!("<@{SLACK_ME}> {url}"))).await;
    }
    s.w.engine.drain().await;
    s.listener.settle().await;

    let hourglass = |list: &Mutex<Vec<(String, String, String)>>| -> Vec<String> {
        list.lock().unwrap().iter().filter(|(_, _, n)| n == "hourglass_flowing_sand").map(|(_, ts, _)| ts.clone()).collect()
    };
    assert_eq!(hourglass(&s.slack.reactions), vec!["1790000004.000100".to_string()], "only the fourth waited");
    assert_eq!(hourglass(&s.slack.removed), vec!["1790000004.000100".to_string()], "and lost it once it started");
}

#[tokio::test]
async fn send_replies_in_every_thread_that_asked_for_the_review_each_tagging_its_requester() {
    use lotus_automation::slack::reply_in_threads;
    let s = setup();
    let (first, second) = ("1790000000.000100", "1790000050.000100");
    s.listener.handle_event(&s.w.engine, &message_event(first, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    let mut other = message_event(second, &format!("<@{SLACK_ME}> can you check {PR_URL}"));
    other["user"] = json!("U0SECOND");
    s.listener.handle_event(&s.w.engine, &other).await;
    // Slack redelivers the second request: still one more thread, not two.
    s.listener.handle_event(&s.w.engine, &other).await;
    s.w.engine.drain().await;

    let run_id = runs_of(&s)[0].run.id.clone();
    let draft = s.w.store.draft_for_run(&run_id).unwrap().unwrap();
    let others = s.w.store.run_slack_threads(&run_id).unwrap();
    let replied = reply_in_threads(s.slack.as_ref(), &draft, "https://github.com/x/y/pull/1#r", &Default::default(), &others)
        .await
        .unwrap();

    assert_eq!(replied, 2);
    let replies = s.slack.replies.lock().unwrap();
    let to: Vec<(&str, bool, bool)> = replies
        .iter()
        .map(|(_, thread, text)| (thread.as_str(), text.contains("<@U0SLACKUSR1>"), text.contains("<@U0SECOND>")))
        .collect();
    assert_eq!(to, vec![(first, true, false), (second, false, true)]);
}

#[tokio::test]
async fn a_two_pr_request_tells_each_review_about_the_other() {
    let s = setup();
    let other = "https://github.com/initech/orbit-app/pull/43";
    s.listener
        .handle_event(&s.w.engine, &message_event("1790000000.000100", &format!("<@{SLACK_ME}> api {PR_URL} ui {other}")))
        .await;
    s.w.engine.drain().await;

    let seen = s.w.agent.seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "one run per PR");
    for (prompt, sibling) in [(&seen[0].prompt, "initech/orbit-app#43"), (&seen[1].prompt, "initech/orbit-app#42")] {
        let (_, part) = prompt.split_once("The same Slack request also asked for these pull requests").expect("siblings listed");
        let fence = part.split_once("</untrusted-data-").unwrap().0;
        assert!(fence.contains(&format!("{sibling} — ")), "{sibling} with its title: {fence}");
        assert!(part.contains("Comment only on this pull request"));
    }
    // A review asked for alone lists no siblings.
    drop(seen);
    let alone = setup();
    alone.listener.handle_event(&alone.w.engine, &message_event("1790000001.000100", &format!("<@{SLACK_ME}> pls {PR_URL}"))).await;
    alone.w.engine.drain().await;
    assert!(!alone.w.agent.seen.lock().unwrap()[0].prompt.contains("also asked for these pull requests"));
}

/// The listener with reactions the user chose in Connectors → Slack.
fn with_reactions(s: Setup, reactions: lotus_automation::slack::StatusReactions) -> Setup {
    let settings = Arc::new(lotus_automation::slack::ReactionSettings::new(reactions.normalized().unwrap()));
    let listener = SlackListener::new(Arc::clone(&s.w.store), s.w.github.clone(), s.slack.clone(), SLACK_ME.into())
        .with_reactions(settings);
    Setup { listener, ..s }
}

fn chosen() -> lotus_automation::slack::StatusReactions {
    lotus_automation::slack::StatusReactions {
        taken: ":mag:".into(),
        running: "gear".into(),
        done: "White_Check_Mark".into(),
        failed: "x".into(),
        ..Default::default()
    }
}

fn names(list: &Mutex<Vec<(String, String, String)>>) -> Vec<String> {
    list.lock().unwrap().iter().map(|(_, _, n)| n.clone()).collect()
}

#[tokio::test]
async fn chosen_reactions_show_taken_running_and_done_and_running_comes_off() {
    let s = with_reactions(setup(), chosen());
    s.listener.handle_event(&s.w.engine, &message_event("1790000000.000100", &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    s.listener.settle().await;

    assert_eq!(runs_of(&s)[0].run.status, lotus_automation::RunStatus::Succeeded);
    assert_eq!(names(&s.slack.reactions), vec!["mag", "gear", "white_check_mark"]);
    assert_eq!(names(&s.slack.removed), vec!["gear"], "running comes off when the review ends");
}

#[tokio::test]
async fn a_failed_review_shows_the_failed_reaction() {
    let limits = pr_review::PrReviewLimits { agent_timeout: std::time::Duration::from_millis(100), ..Default::default() };
    let s = with_reactions(setup_in(world_with(open_pr(), Reply::Hang, limits)), chosen());
    s.listener.handle_event(&s.w.engine, &message_event("1790000000.000100", &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    s.listener.settle().await;

    assert_eq!(runs_of(&s)[0].run.status, lotus_automation::RunStatus::Failed);
    assert!(names(&s.slack.reactions).contains(&"x".to_string()));
    assert!(!names(&s.slack.reactions).contains(&"white_check_mark".to_string()));
}

#[tokio::test]
async fn the_chosen_taken_reaction_is_also_what_asks_for_a_review() {
    let s = with_reactions(setup(), chosen());
    let at = "1790000000.000200";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, "U0SLACKUSR1", PR_URL)]);

    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await;
    s.w.engine.drain().await;
    assert!(runs_of(&s).is_empty(), ":eyes: no longer asks once another emoji was chosen");

    let mut mag = eyes_event(at);
    mag["reaction"] = json!("mag");
    s.listener.handle_event(&s.w.engine, &mag).await;
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 1);
}

#[tokio::test]
async fn lotus_own_chosen_taken_reaction_coming_back_starts_nothing() {
    let s = with_reactions(setup(), chosen());
    let at = "1790000000.000100";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, "U0SLACKUSR1", PR_URL)]);
    s.listener.handle_event(&s.w.engine, &message_event(at, &format!("<@{SLACK_ME}> {PR_URL}"))).await;
    s.w.engine.drain().await;
    s.w.github.pr.lock().unwrap().head_sha = "sha2".into();

    let mut echo = eyes_event(at);
    echo["reaction"] = json!("mag");
    s.listener.handle_event(&s.w.engine, &echo).await;
    s.w.engine.drain().await;

    assert_eq!(runs_of(&s).len(), 1);
}

// ---------- pre-check before any reaction, and what a thread reply is for (ADR-0059) ----------

const SKIPPED: &str = "black_right_pointing_double_triangle_with_vertical_bar";
const REQUESTER: &str = "U0SLACKUSR1";
const REVIEWER: &str = "U0PEERUSER2";
const ROOT: &str = "1790000000.000100";

async fn ask(s: &Setup, at: &str) {
    let text = format!("<@{SLACK_ME}> {PR_URL}");
    s.listener.handle_event(&s.w.engine, &message_event(at, &text)).await;
    s.w.engine.drain().await;
    s.listener.settle().await;
}

#[tokio::test]
async fn a_request_for_my_own_merged_or_draft_pr_gets_no_reaction_and_no_run() {
    type Change = fn(&mut lotus_automation::github::PullRequest);
    let changes: [(Change, &str); 4] = [
        (|pr| pr.author = ME.into(), "own"),
        (|pr| pr.state = lotus_automation::github::PrState::Merged, "merged"),
        (|pr| pr.state = lotus_automation::github::PrState::Closed, "closed"),
        (|pr| pr.is_draft = true, "draft"),
    ];
    for (change, why) in changes {
        let s = setup();
        change(&mut s.w.github.pr.lock().unwrap());
        ask(&s, ROOT).await;
        assert!(runs_of(&s).is_empty(), "{why}: no run");
        assert!(s.slack.reactions.lock().unwrap().is_empty(), "{why}: no eyes and no skip mark");
        assert!(s.w.store.slack_retries().unwrap().is_empty(), "{why}: nothing to retry");
        assert_eq!(s.w.store.prs_in_thread(&s.automation_id, CHANNEL, ROOT).unwrap().len(), 1, "{why}: the thread is still kept");
    }
}

#[tokio::test]
async fn my_eyes_on_a_merged_pr_still_shows_why_nothing_happened() {
    let s = setup();
    s.w.github.pr.lock().unwrap().state = lotus_automation::github::PrState::Merged;
    let at = "1790000000.000900";
    s.slack.history.lock().unwrap().insert(CHANNEL.into(), vec![slack_message(at, REQUESTER, &format!("<@{SLACK_ME}> {PR_URL}"))]);
    s.listener.handle_event(&s.w.engine, &eyes_event(at)).await;
    s.w.engine.drain().await;
    s.listener.settle().await;
    assert_eq!(names(&s.slack.reactions), vec![SKIPPED]);
}

fn reply_event(ts: &str, user: &str, text: &str) -> Value {
    let mut event = message_event(ts, text);
    event["user"] = json!(user);
    event["thread_ts"] = json!(ROOT);
    event
}

/// A thread whose first message, by REQUESTER, asked for the review and was reviewed.
async fn reviewed_thread(s: &Setup) {
    ask(s, ROOT).await;
    assert_eq!(runs_of(s).len(), 1);
}

#[tokio::test]
async fn the_requesters_ask_to_review_again_starts_a_round_and_gets_eyes() {
    let s = setup();
    reviewed_thread(&s).await;
    let at = "1790000100.000100";
    let text = format!("Resolved! Please review again <@{SLACK_ME}> -san");
    s.listener.handle_event(&s.w.engine, &reply_event(at, REQUESTER, &text)).await;
    s.w.engine.drain().await;
    s.listener.settle().await;
    assert_eq!(runs_of(&s).len(), 2);
    assert!(s.slack.reactions.lock().unwrap().contains(&(CHANNEL.into(), at.into(), "eyes".into())));
}

#[tokio::test]
async fn a_co_author_who_did_not_post_the_request_can_still_ask_in_plain_words() {
    let s = setup();
    reviewed_thread(&s).await;
    let at = "1790000100.000100";
    let text = format!("Resolved! Please review again <@{SLACK_ME}> -san");
    s.listener.handle_event(&s.w.engine, &reply_event(at, "U0PEERUSER1", &text)).await;
    s.w.engine.drain().await;
    s.listener.settle().await;
    assert_eq!(runs_of(&s).len(), 2);
    assert!(s.slack.reactions.lock().unwrap().contains(&(CHANNEL.into(), at.into(), "eyes".into())));
    // Their later reply must not make them the thread's requester for the facts.
    assert_eq!(s.w.store.thread_requester(&s.automation_id, CHANNEL, ROOT).unwrap().as_deref(), Some(REQUESTER));
}

#[tokio::test]
async fn replies_that_only_report_a_review_or_a_merge_get_nothing() {
    let s = setup();
    reviewed_thread(&s).await;
    let before = names(&s.slack.reactions).len();
    let cases = [
        (REVIEWER, format!("Reviewed! LGTM <@{SLACK_ME}>-san")),
        (REVIEWER, format!("<@{SLACK_ME}>-san, thanks for the fixes! I re-reviewed it and approved it.")),
        (REVIEWER, format!("Reviewed! I've feedback on acme-api, please check it <@{SLACK_ME}>-san")),
        (REQUESTER, "Merged, thank you <!subteam^S0TEAM>".to_string()),
        (REQUESTER, format!("thank you very much! I'll keep it on all envs and merge the PR <@{SLACK_ME}> :pray:")),
    ];
    for (i, (user, text)) in cases.iter().enumerate() {
        s.listener.handle_event(&s.w.engine, &reply_event(&format!("17900002{i:02}.000100"), user, text)).await;
    }
    s.w.engine.drain().await;
    s.listener.settle().await;
    assert_eq!(runs_of(&s).len(), 1, "none of them asks for another review");
    assert_eq!(names(&s.slack.reactions).len(), before, "and none gets a mark");
    assert_eq!(
        s.w.store.review_feedback(&s.automation_id, "initech/orbit-app#42").unwrap().len(),
        cases.len(),
        "yet each is kept, so a later review still sees them"
    );
}

struct FakeClassifier {
    verdict: Result<lotus_automation::slack::intake::Intake, String>,
    seen: Mutex<Vec<lotus_automation::slack::intake::IntakeInput>>,
}

impl lotus_automation::slack::intake::ReplyClassifier for FakeClassifier {
    fn classify(&self, input: lotus_automation::slack::intake::IntakeInput) -> BoxFuture<Result<lotus_automation::slack::intake::Intake, String>> {
        self.seen.lock().unwrap().push(input);
        let verdict = self.verdict.clone();
        Box::pin(async move { verdict })
    }
}

fn verdict(intent: lotus_automation::slack::intake::Intent, confidence: f32) -> Result<lotus_automation::slack::intake::Intake, String> {
    use lotus_automation::slack::intake::{Intake, Source};
    Ok(Intake { intent, confidence, reason: "test".into(), source: Source::Model })
}

const AMBIGUOUS: &str = "the second endpoint still behaves differently on staging";

async fn ambiguous_reply(verdict: Result<lotus_automation::slack::intake::Intake, String>) -> (Setup, Arc<FakeClassifier>) {
    let classifier = Arc::new(FakeClassifier { verdict, seen: Mutex::new(vec![]) });
    let mut s = setup();
    s.listener = s.listener.with_intake(classifier.clone());
    reviewed_thread(&s).await;
    let text = format!("<@{SLACK_ME}> {AMBIGUOUS}");
    s.listener.handle_event(&s.w.engine, &reply_event("1790000100.000100", REQUESTER, &text)).await;
    s.w.engine.drain().await;
    s.listener.settle().await;
    (s, classifier)
}

#[tokio::test]
async fn an_ambiguous_reply_is_left_to_the_model_and_acted_on_when_it_is_sure() {
    use lotus_automation::slack::intake::Intent;
    let (s, classifier) = ambiguous_reply(verdict(Intent::RereviewRequest, 0.9)).await;
    assert_eq!(runs_of(&s).len(), 2);
    let seen = classifier.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].text.contains(AMBIGUOUS));
    assert_eq!(seen[0].pr_authors, vec!["teammate".to_string()]);
    assert_eq!(seen[0].root_requester.as_deref(), Some(REQUESTER));
}

#[tokio::test]
async fn an_ambiguous_reply_the_model_is_unsure_about_or_calls_something_else_starts_nothing() {
    use lotus_automation::slack::intake::Intent;
    for v in [verdict(Intent::RereviewRequest, 0.6), verdict(Intent::Discussion, 0.99), verdict(Intent::Thanks, 0.9)] {
        let (s, classifier) = ambiguous_reply(v).await;
        assert_eq!(classifier.seen.lock().unwrap().len(), 1);
        assert_eq!(runs_of(&s).len(), 1);
        assert_eq!(eyes_on(&s), 1, "only the first request has eyes");
    }
}

#[tokio::test]
async fn a_model_error_starts_nothing_and_marks_nothing() {
    let (s, classifier) = ambiguous_reply(Err("timed out".into())).await;
    assert_eq!(classifier.seen.lock().unwrap().len(), 1);
    assert_eq!(runs_of(&s).len(), 1);
    assert_eq!(eyes_on(&s), 1);
}

#[tokio::test]
async fn without_a_model_an_ambiguous_reply_starts_nothing() {
    let s = setup();
    reviewed_thread(&s).await;
    let text = format!("<@{SLACK_ME}> {AMBIGUOUS}");
    s.listener.handle_event(&s.w.engine, &reply_event("1790000100.000100", REQUESTER, &text)).await;
    s.w.engine.drain().await;
    assert_eq!(runs_of(&s).len(), 1);
}

#[tokio::test]
async fn the_model_is_not_asked_when_the_rules_or_facts_already_decide() {
    use lotus_automation::slack::intake::Intent;
    let classifier = Arc::new(FakeClassifier { verdict: verdict(Intent::RereviewRequest, 1.0), seen: Mutex::new(vec![]) });
    let mut s = setup();
    s.listener = s.listener.with_intake(classifier.clone());
    reviewed_thread(&s).await;
    for (i, (user, text)) in [(REVIEWER, AMBIGUOUS), (REQUESTER, "LGTM"), (REQUESTER, "please re-review")].iter().enumerate() {
        let text = format!("<@{SLACK_ME}> {text}");
        s.listener.handle_event(&s.w.engine, &reply_event(&format!("17900003{i:02}.000100"), user, &text)).await;
    }
    s.w.engine.drain().await;
    assert!(classifier.seen.lock().unwrap().is_empty());
    assert_eq!(runs_of(&s).len(), 2, "only the requester's explicit ask ran");
}
