//! The Slack thread reply to the reviewers (CoS 12, ADR-0058): after a round pushed, "Round N is
//! pushed: 2 fixed, 1 answered. Could you re-review?" in the Slack thread where the PR's link was
//! shared, posted as the user with Send all (or by itself under `replies = "auto-addressed"`).
//!
//! No thread shares the PR: no Slack message, never a cold DM. A reviewer is mentioned by their
//! Slack member ID, which Lotus asks the user once per GitHub login ([`remember_identity`]) and
//! keeps in [`SlackIdentities`]; until then the reply mentions no one.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use super::alerts::Notifier;
use super::replies::raise;
use super::revision::PrEdits;
use crate::{ChiefOfStaffLog, FeedbackLabel, FeedbackSource, ItemStatus, PrWatch, RunStore, SlackMention, SlackReply};

/// A round's Slack reply has the draft key `slack:<round>`.
pub const SLACK_KEY: &str = "slack:";

pub fn slack_key(round: u32) -> String {
    format!("{SLACK_KEY}{round}")
}

/// GitHub login → Slack member ID, as the user said.
pub trait SlackIdentities: Send + Sync {
    fn get(&self, github: &str) -> Option<String>;
    fn remember(&self, github: &str, slack: &str) -> Result<(), String>;
}

/// [`SlackIdentities`] in one JSON file (`{ "login": "U…" }`).
pub struct FileSlackIdentities {
    path: PathBuf,
    write: Mutex<()>,
}

impl FileSlackIdentities {
    pub fn new(path: PathBuf) -> Self {
        Self { path, write: Mutex::new(()) }
    }

    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read_to_string(&self.path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
    }
}

impl SlackIdentities for FileSlackIdentities {
    fn get(&self, github: &str) -> Option<String> {
        self.read().remove(&github.to_lowercase())
    }

