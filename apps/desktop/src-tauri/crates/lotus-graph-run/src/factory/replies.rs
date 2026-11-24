//! Reply drafts and Send (CoS 9, ADR-0058).
//!
//! When a round pushed, the Judge drafts one reply per item a person wrote and a round summary
//! ([`draft_round`]); a failed or invalid Judge call falls back to plain template text, so a round
//! always has its drafts. Drafts live on the Factory PR's record: an item's `reply`, a round's
//! `summary`. The user edits them ([`edit_draft`]) and posts them with Send or Send all ([`send`]).
//! Send all also asks the reviewers whose items were addressed to review again. Under
//! `replies = "auto-addressed"` the watcher sends the addressed replies and the summary by itself;
//! question answers and declines always wait for Send.
//!
//! Everything posts as the user (`gh` login). Lotus never resolves a thread (the port has no such
//! writer) and never adds a reviewer: only people who left a review are asked again.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::alerts::Notifier;
use super::judge::{Judge, JudgeRequest, JudgeTask};
use super::slack_reply::{self, slack_key, SLACK_KEY};
use super::revision::{waits_for_you, PrEdits};
use super::{Fetched, PullRequests};
use crate::{
    untrusted, ChiefEntry, ChiefOfStaffLog, ChiefSignal, FactoryTicket, FeedbackItem, FeedbackLabel, FeedbackSource, GraphRunRecord, ItemStatus, PrWatch,
    RevisionRound, RoundEnd, RunStore,
};

/// A round summary's draft key is `summary:<round>`; an item's is its id.
pub const SUMMARY_KEY: &str = "summary:";

pub fn summary_key(round: u32) -> String {
    format!("{SUMMARY_KEY}{round}")
}

/// The built-in drafting instructions. The labelling prompt of `chief-of-staff.md` does not apply.
pub const DRAFT_PROMPT: &str = "You write replies on a pull request for its author. A revision round just pushed commits \
that answer the reviewers' feedback. For each item, write the author's short reply to its reviewer: what was done, or, for \
an item that was declined or is not done yet, why, politely and plainly. Then write a short summary comment of the round \
for the whole PR. Write as the author, in the first person, in the reviewer's language. Do not mention the person (Lotus \
adds that), do not thank at length, do not promise what the round did not do, and never say the change is ready to merge. \
One reply per item, by its id. Do not change any file.";

/// The JSON a drafting call replies with.
pub fn draft_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["replies", "summary"],
        "properties": {
            "replies": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "text"],
                    "properties": { "id": { "type": "string" }, "text": { "type": "string" } }
                }
            },
            "summary": { "type": "string" }
        }
    })
}

/// The items of `round` that get a reply: what a person wrote and the round worked on. CI gets none:
/// the summary says how it went.
fn replied_items<'a>(watch: &'a PrWatch, round: &RevisionRound) -> Vec<&'a FeedbackItem> {
    watch
        .feedback
        .iter()
        .filter(|i| round.items.contains(&i.id) && i.source != FeedbackSource::Check)
        .filter(|i| matches!(i.status, ItemStatus::Addressed | ItemStatus::NotAddressed | ItemStatus::Declined))
        .collect()
}

fn status_text(status: ItemStatus) -> &'static str {
    match status {
        ItemStatus::Addressed => "addressed",
        ItemStatus::Declined => "declined by the author",
        _ => "not done yet",
    }
}

/// The round and its items for the Judge, each person's text fenced as data.
pub fn draft_context(ticket: &FactoryTicket, watch: &PrWatch, round: &RevisionRound, items: &[&FeedbackItem]) -> String {
    let nonce = untrusted::nonce();
    let mut out = format!(
        "{}\n\nThe pull request: {}\nIts ticket: {}\nRound {} pushed: {}\n\nThe items of the round:\n",
        untrusted::rule(&nonce),
        watch.url,
        ticket.title.replace('\n', " "),
        round.round,
        round.note.as_deref().unwrap_or("its commits are on the PR branch"),
    );
    for item in items {
        let place = match (&item.path, item.line) {
            (Some(path), Some(line)) => format!(" on {path}:{line}"),
            _ => String::new(),
        };
        out.push_str(&format!("\nItem id `{}`, by {}{place}, {}:\n", item.id, item.author, status_text(item.status)));
        out.push_str(&untrusted::fence("pr-feedback", &item.body, &nonce));
        if let Some(why) = item.why.as_deref().filter(|w| !w.is_empty()) {
            out.push_str(&format!("\nWhat the round says about it:\n{}", untrusted::fence("round-note", why, &nonce)));
        }
        out.push('\n');
    }
    let ci = watch.feedback.iter().filter(|i| round.items.contains(&i.id) && i.source == FeedbackSource::Check).count();
    if ci > 0 {
        out.push_str(&format!("\nThe round also worked on {ci} failing CI check{}: mention it in the summary only.\n", if ci == 1 { "" } else { "s" }));
    }
    out
}

