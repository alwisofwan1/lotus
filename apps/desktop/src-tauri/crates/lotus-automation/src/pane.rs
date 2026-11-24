//! Runs in a pane: an automation that belongs to a project runs its agent the
//! way the user would — interactively, in a new pane of that project, where the
//! user can watch and step in (as bb runs an automation as a thread). The agent
//! hands its result back by calling the `lotus_automation_submit` MCP tool with
//! the run's token; Lotus turns that into the draft or result, exactly as it
//! does a headless run's JSON reply.
//!
//! The pane itself belongs to the frontend, which owns the grid: this module
//! asks for one through [`PaneOpener`] and waits for the frontend to say it
//! opened (or why not), then for the agent to submit.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::mpsc;

use crate::agent::{Access, AgentRequest, AgentRunner, CommandRefusal, Preset, PresetLookup, AUTOMATION_RUN_ENV};
use crate::registry::BoxFuture;

/// What the frontend needs to open a run's pane.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneRequest {
    /// The run's session id; also the secret the agent submits with.
    pub token: String,
    pub workspace_id: String,
    /// The shell command the pane runs, in the project's folder.
    pub command: String,
    /// The GitHub repository (`owner/name`) the run is about, when it is about
    /// one. The frontend opens the pane in a workspace that is a checkout of it
    /// (as bb's `resolveProjectId` does), else in `workspace_id`.
    pub repo: Option<String>,
}

/// Asks the frontend to open a pane. `Err` when no window can be asked.
pub trait PaneOpener: Send + Sync {
    fn open(&self, request: &PaneRequest) -> Result<(), String>;
}

#[derive(Debug)]
enum PaneEvent {
    Opened,
    Failed(String),
    Submitted(Value),
}

/// Runs waiting on a pane, by token. Shared by the runner (which waits) and
/// the host (which reports what the frontend and the agent did).
#[derive(Default)]
pub struct PendingPanes {
    waiting: Mutex<HashMap<String, Waiting>>,
}

/// One waiting run: where its events go, and the schema its result must meet.
struct Waiting {
    events: mpsc::UnboundedSender<PaneEvent>,
    schema: Value,
}

impl PendingPanes {
    fn register(&self, token: &str, schema: Value) -> mpsc::UnboundedReceiver<PaneEvent> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.lock().insert(token.to_string(), Waiting { events: tx, schema });
        rx
    }

    fn forget(&self, token: &str) {
        self.lock().remove(token);
    }

    fn send(&self, token: &str, event: PaneEvent) -> Result<(), String> {
        let map = self.lock();
        let waiting =
            map.get(token).ok_or("no automation run is waiting for this token (it finished, timed out, or never existed)")?;
        waiting.events.send(event).map_err(|_| "that automation run has already ended".to_string())
    }

    /// The frontend opened the pane.
    pub fn opened(&self, token: &str) -> Result<(), String> {
        self.send(token, PaneEvent::Opened)
    }

    /// The frontend could not open the pane; the run fails with `reason`.
    pub fn failed(&self, token: &str, reason: &str) -> Result<(), String> {
        self.send(token, PaneEvent::Failed(reason.to_string()))
    }

    /// The agent in the pane submitted its result. A result that does not
    /// meet the run's schema is refused with why, and the run keeps waiting,
    /// so the agent can fix it and submit again.
    pub fn submit(&self, token: &str, result: Value) -> Result<(), String> {
        let schema = self.lock().get(token).map(|w| w.schema.clone());
        if let Some(schema) = schema {
            crate::schema_check::check(&schema, &result).map_err(|e| format!("{NOT_SUBMITTED}{e}"))?;
        }
        self.send(token, PaneEvent::Submitted(result))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Waiting>> {
        self.waiting.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// How a refused submit starts: the result broke the run's schema, and the
/// run still waits for a fixed one (the host answers it as a bad request).
pub const NOT_SUBMITTED: &str = "not submitted, fix and call again: ";

/// Removes a run from [`PendingPanes`] however its wait ends (a timeout drops
/// the future mid-wait), so a late submit is told the run is over.
struct Registration<'a> {
    pending: &'a PendingPanes,
    token: String,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.pending.forget(&self.token);
    }
}

/// The shell line a pane runs: the preset as the user runs it, interactive,
/// under the run's session id, with the prompt read from `prompt_file` (so a
/// long, multi-line prompt never has to survive shell quoting), and marked as
/// an automation run so it cannot write automations.
pub fn pane_command(preset: &Preset, session_id: &str, prompt_file: &std::path::Path) -> Result<String, CommandRefusal> {
    pane_command_with(preset, &Access::Full, session_id, prompt_file)
}

/// As [`pane_command`], for a run with the given [`Access`]. A read-only run
/// loses the preset's permission flags and runs `--permission-mode manual`
/// with its allow list, so anything off the list asks the user in the pane,
/// and without the user's personal context
/// ([`crate::agent::PERSONAL_CONTEXT_OFF`], ADR-0039). A sealed run never
/// runs in a pane; it is treated as read-only.
pub fn pane_command_with(
    preset: &Preset,
    access: &Access,
    session_id: &str,
    prompt_file: &std::path::Path,
) -> Result<String, CommandRefusal> {
    pane_command_continue(preset, access, session_id, prompt_file, false)
}

