//! The emoji a review request in Slack shows for each state of its review, chosen by the user
//! (Connectors → Slack). Lotus reacts as the user, so these are the user's own reactions.
//!
//! An empty name turns that state's reaction off. `taken` is never empty: it is also the reaction
//! that asks for a review, so it is how Lotus tells its own echo from a request.

use std::sync::{Mutex, RwLock};

use serde::{Deserialize, Serialize};

use super::trigger::{QUEUED_REACTION, REVIEW_REACTION, SKIPPED_REACTION};
use crate::model::RunStatus;
use crate::pr_review::brief::Verdict;

/// The most emoji one verdict may add: a few say it, more is noise on someone's message.
pub const MAX_SENT_REACTIONS: usize = 5;

/// The emoji Lotus adds to the request message when the user sends a review, by the verdict sent.
/// Empty lists add nothing. Added only on Send (or auto mode's post), never on Discard, so they
/// say what the requester was actually told.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SentReactions {
    pub looks_good: Vec<String>,
    pub questions: Vec<String>,
    pub changes_needed: Vec<String>,
}

/// Slack emoji names (no colons), one per state. Empty = no reaction for that state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusReactions {
    /// Taken in hand; also the reaction by the user that asks for a review.
    pub taken: String,
    /// Waiting for a free review slot; taken off when the review starts.
    pub queued: String,
    /// The review runs; taken off when it ends.
    pub running: String,
    /// The review ended, with a draft or with nothing to report.
    pub done: String,
    /// The review failed or was stopped (quit, crash).
    pub failed: String,
    /// The review agent asks the user a question in the Inbox.
    pub asked: String,
    /// The review was skipped, such as a PR that moved while it waited.
    pub skipped: String,
    /// Added when the review is sent, by its verdict.
    pub sent: SentReactions,
}

impl Default for StatusReactions {
    /// What Lotus showed before the reactions could be chosen: 👀 ⏳ ⏭️, nothing else.
    fn default() -> Self {
        Self {
            taken: REVIEW_REACTION.into(),
            queued: QUEUED_REACTION.into(),
            running: String::new(),
            done: String::new(),
            failed: String::new(),
            asked: String::new(),
            skipped: SKIPPED_REACTION.into(),
            sent: SentReactions::default(),
        }
    }
}