/// The reply as `id → text` and the summary. An id that was not asked is an error; a missing one
/// gets the template.
pub fn parse_drafts(reply: &Value, ids: &[&str]) -> Result<(HashMap<String, String>, String), String> {
    let replies = reply["replies"].as_array().ok_or("the reply has no replies list")?;
    let mut out = HashMap::new();
    for r in replies {
        let id = r["id"].as_str().ok_or("a reply has no id")?;
        if !ids.contains(&id) {
            return Err(format!("the reply drafts \"{id}\", which was not asked"));
        }
        let text = r["text"].as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or_else(|| format!("{id} has no text"))?;
        out.insert(id.to_string(), text.to_string());
    }
    let summary = reply["summary"].as_str().map(str::trim).filter(|t| !t.is_empty()).ok_or("the reply has no summary")?;
    Ok((out, summary.to_string()))
}

/// The plain reply when the Judge gave none.
pub fn template_reply(item: &FeedbackItem, round: u32) -> String {
    let why = item.why.as_deref().map(str::trim).filter(|w| !w.is_empty());
    match (item.status, why) {
        (ItemStatus::Addressed, _) => format!("Done in round {round}."),
        (ItemStatus::Declined, Some(why)) => format!("I left this as it is: {why}."),
        (ItemStatus::Declined, None) => "I left this as it is.".into(),
        (_, Some(why)) => format!("Not done yet: {why}."),
        (_, None) => "Not done yet.".into(),
    }
}

/// The plain round summary when the Judge gave none.
pub fn template_summary(watch: &PrWatch, round: &RevisionRound) -> String {
    let items: Vec<&FeedbackItem> = watch.feedback.iter().filter(|i| round.items.contains(&i.id)).collect();
    let n = |status: ItemStatus| items.iter().filter(|i| i.status == status).count();
    let mut parts = vec![format!("{} addressed", n(ItemStatus::Addressed))];
    if n(ItemStatus::Declined) > 0 {
        parts.push(format!("{} declined", n(ItemStatus::Declined)));
    }
    if n(ItemStatus::NotAddressed) > 0 {
        parts.push(format!("{} not done yet", n(ItemStatus::NotAddressed)));
    }
    format!("Round {} is pushed: {} of {} items.", round.round, parts.join(", "), items.len())
}

/// Drafts the replies and summary of round index `at`, which pushed. Returns why the Judge's
/// drafts were not used, if they were not.
pub async fn draft_round(judge: Option<&dyn Judge>, ticket: &FactoryTicket, watch: &mut PrWatch, at: usize) -> Option<String> {
    let round = watch.rounds[at].clone();
    let items = replied_items(watch, &round);
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let drafted = match judge {
        None => Err("no Judge is set up".to_string()),
        Some(judge) => {
            let asked: Vec<&str> = ids.iter().map(String::as_str).collect();
            let request = JudgeRequest { task: JudgeTask::Draft, ticket: ticket.clone(), items: ids.clone(), context: draft_context(ticket, watch, &round, &items), schema: draft_schema() };
            match judge.judge(request).await {
                Ok(reply) => parse_drafts(&reply, &asked).map_err(|why| format!("the Judge's drafts were not valid: {why}")),
                Err(why) => Err(format!("the Judge failed: {why}")),
            }
        }
    };
    let (mut texts, summary, fallback) = match drafted {
        Ok((texts, summary)) => (texts, Some(summary), None),
        Err(why) => (HashMap::new(), None, Some(why)),
    };
    for item in watch.feedback.iter_mut().filter(|i| ids.contains(&i.id)) {
        item.reply = Some(texts.remove(&item.id).unwrap_or_else(|| template_reply(item, round.round)));
        item.reply_sent = None;
    }
    let summary = summary.unwrap_or_else(|| template_summary(watch, &round));
    let round = &mut watch.rounds[at];
    (round.summary, round.summary_sent, round.drafted) = (Some(summary), None, true);
    fallback
}

