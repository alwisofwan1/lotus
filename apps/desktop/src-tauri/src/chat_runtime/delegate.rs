//! Delegation (mockups/chat-delegation.html): a chat hands a task to a child chat on any runner,
//! model and effort, then collects its answer. The child is an ordinary thread with a parent, so
//! the rail nests it and the user can open it and talk to it.
//!
//! Two calls, not one: Claude runs MCP tools one at a time, so a blocking delegate would run the
//! children in sequence. `delegate` starts a child and returns; `wait_children` collects them.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{ChatRuntime, Decision};

/// How deep a chain of delegations may go: lead → child → grandchild → great-grandchild. It stops
/// a loop of agents delegating to each other, not real work; the number of children is not capped.
const MAX_DEPTH: usize = 3;
const POLL: Duration = Duration::from_secs(1);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegateRequest {
    /// The chat that delegates (`LOTUS_CHAT_THREAD_ID` in its agent's environment).
    pub parent_id: String,
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub worktree: bool,
    /// Delegate Verify (ADR-0066): a verifier on the other provider checks the child's work.
    #[serde(default)]
    pub verify: Option<super::verify::VerifyOptions>,
}

/// A lead acting on one chat it delegated: `tell` sends a follow-up, `merge` brings its worktree
/// branch into the lead's, `discard` drops the chat with its worktree, `answer` answers a question
/// it asked. Permission requests are never answered here: they stay the user's.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildRequest {
    pub parent_id: String,
    pub chat_id: String,
    pub action: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub interaction_id: Option<String>,
    #[serde(default)]
    pub answers: Option<BTreeMap<String, String>>,
}

impl ChatRuntime {
    pub async fn child_action(&self, req: ChildRequest) -> Result<Value, String> {
        let threads = self.list_threads()?;
        let links: Vec<(String, Option<String>)> = threads.iter().map(|t| (t.id.clone(), t.parent_id.clone())).collect();
        stop_targets(&links, &req.parent_id, std::slice::from_ref(&req.chat_id))?;
        let child = threads.iter().find(|t| t.id == req.chat_id).ok_or_else(|| format!("no chat {}", req.chat_id))?;
        let title = child.title.clone();
        let busy = |what: &str| match child.status {
            Some(status) => Err(format!(
                "chat {} is {status}: collect it with lotus_chat_wait (or stop it) before you {what}",
                req.chat_id
            )),
            None => Ok(()),
        };
        let done = match req.action.as_str() {
            "tell" => {
                let text = req.text.as_deref().map(str::trim).filter(|t| !t.is_empty()).ok_or("text is required")?;
                busy("tell it more")?;
                let short = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
                let text = format!(
                    "<lotus-delegation from=\"{}\">A follow-up from the agent that delegated your task. End with a short, \
                     complete report again.</lotus-delegation>\n\n{text}",
                    req.parent_id
                );
                self.send(&req.chat_id, &text, &format!("tell-{short}"), Vec::new()).await?;
                json!({ "sent": true })
            }
            "merge" => {
                busy("merge it")?;
                let (runtime, id) = (self.clone(), req.chat_id.clone());
                let commit = tokio::task::spawn_blocking(move || runtime.merge_child(&id)).await.map_err(|e| e.to_string())??;
                json!({ "merged": commit })
            }
            "discard" => json!({ "discardedBranch": self.discard_child(&req.chat_id).await? }),
            "answer" => {
                let interaction_id = req.interaction_id.as_deref().ok_or("interactionId is required")?;
                let answers = req.answers.clone().filter(|a| !a.is_empty()).ok_or("answers is required")?;
                let asked = self
                    .pending_requests(&req.chat_id)?
                    .into_iter()
                    .find(|r| r["interactionId"] == interaction_id)
                    .ok_or("that request is no longer waiting")?;
                if asked["kind"] != "question" {
                    return Err(format!(
                        "that is a permission request ({}); only the user can grant it: ask them to answer in chat {:?}",
                        asked["toolName"].as_str().unwrap_or("a tool"),
                        title.unwrap_or_default()
                    ));
                }
                self.resolve_interaction(&req.chat_id, interaction_id, Decision::Allow { answers: Some(answers), remember: false })
                    .await?;
                json!({ "answered": interaction_id })
            }
            other => return Err(format!("action must be tell, merge, discard or answer, not {other:?}")),
        };
        self.rail_changed();
        Ok(json!({ "chatId": req.chat_id, "title": title, "action": req.action, "result": done }))
    }