impl StatusReactions {
    fn fields(&self) -> [(&'static str, &String); 7] {
        [
            ("taken", &self.taken),
            ("queued", &self.queued),
            ("running", &self.running),
            ("done", &self.done),
            ("failed", &self.failed),
            ("asked", &self.asked),
            ("skipped", &self.skipped),
        ]
    }

    fn fields_mut(&mut self) -> [&mut String; 7] {
        [
            &mut self.taken,
            &mut self.queued,
            &mut self.running,
            &mut self.done,
            &mut self.failed,
            &mut self.asked,
            &mut self.skipped,
        ]
    }

    /// The same reactions, written the way Slack names them, or why they cannot be used.
    ///
    /// Each name loses its surrounding spaces and colons (`:eyes:` → `eyes`) and is lower-cased.
    /// Names must differ from each other: Lotus takes a state's reaction off by name, and its own
    /// `taken` reaction would read as a new request if another state used it.
    pub fn normalized(&self) -> Result<Self, String> {
        let mut out = self.clone();
        for name in out.fields_mut() {
            *name = clean(name);
        }
        let mut seen: Vec<(&str, &str)> = Vec::new();
        for (state, name) in out.fields() {
            if name.is_empty() {
                if state == "taken" {
                    return Err("The \"taken in hand\" reaction cannot be empty: it is also how you ask for a review.".into());
                }
                continue;
            }
            check_name(name)?;
            if let Some((other, _)) = seen.iter().find(|(_, n)| *n == name.as_str()) {
                return Err(format!(":{name}: is used for both \"{other}\" and \"{state}\". Each state needs its own emoji."));
            }
            seen.push((state, name.as_str()));
        }
        // Unlike the states, a sent emoji may repeat another state's: nothing takes it off again.
        for (label, list) in [
            ("Looks good", &mut out.sent.looks_good),
            ("Questions", &mut out.sent.questions),
            ("Changes needed", &mut out.sent.changes_needed),
        ] {
            let mut kept: Vec<String> = Vec::new();
            for name in list.iter().map(|n| clean(n)).filter(|n| !n.is_empty()) {
                check_name(&name)?;
                if !kept.contains(&name) {
                    kept.push(name);
                }
            }
            if kept.len() > MAX_SENT_REACTIONS {
                return Err(format!("\"{label}\" has {} emoji; use at most {MAX_SENT_REACTIONS}.", kept.len()));
            }
            *list = kept;
        }
        Ok(out)
    }

    /// The emoji to add when a review with `verdict` is sent. Never the `taken` one: it is on the
    /// message already, and Lotus adding it again would read as a new request.
    pub fn for_sent(&self, verdict: Verdict) -> Vec<String> {
        let list = match verdict {
            Verdict::LooksGood => &self.sent.looks_good,
            Verdict::Questions => &self.sent.questions,
            Verdict::ChangesNeeded => &self.sent.changes_needed,
        };
        list.iter().filter(|n| !n.is_empty() && **n != self.taken).cloned().collect()
    }

    /// The reaction for a review that ended with `status`; empty when there is none.
    pub fn for_finish(&self, status: RunStatus, quiet: bool) -> &str {
        match status {
            // Nothing to report is a finished review, not a skipped one.
            RunStatus::Skipped if quiet => &self.done,
            RunStatus::Skipped => &self.skipped,
            RunStatus::Succeeded => &self.done,
            RunStatus::Failed | RunStatus::Interrupted => &self.failed,
            RunStatus::Asked => &self.asked,
            RunStatus::Queued | RunStatus::Running => "",
        }
    }
}

/// A name the way Slack writes it: no surrounding spaces or colons (`:Eyes:` → `eyes`), lower case.
fn clean(name: &str) -> String {
    name.trim().trim_matches(':').trim().to_lowercase()
}

fn check_name(name: &str) -> Result<(), String> {
    if name.len() > 100 || !name.chars().all(|c| c.is_ascii_alphanumeric() || "_+-':".contains(c)) {
        return Err(format!(":{name}: is not a Slack emoji name. Use the name Slack shows, such as eyes or white_check_mark."));
    }
    Ok(())
}

/// The reactions in use, shared by the Slack session and the settings screen, so a change
/// applies to the next review without reconnecting. Also keeps the last reaction Slack refused,
/// because a name Slack does not know fails only when it is used.
#[derive(Debug, Default)]
pub struct ReactionSettings {
    current: RwLock<StatusReactions>,
    last_error: Mutex<Option<String>>,
}

impl ReactionSettings {
    pub fn new(reactions: StatusReactions) -> Self {
        Self { current: RwLock::new(reactions), last_error: Mutex::new(None) }
    }

    pub fn get(&self) -> StatusReactions {
        self.current.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Uses `reactions` from now on, and forgets the last error: it may be about a name now gone.
    pub fn set(&self, reactions: StatusReactions) {
        *self.current.write().unwrap_or_else(|p| p.into_inner()) = reactions;
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Records that Slack refused to add or take off `:name:`.
    pub fn note_error(&self, verb: &str, name: &str, error: &str) {
        eprintln!("[automation] could not {verb} :{name}: in Slack: {error}");
        let text = if error.contains("invalid_name") {
            format!("Slack does not know :{name}:. Check the name in Slack's emoji picker.")
        } else {
            format!("Could not {verb} :{name}: in Slack: {error}")
        };
        *self.last_error.lock().unwrap_or_else(|p| p.into_inner()) = Some(text);
    }
}