    fn remember(&self, github: &str, slack: &str) -> Result<(), String> {
        let _held = self.write.lock().unwrap_or_else(|p| p.into_inner());
        let mut all = self.read();
        all.insert(github.to_lowercase(), slack.to_string());
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

/// The question a Needs-you item asks for an unknown reviewer.
pub fn who_is(github: &str) -> String {
    format!("Who is GitHub @{github} on Slack? The Slack reply mentions no one until you say.")
}

/// "Round 2 is pushed: 2 fixed, 1 answered, 1 left as is. Could you re-review?"
fn round_text(watch: &PrWatch, at: usize) -> String {
    let round = &watch.rounds[at];
    let items: Vec<_> = watch.feedback.iter().filter(|i| round.items.contains(&i.id)).collect();
    let n = |f: &dyn Fn(&&crate::FeedbackItem) -> bool| items.iter().filter(|i| f(i)).count();
    let answered = n(&|i| i.status == ItemStatus::Addressed && i.label == Some(FeedbackLabel::Question));
    let fixed = n(&|i| i.status == ItemStatus::Addressed) - answered;
    let mut parts = vec![format!("{fixed} fixed")];
    for (count, what) in [(answered, "answered"), (n(&|i| i.status == ItemStatus::Declined), "left as is"), (n(&|i| i.status == ItemStatus::NotAddressed), "not done yet")] {
        if count > 0 {
            parts.push(format!("{count} {what}"));
        }
    }
    format!("Round {} is pushed: {}. Could you re-review?", round.round, parts.join(", "))
}

/// The people round index `at` asks again: authors of the review items it addressed.
fn reviewers(watch: &PrWatch, at: usize) -> Vec<String> {
    let round = &watch.rounds[at];
    let mut out: Vec<String> = Vec::new();
    for item in watch.feedback.iter().filter(|i| round.items.contains(&i.id)) {
        let reviewed = matches!(item.source, FeedbackSource::Review | FeedbackSource::ReviewComment);
        if item.counts && reviewed && item.status == ItemStatus::Addressed && !out.contains(&item.author) {
            out.push(item.author.clone());
        }
    }
    out
}

/// What [`draft`] found, for the log.
pub enum Drafted {
    /// The round asks no reviewer again: nothing to say on Slack.
    NoReviewer,
    NoThread,
    Failed(String),
    /// Drafted; these logins have no Slack member ID yet.
    Ready { unknown: Vec<String> },
}

/// Drafts the Slack reply of round index `at`, which pushed.
pub async fn draft(notifier: &dyn Notifier, identities: &dyn SlackIdentities, watch: &mut PrWatch, at: usize) -> Drafted {
    let people = reviewers(watch, at);
    if people.is_empty() {
        return Drafted::NoReviewer;
    }
    let thread = match notifier.find_thread(&watch.url).await {
        Ok(Some(thread)) => thread,
        Ok(None) => return Drafted::NoThread,
        Err(why) => return Drafted::Failed(why),
    };
    let mention: Vec<SlackMention> = people.into_iter().map(|github| SlackMention { slack: identities.get(&github), github }).collect();
    let unknown = mention.iter().filter(|m| m.slack.is_none()).map(|m| m.github.clone()).collect();
    watch.rounds[at].slack = Some(SlackReply { thread, text: round_text(watch, at), mention, sent: None });
    Drafted::Ready { unknown }
}

/// Logs what [`draft`] found on the run. Returns the reviewers to ask about ([`ask_who`]).
pub fn log_drafted(log: &mut ChiefOfStaffLog, now: i64, round: u32, drafted: Drafted) -> Vec<String> {
    match drafted {
        Drafted::NoReviewer => {}
        Drafted::NoThread => log.say(now, "No Slack thread shares this PR: no Slack message."),
        // Raised: a round's Slack reply is drafted once, so the user hears of the miss.
        Drafted::Failed(why) => raise(log, now, format!("Round {round}: no Slack reply, the Slack search failed: {why}.")),
        Drafted::Ready { unknown } => return unknown,
    }
    Vec::new()
}

/// One Needs-you item per reviewer with no Slack member ID, asked once per PR.
pub fn ask_who(log: &mut ChiefOfStaffLog, now: i64, unknown: &[String]) {
    for github in unknown {
        let question = who_is(github);
        if !log.log.iter().any(|e| e.text == question) {
            raise(log, now, question);
        }
    }
}

/// The text Lotus posts: the known mentions, then the draft.
pub fn outgoing(reply: &SlackReply) -> String {
    let known: Vec<String> = reply.mention.iter().filter_map(|m| m.slack.as_ref()).map(|id| format!("<@{id}>")).collect();
    if known.is_empty() { reply.text.trim().to_string() } else { format!("{} {}", known.join(" "), reply.text.trim()) }
}

/// A Slack member ID from what the user typed: `U07ABC`, `W07ABC` or `<@U07ABC>`.
pub fn member_id(answer: &str) -> Result<String, String> {
    let id = answer.trim().trim_start_matches("<@").trim_end_matches('>');
    let id = id.split('|').next().unwrap_or_default().trim();
    let ok = id.len() >= 3 && (id.starts_with('U') || id.starts_with('W')) && id.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
    if ok { Ok(id.to_string()) } else { Err(format!("\"{}\" is no Slack member ID (like U07ABC123): Slack profile → ⋮ → Copy member ID", answer.trim())) }
}

/// The user's answer to "Who is GitHub @x on Slack?": remembered, and put into every Slack reply
/// that waits. Returns the ids of the runs it changed.
pub async fn remember_identity(store: &dyn RunStore, edits: &PrEdits, identities: &dyn SlackIdentities, github: &str, answer: &str, now: i64) -> Result<Vec<String>, String> {
    let id = member_id(answer)?;
    identities.remember(github, &id)?;
    let _held = edits.lock().await;
    let mut changed = Vec::new();
    for mut record in store.list_completed().map_err(|e| e.to_string())? {
        let Some(meta) = record.checkpoint.engine.as_mut() else { continue };
        let Some(watch) = meta.pr_watch.as_mut() else { continue };
        let mut patched = false;
        for reply in watch.rounds.iter_mut().filter_map(|r| r.slack.as_mut()).filter(|s| s.sent.is_none()) {
            for m in reply.mention.iter_mut().filter(|m| m.github.eq_ignore_ascii_case(github)) {
                m.slack = Some(id.clone());
                patched = true;
            }
        }
        if !patched {
            continue;
        }
        meta.chief.get_or_insert_with(ChiefOfStaffLog::default).say(now, format!("GitHub @{github} is <@{id}> on Slack."));
        store.save(&record).map_err(|e| e.to_string())?;
        changed.push(record.id.clone());
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member_id_is_read_from_what_slack_copies_or_a_mention() {
        assert_eq!(member_id(" U07ABC123 ").unwrap(), "U07ABC123");
        assert_eq!(member_id("<@W0XY|budi>").unwrap(), "W0XY");
        for bad in ["budi", "@budi", "u07abc", "C07ABC", ""] {
            assert!(member_id(bad).is_err(), "{bad}");
        }
    }
}
