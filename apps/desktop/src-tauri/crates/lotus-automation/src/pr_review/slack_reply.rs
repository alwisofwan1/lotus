//! One Slack reply per thread (ADR-0052 §8). A thread that asked for several PRs gets one message
//! covering all of them: a sent review's reply is held until every review of that thread is sent
//! or dismissed (and no review of it is still running), then the thread gets one message with
//! every held review. "Reply now" posts what is held without waiting. GitHub reviews stay one
//! per PR; only the Slack side is grouped.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::Value;

use crate::model::{Draft, DraftStatus};
use crate::slack::SlackApi;
use crate::store::Store;

/// The Slack threads a draft answers: its request's, and every thread that asked for the same
/// review while it ran. Deduplicated, request thread first.
pub fn threads_of(store: &Store, draft: &Draft) -> Vec<Value> {
    let others = store.run_slack_threads(&draft.run_id).unwrap_or_else(|e| {
        eprintln!("[automation] other Slack threads of run {}: {e}", draft.run_id);
        vec![]
    });
    let mut seen = BTreeSet::new();
    std::iter::once(draft.content["slack"].clone())
        .chain(others)
        .filter(|c| match (c["channel"].as_str(), c["thread_ts"].as_str()) {
            (Some(ch), Some(th)) if !ch.is_empty() && !th.is_empty() => seen.insert((ch.to_string(), th.to_string())),
            _ => false,
        })
        .collect()
}

/// The verdict a sent draft told its requester: an approval looks good and a change request needs
/// changes whatever the brief says; otherwise the brief's, no kinder than the findings.
pub fn sent_verdict(content: &Value) -> super::brief::Verdict {
    use super::brief::{of_draft, Verdict};
    if content["approved"] == Value::Bool(true) {
        Verdict::LooksGood
    } else if content["changes_requested"] == Value::Bool(true) {
        Verdict::ChangesNeeded
    } else {
        of_draft(content).0.verdict
    }
}

/// After `draft_id` was sent: the emoji the user chose for its verdict, on every Slack message
/// that asked for this review. Best effort: the review is sent whatever Slack says, and a name
/// Slack refuses is kept for the settings screen. Returns how many reactions were added.
pub async fn react_after_send(
    store: &Store,
    slack: Option<&dyn SlackApi>,
    settings: &crate::slack::ReactionSettings,
    draft_id: &str,
) -> usize {
    let Some(slack) = slack else { return 0 };
    let Ok(Some(draft)) = store.get_draft(draft_id) else { return 0 };
    if draft.status != DraftStatus::Sent {
        return 0;
    }
    let names = settings.get().for_sent(sent_verdict(&draft.content));
    if names.is_empty() {
        return 0;
    }
    let others = store.run_slack_threads(&draft.run_id).unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut added = 0;
    for context in std::iter::once(draft.content["slack"].clone()).chain(others) {
        let (Some(channel), Some(ts)) = (context["channel"].as_str(), context["message_ts"].as_str()) else { continue };
        if channel.is_empty() || ts.is_empty() || !seen.insert((channel.to_string(), ts.to_string())) {
            continue;
        }
        for name in &names {
            match slack.add_reaction(channel, ts, name).await {
                Ok(()) => added += 1,
                Err(e) => settings.note_error("add", name, &e),
            }
        }
    }
    added
}

/// The most a reply the reviewer edited may hold: Slack's advised message size.
pub const MAX_EDITED_CHARS: usize = 4_000;

/// The reviewer's own text for the request thread's message, checked.
pub fn check_edited(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("the Slack reply is empty".into());
    }
    if text.chars().count() > MAX_EDITED_CHARS {
        return Err(format!("the Slack reply is longer than {MAX_EDITED_CHARS} characters"));
    }
    Ok(text.to_string())
}

/// What the request thread will be told if a draft is sent now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// The one message, as Lotus renders it; `None` while other reviews still hold it back.
    pub text: Option<String>,
    /// Reviews of the thread not in this send: pending drafts and running runs.
    pub waiting: usize,
}