    /// What `thread_id` is waiting on: each open question (with its options) or permission request.
    fn pending_requests(&self, thread_id: &str) -> Result<Vec<Value>, String> {
        let mut core = self.inner.core.lock();
        let pending = core.run(thread_id)?.pending_interactions.clone();
        if pending.is_empty() {
            return Ok(Vec::new());
        }
        let events = core.store()?.events_after(thread_id, 0)?;
        Ok(events
            .into_iter()
            .filter(|e| super::store::event_type(&e.event) == "interaction/requested")
            .filter_map(|e| {
                let i = &e.event["interaction"];
                let id = i["id"].as_str().filter(|id| pending.contains(*id))?;
                Some(match i["kind"].as_str() {
                    Some("question") => json!({ "interactionId": id, "kind": "question", "questions": i["questions"] }),
                    _ => json!({ "interactionId": id, "kind": "toolPermission", "toolName": i["toolName"] }),
                })
            })
            .collect())
    }

    pub async fn delegate(&self, req: DelegateRequest) -> Result<Value, String> {
        if !matches!(req.provider.as_str(), "claude" | "codex") {
            return Err(format!("provider must be \"claude\" or \"codex\", not {:?}", req.provider));
        }
        if req.prompt.trim().is_empty() {
            return Err("prompt is empty".into());
        }
        let (parent, depth) = {
            let mut core = self.inner.core.lock();
            let store = core.store()?;
            let parent = store
                .thread(&req.parent_id)?
                .ok_or_else(|| format!("no chat {}: delegate only from inside a Lotus Chat thread", req.parent_id))?;
            let mut depth = 1;
            let mut up = parent.parent_id.clone();
            while let Some(id) = up {
                depth += 1;
                if depth > MAX_DEPTH {
                    break;
                }
                up = store.thread(&id)?.and_then(|t| t.parent_id);
            }
            (parent, depth)
        };
        if depth > MAX_DEPTH {
            return Err(format!(
                "this chat is already {} levels deep in delegation; do the task yourself",
                MAX_DEPTH
            ));
        }

        let listed = self.list_models(&req.provider).await?;
        let models = listed["models"].as_array().cloned().unwrap_or_default();
        let (model, efforts) = choose_model(&models, req.model.as_deref(), &req.provider)?;
        let effort = choose_effort(req.effort.as_deref(), &efforts)?;
        // The verifier's model is checked now, so a bad one is refused before any child starts.
        let verifier = match &req.verify {
            Some(v) => {
                let provider = super::verify::other_provider(&req.provider);
                let listed = self.list_models(provider).await?;
                let models = listed["models"].as_array().cloned().unwrap_or_default();
                let (model, efforts) = choose_model(&models, v.model.as_deref(), provider)?;
                let effort = choose_effort(v.effort.as_deref().or(reviewer_effort(&efforts)), &efforts)?;
                Some((provider, model, effort, super::verify::clamp_rounds(v.rounds)))
            }
            None => None,
        };

        let short = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        let (cwd, branch) = if req.worktree {
            let slug = slug(&req.title);
            let branch = format!("lotus/d-{slug}-{short}");
            let path = crate::paths::lotus_state_dir().join("chat-worktrees").join(format!("{slug}-{short}"));
            let path = path.to_string_lossy().into_owned();
            let (repo, name, at) = (parent.cwd.clone(), branch.clone(), path.clone());
            tokio::task::spawn_blocking(move || crate::codespace_git::create_git_worktree(repo, name, at))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("could not make a worktree in {}: {e}", parent.cwd))?;
            (path, Some(branch))
        } else {
            (parent.cwd.clone(), None)
        };
        // The commit the worktree starts from: the verify loop skips its verifier while the worker
        // has committed nothing on top of it.
        let base = match &branch {
            Some(_) => {
                let at = cwd.clone();
                tokio::task::spawn_blocking(move || super::verify::head_commit(&at)).await.map_err(|e| e.to_string())?
            }
            None => None,
        };

