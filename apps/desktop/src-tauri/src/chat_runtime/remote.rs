//! A thread whose agent runs in the Lotus Host on an SSH machine (plans/chat-remote-host, d2).
//!
//! The host owns the agent, so the agent outlives this Mac sleeping or the SSH link dropping.
//! This side sends actions (`/v1/chat-cell/:action`), follows the cell's SSE stream, and turns
//! what arrives into the same `ThreadEvent`s a local thread stores (`remote_map`), so the rest of
//! Chat draws it unchanged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::remote_map::{scoped, RemoteMap};
use super::store::RemoteMachine;
use super::attachments::{self, Attachment};
use super::{ChatRuntime, Decision};
use crate::remote_host_link::sse::{follow, StreamEnd, StreamSignal};
use crate::remote_host_link::{HostLinks, Progress};

#[derive(Default)]
pub(super) struct Remote {
    links: Option<Arc<HostLinks>>,
    maps: HashMap<String, RemoteMap>,
    followers: HashMap<String, tauri::async_runtime::JoinHandle<()>>,
    /// Stream trouble per thread, shown in the thread and the rail. Absent = fine.
    trouble: HashMap<String, &'static str>,
}

/// Retries after which "reconnecting" becomes "down" (backoff 0.5 + 1 + 2 s, plus connect time).
const DOWN_AFTER: u32 = 3;

/// This Chat's permission modes in the host's words (`spawn-tuning.ts`).
fn host_mode(runner: &str, mode: &str) -> &'static str {
    match (runner, mode) {
        ("codex", "plan") => "read-only",
        ("codex", "bypassPermissions") => "full-access",
        ("codex", _) => "auto",
        (_, "plan") => "plan",
        (_, "acceptEdits") => "acceptEdits",
        (_, "bypassPermissions") => "bypassPermissions",
        _ => "manual",
    }
}

/// The printed digit that answers `interaction` with `decision` (ADR-8: never a position).
pub(super) fn answer_key(interaction: &Value, decision: &Decision) -> Result<String, String> {
    let key_of = |options: &Value, pick: &dyn Fn(&Value) -> bool| {
        options.as_array().into_iter().flatten().find(|o| pick(o)).and_then(|o| o["key"].as_str()).map(String::from)
    };
    if interaction["kind"] == "question" {
        let Decision::Allow { answers: Some(answers), .. } = decision else {
            return Err("this machine's host cannot refuse a question; pick an option".into());
        };
        let q = &interaction["questions"][0];
        let chosen = answers.get(q["question"].as_str().unwrap_or("")).ok_or("no answer for the question")?;
        return key_of(&q["options"], &|o| o["label"].as_str() == Some(chosen.as_str()))
            .ok_or_else(|| "this machine's host takes one of the listed options, not your own words".into());
    }
    let options = &interaction["input"]["options"];
    let wanted: &[&str] = match decision {
        Decision::Allow { remember: true, .. } => &["allow_always", "allow_once"],
        Decision::Allow { .. } => &["allow_once"],
        Decision::Deny { .. } => &["reject_once", "reject_always"],
    };
    wanted
        .iter()
        .find_map(|kind| key_of(options, &|o| o["kind"].as_str() == Some(kind)))
        .ok_or_else(|| "the host offered no option for that answer".into())
}

fn refusal(status: u16, body: &Value) -> String {
    body["error"].as_str().map(String::from).unwrap_or_else(|| format!("the host answered {status}"))
}

impl ChatRuntime {
    /// Gives the runtime its SSH host links; until then a remote thread cannot be driven.
    pub fn attach_host_links(&self, links: Arc<HostLinks>) {
        self.inner.remote.lock().links = Some(links);
    }

    pub(super) fn machine_of(&self, thread_id: &str) -> Result<Option<RemoteMachine>, String> {
        let mut core = self.inner.core.lock();
        Ok(core.store()?.thread(thread_id)?.ok_or_else(|| format!("unknown thread {thread_id}"))?.machine)
    }

