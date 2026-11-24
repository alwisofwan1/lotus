//! Talking to a run's agent in Lotus, as a chat thread: the run's conversation read back as
//! messages, and the user's own message sent as a Follow-up Run that resumes it.
//!
//! A message is not an authorization. It runs under the automation's own rules: a review stays
//! read-only and only answers, and a prompt's new result waits for Send like any other.

use serde::Serialize;
use serde_json::{json, Value};

use crate::engine::{Engine, Submitted};
use crate::ports::{Clock, SystemClock};
use crate::session::Transcripts;
use crate::store::Store;

/// The longest message the user may send, and the longest answer the agent may give.
pub const CHAT_MESSAGE_CHARS: usize = 4_000;
pub const CHAT_ANSWER_CHARS: usize = 4_000;
/// The action kinds whose runs keep a conversation the user can talk to.
pub const CHAT_KINDS: [&str; 2] = ["agent_prompt", "pr_review"];
/// The line after which a chat turn's prompt holds the user's message, and nothing else. The
/// conversation view reads it back from here, so the user sees their own words, not the prompt.
pub const MESSAGE_LEAD: &str = "--- The user's message, in their own words ---";
/// How an Answer to an Ask starts, in each action kind's Follow-up prompt.
const ANSWER_LEADS: [&str; 2] = ["The user answered your question: ", "The reviewer answered your question: "];
/// The tool a pane run hands its result back with; its name carries the MCP server's prefix.
const SUBMIT_TOOL: &str = "lotus_automation_submit";

/// The `chat` answer a chat turn's agent replies with.
pub fn answer_schema() -> Value {
    json!({ "type": "string", "minLength": 1, "maxLength": CHAT_ANSWER_CHARS })
}

/// The agent's `chat` answer, when that is all it replied with.
pub fn answer_of(reply: &Value) -> Option<Result<String, String>> {
    let object = reply.as_object().filter(|o| o.len() == 1)?;
    let answer = object.get("chat")?.as_str().map(str::trim).unwrap_or_default();
    Some(if answer.is_empty() || answer.chars().count() > CHAT_ANSWER_CHARS {
        Err(format!("chat needs 1 to {CHAT_ANSWER_CHARS} characters"))
    } else {
        Ok(answer.to_string())
    })
}

/// A run's outcome line for a chat answer: its first line, short.
pub fn answer_detail(answer: &str) -> String {
    const MAX: usize = 160;
    let line = answer.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    let cut: String = line.chars().take(MAX).collect();
    let more = if cut.chars().count() < line.chars().count() { "…" } else { "" };
    format!("answered: {cut}{more}")
}

/// What a chat turn's agent is told. It resumed its conversation, so it has the whole work: only
/// the message is new. The message comes last, after [`MESSAGE_LEAD`], so it can be read back.
pub fn message_prompt(context: &str, how: &str, message: &str) -> String {
    format!(
        "{context}The user has a message for you about this work. Answer it in `chat`: plain words, at most \
         {CHAT_ANSWER_CHARS} characters, written for them. {how}\nTheir message is everything after the next line.\n\
         {MESSAGE_LEAD}\n{message}"
    )
}

/// The user's message in a follow-up payload, if the follow-up is a chat turn.
pub fn message_of(follow: &Value) -> Option<&str> {
    follow["message"]["text"].as_str()
}

