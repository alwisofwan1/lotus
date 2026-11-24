//! Answering an Automation Ask (PLAN §8, ADR-0040): the user's Answer is kept on the Ask and
//! starts one Follow-up Run of the same automation, which continues the asking run's work.

use serde_json::{json, Value};

use crate::engine::{Engine, Submitted};
use crate::model::{DraftStatus, ASK_KIND};
use crate::ports::{Clock, SystemClock};
use crate::store::Store;

/// The longest note an Answer may carry.
pub const ANSWER_NOTE_CHARS: usize = 4_000;
/// An Automation Ask: the question's length, and at most this many short choice labels (PLAN §8 Q2).
pub const ASK_QUESTION_CHARS: usize = 4_000;
pub const ASK_CHOICES: usize = 4;
pub const ASK_CHOICE_CHARS: usize = 40;

/// The `ask` an agent may reply with instead of its result, in every action kind's schema.
pub fn ask_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["question"],
        "properties": {
            "question": { "type": "string", "minLength": 1, "maxLength": ASK_QUESTION_CHARS },
            "choices": {
                "type": "array",
                "maxItems": ASK_CHOICES,
                "items": { "type": "string", "minLength": 1, "maxLength": ASK_CHOICE_CHARS }
            }
        }
    })
}

/// The question and choice labels of an `ask` reply, checked against the Ask's limits.
pub fn parse_ask(ask: &Value) -> Result<(String, Vec<String>), String> {
    let question = ask["question"].as_str().map(str::trim).unwrap_or_default();
    if question.is_empty() || question.chars().count() > ASK_QUESTION_CHARS {
        return Err(format!("ask.question needs 1 to {ASK_QUESTION_CHARS} characters"));
    }
    let choices: Vec<String> = match &ask["choices"] {
        Value::Null => vec![],
        Value::Array(items) => items.iter().map(|c| c.as_str().map(|c| c.trim().to_string()).unwrap_or_default()).collect(),
        _ => return Err("ask.choices must be a list of labels".into()),
    };
    if choices.len() > ASK_CHOICES || choices.iter().any(|c| c.is_empty() || c.chars().count() > ASK_CHOICE_CHARS) {
        return Err(format!("ask.choices: at most {ASK_CHOICES} labels of 1 to {ASK_CHOICE_CHARS} characters"));
    }
    if choices.iter().enumerate().any(|(i, c)| choices[..i].contains(c)) {
        return Err("ask.choices: each label must be different".into());
    }
    Ok((question.to_string(), choices))
}

/// A Follow-up Run's questions and answers, for an agent whose conversation is gone: the questions
/// (the agent's own words, numbered when there were several) to go inside the data fence, and the
/// user's answers to the earlier ones — their own words — to go outside it. The answer to the last
/// question is the caller's to say.
pub fn questions_and_answers(follow: &Value) -> (String, String) {
    let chain = follow["chain"].as_array().cloned().unwrap_or_default();
    let (mut questions, mut answers) = (String::new(), String::new());
    for (i, step) in chain.iter().enumerate() {
        questions.push_str(&format!("Question {}:\n{}\n\n", i + 1, step["question"].as_str().unwrap_or_default()));
        answers.push_str(&format!("The user answered question {}: {}\n", i + 1, answer_words(step)));
    }
    if !chain.is_empty() {
        questions.push_str(&format!("Question {} (the last):\n", chain.len() + 1));
    }
    questions.push_str(&format!("{}\n", follow["question"].as_str().unwrap_or_default()));
    (questions, answers)
}

/// How the user answered, in their own words: `they chose "Approve".` and the note, if any.
pub fn answer_words(answer: &Value) -> String {
    let choice = answer["choice"].as_str().map(|c| format!("they chose \"{c}\"")).unwrap_or_else(|| "they wrote".into());
    let note = answer["note"].as_str().filter(|n| !n.trim().is_empty()).map(|n| format!("\n{n}")).unwrap_or_default();
    format!("{choice}.{note}")
}

/// The idempotency key of `ask_id`'s Follow-up Run: one per Ask, however often it is pressed.
/// Each "Send again" after a failed one is a new `attempt` with a key of its own.
pub fn follow_up_key(ask_id: &str, attempt: u64) -> String {
    if attempt > 1 { format!("answer@{ask_id}#{attempt}") } else { format!("answer@{ask_id}") }
}

