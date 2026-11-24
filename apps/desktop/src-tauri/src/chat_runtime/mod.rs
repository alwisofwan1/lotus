//! Runtime for the new Chat module (plans/chat-runtime/PLAN.md, phase 2).
//!
//! One supervised chat bridge serves every thread. Every ThreadEvent it sends is appended to the
//! store, folded into the thread's run state, then pushed to the thread's subscribers. A subscriber
//! first gets everything after the seq it already has, under the same lock that appends, so a
//! reconnect never misses or repeats an event.
//!
//! If the bridge dies, open turns are closed as failed and the next send starts a new bridge that
//! resumes each thread's provider session.

mod api;
mod attachments;
mod auth;
mod bridge;
pub(crate) mod changes;
mod delegate;
mod import;
mod launch;
mod manage;
mod run_state;
mod verify;
mod remote;
mod remote_map;
mod store;
pub(crate) mod title;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub use attachments::{preview as attachment_preview, Attachment};
pub use auth::{AuthMode, AuthView, ChatAuth};
pub use changes::Changes;
use bridge::{Bridge, BridgeMessage};
use changes::{Phase, Snapshot};
pub use delegate::{ChildRequest as ChatChildRequest, DelegateRequest};
pub use manage::{ListRequest as ChatListRequest, ManageRequest as ChatManageRequest};
use run_state::RunState;
use store::Store;
pub use store::{Envelope, RemoteMachine, Stats, ThreadRecord};

pub const PERMISSION_MODES: [&str; 4] = ["default", "acceptEdits", "plan", "bypassPermissions"];
/// The runners with their own bridge code; every `acp` agent in agents.json is a runner too.
const BUILT_IN_RUNNERS: [&str; 3] = ["claude", "codex", "api"];

pub fn is_runner(runner: &str) -> bool {
    BUILT_IN_RUNNERS.contains(&runner) || crate::agent_catalog::is_acp_runner(runner)
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    /// CodeChat chats not imported before this call.
    pub pending: usize,
    pub imported: usize,
}

/// Gets each envelope; returns false once it can no longer deliver (closed webview).
pub type Sink = Box<dyn Fn(&Envelope) -> bool + Send>;

#[derive(Debug, Deserialize)]
#[serde(tag = "behavior", rename_all = "camelCase")]
pub enum Decision {
    /// `answers` answers a question: question text → the chosen labels, or the user's own words.
    Allow {
        #[serde(default)]
        answers: Option<BTreeMap<String, String>>,
        /// Keep the Allow for the rest of the session, where the request offered it.
        #[serde(default)]
        remember: bool,
    },
    Deny { message: String },
}

#[derive(Clone)]
pub struct ChatRuntime {
    inner: Arc<Inner>,
}

struct Inner {
    core: Mutex<Core>,
    /// The current bridge. Read without waiting, so interrupt, stop and approvals never queue
    /// behind a bridge or session that is still starting.
    bridge: Mutex<Option<(u64, Arc<Bridge>)>>,
    /// Held while a bridge spawns, so two sends cannot start two bridges.
    spawning: tokio::sync::Mutex<()>,
    /// Held per thread while its session starts, so two sends cannot start the same session twice.
    starting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The sign-in each new session starts with.
    auth: ChatAuth,
    /// Threads whose agent runs on an SSH machine's Lotus Host (`remote.rs`).
    remote: Mutex<remote::Remote>,
}

