//! A host's conversation (`Part` / `ConversationUpdate`, ACP vocabulary) as this Chat's `ThreadEvent`s.
//!
//! Provider-neutral on purpose: the host is the one translator per provider
//! (`plans/chat-remote-host/RESEARCH.md` §6), so nothing here knows Claude from Codex, and no
//! tool name is guessed at. Idempotent: the same part seen twice (a live update, then a page
//! reloaded after `truncated`) emits nothing the second time, and the state can be rebuilt from
//! the thread's stored events after a restart.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{json, Value};

#[derive(Debug, Clone)]
struct Seen {
    turn: String,
    item: Value,
    /// Bytes of `text` already emitted, for items that stream.
    text: usize,
    done: bool,
}

#[derive(Default)]
pub struct RemoteMap {
    open_turn: Option<String>,
    /// Opened by the host; `turn/started` waits for its first part, to carry the user's text.
    pending_turn: Option<String>,
    closed: HashSet<String>,
    items: HashMap<String, Seen>,
    /// The host's `toolCallId` → the item id it was drawn as, for sub-agent `parentId`s.
    tool_items: HashMap<String, String>,
    /// requestId → resolved.
    interactions: HashMap<String, bool>,
    /// Messages this desktop sent and the host has not echoed yet: (text, clientRequestId, attachments as drawn here).
    outbox: VecDeque<(String, String, Vec<Value>)>,
    usage: Option<Value>,
    error: Option<String>,
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

impl RemoteMap {
    /// Rebuilt from what the thread already stored, so a restart does not draw anything twice.
    pub fn seeded(events: &[Value]) -> Self {
        let mut m = RemoteMap::default();
        for e in events {
            let turn = s(e, "turnId").unwrap_or("").to_string();
            match s(e, "type").unwrap_or("") {
                "turn/started" => m.open_turn = Some(turn),
                "turn/completed" => {
                    m.closed.insert(turn);
                    m.open_turn = None;
                }
                "item/started" | "item/completed" => {
                    let item = e["item"].clone();
                    let id = s(&item, "id").unwrap_or("").to_string();
                    let text = s(&item, "text").map_or(0, str::len);
                    let done = s(e, "type") == Some("item/completed");
                    m.items.insert(id, Seen { turn, item, text, done });
                }
                "item/delta" => {
                    if let Some(seen) = s(e, "itemId").and_then(|id| m.items.get_mut(id)) {
                        seen.text += s(e, "delta").map_or(0, str::len);
                    }
                }
                "interaction/requested" => {
                    if let Some(id) = s(&e["interaction"], "id") {
                        m.interactions.insert(id.to_string(), false);
                    }
                }
                "interaction/resolved" => {
                    if let Some(id) = s(e, "interactionId") {
                        m.interactions.insert(id.to_string(), true);
                    }
                }
                _ => {}
            }
        }
        m
    }

    /// A message this desktop is sending, so the host's echo of it keeps the composer's request id.
    /// `attachments` are this Mac's view of them, so the sent message draws as a local one does.
    pub fn sending(&mut self, text: &str, client_request_id: &str, attachments: &[Value]) {
        self.outbox.push_back((text.trim().to_string(), client_request_id.to_string(), attachments.to_vec()));
    }

    /// One `ConversationUpdate` → the events it adds.
    pub fn update(&mut self, u: &Value) -> Vec<Value> {
        let mut out = Vec::new();
        match s(u, "kind") {
            Some("turn") => self.turn(&u["turn"], &mut out),
            Some("part") => self.part(s(u, "turnId").unwrap_or(""), &u["part"], &mut out),
            Some("text") => {
                let (Some(id), Some(delta)) = (s(u, "partId"), s(u, "delta")) else { return out };
                if let Some(seen) = self.items.get_mut(id).filter(|seen| !seen.done) {
                    seen.text += delta.len();
                    out.push(json!({ "type": "item/delta", "turnId": seen.turn, "itemId": id, "delta": delta }));
                }
            }
            _ => {}
        }
        out
    }

    /// A whole `ConversationPage` (after `truncated`): only what is new comes out.
    pub fn page(&mut self, page: &Value) -> Vec<Value> {
        let mut out = Vec::new();
        for turn in page["turns"].as_array().into_iter().flatten() {
            let id = s(turn, "turnId").unwrap_or("");
            let mut open = turn.clone();
            if let Some(o) = open.as_object_mut() {
                o.remove("endedAt");
                o.remove("parts");
            }
            self.turn(&open, &mut out);
            for part in turn["parts"].as_array().into_iter().flatten() {
                self.part(id, part, &mut out);
            }
            if turn.get("endedAt").is_some() {
                self.turn(turn, &mut out);
            }
        }
        out
    }