/// A round that pushed and has no drafts yet.
pub fn needs_drafts(watch: &PrWatch) -> bool {
    watch.rounds.iter().any(|r| r.ended == Some(RoundEnd::Pushed) && !r.drafted)
}

/// The drafts on the PR that wait for Send: item ids, summary keys, then Slack reply keys.
pub fn unsent(watch: &PrWatch) -> Vec<String> {
    let mut keys: Vec<String> = watch
        .feedback
        .iter()
        .filter(|i| i.counts && i.source != FeedbackSource::Check && i.reply_sent.is_none() && i.reply.as_deref().is_some_and(|r| !r.trim().is_empty()))
        .map(|i| i.id.clone())
        .collect();
    keys.extend(watch.rounds.iter().filter(|r| r.summary_sent.is_none() && r.summary.as_deref().is_some_and(|s| !s.trim().is_empty())).map(|r| summary_key(r.round)));
    keys.extend(
        watch.rounds.iter().filter(|r| r.slack.as_ref().is_some_and(|s| s.sent.is_none() && !s.text.trim().is_empty())).map(|r| slack_key(r.round)),
    );
    keys
}

/// Something on the PR waits for the user: feedback to decide, or a draft to send.
pub fn waits_on_you(watch: &PrWatch) -> bool {
    watch.feedback.iter().any(|i| i.counts && waits_for_you(i.status)) || !unsent(watch).is_empty()
}

/// Sets the text of draft `key` as the user edited it. Empty text discards the draft. A question
/// gets its answer this way: the Judge cannot read the code, so it never answers one.
pub async fn edit_draft(store: &dyn RunStore, edits: &PrEdits, run_id: &str, key: &str, text: &str) -> Result<GraphRunRecord, String> {
    let _held = edits.lock().await;
    let mut record = store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let watch = record.checkpoint.engine.as_mut().and_then(|m| m.pr_watch.as_mut()).ok_or("the Chief of Staff has not looked at the PR yet")?;
    if watch.phase.is_ended() {
        return Err("the PR is merged or closed".into());
    }
    let text = Some(text.trim().to_string()).filter(|t| !t.is_empty());
    if let Some(round) = key.strip_prefix(SLACK_KEY) {
        let reply = watch.rounds.iter_mut().find(|r| r.round.to_string() == round).and_then(|r| r.slack.as_mut()).ok_or_else(|| format!("round {round} has no Slack reply"))?;
        if reply.sent.is_some() {
            return Err("this Slack reply was sent already".into());
        }
        reply.text = text.unwrap_or_default();
    } else if let Some(round) = key.strip_prefix(SUMMARY_KEY) {
        let round = watch.rounds.iter_mut().find(|r| r.round.to_string() == round).ok_or_else(|| format!("the PR has no round {round}"))?;
        if round.summary_sent.is_some() {
            return Err("this summary was sent already".into());
        }
        round.summary = text;
    } else {
        let item = watch.feedback.iter_mut().find(|i| i.id == key).ok_or_else(|| format!("the PR has no feedback item {key}"))?;
        if !item.counts || item.source == FeedbackSource::Check {
            return Err("only a reviewer's comment gets a reply".into());
        }
        if item.reply_sent.is_some() {
            return Err("this reply was sent already".into());
        }
        item.reply = text;
    }
    store.save(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// What [`send`] posts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    /// One draft: an item id or a summary key. No re-request.
    One(String),
    /// Every draft that waits, then the re-request for every round not asked yet.
    All,
    /// `replies = "auto-addressed"` after round N: its addressed replies, its summary, its Slack
    /// reply, its re-request.
    Auto(u32),
}

/// What one [`send`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sent {
    pub posted: Vec<String>,
    pub rerequested: Vec<String>,
}

/// The PR a record watches: account, repo, number.
fn target(record: &GraphRunRecord) -> Result<(String, String, u64), String> {
    let meta = record.checkpoint.engine.as_ref().ok_or("the run has no engine data")?;
    let ticket = meta.factory.as_ref().ok_or("the run is not a Factory Run")?;
    let watch = meta.pr_watch.as_ref().ok_or("the Chief of Staff has not looked at the PR yet")?;
    if watch.phase.is_ended() || meta.pr.is_some() {
        return Err("the PR is merged or closed".into());
    }
    Ok((ticket.account.clone(), ticket.repo.clone(), watch.number))
}