pub fn pane_command_continue(
    preset: &Preset, access: &Access, session_id: &str,
    prompt_file: &std::path::Path, resume: bool,
) -> Result<String, CommandRefusal> {
    // Only claude-based agents take `--session-id`, which reopening the run depends on.
    let (program, positional) = crate::agent::program_of(preset)?;
    let args = match access {
        Access::Full => crate::agent::without_owned_flags(&preset.args).0,
        Access::ReadOnly { mcp_tools, .. } => crate::agent::read_only_shell_args(&preset.args, mcp_tools)?,
        Access::Sealed => crate::agent::read_only_shell_args(&preset.args, &[])?,
    };
    let path = prompt_file.to_string_lossy().replace('\'', "'\\''");
    let personal = match access {
        Access::Full => String::new(),
        Access::ReadOnly { .. } | Access::Sealed => crate::agent::personal_context_off_prefix(),
    };
    // The account the host picked for the preset; `env` runs before the assignments.
    let unset: String = preset.unset.iter().map(|k| format!("-u {k} ")).collect();
    let unset = if unset.is_empty() { unset } else { format!("env {unset}") };
    let assigned: String = preset.env.iter().map(|(k, v)| format!("{k}='{}' ", v.replace('\'', "'\\''"))).collect();
    let mut line = format!("{unset}{assigned}{AUTOMATION_RUN_ENV}=1 {personal}{program}");
    for arg in positional.iter().chain(&args) {
        line.push(' ');
        line.push_str(arg);
    }
    let flag = if resume { "--resume" } else { "--session-id" };
    line.push_str(&format!(" {flag} {session_id} \"$(cat '{path}')\""));
    Ok(line)
}

/// The [`AgentRunner`] for automations: a request that names a project runs in
/// a pane of it; any other runs headless through `headless`.
pub struct PaneAgentRunner {
    presets: PresetLookup,
    opener: Arc<dyn PaneOpener>,
    pending: Arc<PendingPanes>,
    headless: Arc<dyn AgentRunner>,
    /// Where prompt files are written; each is removed when its run ends.
    prompts: PathBuf,
    /// How long the frontend has to say the pane opened.
    open_timeout: Duration,
}

impl PaneAgentRunner {
    pub fn new(
        presets: PresetLookup,
        opener: Arc<dyn PaneOpener>,
        pending: Arc<PendingPanes>,
        headless: Arc<dyn AgentRunner>,
        prompts: PathBuf,
    ) -> Self {
        Self { presets, opener, pending, headless, prompts, open_timeout: Duration::from_secs(60) }
    }

    pub fn with_open_timeout(mut self, timeout: Duration) -> Self {
        self.open_timeout = timeout;
        self
    }
}

impl AgentRunner for PaneAgentRunner {
    fn run(&self, request: AgentRequest) -> BoxFuture<Result<Value, String>> {
        let Some(workspace_id) = request.workspace.clone() else {
            return self.headless.run(request);
        };
        let preset = (self.presets)(&request.preset_id);
        let opener = Arc::clone(&self.opener);
        let pending = Arc::clone(&self.pending);
        let prompts = self.prompts.clone();
        let open_timeout = self.open_timeout;
        Box::pin(async move {
            let preset = preset.ok_or_else(|| format!("no delegation preset with id {}", request.preset_id))?;
            let session = request.session.ok_or("a pane run needs a session")?;
            std::fs::create_dir_all(&prompts).map_err(|e| format!("could not write the prompt: {e}"))?;
            let prompt_file = prompts.join(format!("{}.md", session.id));
            std::fs::write(&prompt_file, &request.prompt).map_err(|e| format!("could not write the prompt: {e}"))?;
            let _cleanup = RemoveOnDrop(prompt_file.clone());

            let pane = PaneRequest {
                token: session.id.clone(),
                workspace_id,
                command: pane_command_continue(&preset, &request.access, &session.id, &prompt_file, session.resume).map_err(|e| e.to_string())?,
                repo: request.repo.clone(),
            };
            let mut events = pending.register(&pane.token, request.schema.clone());
            let _registered = Registration { pending: &pending, token: pane.token.clone() };
            opener.open(&pane)?;

            match tokio::time::timeout(open_timeout, events.recv()).await {
                Err(_) => return Err("no Lotus window opened the pane; is Lotus showing a window?".into()),
                Ok(None) => return Err("the run was dropped before its pane opened".into()),
                Ok(Some(PaneEvent::Failed(reason))) => return Err(reason),
                Ok(Some(PaneEvent::Submitted(value))) => return Ok(value),
                Ok(Some(PaneEvent::Opened)) => {}
            }
            // The prompt file is read by the shell as the agent starts; keep it until then.
            loop {
                match events.recv().await {
                    Some(PaneEvent::Submitted(value)) => return Ok(value),
                    Some(PaneEvent::Failed(reason)) => return Err(reason),
                    Some(PaneEvent::Opened) => {}
                    None => return Err("the run was dropped before the agent submitted".into()),
                }
            }
        })
    }
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Where a pane run's agent must send its result, told in its prompt: the MCP
/// tool's full name for this Lotus instance (`server` is `lotus` or `lotus-dev`).
pub fn submit_tool(server: &str) -> String {
    format!("mcp__{server}__lotus_automation_submit")
}