/// Sends `text` to `run_id`'s agent: a Follow-up Run of the newest run in its conversation, which
/// resumes it. Returns that run's id. `key` is the client's own id for this message, so a second
/// press of Send starts nothing new.
pub async fn send_message(
    store: &Store,
    engine: &Engine,
    transcripts: Option<&dyn Transcripts>,
    run_id: &str,
    text: &str,
    key: &str,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("write a message".into());
    }
    if text.chars().count() > CHAT_MESSAGE_CHARS {
        return Err(format!("the message is longer than {CHAT_MESSAGE_CHARS} characters"));
    }
    if key.is_empty() || key.len() > 64 || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("the message has no valid id".into());
    }
    let run = store.get_run(run_id).map_err(|e| e.to_string())?.ok_or("no such run")?;
    let session = store.run_session(run_id).map_err(|e| e.to_string())?.ok_or("this run kept no conversation")?;
    let automation = store.get_automation(&run.automation_id).map_err(|e| e.to_string())?.ok_or("no such automation")?;
    if !CHAT_KINDS.contains(&automation.action.kind.as_str()) {
        return Err("this kind of automation cannot be asked about its work".into());
    }
    let head = store.session_head(&session.id).map_err(|e| e.to_string())?;
    let (head, busy) = head.unwrap_or_else(|| (run.id.clone(), false));
    // A second agent on a conversation still being written would fork it.
    if busy {
        return Err("the agent is still working; send your message when it has finished".into());
    }
    if !transcripts.is_some_and(|t| t.exists(&session.cwd, &session.id)) {
        return Err("this run's conversation was not saved, so it cannot be continued".into());
    }
    let payload = store.run_payload(&head).map_err(|e| e.to_string())?.unwrap_or(Value::Null);
    // What the conversation worked on (a review: its PR), whichever round this is.
    let origin = match payload.get("follow_up").filter(|f| f.is_object()) {
        Some(follow) => follow["origin"].clone(),
        None => payload,
    };
    let now = SystemClock.now_ms();
    let payload = json!({ "follow_up": {
        "asked_run_id": head,
        "message": { "text": text, "sent_at_ms": now },
        "origin": origin,
    } });
    match engine.submit(&automation.id, &format!("message@{head}:{key}"), payload).await {
        Ok(Submitted::Started { run_id }) => Ok(run_id),
        Ok(Submitted::Duplicate { existing_run_id }) => Ok(existing_run_id),
        Err(e) => Err(format!("the message could not be sent: {e}")),
    }
}

/// One message of a run's conversation, as the thread shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntry {
    /// `instructions` (what Lotus told the agent), `you`, `agent` (its words), `step` (a tool it
    /// used) or `result` (what it handed back).
    pub kind: &'static str,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
    /// A step's tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// A result, as the agent handed it back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    pub at_ms: i64,
}

impl ChatEntry {
    fn new(kind: &'static str, text: impl Into<String>, at_ms: i64) -> Self {
        Self { kind, text: text.into(), tool: None, result: None, at_ms }
    }
}

