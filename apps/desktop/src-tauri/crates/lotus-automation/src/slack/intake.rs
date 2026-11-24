//! What a reply in a known review thread is for (ADR-0059). The thread already names the PR, so a
//! reply that only mentions me would start a review even when it is a colleague's "LGTM @me" or
//! "Merged, thank you @team". Three stages, cheapest first:
//!
//! 1. facts: the thread's requester is the likely author; anyone else must ask in plain words;
//! 2. rules: multilingual phrases, a clear ask beats a clear "done", both beat a fix report;
//! 3. a cheap model, only when the rules are unsure, and only through a [`ReplyClassifier`].
//!
//! Pure except for the classifier port, so the rules are tested with real phrases.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent::{Access, AgentRequest, AgentRunner};
use crate::registry::BoxFuture;
use std::sync::Arc;

/// A model verdict below this does not start a review.
pub const MIN_CONFIDENCE: f32 = 0.75;

/// How long the model has to answer before the reply is left alone.
pub const MODEL_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    /// Asks for another look at the PR.
    RereviewRequest,
    /// Reports a review or an approval (LGTM, "I reviewed").
    ReviewDone,
    MergedOrClosed,
    Thanks,
    Discussion,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Facts,
    Rules,
    Model,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Facts => "facts",
            Source::Rules => "rules",
            Source::Model => "model",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Intake {
    pub intent: Intent,
    pub confidence: f32,
    pub reason: String,
    pub source: Source,
}

impl Intake {
    /// Whether this reply starts a new review round.
    pub fn starts_review(&self) -> bool {
        self.intent == Intent::RereviewRequest && self.confidence >= MIN_CONFIDENCE
    }

    fn new(intent: Intent, confidence: f32, reason: impl Into<String>, source: Source) -> Self {
        Self { intent, confidence, reason: reason.into(), source }
    }
}

/// A reply that has no PR link of its own, with what is known around it.
#[derive(Debug, Clone, Default)]
pub struct IntakeInput {
    pub text: String,
    /// Slack id of the reply's author.
    pub reply_author: String,
    /// GitHub logins of the PR authors, for the model.
    pub pr_authors: Vec<String>,
    /// Slack id of who asked for the review in this thread, when known.
    pub root_requester: Option<String>,
    pub mentions_me: bool,
    /// The thread's first message, short. Filled only when the model is asked.
    pub root_text: Option<String>,
    /// What Lotus last said in the thread. Filled only when the model is asked.
    pub last_lotus_reply: Option<String>,
    /// The delegation preset the automation reviews with; the model runs through it.
    pub preset_id: String,
}

impl IntakeInput {
    /// The thread's requester wrote it. Unknown requester: no evidence against, so yes.
    fn is_by_requester(&self) -> bool {
        self.root_requester.as_deref().is_none_or(|r| r == self.reply_author)
    }
}

/// Stages 1 and 2. `None`: the rules are unsure, and the model may be asked.
pub fn by_rules(input: &IntakeInput) -> Option<Intake> {
    if !input.mentions_me {
        return Some(Intake::new(Intent::Discussion, 1.0, "does not mention you or your team", Source::Facts));
    }
    let t = normalize(&input.text);
    if !input.is_by_requester() {
        // Someone else may be the PR's author (a co-author, a PR posted by a colleague), so this is
        // not hard-stopped: only an explicit ask counts, never the model and never a bare "fixed".
        // A reviewer's own "Reviewed! ... please check it" is a report, not a request.
        let report = merged_in(&t).or_else(|| done_in(&t)).or_else(|| feedback_given_in(&t));
        return Some(match (ask_in(&t), report) {
            (Some(ask), None) => Intake::new(
                Intent::RereviewRequest,
                1.0,
                format!("asks to review again ({ask}), though not the one who asked for the review"),
                Source::Rules,
            ),
            _ => Intake::new(
                Intent::Discussion,
                1.0,
                "written by someone who did not ask for the review, and no plain ask to review again",
                Source::Facts,
            ),
        });
    }
    if let Some(ask) = ask_in(&t) {
        return Some(Intake::new(Intent::RereviewRequest, 1.0, format!("asks to review again ({ask})"), Source::Rules));
    }
    if let Some(m) = merged_in(&t) {
        return Some(Intake::new(Intent::MergedOrClosed, 1.0, format!("says it is merged or closed ({m})"), Source::Rules));
    }
    if let Some(d) = done_in(&t) {
        return Some(Intake::new(Intent::ReviewDone, 1.0, format!("reports a finished review ({d})"), Source::Rules));
    }
    if let Some(f) = fixed_in(&t) {
        return Some(Intake::new(Intent::RereviewRequest, 0.9, format!("reports the feedback is handled ({f})"), Source::Rules));
    }
    if let Some(k) = thanks_in(&t) {
        return Some(Intake::new(Intent::Thanks, 1.0, format!("only thanks ({k})"), Source::Rules));
    }
    None
}