        let where_note = match &branch {
            Some(branch) => format!(" You work in your own git worktree on branch {branch}, made from the last commit: commit your work there."),
            None => String::new(),
        };
        // A verified worker says whether it finished, so a worker that gives up is not sent to a verifier.
        let status_note = if verifier.is_some() { super::verify::WORKER_STATUS_NOTE } else { "" };
        let text = format!(
            "<lotus-delegation from=\"{}\">You are a sub-agent. Your last message goes back to the agent that \
             delegated this task, so end with a short, complete report of what you did and found.{where_note}{status_note}</lotus-delegation>\n\n{}",
            parent.id, req.prompt
        );
        // The child runs in the lead's permission mode: never more than the user allowed the lead.
        let child_id = self
            .start_child(&parent.id, &cwd, &parent.permission_mode, &req.provider, model.clone(), effort.clone(), &req.title, &text, None)
            .await?;
        let verify = verifier.map(|(provider, model, effort, rounds)| {
            self.start_verify(super::verify::Plan {
                worker_id: child_id.clone(),
                title: req.title.clone(),
                task: req.prompt.clone(),
                branch: branch.clone(),
                base: base.clone(),
                cwd: cwd.clone(),
                permission_mode: parent.permission_mode.clone(),
                provider: provider.to_string(),
                model: model.clone(),
                effort: effort.clone(),
                rounds,
            });
            json!({ "provider": provider, "model": model.unwrap_or_else(|| "default".into()), "effort": effort, "rounds": rounds })
        });
        Ok(json!({
            "chatId": child_id,
            "title": req.title,
            "provider": req.provider,
            "model": model.unwrap_or_else(|| "default".into()),
            "effort": effort,
            "permissionMode": parent.permission_mode,
            "cwd": cwd,
            "branch": branch,
            "depth": depth,
            "verify": verify,
        }))
    }

    /// Makes a chat under `parent_id`, names it, and sends it its first message.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn start_child(
        &self,
        parent_id: &str,
        cwd: &str,
        permission_mode: &str,
        provider: &str,
        model: Option<String>,
        effort: Option<String>,
        title: &str,
        text: &str,
        role: Option<&str>,
    ) -> Result<String, String> {
        let record = self.create_thread(cwd, model, Some(permission_mode.to_string()), Some(provider.to_string()), effort, None, None)?;
        {
            let mut core = self.inner.core.lock();
            let store = core.store()?;
            store.set_parent(&record.id, parent_id)?;
            store.rename(&record.id, title)?;
            if let Some(role) = role {
                store.set_role(&record.id, role)?;
            }
        }
        let short = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        self.send(&record.id, text, &format!("delegate-{short}"), Vec::new()).await?;
        self.rail_changed();
        Ok(record.id)
    }

    /// Waits until none of `ids` is still working, or `timeout`. A child waiting for the user's
    /// permission counts as stopped: the lead should say so rather than wait on it.
    pub async fn wait_children(&self, ids: &[String], timeout: Duration) -> Result<Value, String> {
        if ids.is_empty() {
            return Err("no chatIds to wait for".into());
        }
        let deadline = Instant::now() + timeout;
        loop {
            let threads = self.list_threads()?;
            let mut rows = Vec::new();
            let mut busy = false;
            for id in ids {
                let thread = threads.iter().find(|t| &t.id == id).ok_or_else(|| format!("no chat {id}"))?;
                // Not started yet: the message is sent but its turn has not begun.
                let state = match thread.status {
                    Some(status) => status,
                    None if thread.last_turn_ended_at.is_none() => "starting",
                    // Out of quota: Lotus sends it on when the limit resets.
                    None if self.paused_until(id).is_some() => "paused",
                    // Its turn ended but background work runs on, or just settled: it wakes by itself.
                    None if self.still_busy(id) => "working",
                    None => "done",
                };
                let verifying = self.verify_state(id).filter(|v| v.status == "verifying");
                // Its verifier stuck on a permission is reported like the child's own.
                let verifier_waits = verifying
                    .as_ref()
                    .and_then(|v| v.verifier_id.as_ref())
                    .and_then(|v| threads.iter().find(|t| &t.id == v))
                    .is_some_and(|v| v.status == Some("waiting"));
                busy |= (verifying.is_some() && state != "waiting" && !verifier_waits) || matches!(state, "working" | "starting" | "paused");
                rows.push((thread.clone(), state));
            }
            if busy && Instant::now() < deadline {
                tokio::time::sleep(POLL).await;
                continue;
            }
            let links: Vec<(String, Option<String>)> = threads.iter().map(|t| (t.id.clone(), t.parent_id.clone())).collect();
            let children = rows
                .into_iter()
                .map(|(thread, state)| {
                    let answer = (state == "done").then(|| self.last_answer(&thread.id)).flatten();
                    let verify = self.verify_state(&thread.id);
                    let mut waiting_on = if state == "waiting" { self.pending_requests(&thread.id).unwrap_or_default() } else { Vec::new() };
                    if let Some(verifier) = verify.as_ref().filter(|v| v.status == "verifying").and_then(|v| v.verifier_id.as_deref()) {
                        waiting_on.extend(self.pending_requests(verifier).unwrap_or_default().into_iter().map(|mut r| {
                            r["chatId"] = json!(verifier);
                            r
                        }));
                    }
                    // Its branch, so the lead can review and merge the work (git is quick here).
                    let lead = thread.parent_id.as_ref().and_then(|p| threads.iter().find(|t| &t.id == p));
                    let worktree = lead.and_then(|lead| super::changes::delegated(&thread.cwd, &lead.cwd));
                    let tokens = |ids: &[String]| {
                        let (input, output) = self.inner.core.lock().store().and_then(|s| s.tokens_of(ids)).unwrap_or_default();
                        json!({ "input": input, "output": output })
                    };
                    let below = descendants(&links, &thread.id);
                    json!({
                        "chatId": thread.id,
                        "title": thread.title,
                        "status": state,
                        "provider": thread.runner,
                        "model": thread.model.unwrap_or_else(|| "default".into()),
                        "effort": thread.effort,
                        "cwd": thread.cwd,
                        "text": answer,
                        "worktree": worktree,
                        "waitingOn": waiting_on,
                        "resetsAt": (state == "paused").then(|| self.paused_until(&thread.id)).flatten(),
                        "verify": verify.map(|v| v.to_json()),
                        "tokens": tokens(std::slice::from_ref(&thread.id)),
                        "delegatedTokens": tokens(&below),
                    })
                })
                .collect::<Vec<_>>();
            return Ok(json!({ "timedOut": busy, "children": children }));
        }
    }

    /// Stops children of `parent_id` (or theirs) and everything they delegated in turn. A chat
    /// stops only its own subtree: an id from elsewhere is refused before anything stops.
    pub async fn stop_children(&self, parent_id: &str, ids: &[String]) -> Result<Value, String> {
        if ids.is_empty() {
            return Err("no chatIds to stop".into());
        }
        let threads = self.list_threads()?;
        let links: Vec<(String, Option<String>)> = threads.iter().map(|t| (t.id.clone(), t.parent_id.clone())).collect();
        let targets = stop_targets(&links, parent_id, ids)?;
        self.cancel_verify(&targets);
        let mut stopped = Vec::new();
        for thread in targets.iter().filter_map(|id| threads.iter().find(|t| &t.id == id)) {
            // An idle child has no turn to end; it is reported as stopped all the same.
            if thread.status.is_some() || thread.turn_started_at.is_some() {
                self.interrupt(&thread.id).await?;
            }
            stopped.push(json!({ "chatId": thread.id, "title": thread.title }));
        }
        Ok(json!({ "stopped": stopped }))
    }

    pub(super) fn last_answer(&self, thread_id: &str) -> Option<String> {
        let page = self.transcript(thread_id, 0, usize::MAX).ok()?;
        page["messages"]
            .as_array()?
            .iter()
            .rev()
            .find(|m| m["role"] == "assistant")
            .and_then(|m| m["content"].as_str())
            .map(str::to_string)
    }

    pub(super) fn rail_changed(&self) {
        if let Some(notify) = &self.inner.core.lock().on_rail_change {
            notify();
        }
    }
}