/// Posts drafts as the user, then (for All and Auto) asks the reviewers whose items were addressed
/// to review again. Each post is saved as sent before the next, so a failure never sends one twice.
/// A Slack reply goes through `slack`; without it a Slack draft cannot be sent.
#[allow(clippy::too_many_arguments)]
pub async fn send(store: &dyn RunStore, prs: &dyn PullRequests, slack: Option<&dyn Notifier>, edits: &PrEdits, run_id: &str, what: Outgoing, footer: Option<&str>, now: i64) -> Result<(GraphRunRecord, Sent), String> {
    let _held = edits.lock().await;
    send_held(store, prs, slack, run_id, what, footer, now).await
}

/// [`send`] with [`PrEdits`] already held by the caller (the watcher's auto-send).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_held(store: &dyn RunStore, prs: &dyn PullRequests, slack: Option<&dyn Notifier>, run_id: &str, what: Outgoing, footer: Option<&str>, now: i64) -> Result<(GraphRunRecord, Sent), String> {
    let mut record = store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let (account, repo, number) = target(&record)?;
    let watch = record.checkpoint.engine.as_ref().and_then(|m| m.pr_watch.as_ref()).ok_or("the PR is not watched")?;
    let waiting = unsent(watch);
    let keys: Vec<String> = match &what {
        Outgoing::One(key) if waiting.contains(key) => vec![key.clone()],
        Outgoing::One(key) => return Err(format!("no draft of {key} waits to be sent")),
        Outgoing::All => waiting,
        Outgoing::Auto(n) => {
            let round = watch.rounds.iter().find(|r| r.round == *n).ok_or_else(|| format!("the PR has no round {n}"))?;
            waiting
                .into_iter()
                .filter(|k| *k == summary_key(*n) || *k == slack_key(*n) || watch.feedback.iter().any(|i| i.id == *k && round.items.contains(&i.id) && i.status == ItemStatus::Addressed))
                .collect()
        }
    };
    let mut sent = Sent::default();
    let mut failed = None;
    for key in &keys {
        let watch = record.checkpoint.engine.as_ref().and_then(|m| m.pr_watch.as_ref()).ok_or("the PR is not watched")?;
        let posted = match key.starts_with(SLACK_KEY) {
            true => post_slack(slack, watch, key).await.map(|_| None),
            false => post(prs, &account, &repo, number, watch, key, footer).await.map(Some),
        };
        let posted = match posted {
            Ok(posted) => posted,
            Err(why) => {
                failed = Some(format!("Sending {key} failed: {why}"));
                break;
            }
        };
        let watch = record.checkpoint.engine.as_mut().and_then(|m| m.pr_watch.as_mut()).ok_or("the PR is not watched")?;
        watch.posted.extend(posted);
        mark_sent(watch, key, now);
        store.save(&record).map_err(|e| e.to_string())?;
        sent.posted.push(key.clone());
    }
    if failed.is_none() && !matches!(what, Outgoing::One(_)) {
        if let Err(why) = rerequest(prs, &account, &repo, number, &mut record, &what, now, &mut sent).await {
            failed = Some(format!("Asking for review again failed: {why}"));
        }
    }
    let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
    let still_waits = meta.pr_watch.as_ref().is_some_and(waits_on_you);
    let log = meta.chief.get_or_insert_with(ChiefOfStaffLog::default);
    if !sent.posted.is_empty() || !sent.rerequested.is_empty() {
        log.say(now, sent_note(&sent, matches!(what, Outgoing::Auto(_))));
    }
    if let Some(why) = &failed {
        raise(log, now, why.clone());
    } else if !still_waits {
        log.note(ChiefEntry { at: now, signal: Some(ChiefSignal::Feedback), raised: false, text: "Nothing waits for you: the replies are sent.".into() });
    }
    store.save(&record).map_err(|e| e.to_string())?;
    match failed {
        Some(why) => Err(why),
        None => Ok((record, sent)),
    }
}