/// Stage 3: a model that reads what the rules could not. Errors mean "do nothing".
pub trait ReplyClassifier: Send + Sync {
    fn classify(&self, input: IntakeInput) -> BoxFuture<Result<Intake, String>>;
}

/// Lowercase, Slack markup (`<@U…>`, `<!subteam^…>`, `<https://…|label>`) turned into spaces.
fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_token = false;
    for c in text.chars() {
        match c {
            '<' => {
                in_token = true;
                out.push(' ');
            }
            '>' if in_token => in_token = false,
            _ if in_token => {}
            c => out.extend(c.to_lowercase()),
        }
    }
    out
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric()
}

/// `needle` in `text` with no letter or digit right before or after it.
fn has_word(text: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(at) = text[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let before = text[..start].chars().next_back().is_none_or(|c| !is_word_char(c));
        let after = text[end..].chars().next().is_none_or(|c| !is_word_char(c));
        if before && after {
            return true;
        }
        from = start + text[start..].chars().next().map_or(1, char::len_utf8);
    }
    false
}

fn first_phrase<'a>(text: &str, phrases: impl IntoIterator<Item = &'a str>) -> Option<String> {
    phrases.into_iter().find(|p| text.contains(p)).map(str::to_string)
}

fn first_word<'a>(text: &str, words: impl IntoIterator<Item = &'a str>) -> Option<String> {
    words.into_iter().find(|w| has_word(text, w)).map(str::to_string)
}

const ASK_WORDS: &[&str] = &["re-review", "rereview", "re review", "re-check", "recheck", "ptal", "re-reviewing"];
const ASK_LEADERS: &[&str] = &["please", "pls", "plz", "tolong", "mohon", "minta", "bantu", "coba", "kindly"];
const ASK_VERBS: &[&str] = &[
    "review", "direview", "di review", "cek", "dicek", "di cek", "check", "dicheck", "di check", "re-review", "recheck",
    "approve",
];
const ASK_AGAIN: &[&str] = &["again", "lagi", "ulang"];
const ASK_PHRASES: &[&str] = &[
    "ready for review", "ready for another", "ready for a re", "ready to be reviewed", "ready for your review",
    "take a look", "another look", "look again", "could you review", "could you please review", "could you give a review",
    "can you review", "help review", "help me review", "need another review", "review these", "review this pr again",
    "確認お願い", "レビューお願い", "再レビュー", "もう一度",
];

/// The explicit ask found in `t`, if any.
fn ask_in(t: &str) -> Option<String> {
    // "thanks for the re-check" thanks for a review that is over, it does not ask for another.
    let mut thanked = t.to_string();
    for lead in ["for the ", "for your ", "for this ", "for a "] {
        for word in ASK_WORDS {
            thanked = thanked.replace(&format!("{lead}{word}"), " ");
        }
    }
    let t = thanked.as_str();
    if let Some(w) = first_word(t, ASK_WORDS.iter().copied()) {
        return Some(w);
    }
    let leaders: Vec<String> = ASK_LEADERS
        .iter()
        .flat_map(|l| ASK_VERBS.iter().map(move |v| format!("{l} {v}")))
        .chain(ASK_VERBS.iter().flat_map(|v| ASK_AGAIN.iter().map(move |a| format!("{v} {a}"))))
        .collect();
    first_phrase(t, leaders.iter().map(String::as_str).chain(ASK_PHRASES.iter().copied()))
}

fn merged_in(t: &str) -> Option<String> {
    first_word(t, ["merge", "merged", "merging", "dimerge", "dimerged", "di-merge", "mergekan"]).or_else(|| {
        first_phrase(t, ["sudah di merge", "udah di merge", "close this pr", "closed this pr", "closing this pr", "pr is closed"])
    })
}

