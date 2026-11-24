//! The Chief of Staff's Judge (ADR-0056, "Feedback Items and batching"): it labels each comment
//! of a closed batch as change, nit, question, spec-change or none, with a confidence.
//!
//! The Judge is one-shot: no session, no MCP, read-only, the whole context in every call, JSON out.
//! The app's adapter reads its preset, model and prompt from [`CHIEF_OF_STAFF_FILE`] at
//! `origin/<base>`. A CI failure is never sent to it: a rule labels it. A reply that is not valid,
//! or a label below [`CONFIDENT`], is unsure, and unsure goes to Needs you, never to an action.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::{untrusted, BoxFuture, FactoryTicket, FeedbackItem, FeedbackLabel};

/// The Chief of Staff's agent file, beside the five roles' files. It is not a stage role.
pub const CHIEF_OF_STAFF_FILE: &str = "chief-of-staff.md";
/// A label below this confidence is unsure.
pub const CONFIDENT: f64 = 0.7;

/// What a Judge call is for. The app puts different instructions first.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum JudgeTask {
    /// Label a closed batch's items ([`judge_schema`]).
    #[default]
    Label,
    /// Draft the replies and summary of a round that pushed ([`super::replies::draft_schema`]).
    Draft,
}

/// One Judge call.
#[derive(Debug, Clone, PartialEq)]
pub struct JudgeRequest {
    pub task: JudgeTask,
    /// The run's ticket: where its repo is checked out, and its base branch.
    pub ticket: FactoryTicket,
    /// The ids of the items to label, as the context names them.
    pub items: Vec<String>,
    /// The PR and the items, from [`judge_context`]. The adapter puts the agent's prompt first.
    pub context: String,
    /// [`judge_schema`]: the reply must validate against it.
    pub schema: Value,
}

pub trait Judge: Send + Sync {
    fn judge(&self, request: JudgeRequest) -> BoxFuture<Result<Value, String>>;
}

/// The built-in prompt, used when the repo has no [`CHIEF_OF_STAFF_FILE`] or it has no body.
pub const BUILT_IN_PROMPT: &str = "You are the Chief of Staff of a software factory. A reviewer or a teammate left feedback on a \
pull request the factory opened. Label each item by what it asks of the author:\n\
- change: the code must change.\n\
- nit: a small style or wording point; nice to fix, not required.\n\
- question: the reviewer asks something; it needs an answer, not a code change.\n\
- spec-change: the reviewer wants something the ticket's spec did not ask for, or wants the spec itself changed.\n\
- none: thanks, approval, or chat; nothing to do.\n\
Give each label a confidence from 0 to 1. Say less than 0.7 when you are not sure: a person then decides. \
Label every item once, by its id. Do not change any file.";

/// The JSON the Judge replies with.
pub fn judge_schema() -> Value {
    let labels: Vec<&str> = FeedbackLabel::ALL.iter().map(|l| l.name()).collect();
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["items"],
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "label", "confidence"],
                    "properties": {
                        "id": { "type": "string" },
                        "label": { "type": "string", "enum": labels },
                        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                        "why": { "type": "string" }
                    }
                }
            }
        }
    })
}

/// The PR and its items, each text fenced as data.
pub fn judge_context(ticket: &FactoryTicket, pr_url: &str, items: &[&FeedbackItem]) -> String {
    let nonce = untrusted::nonce();
    let mut out = format!(
        "{}\n\nThe pull request: {pr_url}\nIts ticket: {}\n\n",
        untrusted::rule(&nonce),
        ticket.title.replace('\n', " ")
    );
    out.push_str(&untrusted::fence("ticket", &ticket.body, &nonce));
    out.push_str("\n\nThe items to label:\n");
    for item in items {
        let place = match (&item.path, item.line) {
            (Some(path), Some(line)) => format!(" on {path}:{line}"),
            (Some(path), None) => format!(" on {path}"),
            _ => String::new(),
        };
        out.push_str(&format!("\nItem id `{}`, by {}{place}:\n", item.id, item.author));
        out.push_str(&untrusted::fence("pr-feedback", &item.body, &nonce));
        out.push('\n');
    }
    out
}