/// Posts one draft and returns the feedback id the post will have. A line comment's reply goes
/// under its thread; a review's or PR comment's goes on the PR, quoting it; a summary goes on the PR.
async fn post(prs: &dyn PullRequests, account: &str, repo: &str, number: u64, watch: &PrWatch, key: &str, footer: Option<&str>) -> Result<String, String> {
    let with_footer = |text: &str| match footer {
        Some(footer) => format!("{}\n\n{footer}", text.trim()),
        None => text.trim().to_string(),
    };
    if let Some(round) = key.strip_prefix(SUMMARY_KEY) {
        let summary = watch.rounds.iter().find(|r| r.round.to_string() == round).and_then(|r| r.summary.clone()).ok_or("the summary is gone")?;
        return Ok(format!("comment:{}", prs.comment(account, repo, number, &with_footer(&summary)).await?));
    }
    let item = watch.feedback.iter().find(|i| i.id == key).ok_or("the item is gone")?;
    let reply = item.reply.clone().ok_or("the draft is gone")?;
    match item.id.strip_prefix("line:").and_then(|id| id.parse::<u64>().ok()) {
        Some(comment_id) => Ok(format!("line:{}", prs.reply_in_thread(account, repo, number, comment_id, &with_footer(&reply)).await?)),
        None => {
            let body = with_footer(&format!("{}\n\n@{} {}", quote(&item.body), item.author, reply.trim()));
            Ok(format!("comment:{}", prs.comment(account, repo, number, &body).await?))
        }
    }
}

/// Posts a round's Slack reply in its thread, as the user.
async fn post_slack(slack: Option<&dyn Notifier>, watch: &PrWatch, key: &str) -> Result<String, String> {
    let slack = slack.ok_or("Slack is not connected")?;
    let round = key.strip_prefix(SLACK_KEY).unwrap_or_default();
    let reply = watch.rounds.iter().find(|r| r.round.to_string() == round).and_then(|r| r.slack.as_ref()).ok_or("the Slack reply is gone")?;
    slack.reply_in_thread(&reply.thread, &slack_reply::outgoing(reply)).await
}

/// `> ` and the comment's first line, cut to 120 characters.
fn quote(body: &str) -> String {
    let first = body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let cut: String = first.chars().take(120).collect();
    format!("> {cut}{}", if cut.len() < first.len() { "…" } else { "" })
}

fn mark_sent(watch: &mut PrWatch, key: &str, now: i64) {
    if let Some(round) = key.strip_prefix(SLACK_KEY) {
        if let Some(reply) = watch.rounds.iter_mut().find(|r| r.round.to_string() == round).and_then(|r| r.slack.as_mut()) {
            reply.sent = Some(now);
        }
        return;
    }
    if let Some(round) = key.strip_prefix(SUMMARY_KEY) {
        if let Some(round) = watch.rounds.iter_mut().find(|r| r.round.to_string() == round) {
            round.summary_sent = Some(now);
        }
        return;
    }
    if let Some(item) = watch.feedback.iter_mut().find(|i| i.id == key) {
        item.reply_sent = Some(now);
        // An answered question needs nothing more.
        if item.label == Some(FeedbackLabel::Question) && waits_for_you(item.status) {
            item.status = ItemStatus::Addressed;
        }
    }
}

/// Asks again for review from the people whose review items the rounds addressed. Only reviewers:
/// never someone who only commented, never the PR's author, never someone new.
#[allow(clippy::too_many_arguments)]
async fn rerequest(prs: &dyn PullRequests, account: &str, repo: &str, number: u64, record: &mut GraphRunRecord, what: &Outgoing, now: i64, sent: &mut Sent) -> Result<(), String> {
    let watch = record.checkpoint.engine.as_ref().and_then(|m| m.pr_watch.as_ref()).ok_or("the PR is not watched")?;
    let rounds: Vec<u32> = watch
        .rounds
        .iter()
        .filter(|r| r.ended == Some(RoundEnd::Pushed) && r.rerequested.is_none())
        .filter(|r| match what {
            Outgoing::Auto(n) => r.round == *n,
            _ => true,
        })
        .map(|r| r.round)
        .collect();
    if rounds.is_empty() {
        return Ok(());
    }
    let mut reviewers: Vec<String> = Vec::new();
    for round in watch.rounds.iter().filter(|r| rounds.contains(&r.round)) {
        for item in watch.feedback.iter().filter(|i| round.items.contains(&i.id)) {
            let reviewed = matches!(item.source, FeedbackSource::Review | FeedbackSource::ReviewComment);
            if item.counts && reviewed && item.status == ItemStatus::Addressed && !reviewers.contains(&item.author) {
                reviewers.push(item.author.clone());
            }
        }
    }
    if !reviewers.is_empty() {
        let author = pr_author(prs, account, repo, number).await?;
        reviewers.retain(|r| *r != author);
    }
    if !reviewers.is_empty() {
        prs.request_review(account, repo, number, &reviewers).await?;
    }
    let watch = record.checkpoint.engine.as_mut().and_then(|m| m.pr_watch.as_mut()).ok_or("the PR is not watched")?;
    for round in watch.rounds.iter_mut().filter(|r| rounds.contains(&r.round)) {
        round.rerequested = Some(now);
    }
    sent.rerequested = reviewers;
    Ok(())
}