    async fn act(&self, machine: &RemoteMachine, action: &str, mut body: Value) -> Result<Value, String> {
        let links = self.inner.remote.lock().links.clone().ok_or("SSH machines are not ready yet")?;
        if body.get("requestId").is_none() {
            body["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        }
        let (status, answer, _) = links
            .post(&machine.target(), &format!("/v1/chat-cell/{action}"), &body)
            .await
            .map_err(|e| e.to_string())?;
        if (200..300).contains(&status) {
            Ok(answer)
        } else if status == 404 && answer["error"] == "Not Found" {
            // The router's own 404: this host predates `/v1/chat-cell`, not a missing cell.
            Err(format!("{}'s Lotus Host is too old for Chat. Update lotus-host there.", machine.host))
        } else {
            Err(refusal(status, &answer))
        }
    }

    /// Stored events, so the map is rebuilt once per run and never draws a step twice.
    fn with_map<T>(&self, thread_id: &str, f: impl FnOnce(&mut RemoteMap) -> T) -> Result<T, String> {
        let mut remote = self.inner.remote.lock();
        if !remote.maps.contains_key(thread_id) {
            let events: Vec<Value> = {
                let mut core = self.inner.core.lock();
                core.store()?.events_after(thread_id, 0)?.into_iter().map(|e| e.event).collect()
            };
            remote.maps.insert(thread_id.to_string(), RemoteMap::seeded(&events));
        }
        Ok(f(remote.maps.get_mut(thread_id).expect("inserted above")))
    }

    fn ingest_remote(&self, thread_id: &str, events: Vec<Value>) {
        if events.is_empty() {
            return;
        }
        let mut core = self.inner.core.lock();
        if core.run(thread_id).is_err() {
            return;
        }
        for event in events {
            if let Err(error) = core.ingest(thread_id, event) {
                eprintln!("[chat-runtime] dropped a remote event for {thread_id}: {error}");
            }
        }
    }

    /// Records the stream's trouble and tells the rail when it changed.
    pub(super) fn set_trouble(&self, thread_id: &str, trouble: Option<&'static str>) {
        let changed = {
            let mut remote = self.inner.remote.lock();
            match trouble {
                Some(t) => remote.trouble.insert(thread_id.to_string(), t) != Some(t),
                None => remote.trouble.remove(thread_id).is_some(),
            }
        };
        if changed {
            if let Some(notify) = &self.inner.core.lock().on_rail_change {
                notify();
            }
        }
    }

    pub(super) fn remote_trouble(&self) -> HashMap<String, &'static str> {
        self.inner.remote.lock().trouble.clone()
    }

    /// The thread's Retry: reopen the link now instead of waiting out the backoff.
    pub async fn retry_remote(&self, thread_id: &str) -> Result<(), String> {
        let machine = self.machine_of(thread_id)?.ok_or("this chat runs on this Mac")?;
        self.remote_detach(thread_id);
        if let Some(links) = self.inner.remote.lock().links.clone() {
            links.forget(&machine.target());
        }
        self.set_trouble(thread_id, None);
        self.ensure_follow(thread_id, machine);
        Ok(())
    }

    fn save_machine(&self, thread_id: &str, machine: &RemoteMachine) {
        let mut core = self.inner.core.lock();
        if let Err(error) = core.store().and_then(|s| s.set_machine(thread_id, machine)) {
            eprintln!("[chat-runtime] could not save {thread_id}'s machine: {error}");
        }
    }

    pub(super) async fn remote_send(
        &self,
        thread_id: &str,
        mut machine: RemoteMachine,
        text: &str,
        client_request_id: &str,
        attachments: &[Attachment],
    ) -> Result<(), String> {
        // The host is sent its own copies; this Mac draws its own (ADR-0069).
        let on_host = attachments
            .iter()
            .map(|a| {
                let path = a.remote.as_ref().ok_or_else(|| format!("{} has not reached {} yet", a.name, machine.host))?;
                Ok(json!({ "kind": a.kind, "path": path, "name": a.name, "mimeType": a.mime_type }))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let shown: Vec<Value> = attachments.iter().map(|a| json!(a)).collect();
        self.with_map(thread_id, |m| m.sending(text, client_request_id, &shown))?;
        // A spawn takes text only, so a first message with attachments starts the agent, then sends.
        let prompt_in_spawn = machine.pane_id.is_none() && on_host.is_empty();
        if machine.pane_id.is_none() {
            self.remote_spawn(thread_id, &mut machine, prompt_in_spawn.then_some(text), client_request_id).await?;
        }
        if !prompt_in_spawn {
            let pane = machine.pane_id.clone().ok_or("the host started no cell")?;
            let mut body = json!({ "pane_id": pane, "text": text, "requestId": client_request_id });
            if !on_host.is_empty() {
                body["attachments"] = json!(on_host);
            }
            self.act(&machine, "send", body).await?;
        }
        self.ensure_follow(thread_id, machine);
        Ok(())
    }

    async fn remote_spawn(
        &self,
        thread_id: &str,
        machine: &mut RemoteMachine,
        prompt: Option<&str>,
        client_request_id: &str,
    ) -> Result<(), String> {
        let record = {
            let mut core = self.inner.core.lock();
            core.store()?.thread(thread_id)?.ok_or_else(|| format!("unknown thread {thread_id}"))?
        };
        let mut body = json!({
            "provider": record.runner,
            "workspaceId": machine.workspace_id,
            "permissionMode": host_mode(&record.runner, &record.permission_mode),
            "requestId": format!("{client_request_id}-spawn"),
        });
        if let Some(prompt) = prompt {
            body["initialPrompt"] = json!(prompt);
        }
        if let Some(model) = record.model {
            body["model"] = json!(model);
        }
        let spawned = self.act(machine, "spawn", body).await?;
        let pane = spawned["paneId"].as_str().ok_or("the host started no cell")?;
        machine.pane_id = Some(pane.to_string());
        machine.cursor = None;
        self.save_machine(thread_id, machine);
        // A new agent: clears the last one's "ended" notice, as a local respawn does.
        self.ingest_remote(
            thread_id,
            vec![json!({ "type": "session/configured", "providerSessionId": null, "model": null, "authSource": "unknown", "cwd": null })],
        );
        Ok(())
    }

    /// Copies one Chat Attachment to the thread's machine and returns it with the path there (ADR-0069).
    pub async fn upload_attachment(&self, thread_id: &str, attachment: Attachment, progress: Progress) -> Result<Attachment, String> {
        let machine = self.machine_of(thread_id)?.ok_or("this chat runs on this Mac")?;
        let attachment = attachments::checked(attachment)?;
        if attachment.size_bytes.unwrap_or(0) > attachments::MAX_REMOTE_FILE_BYTES {
            return Err(format!("{} is too large; files go up to 10 MB", attachment.name));
        }
        let path = attachment.path.clone();
        let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| format!("{} is no longer there", attachment.name))?;
        let sha = hex::encode(Sha256::digest(&bytes));
        let mut url = reqwest::Url::parse("http://host/v1/chat-attachments").expect("a fixed URL");
        url.query_pairs_mut()
            .append_pair("thread", thread_id)
            .append_pair("name", &attachment.name)
            .append_pair("mime", attachment.mime_type.as_deref().unwrap_or(""))
            .append_pair("sha256", &sha);
        let links = self.inner.remote.lock().links.clone().ok_or("SSH machines are not ready yet")?;
        // `waiting for` is what the composer reads as "the link is down, try again" (decision 11).
        let (status, answer) = links
            .upload(&machine.target(), &format!("{}?{}", url.path(), url.query().unwrap_or("")), bytes, progress)
            .await
            .map_err(|e| format!("waiting for {} · {e}", machine.host))?;
        if status == 404 && answer["error"] == "Not Found" {
            return Err(format!("Update lotus-host on {} to send attachments there.", machine.host));
        }
        if !(200..300).contains(&status) {
            return Err(refusal(status, &answer));
        }
        // Proof of delivery: the host names where it is and hashed what it stored.
        let remote = answer["path"].as_str().filter(|_| answer["sha256"] == sha.as_str());
        let remote = remote.ok_or_else(|| format!("{} did not arrive whole; send it again", attachment.name))?;
        Ok(Attachment { remote: Some(remote.to_string()), ..attachment })
    }

    /// Follows the thread's cell if nothing does yet. Called on send and when the thread is opened.
    pub(super) fn ensure_follow(&self, thread_id: &str, machine: RemoteMachine) {
        let Some(pane) = machine.pane_id.clone() else { return };
        let mut remote = self.inner.remote.lock();
        if remote.followers.get(thread_id).is_some_and(|h| !h.inner().is_finished()) {
            return;
        }
        let Some(links) = remote.links.clone() else { return };
        let (runtime, thread) = (self.clone(), thread_id.to_string());
        let task = tauri::async_runtime::spawn(async move {
            let link = match links.link(&machine.target()).await {
                Ok(link) => link,
                Err(error) => {
                    eprintln!("[chat-runtime] {thread}: cannot reach {}: {error}", machine.host);
                    runtime.set_trouble(&thread, Some("down"));
                    return;
                }
            };
            let mut saved = machine.clone();
            let end = follow(&link, &pane, machine.cursor.clone(), Duration::from_secs(45), |signal| match signal {
                StreamSignal::Event(ev) => {
                    runtime.set_trouble(&thread, None);
                    let data: Value = serde_json::from_str(&ev.data).unwrap_or(Value::Null);
                    match ev.event.as_str() {
                        "conversation" => {
                            let events = runtime.with_map(&thread, |m| m.update(&scoped(&pane, &data["update"]))).unwrap_or_default();
                            runtime.ingest_remote(&thread, events);
                            if ev.id.is_some() && ev.id != saved.cursor {
                                saved.cursor = ev.id;
                                runtime.save_machine(&thread, &saved);
                            }
                        }
                        "truncated" => runtime.reload(&thread, &link, &pane),
                        _ => {}
                    }
                }
                StreamSignal::Reconnecting { attempt, reason } => {
                    eprintln!("[chat-runtime] {thread}: reconnecting to {} ({attempt}): {reason}", machine.host);
                    runtime.set_trouble(&thread, Some(if attempt > DOWN_AFTER { "down" } else { "reconnecting" }));
                }
            })
            .await;
            runtime.set_trouble(&thread, None);
            let why = match end {
                StreamEnd::Ended => format!("The agent on {} ended.", machine.host),
                StreamEnd::Unknown => format!("{} no longer runs this chat's agent; the next message starts a new one.", machine.host),
            };
            // Gone for good: the next message spawns a fresh cell.
            saved.pane_id = None;
            saved.cursor = None;
            runtime.save_machine(&thread, &saved);
            runtime.ingest_remote(&thread, vec![json!({ "type": "session/ended", "error": why })]);
        });
        remote.followers.insert(thread_id.to_string(), task);
    }

    /// The stream lost its place (host restart or a full ring): draw what the page has that we lack.
    fn reload(&self, thread_id: &str, link: &Arc<crate::remote_host_link::HostLink>, pane: &str) {
        let (runtime, thread, link, pane) = (self.clone(), thread_id.to_string(), Arc::clone(link), pane.to_string());
        tauri::async_runtime::spawn(async move {
            match link.post("/v1/cell-conversation", &json!({ "pane_id": pane })).await {
                Ok((200, page)) => {
                    let events = runtime.with_map(&thread, |m| m.page(&scoped(&pane, &page))).unwrap_or_default();
                    runtime.ingest_remote(&thread, events);
                }
                Ok((status, body)) => eprintln!("[chat-runtime] {thread}: page reload refused: {}", refusal(status, &body)),
                Err(error) => eprintln!("[chat-runtime] {thread}: page reload failed: {error}"),
            }
        });
    }

    pub(super) async fn remote_interrupt(&self, machine: &RemoteMachine) -> Result<(), String> {
        let Some(pane) = &machine.pane_id else { return Ok(()) };
        self.act(machine, "stop", json!({ "pane_id": pane })).await.map(|_| ())
    }

    /// Stops following only: the agent keeps running on the machine, which is the point of it.
    pub(super) fn remote_detach(&self, thread_id: &str) {
        let mut remote = self.inner.remote.lock();
        remote.trouble.remove(thread_id);
        if let Some(task) = remote.followers.remove(thread_id) {
            task.abort();
        }
    }

    /// Deleting the chat closes its agent on the machine too.
    pub(super) async fn remote_close(&self, thread_id: &str, machine: &RemoteMachine) {
        self.remote_detach(thread_id);
        if let Some(pane) = &machine.pane_id {
            if let Err(error) = self.act(machine, "close", json!({ "pane_id": pane })).await {
                eprintln!("[chat-runtime] {thread_id}: remote cell not closed: {error}");
            }
        }
        // Its Chat Attachment copies go too; the host sweeps unsent ones itself.
        let links = self.inner.remote.lock().links.clone();
        if let Some(links) = links {
            let body = json!({ "thread": thread_id });
            if let Err(error) = links.post(&machine.target(), "/v1/chat-attachments/drop", &body).await {
                eprintln!("[chat-runtime] {thread_id}: attachments not dropped: {error}");
            }
        }
        self.inner.remote.lock().maps.remove(thread_id);
    }

    pub(super) async fn remote_resolve(
        &self,
        thread_id: &str,
        machine: &RemoteMachine,
        interaction_id: &str,
        decision: &Decision,
    ) -> Result<(), String> {
        let pane = machine.pane_id.as_ref().ok_or("the chat's agent on the machine has ended")?;
        let interaction = {
            let mut core = self.inner.core.lock();
            core.store()?
                .events_after(thread_id, 0)?
                .into_iter()
                .rev()
                .find(|e| e.event["type"] == "interaction/requested" && e.event["interaction"]["id"] == interaction_id)
                .map(|e| e.event["interaction"].clone())
                .ok_or("this approval is no longer waiting")?
        };
        let key = answer_key(&interaction, decision)?;
        self.act(machine, "answer", json!({ "pane_id": pane, "data": key })).await.map(|_| ())
    }

    pub(super) async fn remote_posture(&self, machine: &RemoteMachine, runner: &str, mode: &str) -> Result<(), String> {
        let Some(pane) = &machine.pane_id else { return Ok(()) };
        self.act(machine, "posture", json!({ "pane_id": pane, "mode": host_mode(runner, mode) })).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn answers_by_the_printed_digit_of_the_matching_option() {
        let perm = json!({ "kind": "toolPermission", "input": { "options": [
            { "key": "1", "kind": "allow_once" }, { "key": "2", "kind": "allow_always" }, { "key": "3", "kind": "reject_once" },
        ] } });
        let allow = |remember| Decision::Allow { answers: None, remember };
        assert_eq!(answer_key(&perm, &allow(false)).unwrap(), "1");
        assert_eq!(answer_key(&perm, &allow(true)).unwrap(), "2");
        assert_eq!(answer_key(&perm, &Decision::Deny { message: String::new() }).unwrap(), "3");

        let question = json!({ "kind": "question", "questions": [{ "question": "Which?", "options": [
            { "label": "A", "key": "1" }, { "label": "B", "key": "2" },
        ] }] });
        let pick = |label: &str| Decision::Allow { answers: Some(BTreeMap::from([("Which?".into(), label.into())])), remember: false };
        assert_eq!(answer_key(&question, &pick("B")).unwrap(), "2");
        assert!(answer_key(&question, &pick("my own words")).is_err());
    }

    #[test]
    fn maps_this_chats_modes_to_the_hosts() {
        assert_eq!(host_mode("claude", "default"), "manual");
        assert_eq!(host_mode("claude", "acceptEdits"), "acceptEdits");
        assert_eq!(host_mode("codex", "bypassPermissions"), "full-access");
        assert_eq!(host_mode("codex", "default"), "auto");
    }
}