/// Records the Answer to `ask_id` and starts its Follow-up Run at once — also when the automation
/// is switched off, since the user asked for it directly. Returns the Follow-up Run's id.
/// `choice` must be one of the Ask's labels; an Ask without labels needs a note instead.
/// An Ask back after a failed Follow-up Run is answered the same way: that is "Send again".
pub async fn answer_ask(store: &Store, engine: &Engine, ask_id: &str, choice: Option<&str>, note: &str) -> Result<String, String> {
    let ask = store.get_draft(ask_id).map_err(|e| e.to_string())?.ok_or("no such question")?;
    if ask.kind != ASK_KIND {
        return Err("this is not a question".into());
    }
    let choices: Vec<String> = serde_json::from_value(ask.content["choices"].clone()).unwrap_or_default();
    let note = note.trim();
    match choice {
        Some(c) if !choices.iter().any(|x| x == c) => return Err(format!("{c:?} is not one of this question's choices")),
        None if !choices.is_empty() => return Err("choose one of the answers".into()),
        None if note.is_empty() => return Err("write your answer".into()),
        _ => {}
    }
    if note.chars().count() > ANSWER_NOTE_CHARS {
        return Err(format!("the note is longer than {ANSWER_NOTE_CHARS} characters"));
    }
    // Claimed first: a second press finds it taken and starts nothing.
    if let Err(status) = store.claim_draft_for_sending(&ask.id).map_err(|e| e.to_string())? {
        let why = if status == DraftStatus::Discarded { "dismissed" } else { "already answered" };
        return Err(format!("this question was {why}"));
    }
    let prev_attempt = ask.content["answer"]["attempt"].as_u64().unwrap_or(0);
    let attempt = prev_attempt + 1;
    let now = SystemClock.now_ms();
    let answer = json!({ "choice": choice, "note": note, "answered_at_ms": now, "attempt": attempt });
    let chain = ask.content.get("chain").cloned().unwrap_or_else(|| json!([]));
    let payload = json!({ "follow_up": {
        "ask_id": ask.id, "asked_run_id": ask.run_id, "question": ask.content["question"], "answer": answer, "chain": chain,
        // What the asking run worked on (a review: its PR), for the follow-up to go on with.
        "origin": ask.content["origin"],
    } });
    let run_id = match engine.submit(&ask.automation_id, &follow_up_key(&ask.id, attempt), payload).await {
        Ok(Submitted::Started { run_id }) => run_id,
        Ok(Submitted::Duplicate { existing_run_id }) => existing_run_id,
        Err(e) => {
            if let Err(release) = store.release_draft(&ask.id) {
                eprintln!("[automation] could not put question {} back: {release}", ask.id);
            }
            return Err(format!("the follow-up run could not start: {e}"));
        }
    };
    let mut content: Value = ask.content.clone();
    content["answer"] = with_run(&answer, &run_id);
    // The run is on its way either way. If this fails the Ask stays claimed until Lotus restarts,
    // which puts it back; answering it again then finds this same run (its key) and records it.
    // A follow-up that already failed has put the Ask back itself, and this changes nothing.
    if let Err(e) = store.mark_ask_answered(&ask.id, &format!("run:{run_id}"), &content, prev_attempt, now) {
        eprintln!("[automation] could not record the answer to {}: {e}", ask.id);
    }
    Ok(run_id)
}

fn with_run(answer: &Value, run_id: &str) -> Value {
    let mut answer = answer.clone();
    answer["follow_up_run_id"] = json!(run_id);
    answer
}

/// What a Follow-up Run's own Ask records (PLAN §8 Q15): the Ask it answers, and the chain's
/// questions and answers so far — the earlier ones, then the one this run answers.
pub(crate) fn chain_fields(follow_up: &Value) -> Option<(Value, Value)> {
    let ask_id = follow_up["ask_id"].as_str()?;
    let mut chain = follow_up["chain"].as_array().cloned().unwrap_or_default();
    chain.push(json!({
        "question": follow_up["question"],
        "choice": follow_up["answer"]["choice"],
        "note": follow_up["answer"]["note"].as_str().unwrap_or_default(),
    }));
    Some((json!(ask_id), Value::Array(chain)))
}

/// A Follow-up Run failed (PLAN §8 Q14): its Ask waits again, keeping the Answer, so the user
/// sends it again without retyping it.
pub(crate) fn follow_up_failed(store: &Store, follow_up: &Value, run_id: &str) {
    let Some(ask_id) = follow_up["ask_id"].as_str() else { return };
    let ask = match store.get_draft(ask_id) {
        Ok(Some(ask)) => ask,
        Ok(None) => return,
        Err(e) => return eprintln!("[automation] could not read question {ask_id}: {e}"),
    };
    let mut content = ask.content;
    content["answer"] = with_run(&follow_up["answer"], run_id);
    content["answer"]["failed_run_id"] = json!(run_id);
    if let Err(e) = store.return_ask(ask_id, &content) {
        eprintln!("[automation] could not bring question {ask_id} back: {e}");
    }
}

/// How long after an Ask's notification a window gaining focus still means "show me" (PLAN §8 Q10).
pub const ASK_NOTICE_WINDOW_MS: i64 = 10 * 60 * 1000;

/// The last Ask a notification was shown for. The notification plugin reports no click on macOS
/// (tauri-plugin-notification 2.3.3), so following it is read from its effect: a Lotus window
/// gains focus. The first focus within [`ASK_NOTICE_WINDOW_MS`] takes the Ask — one window, once;
/// any focus forgets it, too late or not.
#[derive(Debug, Default)]
pub struct AskNotice {
    last: std::sync::Mutex<Option<(String, i64)>>,
}

impl AskNotice {
    pub fn notified(&self, ask_id: &str, now_ms: i64) {
        *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Some((ask_id.to_string(), now_ms));
    }

    /// The Ask to open for a window that just gained focus, if its notification was recent.
    pub fn take_on_focus(&self, now_ms: i64) -> Option<String> {
        let (ask_id, at_ms) = self.last.lock().unwrap_or_else(|p| p.into_inner()).take()?;
        (now_ms - at_ms <= ASK_NOTICE_WINDOW_MS).then_some(ask_id)
    }
}