/// The request thread's message when `draft` (with `all`: its whole send group) is sent now,
/// with every reply already held there. A review not sent yet links its PR; at post time each
/// PR link becomes that review's link, so an edited text keeps them right.
pub fn preview(store: &Store, draft: &Draft, all: bool) -> Result<Preview, String> {
    let context = draft.content["slack"].clone();
    let (channel, thread) = thread_key(&context);
    if channel.is_empty() || thread.is_empty() {
        return Err("this review did not come from Slack".into());
    }
    let included = if all { send_group(store, draft) } else { vec![draft.id.clone()] };
    let (pending, running) = store.waiting_in_thread(channel, thread, "").map_err(|e| e.to_string())?;
    let waiting = pending.iter().filter(|id| !included.contains(id)).count() + running;
    if waiting > 0 {
        return Ok(Preview { text: None, waiting });
    }
    let mut list = store.held_slack_replies(channel, thread).map_err(|e| e.to_string())?;
    for id in &included {
        let d = store.get_draft(id).map_err(|e| e.to_string())?.ok_or("draft not found")?;
        list.push((d.id.clone(), context.clone(), d.content["url"].as_str().unwrap_or_default().to_string()));
    }
    Ok(Preview { text: Some(message(store, &list)?), waiting: 0 })
}

/// What happened to one thread's reply.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Thread {
    Replied,
    Waiting { sent: usize, total: usize },
    Failed(String),
}

/// After `draft_id` was sent to GitHub at `url` with "reply in thread": holds its reply in each of
/// its threads, and posts each thread's one message when nothing else there is still waiting.
/// Returns the outcome for the panel: `replied`, `replied in N threads`, `waiting: 1 of 2 sent`, or
/// `not replied: …`.
/// `edited`: the reviewer's text for the request thread's message, used if this send posts it.
pub async fn reply_after_send(
    store: &Store,
    slack: Option<&dyn SlackApi>,
    draft_id: &str,
    url: &str,
    edited: Option<&str>,
    now_ms: i64,
) -> String {
    let draft = match store.get_draft(draft_id) {
        Ok(Some(draft)) => draft,
        Ok(None) => return "not replied: draft not found".into(),
        Err(e) => return format!("not replied: {e}"),
    };
    let threads = threads_of(store, &draft);
    if threads.is_empty() {
        return "not replied: this review did not come from Slack".into();
    }
    let mut outcomes = Vec::new();
    for context in &threads {
        if let Err(e) = store.hold_slack_reply(draft_id, context, url, now_ms) {
            outcomes.push(Thread::Failed(e.to_string()));
            continue;
        }
        let own = (context["channel"] == draft.content["slack"]["channel"] && context["thread_ts"] == draft.content["slack"]["thread_ts"])
            .then_some(edited)
            .flatten();
        outcomes.push(flush(store, slack, thread_key(context), false, own, now_ms).await);
    }
    describe(&outcomes)
}

/// Posts every reply held in `draft_id`'s threads now, whatever is still waiting there.
pub async fn reply_now(store: &Store, slack: Option<&dyn SlackApi>, draft_id: &str, now_ms: i64) -> String {
    let threads = match store.held_threads_of(draft_id) {
        Ok(threads) => threads,
        Err(e) => return format!("not replied: {e}"),
    };
    if threads.is_empty() {
        return "not replied: nothing is waiting".into();
    }
    let mut outcomes = Vec::new();
    for (channel, thread) in &threads {
        outcomes.push(flush(store, slack, (channel.as_str(), thread.as_str()), true, None, now_ms).await);
    }
    describe(&outcomes)
}

/// A draft left the thread without a reply of its own (dismissed, or sent without "reply in
/// thread"): the replies it held up go out when nothing else is waiting.
pub async fn release(store: &Store, slack: Option<&dyn SlackApi>, draft: &Draft, now_ms: i64) {
    for context in threads_of(store, draft) {
        let key = thread_key(&context);
        if store.held_slack_replies(key.0, key.1).is_ok_and(|held| !held.is_empty()) {
            let _ = flush(store, slack, key, false, None, now_ms).await;
        }
    }
}

/// The pending review drafts that share a Slack thread with `draft`, itself included, oldest
/// first: what "Send all" sends.
pub fn send_group(store: &Store, draft: &Draft) -> Vec<String> {
    let mut ids = vec![draft.id.clone()];
    for context in threads_of(store, draft) {
        let (channel, thread) = thread_key(&context);
        if let Ok((pending, _)) = store.waiting_in_thread(channel, thread, &draft.id) {
            let pending: Vec<String> = pending
                .into_iter()
                .filter(|id| !ids.contains(id))
                .filter(|id| matches!(store.get_draft(id), Ok(Some(d)) if d.status == DraftStatus::Pending))
                .collect();
            ids.extend(pending);
        }
    }
    ids
}

fn thread_key(context: &Value) -> (&str, &str) {
    (context["channel"].as_str().unwrap_or_default(), context["thread_ts"].as_str().unwrap_or_default())
}