/// `instructions` (the agent file's body, or [`BUILT_IN_PROMPT`]) and then the context.
/// The instructions a call reads: labelling reads the repo's `chief-of-staff.md`; drafting reads
/// Lotus's own, whatever that file says (CoS 9).
pub fn task_instructions(task: JudgeTask, chief: &str) -> &str {
    match task {
        JudgeTask::Label => chief,
        JudgeTask::Draft => super::replies::DRAFT_PROMPT,
    }
}

pub fn judge_prompt(instructions: &str, context: &str) -> String {
    format!("{}\n\n{context}", instructions.trim())
}

/// The reply as `id → (label, confidence)`, only for the asked `ids`. Any break of the schema
/// is an error: the whole batch is then unsure.
pub fn parse_verdicts(reply: &Value, ids: &[&str]) -> Result<HashMap<String, (FeedbackLabel, f64)>, String> {
    let items = reply["items"].as_array().ok_or("the reply has no items list")?;
    let mut out = HashMap::new();
    for item in items {
        let id = item["id"].as_str().ok_or("an item has no id")?;
        if !ids.contains(&id) {
            return Err(format!("the reply labels \"{id}\", which was not asked"));
        }
        let name = item["label"].as_str().ok_or_else(|| format!("{id} has no label"))?;
        let label = FeedbackLabel::parse(name).ok_or_else(|| format!("{id}: \"{name}\" is not a label"))?;
        let confidence = item["confidence"].as_f64().filter(|c| (0.0..=1.0).contains(c)).ok_or_else(|| format!("{id}: the confidence is not 0 to 1"))?;
        if out.insert(id.to_string(), (label, confidence)).is_some() {
            return Err(format!("{id} is labelled twice"));
        }
    }
    if let Some(missing) = ids.iter().find(|id| !out.contains_key(**id)) {
        return Err(format!("{missing} has no label"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drafting_reads_lotuss_instructions_not_the_repos_labelling_prompt() {
        assert_eq!(task_instructions(JudgeTask::Label, "Label each comment."), "Label each comment.");
        assert!(task_instructions(JudgeTask::Draft, "Label each comment.").starts_with("You write replies on a pull request"));
    }

    #[test]
    fn a_reply_must_label_every_asked_item_once_and_nothing_else() {
        let ok = json!({ "items": [{ "id": "a", "label": "nit", "confidence": 0.9 }, { "id": "b", "label": "spec-change", "confidence": 0.4 }] });
        let got = parse_verdicts(&ok, &["a", "b"]).unwrap();
        assert_eq!(got["a"], (FeedbackLabel::Nit, 0.9));
        assert_eq!(got["b"], (FeedbackLabel::SpecChange, 0.4));
        let bad = [
            (json!("not an object"), "no items"),
            (json!({ "items": [{ "id": "a", "label": "nit", "confidence": 0.9 }] }), "b has no label"),
            (json!({ "items": [{ "id": "a", "label": "bug", "confidence": 0.9 }, { "id": "b", "label": "nit", "confidence": 1 }] }), "not a label"),
            (json!({ "items": [{ "id": "a", "label": "nit", "confidence": 2 }, { "id": "b", "label": "nit", "confidence": 1 }] }), "0 to 1"),
            (json!({ "items": [{ "id": "z", "label": "nit", "confidence": 1 }] }), "not asked"),
            (json!({ "items": [{ "id": "a", "label": "nit", "confidence": 1 }, { "id": "a", "label": "nit", "confidence": 1 }] }), "twice"),
        ];
        for (reply, why) in bad {
            let err = parse_verdicts(&reply, &["a", "b"]).unwrap_err();
            assert!(err.contains(why), "{err}");
        }
    }

    #[test]
    fn the_schema_lists_the_five_labels() {
        let schema = judge_schema();
        assert_eq!(schema["properties"]["items"]["items"]["properties"]["label"]["enum"], json!(["change", "nit", "question", "spec-change", "none"]));
    }
}
