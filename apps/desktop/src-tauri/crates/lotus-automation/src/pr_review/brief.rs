//! What a review tells the Slack thread it was asked in: a verdict and at most
//! two points for the author. Kept apart from the summary, which is for GitHub.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::github::{ReviewComment, Severity};

pub const MAX_POINTS: usize = 2;
pub const MAX_POINT_CHARS: usize = 120;
/// The reply's opening line, in the agent's own words.
pub const MAX_LEAD_CHARS: usize = 160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Verdict {
    LooksGood,
    Questions,
    ChangesNeeded,
}

impl Verdict {
    pub const ALL: [Verdict; 3] = [Verdict::LooksGood, Verdict::Questions, Verdict::ChangesNeeded];

    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::LooksGood => "looks-good",
            Verdict::Questions => "questions",
            Verdict::ChangesNeeded => "changes-needed",
        }
    }

    /// The least the findings allow: a blocker or should-fix needs changes, a question asks.
    /// The agent may be stricter (a finding on no line), never kinder.
    pub fn at_least(self, severities: &[Severity]) -> Verdict {
        let floor = if severities.iter().any(|s| matches!(s, Severity::Blocker | Severity::ShouldFix)) {
            Verdict::ChangesNeeded
        } else if severities.contains(&Severity::Question) {
            Verdict::Questions
        } else {
            Verdict::LooksGood
        };
        self.max(floor)
    }
}

impl PartialOrd for Verdict {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Verdict {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let rank = |v: &Verdict| Verdict::ALL.iter().position(|x| x == v);
        rank(self).cmp(&rank(other))
    }
}

/// The agent's `reply`, and what the reviewer edits before Send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Brief {
    pub verdict: Verdict,
    #[serde(default)]
    pub points: Vec<String>,
    /// One sentence that opens the Slack reply, fitting this round (`{lead}`); `None`: the
    /// template's own words only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
}

impl Brief {
    /// Too many or too long points are refused, as any schema breach is.
    pub fn check(&self) -> Result<(), String> {
        if self.points.len() > MAX_POINTS {
            return Err(format!("reply: at most {MAX_POINTS} points"));
        }
        if self.points.iter().any(|p| p.chars().count() > MAX_POINT_CHARS) {
            return Err(format!("reply: a point is longer than {MAX_POINT_CHARS} characters"));
        }
        if self.lead.as_ref().is_some_and(|l| l.chars().count() > MAX_LEAD_CHARS) {
            return Err(format!("reply: the lead is longer than {MAX_LEAD_CHARS} characters"));
        }
        Ok(())
    }

    /// Without one (drafts from before it, or an agent that left it out): the findings' own
    /// verdict, and the worst two comments' first sentences.
    pub fn from_comments(comments: &[ReviewComment]) -> Brief {
        let rank = |c: &&ReviewComment| c.severity.map_or(Severity::ALL.len(), |s| Severity::ALL.iter().position(|x| *x == s).unwrap_or(0));
        let mut worst: Vec<&ReviewComment> = comments.iter().collect();
        worst.sort_by_key(rank);
        Brief {
            verdict: Verdict::LooksGood,
            points: worst.iter().take(MAX_POINTS).map(|c| format!("{} (L{})", first_sentence(&c.body), c.line)).collect(),
            lead: None,
        }
    }
}

/// What a draft's thread reply says: its `reply` (else one made from its comments) with a verdict
/// no kinder than its findings, and the severities of every finding — inline and moved off the diff.
/// The one place the Slack reply and the draft view read it from, so they cannot disagree.
pub fn of_draft(content: &Value) -> (Brief, Vec<Severity>) {
    let comments: Vec<ReviewComment> = serde_json::from_value(content["comments"].clone()).unwrap_or_default();
    let mut severities = new_severities(content);
    // A re-review's earlier findings still open count as much as new ones.
    severities.extend(super::rereview::open_severities(content));
    let mut brief = serde_json::from_value::<Brief>(content["reply"].clone()).unwrap_or_else(|_| Brief::from_comments(&comments));
    brief.verdict = brief.verdict.at_least(&severities);
    (brief, severities)
}

/// The severities of what this review found itself: its comments, and those moved off the diff.
pub fn new_severities(content: &Value) -> Vec<Severity> {
    let comments: Vec<ReviewComment> = serde_json::from_value(content["comments"].clone()).unwrap_or_default();
    let mut severities: Vec<Severity> = comments.iter().filter_map(|c| c.severity).collect();
    severities.extend(serde_json::from_value::<Vec<Severity>>(content["off_diff_severities"].clone()).unwrap_or_default());
    severities
}

pub fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["verdict", "points"],
        "properties": {
            "verdict": { "type": "string", "enum": Verdict::ALL.map(Verdict::as_str) },
            "points": {
                "type": "array",
                "maxItems": MAX_POINTS,
                "items": { "type": "string", "maxLength": MAX_POINT_CHARS }
            },
            "lead": { "type": "string", "maxLength": MAX_LEAD_CHARS }
        }
    })
}

/// A reviewer's edit of the points keeps the agent's lead when the edit names none: the panel
/// edits verdict and points only.
pub fn keep_lead(mut edited: Brief, draft_reply: &Value) -> Brief {
    if edited.lead.is_none() {
        edited.lead = draft_reply["lead"].as_str().map(str::to_string);
    }
    edited
}

fn first_sentence(text: &str) -> &str {
    let text = text.trim();
    text.char_indices()
        .find(|&(i, c)| c == '.' && text[i + 1..].starts_with(char::is_whitespace))
        .map_or(text, |(i, _)| &text[..=i])
}