/// A Claude transcript (`<session>.jsonl`) as the thread's messages, oldest first. Lines that do
/// not parse are skipped: the file may be half-written while the agent works.
pub fn conversation(jsonl: &str) -> Vec<ChatEntry> {
    let mut out: Vec<ChatEntry> = Vec::new();
    for line in jsonl.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
        let at = value["timestamp"].as_str().and_then(iso_ms).unwrap_or(0);
        let content = &value["message"]["content"];
        match value["type"].as_str() {
            // A string is a prompt Lotus sent. A list is tool results and skill text, not shown.
            Some("user") => {
                if let Some(prompt) = content.as_str().filter(|p| !p.trim().is_empty()) {
                    out.push(prompt_entry(prompt, at));
                }
            }
            Some("assistant") => {
                for block in content.as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") => {
                            let text = block["text"].as_str().unwrap_or_default().trim();
                            if !text.is_empty() {
                                out.push(ChatEntry::new("agent", text, at));
                            }
                        }
                        Some("tool_use") => {
                            let entry = tool_entry(block, at);
                            // A result handed back again (the agent retried it) replaces the one before.
                            match out.last_mut() {
                                Some(last) if last.kind == "result" && entry.kind == "result" => *last = entry,
                                _ => out.push(entry),
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A prompt: the user's message or Answer when it holds one, else Lotus's instructions.
fn prompt_entry(prompt: &str, at: i64) -> ChatEntry {
    if let Some((_, message)) = prompt.split_once(&format!("\n{MESSAGE_LEAD}\n")) {
        return ChatEntry::new("you", message.trim(), at);
    }
    for lead in ANSWER_LEADS {
        if let Some(rest) = prompt.strip_prefix(lead) {
            let answer = rest.split("\n\n").next().unwrap_or_default().trim();
            return ChatEntry::new("you", answer, at);
        }
    }
    ChatEntry::new("instructions", prompt.trim(), at)
}

/// A tool call: the result when it hands one back, else one step.
fn tool_entry(block: &Value, at: i64) -> ChatEntry {
    let name = block["name"].as_str().unwrap_or_default();
    let input = &block["input"];
    if name == "StructuredOutput" || name.ends_with(SUBMIT_TOOL) {
        let mut result = input.clone();
        if let Some(object) = result.as_object_mut() {
            // A pane run's token is Lotus's, not the agent's words.
            object.remove("token");
        }
        // A chat answer reads as the agent talking.
        if let Some(Ok(answer)) = answer_of(&result) {
            return ChatEntry::new("agent", answer, at);
        }
        return ChatEntry { result: Some(result), ..ChatEntry::new("result", "", at) };
    }
    let target = ["command", "pattern", "query", "file_path", "path", "url", "skill", "prompt"]
        .iter()
        .find_map(|k| input[k].as_str().filter(|t| !t.is_empty()))
        .map(|t| {
            let line = t.lines().next().unwrap_or_default();
            let cut: String = line.chars().take(120).collect();
            if cut.len() < t.len() { format!("{cut}…") } else { cut }
        })
        .unwrap_or_default();
    ChatEntry { tool: Some(name.to_string()), ..ChatEntry::new("step", target, at) }
}

fn iso_ms(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|t| t.timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: Value) -> String {
        v.to_string()
    }

    #[test]
    fn a_transcript_reads_as_instructions_steps_words_and_result() {
        let at = "2026-10-02T08:00:00.000Z";
        let text = [
            line(json!({"type": "queue-operation", "operation": "enqueue"})),
            line(json!({"type": "user", "timestamp": at, "message": {"content": "You are running a scheduled task…"}})),
            line(json!({"type": "assistant", "timestamp": at, "message": {"content": [
                {"type": "thinking", "thinking": "hm"},
                {"type": "text", "text": "Reading the vault."},
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls\nmore"}}
            ]}})),
            line(json!({"type": "user", "timestamp": at, "message": {"content": [{"type": "tool_result", "content": "a"}]}})),
            line(json!({"type": "assistant", "timestamp": at, "message": {"content": [
                {"type": "tool_use", "name": "StructuredOutput", "input": {"text": "Draft."}}
            ]}})),
            line(json!({"type": "assistant", "timestamp": at, "message": {"content": [
                {"type": "tool_use", "name": "StructuredOutput", "input": {"text": "Done."}}
            ]}})),
            "{half a line".to_string(),
        ]
        .join("\n");
        let entries = conversation(&text);
        let kinds: Vec<_> = entries.iter().map(|e| e.kind).collect();
        assert_eq!(kinds, ["instructions", "agent", "step", "result"]);
        assert_eq!(entries[2].tool.as_deref(), Some("Bash"));
        assert_eq!(entries[2].text, "ls…");
        assert_eq!(entries[3].result, Some(json!({"text": "Done."})));
        assert_eq!(entries[0].at_ms, 1_790_928_000_000);
    }

    #[test]
    fn the_user_sees_their_own_words_and_the_agent_its_answer() {
        let prompt = message_prompt("It is now 9:00.\n", "Stay read-only.", "Why line 20?\n\nAnd 30?");
        let text = [
            line(json!({"type": "user", "message": {"content": prompt}})),
            line(json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "StructuredOutput", "input": {"chat": "Because of the nil check."}}
            ]}})),
            line(json!({"type": "user", "message": {"content": "The reviewer answered your question: they chose \"Yes\".\n\nContinue."}})),
            line(json!({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "name": "mcp__lotus__lotus_automation_submit", "input": {"token": "t", "text": "Hi"}}
            ]}})),
        ]
        .join("\n");
        let entries = conversation(&text);
        assert_eq!(entries[0], ChatEntry::new("you", "Why line 20?\n\nAnd 30?", 0));
        assert_eq!(entries[1], ChatEntry::new("agent", "Because of the nil check.", 0));
        assert_eq!(entries[2], ChatEntry::new("you", "they chose \"Yes\".", 0));
        assert_eq!(entries[3].result, Some(json!({"text": "Hi"})));
    }

    #[test]
    fn a_chat_answer_is_checked() {
        assert_eq!(answer_of(&json!({"chat": " ok "})), Some(Ok("ok".into())));
        assert!(matches!(answer_of(&json!({"chat": ""})), Some(Err(_))));
        assert_eq!(answer_of(&json!({"text": "x"})), None);
        assert_eq!(answer_of(&json!({"chat": "a", "text": "b"})), None);
        assert_eq!(answer_detail("\n  First line\nsecond"), "answered: First line");
    }
}