/// Posts the thread's one message when nothing is waiting there (or `force`), else says how
/// far it is. `edited` replaces the rendered message, its PR links turned into review links.
async fn flush(
    store: &Store,
    slack: Option<&dyn SlackApi>,
    (channel, thread): (&str, &str),
    force: bool,
    edited: Option<&str>,
    now_ms: i64,
) -> Thread {
    let held = match store.held_slack_replies(channel, thread) {
        Ok(held) => held,
        Err(e) => return Thread::Failed(e.to_string()),
    };
    if held.is_empty() {
        return Thread::Replied;
    }
    if !force {
        match store.waiting_in_thread(channel, thread, "") {
            Ok((pending, running)) if !pending.is_empty() || running > 0 => {
                return Thread::Waiting { sent: held.len(), total: held.len() + pending.len() + running };
            }
            Ok(_) => {}
            Err(e) => return Thread::Failed(e.to_string()),
        }
    }
    let Some(slack) = slack else { return Thread::Failed("Slack is not connected".into()) };
    let text = match edited {
        Some(edited) => with_review_links(store, edited, &held),
        None => match message(store, &held) {
            Ok(text) => text,
            Err(e) => return Thread::Failed(e),
        },
    };
    if let Err(e) = slack.post_reply(channel, thread, &text).await {
        return Thread::Failed(e);
    }
    let ids: Vec<String> = held.iter().map(|(id, _, _)| id.clone()).collect();
    if let Err(e) = store.mark_slack_replies_posted(channel, thread, &ids, now_ms) {
        eprintln!("[automation] Slack reply in {channel}/{thread} posted but not recorded: {e}");
    }
    // Earlier sends said "waiting": the Sent list now says what happened.
    for id in &ids {
        let _ = store.note_on_sent_draft(id, "slack_reply", Value::String("replied".into()));
    }
    Thread::Replied
}

/// One review: its usual reply, mention included. Several: the `slack-reply-group` shape, one
/// mention (the first requester's) and each review's `slack-reply-group-item` part, a blank line
/// between.
fn message(store: &Store, held: &[(String, Value, String)]) -> Result<String, String> {
    let mut parts = Vec::new();
    let mut style = None;
    for (id, _, url) in held {
        let draft = store.get_draft(id).map_err(|e| e.to_string())?.ok_or("draft not found")?;
        let style = style.get_or_insert_with(|| match store.get_automation(&draft.automation_id) {
            Ok(Some(automation)) => super::reply_style::ReplyStyle::of(&automation),
            _ => Default::default(),
        });
        parts.push((draft, url.clone(), style.clone()));
    }
    let requester = held[0].1["requester"].as_str();
    if let [(draft, url, style)] = parts.as_slice() {
        return Ok(crate::slack::thread_reply_text(&draft.subject, url, &draft.content, requester, style));
    }
    let mention = requester.filter(|u| !u.is_empty() && u.chars().all(|c| c.is_ascii_alphanumeric())).map(|u| format!("<@{u}>"));
    let reviews: Vec<String> =
        parts.iter().map(|(draft, url, style)| crate::slack::group_item_text(&draft.subject, url, &draft.content, style)).collect();
    // A round after the first for every PR in it: the group's re-review words, when the owner wrote some.
    let again = parts.iter().all(|(draft, _, _)| super::rereview::progress(&draft.content).is_some());
    Ok(parts[0].2.render_group(&mention.unwrap_or_default(), &reviews, again))
}

/// `<PR url|` → `<review url|` for each held review: a preview links PRs not yet reviewed on GitHub.
fn with_review_links(store: &Store, text: &str, held: &[(String, Value, String)]) -> String {
    let mut text = text.to_string();
    for (id, _, review_url) in held {
        if let Ok(Some(d)) = store.get_draft(id) {
            if let Some(pr_url) = d.content["url"].as_str().filter(|u| !u.is_empty() && *u != review_url) {
                text = text.replace(&format!("<{pr_url}|"), &format!("<{review_url}|"));
            }
        }
    }
    text
}

fn describe(outcomes: &[Thread]) -> String {
    if let Some(Thread::Waiting { sent, total }) = outcomes.iter().find(|o| matches!(o, Thread::Waiting { .. })) {
        return format!("waiting: {sent} of {total} sent");
    }
    let replied = outcomes.iter().filter(|o| **o == Thread::Replied).count();
    match (replied, outcomes.iter().find_map(|o| if let Thread::Failed(e) = o { Some(e) } else { None })) {
        (0, Some(e)) => format!("not replied: {e}"),
        (1, _) => "replied".into(),
        (n, _) => format!("replied in {n} threads"),
    }
}