struct Core {
    store: Result<Store, String>,
    runs: HashMap<String, RunState>,
    subscribers: HashMap<String, Vec<(u64, Sink)>>,
    /// Told when a thread's place in the rail may have changed (Command Rail), so it refetches now.
    on_rail_change: Option<Box<dyn Fn() + Send>>,
    next_subscription: u64,
    bridge_generation: u64,
    /// Threads whose title is being made in this run, so two quick sends make one.
    titling: HashSet<String>,
    /// Delegate Verify loops in this run, by the verified child's id (lost on restart).
    verifies: HashMap<String, verify::VerifyState>,
    /// Delegated chats with a resume already scheduled for their quota reset.
    resumes: HashSet<String>,
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl ChatRuntime {
    /// A store that cannot open does not stop Lotus; every chat call then reports why.
    pub fn open(db_path: &Path) -> Self {
        Self::with_store(Store::open(db_path))
    }

    fn with_store(store: Result<Store, String>) -> Self {
        if let Err(error) = &store {
            eprintln!("[chat-runtime] chat store unavailable: {error}");
        }
        let core = Core {
            store,
            runs: HashMap::new(),
            subscribers: HashMap::new(),
            on_rail_change: None,
            next_subscription: 1,
            bridge_generation: 0,
            titling: HashSet::new(),
            verifies: HashMap::new(),
            resumes: HashSet::new(),
        };
        Self {
            inner: Arc::new(Inner {
                core: Mutex::new(core),
                bridge: Mutex::new(None),
                spawning: tokio::sync::Mutex::new(()),
                starting: Mutex::new(HashMap::new()),
                auth: ChatAuth::open(),
                remote: Mutex::new(remote::Remote::default()),
            }),
        }
    }

    pub fn create_thread(
        &self,
        cwd: &str,
        model: Option<String>,
        permission_mode: Option<String>,
        runner: Option<String>,
        effort: Option<String>,
        provider: Option<String>,
        id: Option<String>,
    ) -> Result<ThreadRecord, String> {
        self.create(cwd, model, permission_mode, runner, effort, provider, id, None)
    }

    /// A thread whose agent runs on `machine`'s Lotus Host; `cwd` is the project's path there.
    #[allow(clippy::too_many_arguments)]
    pub fn create_remote_thread(
        &self,
        machine: RemoteMachine,
        cwd: &str,
        model: Option<String>,
        permission_mode: Option<String>,
        runner: Option<String>,
        effort: Option<String>,
        id: Option<String>,
    ) -> Result<ThreadRecord, String> {
        if !matches!(runner.as_deref(), None | Some("claude") | Some("codex")) {
            return Err("a chat on another machine runs claude or codex".into());
        }
        self.create(cwd, model, permission_mode, runner, effort, None, id, Some(machine))
    }

    #[allow(clippy::too_many_arguments)]
    fn create(
        &self,
        cwd: &str,
        model: Option<String>,
        permission_mode: Option<String>,
        runner: Option<String>,
        effort: Option<String>,
        provider: Option<String>,
        id: Option<String>,
        machine: Option<RemoteMachine>,
    ) -> Result<ThreadRecord, String> {
        // The new-chat screen names the chat before it exists, so files pasted there are already in
        // the chat's own `chat-attachments/<id>` and go with it.
        let id = match id {
            Some(id) => uuid::Uuid::parse_str(&id).map_err(|_| format!("{id:?} is not a chat id"))?.to_string(),
            None => uuid::Uuid::new_v4().to_string(),
        };
        // An API chat touches no files (#288); without a folder it sits in the home folder.
        let cwd = if runner.as_deref() == Some("api") && cwd.trim().is_empty() {
            crate::paths::home_dir().to_string_lossy().into_owned()
        } else {
            cwd.to_string()
        };
        let cwd = cwd.as_str();
        // A remote thread's folder is on the machine; the host checks it at spawn.
        if machine.is_none() && !Path::new(cwd).is_dir() {
            return Err(format!("{cwd} is not a folder"));
        }
        let permission_mode = permission_mode.unwrap_or_else(|| "default".into());
        if !PERMISSION_MODES.contains(&permission_mode.as_str()) {
            return Err(format!("unknown permission mode {permission_mode}"));
        }
        let runner = runner.unwrap_or_else(|| "claude".into());
        if !is_runner(&runner) {
            return Err(format!("unknown runner {runner}"));
        }
        // An API thread is fixed to one registry provider; the others have none.
        let provider = if runner == "api" {
            let id = provider.filter(|p| !p.trim().is_empty()).ok_or("pick an API provider's model")?;
            Some(api::provider(&id)?.id)
        } else {
            None
        };
        // Pinned at creation, so a later "Use" moves only new chats. The machine has its own.
        let account = match runner.as_str() {
            _ if machine.is_some() => None,
            "claude" => crate::usage::chosen_account().map(|a| a.id),
            "codex" => crate::usage::chosen_codex_account().map(|a| a.id),
            _ => None,
        };
        let at = now_ms();
        let record = ThreadRecord {
            id,
            cwd: cwd.to_string(),
            model: model.filter(|m| !m.trim().is_empty()),
            permission_mode,
            runner,
            provider,
            effort: effort.filter(|e| !e.trim().is_empty()),
            provider_session_id: None,
            account,
            created_at: at,
            updated_at: at,
            title: None,
            imported_from: None,
            archived: false,
            pinned_at: None,
            last_turn_ended_at: None,
            last_read_at: None,
            turn_started_at: None,
            status: None,
            link: None,
            parent_id: None,
            machine,
            agent_name: None,
        };
        let mut core = self.inner.core.lock();
        let store = core.store()?;
        if store.thread(&record.id)?.is_some() {
            return Err(format!("chat {} already exists", record.id));
        }
        store.create_thread(&record)?;
        Ok(record)
    }

    /// The runner's own model list (#278, #286): Claude's for the current sign-in, or Codex's.
    pub async fn list_models(&self, runner: &str) -> Result<Value, String> {
        if runner == "api" {
            return Ok(api::models());
        }
        let bridge = self.ensure_bridge().await?;
        let params = if runner != "claude" {
            json!({ "runner": runner })
        } else {
            json!({ "auth": self.inner.auth.session_auth(None)? })
        };
        bridge.request("models/list", params).await
    }

    /// What `/` offers in a folder, asked of the agent itself. The API runner has none.
    pub async fn list_commands(&self, runner: &str, cwd: &str) -> Result<Value, String> {
        if runner == "api" {
            return Ok(json!({ "commands": [], "skillNames": [] }));
        }
        let bridge = self.ensure_bridge().await?;
        let params = if runner != "claude" {
            json!({ "runner": runner, "cwd": cwd })
        } else {
            json!({ "runner": "claude", "cwd": cwd, "auth": self.inner.auth.session_auth(None)? })
        };
        bridge.request("commands/list", params).await
    }

    /// Switches the thread's model from its next message, and records the switch in the thread so
    /// the header and a replay show it. A thread without a live session starts on it next time.
    pub async fn set_model(
        &self,
        thread_id: &str,
        model: &str,
        effort: Option<&str>,
        label: &str,
    ) -> Result<(), String> {
        if model.trim().is_empty() {
            return Err("no model picked".into());
        }
        // Not while its session starts, or that session could start on the old model.
        let start_lock = self.start_lock(thread_id);
        let _starting = start_lock.lock().await;
        if let Some(bridge) = self.live_bridge(thread_id) {
            let mut params = json!({ "threadId": thread_id, "model": model });
            if let Some(effort) = effort {
                params["effort"] = json!(effort);
            }
            bridge.request("thread/setModel", params).await?;
        }
        let mut event = json!({ "type": "session/modelChanged", "model": model, "label": label });
        if let Some(effort) = effort {
            event["effort"] = json!(effort);
        }
        let mut core = self.inner.core.lock();
        core.run(thread_id)?;
        core.ingest(thread_id, event)
    }

    /// Moves a Claude thread to another ccs account (subscription-usage step 4). A live session is
    /// stopped; the next message starts it on the new account with `--resume`, which keeps the
    /// whole conversation: ccs accounts share one `projects/` dir (verified 2026-11-02, initech →
    /// acme recalled a code word from the first turn), and for any other pair the start copies
    /// the transcript over first (`fs_browse::ensure_claude_session_in`).
    pub async fn set_account(&self, thread_id: &str, account: &str) -> Result<(), String> {
        if crate::usage::account_dir(account).is_none() {
            return Err(format!("no Claude account named {account}"));
        }
        let start_lock = self.start_lock(thread_id);
        let _starting = start_lock.lock().await;
        {
            let mut core = self.inner.core.lock();
            let record = core.store()?.thread(thread_id)?.ok_or_else(|| format!("unknown thread {thread_id}"))?;
            if record.runner != "claude" {
                return Err("only a Claude chat runs on a Claude account".into());
            }
            if core.run(thread_id)?.active_turn.is_some() {
                return Err("wait for the reply to finish, then switch".into());
            }
            if record.machine.is_some() {
                return Err("a chat on another machine runs on that machine's account".into());
            }
        }
        self.stop_for_restart(thread_id).await?;
        let mut core = self.inner.core.lock();
        core.run(thread_id)?;
        core.ingest(thread_id, json!({ "type": "session/accountChanged", "account": account }))
    }

    /// Changes what the agent may do without asking. A permission mode is fixed when a session
    /// starts, so a live one is stopped the way `set_account` does; the next message resumes the
    /// same conversation in the new mode. `label` is what the switch line in the chat says.
    pub async fn set_permission_mode(&self, thread_id: &str, mode: &str, label: &str) -> Result<(), String> {
        if !matches!(mode, "plan" | "default" | "acceptEdits" | "bypassPermissions") {
            return Err(format!("unknown permission mode {mode}"));
        }
        let start_lock = self.start_lock(thread_id);
        let _starting = start_lock.lock().await;
        let remote = {
            let mut core = self.inner.core.lock();
            let record = core.store()?.thread(thread_id)?.ok_or_else(|| format!("unknown thread {thread_id}"))?;
            if record.runner == "api" {
                return Err("a text-only chat has no permissions to change".into());
            }
            if core.run(thread_id)?.active_turn.is_some() {
                return Err("wait for the reply to finish, then switch".into());
            }
            record.machine.map(|m| (m, record.runner))
        };
        match remote {
            // The host moves a running cell's mode in place; no session to restart here.
            Some((machine, runner)) => self.remote_posture(&machine, &runner, mode).await?,
            None => self.stop_for_restart(thread_id).await?,
        }
        let mut core = self.inner.core.lock();
        core.run(thread_id)?;
        core.ingest(thread_id, json!({ "type": "session/permissionChanged", "mode": mode, "label": label }))
    }

    /// Stops a live session and waits until the bridge has freed the thread: a start before that is refused.
    async fn stop_for_restart(&self, thread_id: &str) -> Result<(), String> {
        let Some(bridge) = self.live_bridge(thread_id) else {
            return Ok(());
        };
        bridge.request("thread/stop", json!({ "threadId": thread_id })).await?;
        let mut waited = 0;
        while self.live_bridge(thread_id).is_some() {
            if waited >= 50 {
                return Err("the old session did not stop; try again".into());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            waited += 1;
        }
        Ok(())
    }

    /// Fork and rewind work on this Mac's files and sessions; a remote thread has neither here.
    fn local_only(&self, thread_id: &str) -> Result<(), String> {
        match self.machine_of(thread_id)? {
            Some(machine) => Err(format!("not available yet for a chat on {}", machine.host)),
            None => Ok(()),
        }
    }

    fn start_lock(&self, thread_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(
            self.inner
                .starting
                .lock()
                .entry(thread_id.to_string())
                .or_default(),
        )
    }

    /// Saves pasted content for `thread_id`, which has no file of its own (#279).
    pub fn save_pasted(
        &self,
        thread_id: &str,
        name: &str,
        mime_type: Option<String>,
        data_base64: &str,
    ) -> Result<Attachment, String> {
        if uuid::Uuid::parse_str(thread_id).is_err() {
            return Err(format!("unknown thread {thread_id}"));
        }
        let dir = crate::paths::lotus_state_dir().join("chat-attachments").join(thread_id);
        attachments::save_pasted(&dir, name, mime_type, data_base64)
    }

    pub fn auth(&self) -> &ChatAuth {
        &self.inner.auth
    }

    /// Called on every event that can move a thread in the rail: a turn starting or ending, an
    /// approval asked or answered, a session ending.
    pub fn on_rail_change(&self, notify: impl Fn() + Send + 'static) {
        self.inner.core.lock().on_rail_change = Some(Box::new(notify));
    }

    /// Every thread, newest first, each with what it is doing in this Lotus run.
    pub fn list_threads(&self) -> Result<Vec<ThreadRecord>, String> {
        // Read before the core lock: `with_map` takes remote then core, so never the reverse.
        let trouble = self.remote_trouble();
        let mut core = self.inner.core.lock();
        let mut threads = core.store()?.list_threads()?;
        for thread in &mut threads {
            thread.link = trouble.get(&thread.id).copied();
            let run = core.runs.get(&thread.id);
            thread.turn_started_at = run.and_then(|run| run.active_turn.as_ref().map(|(.., at)| *at));
            thread.status = run.and_then(|run| {
                if !run.pending_interactions.is_empty() {
                    Some("waiting")
                } else {
                    run.active_turn.as_ref().map(|_| "working")
                }
            });
        }
        Ok(threads)
    }

    /// Settings' "Import CodeChat history" (#290): adds every CodeChat chat not imported yet, or
    /// with `dry_run` only counts them. Safe to repeat; CodeChat's own database is only read.
    pub fn import_codechat(&self, db_path: &Path, dry_run: bool) -> Result<ImportReport, String> {
        let home = crate::paths::home_dir().to_string_lossy().into_owned();
        let sessions = import::read(db_path, &home)?;
        let mut core = self.inner.core.lock();
        let store = core.store()?;
        let mut report = ImportReport::default();
        for session in sessions {
            if store.is_imported(session.record.imported_from.as_deref().unwrap_or_default())? {
                continue;
            }
            report.pending += 1;
            if !dry_run {
                store.import_thread(&session.record, &session.events)?;
                report.imported += 1;
            }
        }
        Ok(report)
    }

    /// Settings' "Fetch models" for an API provider (#288).
    pub async fn api_models(base_url: &str, api_key: Option<&str>, provider_id: Option<&str>) -> Result<Vec<String>, String> {
        api::fetch_models(base_url, api_key, provider_id).await
    }

    /// A chat's messages `from..from+limit`, for another agent continuing it (`lotus_chat_read`).
    pub fn transcript(&self, thread_id: &str, from: usize, limit: usize) -> Result<Value, String> {
        let mut core = self.inner.core.lock();
        let store = core.store()?;
        let thread = store.thread(thread_id)?.ok_or_else(|| format!("no chat {thread_id}"))?;
        let messages = api::history(&store::live(store.events_after(thread_id, 0)?));
        let page: Vec<&Value> = messages.iter().skip(from).take(limit).collect();
        Ok(json!({
            "chatId": thread.id,
            "title": thread.title,
            "runner": thread.runner,
            "cwd": thread.cwd,
            "total": messages.len(),
            "from": from,
            "messages": page,
        }))
    }

    /// The first message of a chat that continues `thread_id` in the `to` runner (handoff). Claude
    /// and Codex get the last turn and read the rest with `lotus_chat_read`; the API agent has no
    /// tools, so it gets as much of the chat as fits.
    pub fn handoff_seed(&self, thread_id: &str, to: &str) -> Result<String, String> {
        const TURN_CHARS: usize = 2_000;
        const API_CHARS: usize = 24_000;
        let mut core = self.inner.core.lock();
        let store = core.store()?;
        let thread = store.thread(thread_id)?.ok_or_else(|| format!("no chat {thread_id}"))?;
        let messages = api::history(&store::live(store.events_after(thread_id, 0)?));
        drop(core);
        let line = |m: &Value, cap: usize| {
            let who = if m["role"] == "user" { "User" } else { "Assistant" };
            let text = m["content"].as_str().unwrap_or_default();
            let cut: String = text.chars().take(cap).collect();
            format!("{who}: {cut}{}", if cut.len() < text.len() { " […]" } else { "" })
        };
        let (budget, cap, keep) = if to == "api" { (API_CHARS, API_CHARS, usize::MAX) } else { (usize::MAX, TURN_CHARS, 2) };
        let mut lines: Vec<String> = Vec::new();
        let mut used = 0;
        for message in messages.iter().rev().take(keep) {
            let next = line(message, cap);
            if used + next.len() > budget && !lines.is_empty() {
                break;
            }
            used += next.len();
            lines.push(next);
        }
        lines.reverse();
        let title = thread.title.as_deref().unwrap_or("untitled");
        let earlier = messages.len() - lines.len();
        let read = if to == "api" || earlier == 0 {
            String::new()
        } else {
            format!("\n\n{earlier} earlier messages are not shown. Read them with the lotus_chat_read tool (chatId \"{thread_id}\") when the task needs them.")
        };
        Ok(format!(
            "<lotus-handoff chat=\"{thread_id}\" from=\"{}\">\nThis continues the chat \"{title}\", which ran in {} in {}. The last messages:\n\n{}{read}\n</lotus-handoff>",
            thread.runner,
            thread.runner,
            thread.cwd,
            lines.join("\n\n"),
        ))
    }

    pub fn stats_since(&self, since: i64) -> Result<Stats, String> {
        self.inner.core.lock().store()?.stats_since(since)
    }

    /// Starts a turn, or steers the running one (the provider decides which; see PLAN finding 1).
    pub async fn send(
        &self,
        thread_id: &str,
        text: &str,
        client_request_id: &str,
        attachments: Vec<Attachment>,
    ) -> Result<(), String> {
        if text.trim().is_empty() && attachments.is_empty() {
            return Err("message is empty".into());
        }
        if let Some(machine) = self.machine_of(thread_id)? {
            let total: u64 = attachments.iter().filter_map(|a| a.size_bytes).sum();
            if total > attachments::MAX_REMOTE_MESSAGE_BYTES {
                return Err("these attachments are too large together; one message takes up to 25 MB".into());
            }
            // The composer copies on attach; the start screen has no thread yet, so its files go now.
            let mut copied = Vec::with_capacity(attachments.len());
            for a in attachments {
                copied.push(if a.remote.is_some() { a } else { self.upload_attachment(thread_id, a, Arc::new(|_| {})).await? });
            }
            self.start_title(thread_id, text);
            return self.remote_send(thread_id, machine, text, client_request_id, &copied).await;
        }
        let attachments = attachments
            .into_iter()
            .map(attachments::checked)
            .collect::<Result<Vec<_>, _>>()?;
        // A message that starts a new turn: the folder as it is before the agent can act (#281).
        let idle = self.inner.core.lock().run(thread_id)?.active_turn.is_none();
        if idle {
            let runtime = self.clone();
            let thread_id = thread_id.to_string();
            let _ = tokio::task::spawn_blocking(move || runtime.snapshot(&thread_id, Phase::Before)).await;
        }
        self.start_title(thread_id, text);
        let bridge = self.ensure_session(thread_id).await?;
        // shortcut: a remote thread (remote_send above) is not told its name; pass it to the host when that matters.
        let agent_name = self.inner.core.lock().store()?.thread(thread_id)?.and_then(|r| r.agent_name);
        bridge
            .request(
                "turn/start",
                json!({ "threadId": thread_id, "text": text, "clientRequestId": client_request_id, "attachments": attachments, "agentName": agent_name }),
            )
            .await
            .map(|_| ())
    }

    /// Names the thread from its first message, in the background (plans/chat-auto-title). Until
    /// then, and if it fails, the rail shows the message's first line. Never over a rename.
    fn start_title(&self, thread_id: &str, text: &str) {
        let (provider, auth) = {
            let mut core = self.inner.core.lock();
            let Ok(store) = core.store() else { return };
            let Ok(Some(record)) = store.thread(thread_id) else { return };
            if !store.needs_title(thread_id).unwrap_or(false) || !title::worth_generating(text) {
                return;
            }
            if title::provider_of(&record.runner).is_none() || !core.titling.insert(thread_id.to_string()) {
                return;
            }
            match self.titler(&record) {
                Ok(titler) => titler,
                Err(error) => return eprintln!("[chat-title] {} no sign-in: {error}", short(thread_id)),
            }
        };
        let inner = Arc::downgrade(&self.inner);
        let (thread_id, text) = (thread_id.to_string(), text.to_string());
        tokio::spawn(async move {
            let started = std::time::Instant::now();
            let made = title::generate(provider, &auth, &title::material(&text)).await;
            let ms = started.elapsed().as_millis();
            let Some(inner) = inner.upgrade() else { return };
            let mut core = inner.core.lock();
            let outcome = made.and_then(|title| {
                let applied = core.store()?.apply_generated_title(&thread_id, &title)?;
                Ok((title, applied))
            });
            match outcome {
                Ok((title, true)) => {
                    eprintln!("[chat-title] {} {title:?} {ms}ms", short(&thread_id));
                    if let Some(notify) = &core.on_rail_change {
                        notify();
                    }
                }
                Ok((title, false)) => eprintln!("[chat-title] {} kept the user's name over {title:?}", short(&thread_id)),
                Err(error) => eprintln!("[chat-title] {} failed after {ms}ms: {error}", short(&thread_id)),
            }
        });
    }

    /// Who titles `record` and on which sign-in: its own family; a Claude chat on its own account.
    fn titler(&self, record: &ThreadRecord) -> Result<(crate::pane_title::TitleProvider, Value), String> {
        let provider = title::provider_of(&record.runner).ok_or("an API chat keeps its first message as its title")?;
        let auth = match provider {
            crate::pane_title::TitleProvider::Claude => self.inner.auth.session_auth(record.account.as_deref())?,
            crate::pane_title::TitleProvider::Codex => Value::Null,
        };
        Ok((provider, auth))
    }

    /// The thread menu's "Regenerate title" (bb #6427): from the whole chat so far, and asked for,
    /// so it replaces any title, a rename too. On failure the title stays and the error says why.
    pub async fn regenerate_title(&self, thread_id: &str) -> Result<String, String> {
        let (provider, auth, material, current) = {
            let mut core = self.inner.core.lock();
            let store = core.store()?;
            let record = store.thread(thread_id)?.ok_or_else(|| format!("unknown thread {thread_id}"))?;
            let material = title::regenerate_material(&store::live(store.events_after(thread_id, 0)?), record.title.as_deref())
                .ok_or("this chat has no message to make a title from")?;
            let (provider, auth) = self.titler(&record)?;
            (provider, auth, material, record.title)
        };
        let started = std::time::Instant::now();
        let made = title::generate(provider, &auth, &material).await;
        let ms = started.elapsed().as_millis();
        let title = made.map_err(|error| {
            eprintln!("[chat-title] {} regenerate failed after {ms}ms: {error}", short(thread_id));
            format!("Could not regenerate the title, so it was kept: {error}")
        })?;
        eprintln!("[chat-title] {} regenerated {title:?} {ms}ms", short(thread_id));
        if current.as_deref() != Some(title.as_str()) {
            let mut core = self.inner.core.lock();
            core.store()?.set_generated_title(thread_id, &title)?;
            if let Some(notify) = &core.on_rail_change {
                notify();
            }
        }
        Ok(title)
    }

    /// Records the thread's folder as it is now. Not a git repository: nothing to record.
    fn snapshot(&self, thread_id: &str, phase: Phase) {
        let Ok((cwd, seq)) = (|| {
            let mut core = self.inner.core.lock();
            let store = core.store()?;
            let cwd = store.thread(thread_id)?.ok_or("unknown thread")?.cwd;
            Ok::<_, String>((cwd, store.last_seq(thread_id)?))
        })() else {
            return;
        };
        let Some(repo) = changes::repo_root(&cwd) else { return };
        match changes::snapshot(&repo) {
            Ok(tree) => {
                let snapshot = Snapshot { seq, phase, tree };
                let added = self.inner.core.lock().store().and_then(|s| s.add_snapshot(thread_id, &snapshot));
                if let Err(error) = added {
                    eprintln!("[chat-runtime] snapshot for {thread_id} not saved: {error}");
                }
            }
            Err(error) => eprintln!("[chat-runtime] snapshot for {thread_id} failed: {error}"),
        }
    }

    /// Everything the Changes drawer reads: the thread's folder, its events and its snapshots.
    fn changes_context(&self, thread_id: &str) -> Result<(String, Vec<Envelope>, Vec<Snapshot>), String> {
        let mut core = self.inner.core.lock();
        let store = core.store()?;
        let cwd = store
            .thread(thread_id)?
            .ok_or_else(|| format!("unknown thread {thread_id}"))?
            .cwd;
        Ok((cwd, store.events_after(thread_id, 0)?, store.snapshots(thread_id)?))
    }

    pub fn changes(&self, thread_id: &str) -> Result<Changes, String> {
        let (cwd, events, snapshots) = self.changes_context(thread_id)?;
        if self.machine_of(thread_id)?.is_some() {
            return Ok(changes::remote(&cwd, &events));
        }
        let mut listed = changes::list(&cwd, &events, &snapshots)?;
        listed.delegated = self.lead_cwd(thread_id)?.and_then(|lead| changes::delegated(&cwd, &lead));
        Ok(listed)
    }

    /// The folder of the chat that delegated this one, if any.
    fn lead_cwd(&self, thread_id: &str) -> Result<Option<String>, String> {
        let mut core = self.inner.core.lock();
        let store = core.store()?;
        let parent = store.thread(thread_id)?.and_then(|t| t.parent_id);
        Ok(match parent {
            Some(id) => store.thread(&id)?.map(|t| t.cwd),
            None => None,
        })
    }

    /// Merges a delegated chat's worktree branch into its lead's branch; returns the merge commit.
    pub fn merge_child(&self, thread_id: &str) -> Result<String, String> {
        let cwd = self.changes_context(thread_id)?.0;
        let lead = self.lead_cwd(thread_id)?.ok_or("this chat was not delegated by another chat")?;
        changes::merge(&cwd, &lead)
    }

    /// A new chat holding this one's conversation through `turn_id` (mockups/chat-fork-turn.html).
    /// Same runner, model, folder and account; it nests under the original on the rail. Its first
    /// session branches the provider's session at the turn's fork point (`fork_at`), so the
    /// original's own session is never continued by the fork.
    pub fn fork(&self, thread_id: &str, turn_id: &str) -> Result<ThreadRecord, String> {
        self.local_only(thread_id)?;
        let mut core = self.inner.core.lock();
        let store = core.store()?;
        let source = store.thread(thread_id)?.ok_or_else(|| format!("unknown thread {thread_id}"))?;
        let events = store.events_after(thread_id, 0)?;
        let end = events
            .iter()
            .position(|e| store::event_type(&e.event) == "turn/completed" && e.event["turnId"] == turn_id)
            .ok_or("that turn has not finished")?;
        let done = &events[end].event;
        if done["status"] != "completed" {
            return Err("only a turn that finished can be forked".into());
        }
        let fork_point = done.get("forkPoint").and_then(Value::as_str).map(str::to_string);
        if source.runner != "api" && fork_point.is_none() {
            return Err("Lotus did not record a fork point for this turn".into());
        }
        let turn = events[..=end].iter().filter(|e| store::event_type(&e.event) == "turn/started").count();
        let title = source.title.clone().unwrap_or_else(|| "Chat".into());
        let at = now_ms();
        let record = ThreadRecord {
            id: uuid::Uuid::new_v4().to_string(),
            title: Some(format!("{title} (fork)")),
            provider_session_id: None,
            created_at: at,
            updated_at: at,
            imported_from: None,
            archived: false,
            pinned_at: None,
            last_turn_ended_at: None,
            last_read_at: None,
            turn_started_at: None,
            status: None,
            link: None,
            parent_id: None,
            machine: None,
            // A fork is another agent: it draws its own name when opened.
            agent_name: None,
            ..source.clone()
        };
        store.create_thread(&record)?;
        // Through `append`, so the copied session/configured and switches set the fork's session
        // id, model and account as they were at that turn.
        let mut fill = || -> Result<(), String> {
            for e in &events[..=end] {
                store.append(&record.id, e.at, e.event.clone())?;
            }
            let marker = json!({ "type": "thread/forked", "fromThreadId": source.id, "fromTitle": title, "turn": turn, "turnId": turn_id });
            store.append(&record.id, at, marker)?;
            store.set_parent(&record.id, &source.id)?;
            match (&fork_point, source.runner.as_str()) {
                (Some(point), "claude" | "codex") => store.set_fork_at(&record.id, point),
                _ => Ok(()),
            }
        };
        if let Err(error) = fill() {
            let _ = store.delete_thread(&record.id);
            return Err(error);
        }
        let record = store.thread(&record.id)?.ok_or("the fork was not saved")?;
        drop(core);
        self.rail_changed();
        Ok(record)
    }

    /// Edits a sent message, in this chat (mockups/chat-user-actions.html, like bb): the chat goes
    /// back to just before `turn_id`, and the caller then sends the new text. Its session branches
    /// at the turn before, as a fork does, so the provider forgets that turn and all after it; a
    /// `thread/rewound` marker hides them in the timeline. The events stay in the store. Files the
    /// agent changed are not put back.
    pub async fn rewind(&self, thread_id: &str, turn_id: &str) -> Result<(), String> {
        self.local_only(thread_id)?;
        let start_lock = self.start_lock(thread_id);
        let _starting = start_lock.lock().await;
        if self.inner.core.lock().run(thread_id)?.active_turn.is_some() {
            return Err("wait for the reply to finish".into());
        }
        // Checked before the live session stops, so a refused edit leaves the chat as it was.
        let (session, fork_at) = {
            let mut core = self.inner.core.lock();
            let store = core.store()?;
            let runner = store.thread(thread_id)?.ok_or_else(|| format!("unknown thread {thread_id}"))?.runner;
            let events = store::live(store.events_after(thread_id, 0)?);
            let start = events
                .iter()
                .position(|e| store::event_type(&e.event) == "turn/started" && e.event["turnId"] == turn_id)
                .ok_or("that message is no longer in this chat")?;
            let before = &events[..start];
            let previous = before.iter().rev().find(|e| store::event_type(&e.event) == "turn/completed");
            match (runner.as_str(), previous) {
                // The API agent's history is the timeline itself; the first message starts over.
                ("api", _) | (_, None) => (None, None),
                ("claude" | "codex", Some(done)) => {
                    let point = done.event.get("forkPoint").and_then(Value::as_str).ok_or("Lotus did not record where the turn before ended")?;
                    let session = before
                        .iter()
                        .rev()
                        .find_map(|e| (store::event_type(&e.event) == "session/configured").then(|| e.event["providerSessionId"].as_str()).flatten())
                        .ok_or("no session to go back to")?;
                    (Some(session.to_string()), Some(point.to_string()))
                }
                (other, _) => return Err(format!("{other} chats cannot edit a sent message")),
            }
        };
        self.stop_for_restart(thread_id).await?;
        let mut core = self.inner.core.lock();
        core.store()?.set_session(thread_id, session.as_deref(), fork_at.as_deref())?;
        core.ingest(thread_id, json!({ "type": "thread/rewound", "turnId": turn_id }))
    }

    /// Moves a fork that has not worked yet into its own git worktree, its files as they were when
    /// the forked turn ended (the original's `After` snapshot of that turn), on a new branch from
    /// HEAD (mockups/chat-fork-worktree.html). The Changes tab then offers to merge it back.
    pub async fn fork_to_worktree(&self, thread_id: &str) -> Result<ThreadRecord, String> {
        self.local_only(thread_id)?;
        let start_lock = self.start_lock(thread_id);
        let _starting = start_lock.lock().await;
        let (source_cwd, tree, title) = {
            let mut core = self.inner.core.lock();
            if core.run(thread_id)?.active_turn.is_some() {
                return Err("wait for the reply to finish".into());
            }
            let store = core.store()?;
            let events = store.events_after(thread_id, 0)?;
            let marker_at = events
                .iter()
                .position(|e| store::event_type(&e.event) == "thread/forked")
                .ok_or("only a fork can move to a worktree")?;
            let since = &events[marker_at..];
            if since.iter().any(|e| store::event_type(&e.event) == "thread/worktree") {
                return Err("this fork already has its own worktree".into());
            }
            if since.iter().any(|e| store::event_type(&e.event) == "turn/started") {
                return Err("this fork has already worked in the shared folder".into());
            }
            let marker = &events[marker_at].event;
            // Forks made before the marker named its turn: the last turn copied.
            let turn_id = marker["turnId"].as_str().map(str::to_string).or_else(|| {
                events[..marker_at]
                    .iter()
                    .rev()
                    .find(|e| store::event_type(&e.event) == "turn/completed")
                    .and_then(|e| e.event["turnId"].as_str().map(str::to_string))
            });
            let source_id = marker["fromThreadId"].as_str().ok_or("the fork does not name its original")?;
            let source = store.thread(source_id)?.ok_or("the original chat is gone")?;
            let source_events = store.events_after(source_id, 0)?;
            let end = source_events
                .iter()
                .find(|e| store::event_type(&e.event) == "turn/completed" && e.event["turnId"].as_str() == turn_id.as_deref())
                .map(|e| e.seq)
                .ok_or("the forked turn is no longer in the original chat")?;
            let next = source_events
                .iter()
                .find(|e| e.seq > end && store::event_type(&e.event) == "turn/started")
                .map_or(u64::MAX, |e| e.seq);
            let tree = store
                .snapshots(source_id)?
                .into_iter()
                .filter(|s| s.phase == Phase::After && s.seq >= end && s.seq < next)
                .min_by_key(|s| s.seq)
                .map(|s| s.tree)
                .ok_or("Lotus took no snapshot of the folder when that turn ended")?;
            let title = store.thread(thread_id)?.and_then(|t| t.title).unwrap_or_default();
            (source.cwd, tree, title)
        };
        let repo = changes::repo_root(&source_cwd).ok_or("the folder is not in a git repository")?;
        // The chat's place inside the repository, so a chat opened in a subfolder stays in it.
        let inside = std::fs::canonicalize(&source_cwd)
            .ok()
            .and_then(|cwd| cwd.strip_prefix(std::fs::canonicalize(&repo).ok()?).ok().map(Path::to_path_buf))
            .unwrap_or_default();
        let slug = delegate::slug(&title);
        let short = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
        let branch = format!("lotus/f-{slug}-{short}");
        let path = crate::paths::lotus_state_dir().join("chat-worktrees").join(format!("f-{slug}-{short}"));
        let (made_branch, made_path) = (branch.clone(), path.clone());
        tokio::task::spawn_blocking(move || changes::worktree_at(&repo, &tree, &made_branch, &made_path))
            .await
            .map_err(|e| e.to_string())??;
        // A session started meanwhile would still run in the shared folder.
        self.stop_for_restart(thread_id).await?;
        let cwd = path.join(inside).to_string_lossy().into_owned();
        let record = {
            let mut core = self.inner.core.lock();
            core.store()?.set_cwd(thread_id, &cwd)?;
            core.run(thread_id)?;
            core.ingest(thread_id, json!({ "type": "thread/worktree", "branch": branch }))?;
            core.store()?.thread(thread_id)?.ok_or("the fork was not saved")?
        };
        self.rail_changed();
        Ok(record)
    }

    pub fn change_diff(&self, thread_id: &str, path: &str, ignore_whitespace: bool) -> Result<String, String> {
        self.local_only(thread_id)?;
        changes::diff(&self.changes_context(thread_id)?.0, path, ignore_whitespace)
    }

    /// Returns the new commit's short id.
    pub fn commit_changes(&self, thread_id: &str, paths: &[String], message: &str) -> Result<String, String> {
        self.local_only(thread_id)?;
        changes::commit(&self.changes_context(thread_id)?.0, paths, message)
    }

    pub fn undo_changes(&self, thread_id: &str, paths: &[String]) -> Result<(), String> {
        self.local_only(thread_id)?;
        let (cwd, events, snapshots) = self.changes_context(thread_id)?;
        changes::undo(&cwd, paths, &events, &snapshots)
    }

    pub async fn interrupt(&self, thread_id: &str) -> Result<(), String> {
        if let Some(machine) = self.machine_of(thread_id)? {
            return self.remote_interrupt(&machine).await;
        }
        let Some(bridge) = self.live_bridge(thread_id) else {
            return Ok(());
        };
        bridge
            .request("turn/interrupt", json!({ "threadId": thread_id }))
            .await
            .map(|_| ())
    }

    pub async fn stop_thread(&self, thread_id: &str) -> Result<(), String> {
        if self.machine_of(thread_id)?.is_some() {
            self.remote_detach(thread_id);
            return Ok(());
        }
        let Some(bridge) = self.live_bridge(thread_id) else {
            return Ok(());
        };
        bridge
            .request("thread/stop", json!({ "threadId": thread_id }))
            .await
            .map(|_| ())
    }

    /// The rail's Rename (#291); an empty name goes back to the first message's line.
    pub fn rename_thread(&self, thread_id: &str, title: &str) -> Result<(), String> {
        self.inner.core.lock().store()?.rename(thread_id, title)
    }

    /// The thread's Agent Handle (ADR-0068). The frontend picks and checks it; the agent hears it
    /// with the next message (see `turn/start`).
    pub fn set_agent_name(&self, thread_id: &str, name: &str) -> Result<(), String> {
        self.inner.core.lock().store()?.set_agent_name(thread_id, name)
    }

    /// The Command Rail's read mark: opening a thread, or watching it while a turn ends.
    pub fn mark_read(&self, thread_id: &str) -> Result<(), String> {
        self.inner.core.lock().store()?.mark_read(thread_id, now_ms())
    }

    /// Archiving also ends an idle session, so a chat put away holds no agent process.
    pub async fn archive_thread(&self, thread_id: &str, archived: bool) -> Result<(), String> {
        self.inner.core.lock().store()?.set_archived(thread_id, archived)?;
        if archived {
            self.stop_if_idle(thread_id, i64::MAX).await?;
        }
        Ok(())
    }

    /// Ends every session unused for `idle_ms`. The next message resumes it, so nothing is lost;
    /// until then the agent process is not held for a chat nobody is in.
    pub async fn reap_idle_sessions(&self, idle_ms: i64) {
        let cutoff = now_ms() - idle_ms;
        let idle: Vec<String> = {
            let core = self.inner.core.lock();
            core.runs.iter().filter(|(_, run)| run.idle_since(cutoff)).map(|(id, _)| id.clone()).collect()
        };
        for thread_id in idle {
            if let Err(error) = self.stop_if_idle(&thread_id, cutoff).await {
                eprintln!("[chat-runtime] idle session {thread_id} not stopped: {error}");
            }
        }
    }

    /// Stops the session only if it is still idle once no send can be starting it.
    async fn stop_if_idle(&self, thread_id: &str, cutoff: i64) -> Result<(), String> {
        let start_lock = self.start_lock(thread_id);
        let _starting = start_lock.lock().await;
        let idle = self.inner.core.lock().runs.get(thread_id).is_some_and(|run| run.idle_since(cutoff));
        if idle {
            self.stop_thread(thread_id).await?;
        }
        Ok(())
    }

    pub fn pin_thread(&self, thread_id: &str, pinned: bool) -> Result<(), String> {
        self.inner.core.lock().store()?.set_pinned(thread_id, pinned.then(now_ms))
    }

    /// Removes chat worktrees (`chat-worktrees/`) that no chat works in any more, when that loses
    /// nothing (`changes::reap_worktree`). With `None`, every one there: the sweep at start, which
    /// catches worktrees whose work reached the main branch some other way.
    pub fn reap_worktrees(&self, only: Option<Vec<std::path::PathBuf>>) {
        let root = crate::paths::lotus_state_dir().join("chat-worktrees");
        let in_use: HashSet<_> = match self.list_threads() {
            Ok(threads) => threads.iter().filter_map(|t| chat_worktree(&t.cwd)).collect(),
            Err(error) => return eprintln!("[chat-runtime] worktree sweep skipped: {error}"),
        };
        let candidates = only.unwrap_or_else(|| {
            std::fs::read_dir(&root).into_iter().flatten().flatten().map(|e| e.path()).collect()
        });
        for path in candidates.into_iter().filter(|p| p.is_dir() && p.starts_with(&root) && !in_use.contains(p)) {
            match changes::reap_worktree(&path) {
                Ok(()) => eprintln!("[chat-runtime] removed unused worktree {}", path.display()),
                Err(why) => eprintln!("[chat-runtime] kept worktree {}: {why}", path.display()),
            }
        }
    }

    /// The Branch card's Discard: drops a delegated or forked chat with its worktree and branch,
    /// unmerged commits and uncommitted files included. Returns the branch. Refused while another
    /// chat works in that worktree, and for a chat not in a chat worktree (its folder is the user's).
    pub async fn discard_child(&self, thread_id: &str) -> Result<String, String> {
        let threads = self.list_threads()?;
        let thread = threads.iter().find(|t| t.id == thread_id).ok_or_else(|| format!("unknown thread {thread_id}"))?;
        let worktree = chat_worktree(&thread.cwd).ok_or("this chat does not work in a chat worktree")?;
        let sharers: Vec<(String, Option<String>, bool)> = threads
            .iter()
            .map(|t| (t.id.clone(), t.parent_id.clone(), chat_worktree(&t.cwd).as_ref() == Some(&worktree)))
            .collect();
        let own = own_worktree_chats(&sharers, thread_id).ok_or("another chat works in the same worktree")?;
        self.cancel_verify(&[thread_id.to_string()]);
        self.stop_thread(thread_id).await?;
        // Its own verifiers lose their folder with it, so they go too.
        for id in &own {
            self.delete_thread(id).await?;
        }
        let branch = {
            let worktree = worktree.clone();
            tokio::task::spawn_blocking(move || changes::discard_worktree(&worktree)).await.map_err(|e| e.to_string())??
        };
        self.delete_thread(thread_id).await?;
        Ok(branch)
    }

    /// The rail's Delete (#291): stops a running turn first, then drops the thread's history,
    /// snapshots and the pasted files no other chat (a fork) still shows. The folder it worked in is never touched, unless it is a chat
    /// worktree that nothing else uses and that holds no unmerged work (`reap_worktrees`).
    ///
    /// The chats it delegated (and theirs) are kept but their sessions end: with no lead left to
    /// collect them, they would otherwise keep working and spending. They stay in the rail, top
    /// level, and the next message resumes them; their worktrees are left alone.
    pub async fn delete_thread(&self, thread_id: &str) -> Result<(), String> {
        let threads = self.list_threads()?;
        let worktree = threads.iter().find(|t| t.id == thread_id).and_then(|t| chat_worktree(&t.cwd));
        let links: Vec<(String, Option<String>)> = threads.into_iter().map(|t| (t.id, t.parent_id)).collect();
        for child in delegate::descendants(&links, thread_id) {
            if let Err(error) = self.stop_thread(&child).await {
                eprintln!("[chat-runtime] delegated chat {child} not stopped: {error}");
            }
        }
        if let Some(machine) = self.machine_of(thread_id)? {
            self.remote_close(thread_id, &machine).await;
        }
        self.stop_thread(thread_id).await?;
        let attachments = {
            let mut core = self.inner.core.lock();
            let store = core.store()?;
            // Its own folder, and any it names (pasted before the new-chat screen named the chat).
            let mut named = store.attachment_dirs_named(Some(thread_id))?;
            named.insert(thread_id.to_string());
            store.delete_thread(thread_id)?;
            core.runs.remove(thread_id);
            core.subscribers.remove(thread_id);
            named
        };
        self.inner.starting.lock().remove(thread_id);
        if let Some(worktree) = worktree {
            let this = self.clone();
            tokio::task::spawn_blocking(move || this.reap_worktrees(Some(vec![worktree])));
        }
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.reap_attachments(Some(attachments.into_iter().collect())));
        Ok(())
    }

    /// Removes pasted-file folders (`chat-attachments/<id>`) no chat uses: neither a chat's own nor
    /// named by any chat's events, so a fork keeps its original's pictures. With `only`, just those
    /// (a chat just deleted); with `None`, every folder untouched for a day: the sweep at start,
    /// which catches drafts never sent and chats deleted before this existed.
    pub fn reap_attachments(&self, only: Option<Vec<String>>) {
        const DRAFT_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
        let in_use = {
            let mut core = self.inner.core.lock();
            let named = core.store().and_then(|store| {
                let mut named = store.attachment_dirs_named(None)?;
                named.extend(store.list_threads()?.into_iter().map(|t| t.id));
                Ok(named)
            });
            match named {
                Ok(named) => named,
                Err(error) => return eprintln!("[chat-runtime] attachment sweep skipped: {error}"),
            }
        };
        let root = crate::paths::lotus_state_dir().join("chat-attachments");
        for path in attachments::reap_unused(&root, &in_use, only.as_deref(), DRAFT_AGE) {
            eprintln!("[chat-runtime] removed unused attachments {}", path.display());
        }
    }

    pub async fn resolve_interaction(
        &self,
        thread_id: &str,
        interaction_id: &str,
        decision: Decision,
    ) -> Result<(), String> {
        let waiting = self
            .inner
            .core
            .lock()
            .run(thread_id)?
            .pending_interactions
            .contains(interaction_id);
        if !waiting {
            return Err("this approval is no longer waiting".into());
        }
        if let Some(machine) = self.machine_of(thread_id)? {
            return self.remote_resolve(thread_id, &machine, interaction_id, &decision).await;
        }
        let bridge = self
            .live_bridge(thread_id)
            .ok_or("the chat session has ended")?;
        let result = match decision {
            Decision::Allow { answers, remember } => {
                let mut allow = json!({ "behavior": "allow" });
                if let Some(answers) = answers {
                    allow["answers"] = json!(answers);
                }
                if remember {
                    allow["remember"] = json!(true);
                }
                allow
            }
            Decision::Deny { message } => json!({ "behavior": "deny", "message": message }),
        };
        bridge.reply(interaction_id, result).await
    }

    /// Sends every stored event after `after_seq`, then each new one. Returns the subscription id.
    pub fn subscribe(&self, thread_id: &str, after_seq: u64, sink: Sink) -> Result<u64, String> {
        // Opening a remote thread picks its stream up again (after a restart, or a sleep).
        if let Some(machine) = self.machine_of(thread_id)? {
            self.ensure_follow(thread_id, machine);
        }
        let mut core = self.inner.core.lock();
        core.run(thread_id)?;
        for envelope in core.store()?.events_after(thread_id, after_seq)? {
            if !sink(&envelope) {
                return Err("the subscriber closed during replay".into());
            }
        }
        let id = core.next_subscription;
        core.next_subscription += 1;
        core.subscribers
            .entry(thread_id.to_string())
            .or_default()
            .push((id, sink));
        Ok(id)
    }

    pub fn unsubscribe(&self, subscription_id: u64) {
        for subs in self.inner.core.lock().subscribers.values_mut() {
            subs.retain(|(id, _)| *id != subscription_id);
        }
    }

    fn current_bridge(&self) -> Option<Arc<Bridge>> {
        self.inner
            .bridge
            .lock()
            .as_ref()
            .filter(|(_, b)| b.is_alive())
            .map(|(_, b)| Arc::clone(b))
    }

    fn live_bridge(&self, thread_id: &str) -> Option<Arc<Bridge>> {
        let live = self.inner.core.lock().run(thread_id).ok()?.session_live;
        live.then(|| self.current_bridge()).flatten()
    }

    async fn ensure_bridge(&self) -> Result<Arc<Bridge>, String> {
        let _spawning = self.inner.spawning.lock().await;
        if let Some(bridge) = self.current_bridge() {
            return Ok(bridge);
        }
        let generation = {
            let mut core = self.inner.core.lock();
            core.bridge_generation += 1;
            core.bridge_generation
        };
        let weak = Arc::downgrade(&self.inner);
        let bridge = Bridge::spawn(launch::launch_command()?, move |m| {
            on_bridge_message(&weak, generation, m)
        })
        .await?;
        *self.inner.bridge.lock() = Some((generation, Arc::clone(&bridge)));
        Ok(bridge)
    }

    async fn ensure_session(&self, thread_id: &str) -> Result<Arc<Bridge>, String> {
        let start_lock = self.start_lock(thread_id);
        let _starting = start_lock.lock().await;
        let (record, live) = {
            let mut core = self.inner.core.lock();
            let live = core.run(thread_id)?.session_live;
            (
                core.store()?
                    .thread(thread_id)?
                    .ok_or_else(|| format!("unknown thread {thread_id}"))?,
                live,
            )
        };
        let bridge = self.ensure_bridge().await?;
        if !live {
            let mut params = json!({
                "threadId": record.id,
                "runner": record.runner,
                "cwd": record.cwd,
                "permissionMode": record.permission_mode,
            });
            // Codex signs in with its own `codex login`; the saved key is Claude's. Its account is a
            // home dir: `~/.codex` itself is a fine `CODEX_HOME`, so `default` needs no special case.
            if record.runner == "claude" {
                params["auth"] = self.inner.auth.session_auth(record.account.as_deref())?;
            } else if record.runner == "codex" {
                let codex = |id: &str| crate::accounts::find_for(crate::accounts::Provider::Codex, id);
                if let Some(account) = record.account.as_deref().and_then(codex).or_else(crate::usage::chosen_codex_account) {
                    params["auth"] = json!({ "mode": "login", "configDir": account.dir });
                }
            }
            if let Some(effort) = &record.effort {
                params["effort"] = json!(effort);
            }
            if let Some(model) = &record.model {
                params["model"] = json!(model);
            }
            if record.runner == "api" {
                let provider = api::provider(record.provider.as_deref().unwrap_or_default())?;
                if record.model.is_none() {
                    params["model"] = json!(provider.default_model);
                }
                params["api"] = api::session_params(&provider);
                params["history"] = json!(api::history(&store::live(self.inner.core.lock().store()?.events_after(thread_id, 0)?)));
            }
            if let Some(session) = &record.provider_session_id {
                // After an account switch the transcript may live only in the previous account's
                // `projects/`; resume reads the config dir this session starts with.
                if record.runner == "claude" {
                    let dir = params["auth"]["configDir"].as_str().map(std::path::PathBuf::from).unwrap_or_else(crate::paths::claude_dir);
                    crate::fs_browse::ensure_claude_session_in(&dir, &record.cwd, session)
                        .map_err(|e| format!("could not bring this conversation to the account: {e}"))?;
                }
                params["resumeSessionId"] = json!(session);
                // The bridge lets Claude read the outside paths these named again, as it did before.
                if record.runner == "claude" {
                    params["priorInputs"] = json!(outside_path_inputs(&self.inner.core.lock().store()?.events_after(thread_id, 0)?));
                }
                if let Some(at) = self.inner.core.lock().store()?.fork_at(thread_id)? {
                    params["forkAt"] = json!(at);
                }
            }
            // Read at each session start, so a chat picks up the toggle when it next wakes.
            if record.runner != "api" && concise_replies(&crate::settings::get_settings()) {
                params["conciseReplies"] = json!(true);
            }
            bridge.request("thread/start", params).await?;
        }
        // Under the start lock, so the reaper (which takes it too) sees this send.
        self.inner.core.lock().run(thread_id)?.sending(now_ms());
        Ok(bridge)
    }
}

fn on_bridge_message(inner: &Weak<Inner>, generation: u64, message: BridgeMessage) {
    let Some(inner) = inner.upgrade() else { return };
    let mut core = inner.core.lock();
    match message {
        BridgeMessage::Event { thread_id, event } => {
            let completed = store::event_type(&event) == "turn/completed";
            let limited = store::event_type(&event) == "session/rateLimit" && event["status"] == "rejected";
            if let Err(error) = core.ingest(&thread_id, event) {
                eprintln!("[chat-runtime] dropped an event for {thread_id}: {error}");
                return;
            }
            if limited {
                drop(core);
                ChatRuntime { inner }.schedule_resume(&thread_id);
                return;
            }
            if completed {
                // The folder as the turn left it, to tell later edits of the user's (#281).
                drop(core);
                let runtime = ChatRuntime { inner };
                std::thread::spawn(move || runtime.snapshot(&thread_id, Phase::After));
            }
        }
        BridgeMessage::Exited { error } => {
            // A bridge replaced by a newer one has nothing left to close.
            if generation != core.bridge_generation {
                return;
            }
            eprintln!("[chat-runtime] {error}");
            let open: Vec<(String, Vec<Value>)> = core
                .runs
                .iter()
                .map(|(id, run)| (id.clone(), run.crash_events(&error)))
                .collect();
            for (thread_id, events) in open {
                for event in events {
                    let _ = core.ingest(&thread_id, event);
                }
                if let Some(run) = core.runs.get_mut(&thread_id) {
                    run.session_live = false;
                }
            }
        }
    }
}

impl Core {
    fn store(&mut self) -> Result<&mut Store, String> {
        self.store
            .as_mut()
            .map_err(|e| format!("chat store unavailable: {e}"))
    }