    fn turn(&mut self, turn: &Value, out: &mut Vec<Value>) {
        let Some(id) = s(turn, "turnId") else { return };
        if self.closed.contains(id) {
            return;
        }
        if turn.get("endedAt").is_none() {
            if self.open_turn.as_deref() != Some(id) {
                self.pending_turn = Some(id.to_string());
            }
            return;
        }
        self.start(id, None, out);
        let status = match s(turn, "stopReason") {
            Some("cancelled") => "interrupted",
            Some("error") => "failed",
            _ => "completed",
        };
        // Steps the host never settled end with their turn.
        let item_status = if status == "completed" { "completed" } else { "interrupted" };
        for seen in self.items.values_mut().filter(|seen| seen.turn == id && !seen.done) {
            seen.done = true;
            let mut item = seen.item.clone();
            item["status"] = json!(item_status);
            out.push(json!({ "type": "item/completed", "turnId": id, "item": item }));
        }
        out.push(json!({
            "type": "turn/completed", "turnId": id, "status": status,
            "error": self.error.take(), "usage": self.usage.take(),
        }));
        self.closed.insert(id.to_string());
        self.open_turn = None;
    }

    /// `turn/started` for `id` if it has not been said, with the user's text when the first part is it.
    fn start(&mut self, id: &str, input: Option<Value>, out: &mut Vec<Value>) -> bool {
        if self.open_turn.as_deref() == Some(id) || self.closed.contains(id) {
            return false;
        }
        if let Some(other) = self.open_turn.clone() {
            // The host moved on without closing it: close it here rather than leave it spinning.
            self.turn(&json!({ "turnId": other, "endedAt": 0, "stopReason": "cancelled" }), out);
        }
        out.push(json!({ "type": "turn/started", "turnId": id, "input": input }));
        self.open_turn = Some(id.to_string());
        self.pending_turn = None;
        true
    }

    fn client_request_id(&mut self, text: &str, part_id: &str) -> (String, Vec<Value>) {
        match self.outbox.iter().position(|(t, _, _)| t == text.trim()).and_then(|at| self.outbox.remove(at)) {
            Some((_, id, attachments)) => (id, attachments),
            None => (part_id.to_string(), Vec::new()),
        }
    }

    fn part(&mut self, turn: &str, part: &Value, out: &mut Vec<Value>) {
        let Some(id) = s(part, "id") else { return };
        if self.closed.contains(turn) {
            return;
        }
        match s(part, "type").unwrap_or("") {
            "user_message" => {
                if self.items.contains_key(id) {
                    return;
                }
                let text = s(part, "text").unwrap_or("").to_string();
                let (crid, attachments) = self.client_request_id(&text, id);
                let mut input = json!({ "text": text, "clientRequestId": crid });
                let mut item = json!({ "id": id, "status": "completed", "kind": "userMessage", "text": text, "clientRequestId": crid });
                if !attachments.is_empty() {
                    input["attachments"] = json!(attachments);
                    item["attachments"] = json!(attachments);
                }
                self.items.insert(id.into(), Seen { turn: turn.into(), item: item.clone(), text: 0, done: true });
                if !self.start(turn, Some(input), out) {
                    // Sent while the turn ran: a steer.
                    out.push(json!({ "type": "item/started", "turnId": turn, "item": item }));
                    out.push(json!({ "type": "item/completed", "turnId": turn, "item": item }));
                }
            }
            "permission" | "question" => {
                self.start(turn, None, out);
                self.interaction(turn, part, out);
            }
            "result" => {
                let u = &part["usage"];
                self.usage = Some(json!({
                    "inputTokens": u["input"].as_u64().unwrap_or(0),
                    "outputTokens": u["output"].as_u64().unwrap_or(0),
                    "costUsd": part.get("costUsd").cloned().unwrap_or(Value::Null),
                    "durationMs": part.get("durationMs").cloned().unwrap_or(Value::Null),
                }));
            }
            "error" => self.error = s(part, "message").map(String::from),
            // This desktop sets a remote thread's mode itself, in its own words; the host's echo
            // (`manual`, `auto`) is not one this Chat's picker knows.
            "mode_change" => {}
            "status" if s(part, "state") == Some("ended") => {
                out.push(json!({ "type": "session/ended", "error": part.get("detail").cloned().unwrap_or(Value::Null) }));
            }
            _ => {
                if let Some((item, done)) = self.item_of(part) {
                    self.start(turn, None, out);
                    self.item(turn, id, item, done, out);
                }
            }
        }
    }