/// GitHub cannot ask the PR's author to review it: read who that is.
async fn pr_author(prs: &dyn PullRequests, account: &str, repo: &str, number: u64) -> Result<String, String> {
    match prs.get(account, &format!("repos/{repo}/pulls/{number}"), None).await? {
        Fetched::Changed { body, .. } => body["user"]["login"].as_str().map(str::to_string).ok_or_else(|| "the PR has no author".into()),
        Fetched::Unchanged => Err("GitHub sent no PR".into()),
    }
}

fn sent_note(sent: &Sent, auto: bool) -> String {
    let summaries = sent.posted.iter().filter(|k| k.starts_with(SUMMARY_KEY)).count();
    let slack = sent.posted.iter().filter(|k| k.starts_with(SLACK_KEY)).count();
    let replies = sent.posted.len() - summaries - slack;
    let mut parts = Vec::new();
    if replies > 0 {
        parts.push(format!("{replies} repl{}", if replies == 1 { "y" } else { "ies" }));
    }
    if summaries > 0 {
        parts.push(format!("{summaries} round summar{}", if summaries == 1 { "y" } else { "ies" }));
    }
    if slack > 0 {
        parts.push(format!("{slack} Slack repl{}", if slack == 1 { "y" } else { "ies" }));
    }
    let mut text = match parts.split_last() {
        None => "Sent nothing new".to_string(),
        Some((last, [])) => format!("Sent {last}"),
        Some((last, rest)) => format!("Sent {} and {last}", rest.join(", ")),
    };
    if auto {
        text.push_str(" by itself (replies = \"auto-addressed\")");
    }
    if !sent.rerequested.is_empty() {
        let names: Vec<String> = sent.rerequested.iter().map(|r| format!("@{r}")).collect();
        text.push_str(&format!("; asked {} to review again", names.join(", ")));
    }
    text.push('.');
    text
}

pub(crate) fn raise(log: &mut ChiefOfStaffLog, at: i64, text: String) {
    log.log.push(ChiefEntry { at, signal: Some(ChiefSignal::Feedback), raised: true, text });
    if !log.is_open(ChiefSignal::Feedback) {
        log.open.push(ChiefSignal::Feedback);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafts_must_name_asked_items_and_carry_a_summary() {
        let ok = json!({ "replies": [{ "id": "line:1", "text": " Renamed. " }], "summary": "Round 1 fixes the name." });
        let (texts, summary) = parse_drafts(&ok, &["line:1", "review:2"]).unwrap();
        assert_eq!((texts["line:1"].as_str(), summary.as_str()), ("Renamed.", "Round 1 fixes the name."));
        assert!(!texts.contains_key("review:2"), "a missing one gets the template");
        for (bad, why) in [
            (json!({ "replies": [{ "id": "x", "text": "a" }], "summary": "s" }), "not asked"),
            (json!({ "replies": [], "summary": " " }), "no summary"),
            (json!({ "replies": [{ "id": "line:1", "text": "" }], "summary": "s" }), "no text"),
        ] {
            assert!(parse_drafts(&bad, &["line:1"]).unwrap_err().contains(why));
        }
    }

    #[test]
    fn a_quote_is_the_first_line_cut_short() {
        assert_eq!(quote("\n  rename x  \nplease"), "> rename x");
        assert_eq!(quote(&"a".repeat(130)), format!("> {}…", "a".repeat(120)));
    }
}