/// Every chat delegated under `parent_id`, at any depth. `links` is every chat as (id, parent).
pub(super) fn descendants(links: &[(String, Option<String>)], parent_id: &str) -> Vec<String> {
    let children: Vec<String> =
        links.iter().filter(|(_, p)| p.as_deref() == Some(parent_id)).map(|(i, _)| i.clone()).collect();
    if children.is_empty() {
        return children;
    }
    stop_targets(links, parent_id, &children).unwrap_or_default()
}

/// `ids` and their descendants, after checking each id sits under `parent_id`. `links` is every
/// chat as (id, parent).
fn stop_targets(links: &[(String, Option<String>)], parent_id: &str, ids: &[String]) -> Result<Vec<String>, String> {
    let parent_of = |id: &str| links.iter().find(|(i, _)| i == id).and_then(|(_, p)| p.clone());
    for id in ids {
        if !links.iter().any(|(i, _)| i == id) {
            return Err(format!("no chat {id}"));
        }
        let mut up = parent_of(id);
        let mut hops = 0;
        while let Some(p) = up.as_deref().filter(|p| *p != parent_id) {
            hops += 1;
            up = if hops > 16 { None } else { parent_of(p) };
        }
        if up.is_none() {
            return Err(format!("chat {id} was not delegated by this chat; stop only your own children"));
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut queue: Vec<String> = ids.to_vec();
    while let Some(id) = queue.pop() {
        if out.contains(&id) {
            continue;
        }
        queue.extend(links.iter().filter(|(_, p)| p.as_deref() == Some(id.as_str())).map(|(i, _)| i.clone()));
        out.push(id);
    }
    Ok(out)
}

/// The model to run, as the runner's own list names it, and the efforts that model takes. The
/// lead may say the id, the alias Claude resolves, or the name a person sees ("GPT-6.1 Astra").
fn choose_model(models: &[Value], asked: Option<&str>, provider: &str) -> Result<(Option<String>, Vec<String>), String> {
    let efforts = |m: &Value| -> Vec<String> {
        m["efforts"].as_array().map(|a| a.iter().filter_map(|e| e.as_str().map(str::to_string)).collect()).unwrap_or_default()
    };
    let Some(asked) = asked.map(str::trim).filter(|a| !a.is_empty()) else {
        // The runner's default: Codex marks one, Claude calls it "default". Named by the model it is,
        // so the rail says what the child runs instead of a bare "claude" or "codex".
        let default = models.iter().find(|m| m["isDefault"] == true || m["value"] == "default");
        let name = default.and_then(|m| {
            let value = m["value"].as_str().filter(|v| *v != "default");
            value.or_else(|| m["resolvedModel"].as_str()).filter(|v| !v.is_empty()).map(str::to_string)
        });
        return Ok((name, default.map(efforts).unwrap_or_default()));
    };
    let norm = |s: &str| s.to_lowercase().replace([' ', '_'], "-");
    let names = |m: &Value| ["value", "resolvedModel", "displayName"].map(|key| m[key].as_str().unwrap_or("").to_string());
    // Then by words, as a person says it: "GPT Terra" is gpt-6.1-terra. Several match ("GPT Sol"):
    // the first the runner lists, its newest.
    let words = |s: &str| s.to_lowercase().split(|c: char| !c.is_ascii_alphanumeric() && c != '.').filter(|w| !w.is_empty()).map(str::to_string).collect::<Vec<_>>();
    let found = models
        .iter()
        .find(|m| names(m).iter().any(|v| !v.is_empty() && norm(v) == norm(asked)))
        .or_else(|| {
            let want = words(asked);
            models.iter().find(|m| {
                let have: Vec<String> = names(m).iter().flat_map(|v| words(v)).collect();
                !want.is_empty() && want.iter().all(|w| have.contains(w))
            })
        });
    match found {
        Some(m) => Ok((m["value"].as_str().map(str::to_string), efforts(m))),
        None => {
            let names: Vec<String> = models
                .iter()
                .filter_map(|m| {
                    let value = m["value"].as_str()?;
                    Some(match m["displayName"].as_str() {
                        Some(name) if name != value => format!("{value} ({name})"),
                        _ => value.to_string(),
                    })
                })
                .collect();
            Err(format!("{asked:?} is not a {provider} model here. Pick one of: {}", names.join(", ")))
        }
    }
}

/// Checks an effort against what the model takes. A list that names none says nothing either
/// way, so the effort goes through and the runner decides (Claude drops one it does not know).
fn choose_effort(asked: Option<&str>, efforts: &[String]) -> Result<Option<String>, String> {
    let Some(asked) = asked.map(str::trim).filter(|a| !a.is_empty()) else {
        return Ok(None);
    };
    let asked = asked.to_lowercase();
    if efforts.contains(&asked) {
        return Ok(Some(asked));
    }
    if efforts.is_empty() {
        return Ok(Some(asked));
    }
    Err(format!("effort {asked:?} is not offered for this model. Pick one of: {}", efforts.join(", ")))
}

/// A verifier left on the runner's default ran at low and nearly skipped the full suite, so an
/// unset verifier effort is high, or medium when the model lists efforts without high.
fn reviewer_effort(efforts: &[String]) -> Option<&'static str> {
    ["high", "medium"].into_iter().find(|e| efforts.is_empty() || efforts.iter().any(|x| x == e))
}

pub(super) fn slug(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|w| !w.is_empty())
        .take(4)
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() { "task".into() } else { slug }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models() -> Vec<Value> {
        vec![
            json!({ "value": "default", "displayName": "Default", "efforts": ["low", "medium", "high"] }),
            json!({ "value": "claude-fable-5-1", "resolvedModel": "claude-fable-5-1", "displayName": "Fable 5.1", "efforts": ["low", "high", "max"] }),
            json!({ "value": "gpt-6.1-astra", "displayName": "GPT-6.1 Astra", "efforts": [] }),
        ]
    }

    #[test]
    fn a_model_named_the_way_a_person_says_it() {
        let list = vec![
            json!({ "value": "gpt-6.1-sol", "displayName": "GPT-6.1-Sol", "efforts": [] }),
            json!({ "value": "gpt-6-astra", "displayName": "GPT-6-Astra", "efforts": [] }),
            json!({ "value": "gpt-6.1-terra", "displayName": "GPT-6.1 Terra", "efforts": [] }),
            json!({ "value": "gpt-6-sol", "displayName": "GPT-6-Sol", "efforts": [] }),
        ];
        let pick = |asked: &str| choose_model(&list, Some(asked), "codex").map(|(m, _)| m.unwrap());
        assert_eq!(pick("GPT Terra").unwrap(), "gpt-6.1-terra");
        assert_eq!(pick("terra").unwrap(), "gpt-6.1-terra");
        assert_eq!(pick("GPT Sol").unwrap(), "gpt-6.1-sol");
        assert_eq!(pick("gpt 6 sol").unwrap(), "gpt-6-sol");
        assert!(pick("GPT Luna").is_err());
    }

    #[test]
    fn stop_takes_the_child_and_what_it_delegated_but_only_under_the_caller() {
        let link = |id: &str, parent: Option<&str>| (id.to_string(), parent.map(str::to_string));
        let links = vec![
            link("lead", None),
            link("child", Some("lead")),
            link("grandchild", Some("child")),
            link("sibling", Some("lead")),
            link("other", None),
            link("stranger", Some("other")),
        ];
        let ids = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mut got = stop_targets(&links, "lead", &ids(&["child"])).unwrap();
        got.sort();
        assert_eq!(got, ids(&["child", "grandchild"]));
        assert_eq!(stop_targets(&links, "lead", &ids(&["grandchild"])).unwrap(), ids(&["grandchild"]));
        assert!(stop_targets(&links, "lead", &ids(&["stranger"])).unwrap_err().contains("not delegated by this chat"));
        assert!(stop_targets(&links, "lead", &ids(&["lead"])).is_err());
        assert!(stop_targets(&links, "lead", &ids(&["missing"])).unwrap_err().contains("no chat"));
    }

    #[test]
    fn a_deleted_lead_reaches_every_chat_it_delegated_and_nothing_else() {
        let link = |id: &str, parent: Option<&str>| (id.to_string(), parent.map(str::to_string));
        let links = vec![
            link("lead", None),
            link("child", Some("lead")),
            link("grandchild", Some("child")),
            link("sibling", Some("lead")),
            link("other", None),
            link("stranger", Some("other")),
        ];
        let mut got = descendants(&links, "lead");
        got.sort();
        assert_eq!(got, vec!["child", "grandchild", "sibling"]);
        assert_eq!(descendants(&links, "child"), vec!["grandchild"]);
        assert!(descendants(&links, "grandchild").is_empty());
        assert!(descendants(&links, "missing").is_empty());
    }

    #[test]
    fn a_model_is_found_by_id_or_by_the_name_a_person_says() {
        assert_eq!(choose_model(&models(), Some("Fable 5.1"), "claude").unwrap().0.as_deref(), Some("claude-fable-5-1"));
        assert_eq!(choose_model(&models(), Some("gpt-6.1-astra"), "codex").unwrap().0.as_deref(), Some("gpt-6.1-astra"));
        assert_eq!(choose_model(&models(), Some("GPT 6.1 ASTRA"), "codex").unwrap().0.as_deref(), Some("gpt-6.1-astra"));
        assert_eq!(choose_model(&models(), None, "claude").unwrap(), (None, vec!["low".into(), "medium".into(), "high".into()]));
        let codex = vec![json!({ "value": "gpt-6.1-terra", "isDefault": true, "efforts": [] })];
        assert_eq!(choose_model(&codex, None, "codex").unwrap().0.as_deref(), Some("gpt-6.1-terra"));
        let claude = vec![json!({ "value": "default", "resolvedModel": "claude-sonnet-5-5", "efforts": [] })];
        assert_eq!(choose_model(&claude, None, "claude").unwrap().0.as_deref(), Some("claude-sonnet-5-5"));
    }

    #[test]
    fn an_unknown_model_is_refused_with_the_list() {
        let error = choose_model(&models(), Some("opus-9"), "claude").unwrap_err();
        assert!(error.contains("\"opus-9\" is not a claude model"), "{error}");
        assert!(error.contains("claude-fable-5-1 (Fable 5.1)"), "{error}");
    }

    #[test]
    fn an_effort_must_be_one_the_model_takes() {
        let fable = choose_model(&models(), Some("claude-fable-5-1"), "claude").unwrap().1;
        assert_eq!(choose_effort(Some("High"), &fable).unwrap().as_deref(), Some("high"));
        assert_eq!(choose_effort(None, &fable).unwrap(), None);
        assert!(choose_effort(Some("xhigh"), &fable).unwrap_err().contains("low, high, max"));
        assert_eq!(choose_effort(Some("high"), &[]).unwrap().as_deref(), Some("high"));
        let s = |v: &[&str]| v.iter().map(|e| e.to_string()).collect::<Vec<_>>();
        assert_eq!(reviewer_effort(&[]), Some("high"));
        assert_eq!(reviewer_effort(&s(&["low", "medium"])), Some("medium"));
        assert_eq!(reviewer_effort(&s(&["minimal"])), None);
    }

    #[test]
    fn a_branch_slug_is_short_and_safe() {
        assert_eq!(slug("Nest child threads in the rail!"), "nest-child-threads-in");
        assert_eq!(slug("…"), "task");
    }
}