    fn item(&mut self, turn: &str, id: &str, item: Value, done: bool, out: &mut Vec<Value>) {
        let text = s(&item, "text").unwrap_or("").to_string();
        match self.items.get_mut(id) {
            Some(seen) if seen.done => {}
            Some(seen) => {
                if let Some(rest) = text.get(seen.text..).filter(|r| !r.is_empty() && text.len() > seen.text) {
                    out.push(json!({ "type": "item/delta", "turnId": turn, "itemId": id, "delta": rest }));
                    seen.text = text.len();
                }
                seen.item = item.clone();
                if done {
                    seen.done = true;
                    out.push(json!({ "type": "item/completed", "turnId": turn, "item": item }));
                }
            }
            None => {
                // A new step settles the thinking before it.
                let settled: Vec<String> = self
                    .items
                    .iter()
                    .filter(|(_, seen)| !seen.done && seen.turn == turn && seen.item["kind"] == "reasoning")
                    .map(|(k, _)| k.clone())
                    .collect();
                for k in settled {
                    if let Some(seen) = self.items.get_mut(&k) {
                        seen.done = true;
                        let mut done_item = seen.item.clone();
                        done_item["status"] = json!("completed");
                        out.push(json!({ "type": "item/completed", "turnId": turn, "item": done_item }));
                    }
                }
                let mut started = item.clone();
                started["status"] = json!("running");
                out.push(json!({ "type": "item/started", "turnId": turn, "item": started }));
                self.items.insert(id.into(), Seen { turn: turn.into(), item: item.clone(), text: text.len(), done });
                if done {
                    out.push(json!({ "type": "item/completed", "turnId": turn, "item": item }));
                }
            }
        }
    }

    /// The `ThreadItem` a part is drawn as, and whether it has settled.
    fn item_of(&mut self, part: &Value) -> Option<(Value, bool)> {
        let id = s(part, "id")?;
        let mut item = match s(part, "type")? {
            "assistant_text" => {
                let done = s(part, "state") != Some("streaming");
                json!({ "kind": "agentMessage", "text": s(part, "text").unwrap_or(""), "status": if done { "completed" } else { "running" } })
            }
            "reasoning" => json!({ "kind": "reasoning", "text": s(part, "text").unwrap_or(""), "status": "running" }),
            "tool_call" => {
                if let Some(call) = s(part, "toolCallId") {
                    self.tool_items.insert(call.to_string(), id.to_string());
                }
                tool_item(part)
            }
            "plan_update" => json!({ "kind": "tool", "name": "Plan", "input": { "entries": part["entries"] }, "output": null, "status": "completed" }),
            "unknown" => json!({
                "kind": "tool", "name": s(part, "rawType").unwrap_or("unknown"),
                "input": { "summary": s(part, "summary").unwrap_or("") }, "output": null, "status": "completed",
            }),
            _ => return None,
        };
        item["id"] = json!(id);
        if let Some(parent) = s(part, "parentToolCallId").and_then(|c| self.tool_items.get(c)) {
            item["parentId"] = json!(parent);
        }
        let done = item["status"] != "running";
        Some((item, done))
    }