    /// The thread's run state. Loaded from its stored events the first time; a turn or session
    /// left open by a previous Lotus run is closed then, since no bridge can finish it.
    fn run(&mut self, thread_id: &str) -> Result<&mut RunState, String> {
        if !self.runs.contains_key(thread_id) {
            let store = self.store()?;
            let record = store
                .thread(thread_id)?
                .ok_or_else(|| format!("unknown thread {thread_id}"))?;
            let mut run = RunState::default();
            for envelope in store.events_after(thread_id, 0)? {
                run.observe(envelope.seq, envelope.at, &envelope.event);
            }
            // A remote thread's agent lives on its host, which outlives this Mac's Lotus.
            let leftovers = if record.machine.is_some() {
                Vec::new()
            } else {
                run.crash_events("Lotus closed while this was running.")
            };
            run = RunState::default();
            self.runs.insert(thread_id.to_string(), run);
            for event in leftovers {
                self.ingest(thread_id, event)?;
            }
        }
        Ok(self.runs.get_mut(thread_id).expect("inserted above"))
    }

    fn ingest(&mut self, thread_id: &str, event: Value) -> Result<(), String> {
        let envelope = self.store()?.append(thread_id, now_ms(), event)?;
        let run = self.runs.entry(thread_id.to_string()).or_default();
        let finished_turn = (store::event_type(&envelope.event) == "turn/completed")
            .then(|| run.active_turn.as_ref().map(|(_, from, _)| *from))
            .flatten();
        run.observe(envelope.seq, envelope.at, &envelope.event);
        if let Some(from_seq) = finished_turn {
            self.store()?.compact_turn(thread_id, from_seq)?;
        }
        if let Some(subs) = self.subscribers.get_mut(thread_id) {
            subs.retain(|(_, sink)| sink(&envelope));
        }
        let moves_rail = matches!(
            store::event_type(&envelope.event),
            "turn/started"
                | "turn/completed"
                | "interaction/requested"
                | "interaction/resolved"
                | "session/ended"
                // The composer's picker reads the mode from the rail's thread list.
                | "session/permissionChanged"
                // An edited message changes what the rail previews.
                | "thread/rewound"
        );
        if let (true, Some(notify)) = (moves_rail, &self.on_rail_change) {
            notify();
        }
        Ok(())
    }
}

/// Settings › Chat › Reading › Concise replies (`chat.conciseReplies`); off unless set.
/// What the user sent before (a message or a steer) that may name a path outside the chat's folder:
/// a backticked absolute path or a file that is not a picture. The bridge works out which of them
/// are outside (`outsideReadRules`); this only keeps the rest of a long history off the wire.
fn outside_path_inputs(envelopes: &[store::Envelope]) -> Vec<Value> {
    envelopes
        .iter()
        .filter_map(|e| match store::event_type(&e.event) {
            "turn/started" => Some(&e.event["input"]),
            "item/completed" if e.event["item"]["kind"] == "userMessage" => Some(&e.event["item"]),
            _ => None,
        })
        .filter_map(|input| {
            let text = input["text"].as_str().unwrap_or_default();
            let files: Vec<&Value> = input["attachments"].as_array().into_iter().flatten().filter(|a| a["kind"] != "image").collect();
            (text.contains("`/") || !files.is_empty()).then(|| json!({ "text": text, "attachments": files }))
        })
        .collect()
}

fn concise_replies(settings: &Value) -> bool {
    settings.pointer("/chat/conciseReplies").and_then(Value::as_bool).unwrap_or(false)
}

/// The chats below `thread_id` that work in its worktree (its verifiers), or None when a chat
/// outside its subtree also works there. Each entry: (id, parent, works in that worktree).
fn own_worktree_chats(threads: &[(String, Option<String>, bool)], thread_id: &str) -> Option<Vec<String>> {
    let links: Vec<(String, Option<String>)> = threads.iter().map(|(i, p, _)| (i.clone(), p.clone())).collect();
    let below = delegate::descendants(&links, thread_id);
    let mut own = Vec::new();
    for (id, _, _) in threads.iter().filter(|(i, _, shares)| *shares && i != thread_id) {
        if !below.contains(id) {
            return None;
        }
        own.push(id.clone());
    }
    Some(own)
}

/// The chat worktree a folder is in; a fork's folder may sit deeper inside its worktree.
fn chat_worktree(cwd: &str) -> Option<std::path::PathBuf> {
    let root = crate::paths::lotus_state_dir().join("chat-worktrees");
    Some(root.join(Path::new(cwd).strip_prefix(&root).ok()?.components().next()?))
}

#[cfg(test)]
mod tests;