fn done_in(t: &str) -> Option<String> {
    first_word(t, ["lgtm", "lgmt", "approved", "approve", "approving", "approval", "re-reviewed", "rereviewed"]).or_else(|| {
        first_phrase(
            t,
            [
                "looks good", "look good", "i've reviewed", "i have reviewed", "i reviewed", "i just reviewed", "reviewed!",
                "reviewed both", "reviewed all", "reviewed and", "reviewed the pr", "sudah review", "udah review",
                "sudah direview", "udah direview", "sudah di review", "sudah dicek", "udah dicek", "sudah saya review",
                "good to merge", "ok to merge",
            ],
        )
    })
}

/// A reviewer handing back feedback: "I've feedback on", "left comments".
fn feedback_given_in(t: &str) -> Option<String> {
    first_phrase(t, ["i've feedback", "i have feedback", "i've left", "i left", "left a few comments", "left some comments", "comments on the pr", "requested changes", "changes requested"])
}

fn fixed_in(t: &str) -> Option<String> {
    first_word(t, ["fixed", "addressed", "resolved", "implemented", "applied", "updated", "revised", "difix", "diperbaiki"])
        .or_else(|| {
            first_phrase(
                t,
                [
                    "sudah fix", "udah fix", "sudah di fix", "sudah diperbaiki", "udah diperbaiki", "sudah diupdate", "udah diupdate",
                    "sudah direvisi", "sudah saya perbaiki", "replied to", "have replied", "i've replied",
                ],
            )
        })
}

fn thanks_in(t: &str) -> Option<String> {
    first_word(t, ["thanks", "thank", "thx", "tq", "makasih", "terima kasih", "matur nuwun", "arigato", "ありがとう"])
        .or_else(|| first_phrase(t, [":pray:", ":dogeza", ":bow:", ":man-bowing:"]))
}

/// The schema the model's reply must match.
fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "intent": { "type": "string", "enum": ["rereview_request", "review_done", "merged_or_closed", "thanks", "discussion", "other"] },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            "reason": { "type": "string" }
        },
        "required": ["intent", "confidence", "reason"],
        "additionalProperties": false
    })
}

fn clip(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn prompt(input: &IntakeInput) -> String {
    let side = if input.is_by_requester() { "the person who asked for the review in this thread" } else { "someone else" };
    format!(
        "A reply was posted in a Slack thread where a pull request is reviewed. It mentions the reviewer. \
Decide what the reply is for. Answer with rereview_request ONLY when the author of the PR asks the reviewer \
to look at the PR again (fixes are in, comments are answered, a question needs the reviewer's eyes). \
Reviews, approvals, LGTM, merge news, thanks and discussion are not requests.\n\n\
PR author(s) on GitHub: {authors}\n\
Reply written by: {side}\n\
Thread's first message: {root}\n\
Last thing the reviewer said in the thread: {last}\n\n\
Reply:\n{text}\n\n\
Set confidence from 0 to 1. Give one short reason.",
        authors = if input.pr_authors.is_empty() { "unknown".to_string() } else { input.pr_authors.join(", ") },
        root = input.root_text.as_deref().map_or("unknown".to_string(), |t| clip(t, 400)),
        last = input.last_lotus_reply.as_deref().map_or("nothing".to_string(), |t| clip(t, 400)),
        text = clip(&input.text, 1500),
    )
}

#[derive(Deserialize)]
struct ModelReply {
    intent: Intent,
    confidence: f32,
    reason: String,
}

/// A [`ReplyClassifier`] that asks an agent (sealed, no tools, schema-bound). The runner decides
/// the model: the host gives it presets that run a cheap one.
pub struct AgentClassifier {
    runner: Arc<dyn AgentRunner>,
}

impl AgentClassifier {
    pub fn new(runner: Arc<dyn AgentRunner>) -> Self {
        Self { runner }
    }
}

impl ReplyClassifier for AgentClassifier {
    fn classify(&self, input: IntakeInput) -> BoxFuture<Result<Intake, String>> {
        let request = AgentRequest {
            preset_id: input.preset_id.clone(),
            prompt: prompt(&input),
            schema: schema(),
            tools: vec![],
            access: Access::Sealed,
            session: None,
            workspace: None,
            repo: None,
            run_id: None,
            mcp_config: None,
            plugin_dirs: vec![],
        };
        let run = self.runner.run(request);
        Box::pin(async move {
            let reply = run.await?;
            let reply: ModelReply = serde_json::from_value(reply).map_err(|e| format!("the intake reply does not match its schema: {e}"))?;
            Ok(Intake::new(reply.intent, reply.confidence.clamp(0.0, 1.0), reply.reason, Source::Model))
        })
    }
}