    fn interaction(&mut self, turn: &str, part: &Value, out: &mut Vec<Value>) {
        let question = s(part, "type") == Some("question") || s(part, "ask") == Some("question");
        let Some(request) = s(part, "requestId").map(String::from) else { return };
        let item_id = s(part, "toolCallId").and_then(|c| self.tool_items.get(c)).cloned();
        if !self.interactions.contains_key(&request) {
            let interaction = if question {
                let questions: Vec<Value> = part["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|q| json!({
                        "question": s(q, "question").unwrap_or(""),
                        "header": s(q, "header").unwrap_or(""),
                        "multiSelect": q["multiSelect"].as_bool().unwrap_or(false),
                        "options": q["options"].as_array().into_iter().flatten().map(|o| json!({
                            "label": s(o, "label").unwrap_or(""),
                            "description": o.get("description").cloned().unwrap_or(Value::Null),
                            // The digit the host is answered by (ADR-8).
                            "key": o.get("key").cloned().unwrap_or(Value::Null),
                        })).collect::<Vec<_>>(),
                    }))
                    .collect();
                json!({ "id": request, "kind": "question", "itemId": item_id, "questions": questions })
            } else {
                json!({
                    "id": request, "kind": "toolPermission", "itemId": item_id,
                    "toolName": s(part, "title").unwrap_or("a tool"),
                    "input": { "options": part["options"] }, "blockedPath": null,
                })
            };
            out.push(json!({ "type": "interaction/requested", "turnId": turn, "interaction": interaction }));
            self.interactions.insert(request.clone(), false);
        }
        if self.interactions.get(&request) == Some(&true) {
            return;
        }
        let resolved = if let Some(answered) = part.get("answered").and_then(Value::as_object) {
            let answers: serde_json::Map<String, Value> = answered
                .iter()
                .map(|(q, labels)| {
                    let joined = labels.as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
                    (q.clone(), json!(joined))
                })
                .collect();
            Some(json!({ "decision": "answered", "message": null, "answers": answers }))
        } else if part.get("cancelled").is_some() || part["outcome"].get("cancelled").is_some() {
            Some(json!({ "decision": "denied", "message": null, "answers": null }))
        } else if let Some(key) = part["outcome"].get("selected").and_then(Value::as_str) {
            let kind = part["options"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|o| s(o, "key") == Some(key))
                .and_then(|o| s(o, "kind"))
                .unwrap_or("");
            let decision = if kind.starts_with("allow") { "allowed" } else { "denied" };
            Some(json!({ "decision": decision, "message": null, "answers": null }))
        } else {
            None
        };
        if let Some(mut event) = resolved {
            event["type"] = json!("interaction/resolved");
            event["interactionId"] = json!(request);
            out.push(event);
            self.interactions.insert(request, true);
        }
    }
}

/// A host update or page with its turn and part ids scoped to `pane`. A new cell numbers its turns
/// from `t-0` again, so a thread's second cell would otherwise collide with the first's settled turns.
pub fn scoped(pane: &str, v: &Value) -> Value {
    fn tag(pane: &str, v: &mut Value, k: &str) {
        if let Some(id) = v.get(k).and_then(Value::as_str) {
            v[k] = json!(format!("{pane}:{id}"));
        }
    }
    fn turn(pane: &str, t: &mut Value) {
        tag(pane, t, "turnId");
        for part in t.get_mut("parts").and_then(Value::as_array_mut).into_iter().flatten() {
            tag(pane, part, "id");
        }
    }
    let mut v = v.clone();
    tag(pane, &mut v, "turnId");
    tag(pane, &mut v, "partId");
    if v.get("part").is_some() {
        tag(pane, &mut v["part"], "id");
    }
    if v.get("turn").is_some() {
        turn(pane, &mut v["turn"]);
    }
    for t in v.get_mut("turns").and_then(Value::as_array_mut).into_iter().flatten() {
        turn(pane, t);
    }
    v
}

/// A `tool_call` part by its ACP `kind`; anything without a dedicated item stays a named tool.
fn tool_item(part: &Value) -> Value {
    let title = s(part, "title").unwrap_or("").to_string();
    let first_path = part["locations"][0]["path"].as_str().map(String::from);
    let output = part["output"]["text"].as_str().map(String::from);
    let status = match s(part, "status").unwrap_or("") {
        "completed" => "completed",
        "failed" => "failed",
        "cancelled" => "interrupted",
        _ => "running",
    };
    let mut item = match s(part, "kind").unwrap_or("other") {
        "execute" => json!({ "kind": "command", "command": title, "description": null, "output": output }),
        "read" => json!({ "kind": "fileRead", "path": first_path.unwrap_or(title), "lineCount": null }),
        "edit" | "delete" | "move" => {
            let file = &part["diff"]["files"][0];
            let path = s(file, "path").map(String::from).or(first_path).unwrap_or(title);
            let change = if s(file, "op") == Some("add") { "create" } else { "edit" };
            // No patch from the host yet, only its counts; the Changes list reads them (`changes::remote`).
            json!({ "kind": "fileChange", "path": path, "change": change, "patch": null,
                    "added": file["additions"], "removed": file["deletions"] })
        }
        "search" => json!({ "kind": "search", "query": title, "output": output }),
        _ => json!({
            "kind": "tool", "name": s(part, "toolName").unwrap_or("tool"),
            "input": { "title": title, "locations": part["locations"] }, "output": output,
        }),
    };
    item["status"] = json!(status);
    item
}

#[cfg(test)]
#[path = "remote_map_tests.rs"]
mod tests;
