//! Tauri side of the automation engine (ADR-0038).
//!
//! The engine itself lives in `crates/lotus-automation` and knows nothing
//! about Tauri. This module opens its database in Lotus's state dir, settles
//! runs a previous process left in flight, wires action kinds to the real
//! `gh` and agent CLIs with the user's login-shell environment, and turns
//! run results into UI events and OS notifications. The `#[tauri::command]`
//! wrappers in `lib.rs` call the functions here.

use crate::no_window::NoWindow;
use std::path::PathBuf;
use std::sync::Arc;

use lotus_automation::agent::{
    build_agent_command, CliAgentRunner, Preset, PresetLookup,
};
use lotus_automation::pane::{PaneAgentRunner, PaneOpener, PaneRequest, PendingPanes};
use lotus_automation::session::SessionKeeper;
use lotus_automation::authoring::Proposal;
use lotus_automation::github::{parse_gh_hosts, Gh, GhAccount, GhCli};
use lotus_automation::pr_review::{
    self, new_pr_review_automation, EditedReview, PrReviewAction, PrReviewForm, PrReviewLimits, SendError,
    SendRequest,
};
use lotus_automation::views::{AutomationView, DraftView, RunView};
use lotus_automation::{
    Clock, DraftStatus, Engine, EngineConfig, Notifier, Registry, RunReport, Store, Submitted, SystemClock,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{paths, shell_env};

/// Fired whenever automations, runs or drafts change. No payload: listeners
/// re-read, so an event can never carry stale or sensitive data.
pub const CHANGED_EVENT: &str = "automation://changed";

/// Fired for each step a headless run takes: `{ runId, atMs, text }`. The
/// text is Lotus's one-line description of a tool call, built from what the
/// agent asked for (a command, a path, its own description of a step), so in
/// a review it can echo a PR's text: the UI shows it as plain text, as the
/// agent's report.
pub const STEP_EVENT: &str = "automation://step";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StepEvent<'a> {
    run_id: &'a str,
    at_ms: i64,
    text: &'a str,
}

pub struct AutomationRuntime {
    store: Arc<Store>,
    /// Runs waiting on a pane: the frontend reports it opened, the agent submits.
    panes: Arc<PendingPanes>,
    engine: Arc<Engine>,
    github: Arc<GhCli>,
    app: AppHandle,
    slack: crate::automation_slack::SlackHost,
    /// Lotus's own Google sign-in, for Sheets and Drive outputs.
    google: crate::automation_google::GoogleHost,
    /// The frontend's local workspaces, for runs in a project.
    workspaces: Arc<KnownWorkspaces>,
    /// Each recent run's latest steps.
    activity: Arc<lotus_automation::activity::ActivityLog>,
    /// The last Ask a notification was shown for, until a window's focus takes it.
    ask_notice: Arc<lotus_automation::ask::AskNotice>,
    /// Where else reviews are asked for, polled: GitHub's review requests (ADR-0041).
    requests: Arc<lotus_automation::sources::Poller>,
    /// Runs the last shutdown cut off, run again once the app is up.
    resumable: std::sync::Mutex<Vec<lotus_automation::Resumable>>,
    /// Review worktrees, counted for the UI.
    prefetch: Arc<lotus_automation::pr_review::Prefetch>,
}

/// The review worktrees on disk now: normally 0, one per review while it runs.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewWorktreesView {
    pub count: usize,
    pub bytes: u64,
}

pub fn database_path() -> PathBuf {
    paths::lotus_state_dir().join("automations.db")
}

/// Where an automation's runs work when it names no folder: one empty folder
/// per automation, kept, because `--resume` finds a session only from there.
fn runs_folder() -> PathBuf {
    paths::lotus_state_dir().join("automation-runs")
}

/// Opens the store and builds the engine. Must run before anything submits
/// work, so interrupted runs are settled before new ones can be claimed.
pub fn start(app: &AppHandle) -> Result<AutomationRuntime, lotus_automation::Error> {
    let store = Arc::new(Store::open(&database_path())?);
    let resumable = store.reconcile_for_resume(SystemClock.now_ms())?;
    if !resumable.is_empty() {
        eprintln!("[automation] {} run(s) cut off by the last shutdown will run again", resumable.len());
    }
    let env = shell_env::login_env_without_unset();
    let github = Arc::new(GhCli::new(Gh::new("gh").with_base_env(env.clone())));
    let activity = Arc::new(lotus_automation::activity::ActivityLog::new(200, 30));
    let steps: lotus_automation::agent::StepSink = {
        let (activity, app) = (Arc::clone(&activity), app.clone());
        Arc::new(move |run_id: &str, text: String| {
            let at_ms = SystemClock.now_ms();
            let _ = app.emit(STEP_EVENT, StepEvent { run_id, at_ms, text: &text });
            activity.push(run_id, at_ms, text);
        })
    };
    // Each headless review works in its own worktree (ADR-0052 §2); a crash's leftovers go first.
    // Beside the state folder, not in it: a review may never read the state folder (it holds
    // Lotus's secrets), and a deny there also hid the review's own worktree (tested 2026-10-08).
    let state = paths::lotus_state_dir();
    let root = state.with_file_name(format!("{}-review-worktrees", state.file_name().unwrap_or_default().to_string_lossy()));
    // Worktrees made before the move.
    lotus_automation::pr_review::Prefetch::new(env.clone()).with_worktrees(state.join("review-worktrees")).sweep();
    let prefetch = Arc::new(lotus_automation::pr_review::Prefetch::new(env.clone()).with_worktrees(root));
    prefetch.sweep();
    // A headless review runs sandboxed with no token; it reads GitHub through this Lotus's MCP
    // server, as the automation's gh login (ADR-0052 §3).
    let claude_json = dirs::home_dir().unwrap_or_default().join(".claude.json");
    let headless = Arc::new(
        CliAgentRunner::new(delegation_presets(), env)
            .with_steps(steps)
            .with_review_mcp(claude_json, crate::mcp_config::mcp_server_key()),
    );
    let workspaces = Arc::new(KnownWorkspaces::default());
    let panes = Arc::new(PendingPanes::default());
    // A run of an automation that asks for a pane opens one in its project; any other stays headless.
    let agent: Arc<dyn lotus_automation::agent::AgentRunner> = Arc::new(PaneAgentRunner::new(
        delegation_presets(),
        Arc::new(TauriPaneOpener(app.clone())),
        Arc::clone(&panes),
        headless,
        runs_folder().join("prompts"),
    ));
    let submit_tool = lotus_automation::pane::submit_tool(crate::mcp_config::mcp_server_key());
    let slack = crate::automation_slack::SlackHost::new();
    let google = crate::automation_google::GoogleHost::new();
    let sessions = Arc::new(SessionKeeper::new(Arc::clone(&store), runs_folder()));
    let registry = Registry::new()
        .with_action(
            PrReviewAction::new(github.clone(), agent.clone(), PrReviewLimits::default())
                // A review's skill must be one `claude` loads with `--setting-sources user`.
                .with_skill_check(Arc::new(|name: &str| lotus_automation::pr_review::skill::exists(&paths::claude_dir(), name)))
                .with_sessions(Arc::clone(&sessions))
                .with_submit_tool(submit_tool.clone())
                .with_workspaces(workspaces.clone())
                .with_history(Arc::clone(&store))
                .with_transcripts(Arc::new(HostTranscripts))
                .with_prefetch(Arc::clone(&prefetch))
                .with_threads(Arc::new(slack.thread_reader())),
        )
        .with_action(
            lotus_automation::agent_prompt::AgentPromptAction::new(github.clone(), agent, Arc::new(slack.messenger()))
                .with_google(Arc::new(google.writer()))
                .with_sessions(sessions)
                .with_submit_tool(submit_tool)
                .with_workspaces(workspaces.clone())
                .with_history(Arc::clone(&store))
                .with_transcripts(Arc::new(HostTranscripts)),
        );
    let ask_notice = Arc::new(lotus_automation::ask::AskNotice::default());
    let engine = Engine::new(Arc::clone(&store), registry, Arc::new(SystemClock), EngineConfig::default())
        .with_notifier(Arc::new(TauriNotifier(app.clone(), Arc::clone(&ask_notice))));
    let gh: Arc<dyn lotus_automation::github::GitHub> = github.clone();
    let requests = Arc::new(lotus_automation::sources::Poller::new(
        Arc::clone(&store),
        Arc::clone(&gh),
        vec![Arc::new(lotus_automation::sources::GitHubRequests::new(gh))],
    ));
    Ok(AutomationRuntime {
        store,
        panes,
        engine: Arc::new(engine),
        github,
        app: app.clone(),
        slack,
        google,
        workspaces,
        activity,
        ask_notice,
        requests,
        resumable: std::sync::Mutex::new(resumable),
        prefetch,
    })
}

/// Asks the frontend, which owns the grid, to open a run's pane.
pub const OPEN_PANE_EVENT: &str = "automation://open-pane";

struct TauriPaneOpener(AppHandle);

impl PaneOpener for TauriPaneOpener {
    fn open(&self, request: &PaneRequest) -> Result<(), String> {
        self.0.emit(OPEN_PANE_EVENT, request).map_err(|e| format!("could not ask Lotus to open the pane: {e}"))
    }
}

/// A conversation's transcript is on disk when the agent's project folder for `cwd` lists it.
struct HostTranscripts;

impl lotus_automation::session::Transcripts for HostTranscripts {
    fn exists(&self, cwd: &str, session_id: &str) -> bool {
        crate::fs_browse::list_claude_sessions(cwd.to_string()).iter().any(|id| id == session_id)
    }
}

struct TauriNotifier(AppHandle, Arc<lotus_automation::ask::AskNotice>);

impl Notifier for TauriNotifier {
    fn run_finished(&self, report: &RunReport) {
        use tauri::Manager;
        use tauri_plugin_notification::NotificationExt;
        let _ = self.0.emit(CHANGED_EVENT, ());
        // Auto mode: a finished review is posted now, without Send (ADR-0042, amended 2026-10-14).
        if let (lotus_automation::RunStatus::Succeeded, Some(draft_id)) = (report.status, &report.draft_id) {
            let (app, draft_id) = (self.0.clone(), draft_id.clone());
            tauri::async_runtime::spawn(async move {
                if let Some(runtime) = app.try_state::<AutomationRuntime>() {
                    runtime.auto_send(&draft_id).await;
                }
            });
        }
        let Some((title, body)) = lotus_automation::notification_text(report) else {
            return;
        };
        if let Err(e) = self.0.notification().builder().title(title).body(body).show() {
            eprintln!("[automation] notification failed: {e}");
            return;
        }
        // The plugin reports no click on macOS: a window gaining focus soon after this is read as
        // following it (PLAN §8 Q10, `window_focused`).
        if let (lotus_automation::RunStatus::Asked, Some(ask_id)) = (report.status, &report.draft_id) {
            self.1.notified(ask_id, SystemClock.now_ms());
            eprintln!("[automation] notified Ask {ask_id}: a Lotus window focused within 10 minutes opens it");
        }
    }
}

/// Tells one window to open Automation › Inbox on an Ask: `{ askId, window }` (its label).
pub const OPEN_ASK_EVENT: &str = "automation://open-ask";

/// A window gained focus: when an Ask's notification was shown moments ago, that window opens it.
pub fn window_focused(window: &tauri::Window) {
    use tauri::Manager;
    let Some(runtime) = window.try_state::<AutomationRuntime>() else { return };
    let Some(ask_id) = runtime.ask_notice.take_on_focus(SystemClock.now_ms()) else { return };
    eprintln!("[automation] window {} focused after the notification: opening Ask {ask_id}", window.label());
    let payload = serde_json::json!({ "askId": ask_id, "window": window.label() });
    if let Err(e) = runtime.app.emit(OPEN_ASK_EVENT, payload) {
        eprintln!("[automation] could not ask the window to open Ask {ask_id}: {e}");
    }
}

impl AutomationRuntime {
    fn slack_deps(&self) -> crate::automation_slack::SlackDeps {
        crate::automation_slack::SlackDeps {
            store: Arc::clone(&self.store),
            engine: Arc::clone(&self.engine),
            github: Arc::clone(&self.github),
            app: self.app.clone(),
        }
    }

    /// Runs again, once, what the last shutdown cut off. Called once, after start.
    pub async fn resume_interrupted(&self) {
        let runs = std::mem::take(&mut *self.resumable.lock().unwrap_or_else(|p| p.into_inner()));
        if self.engine.resume(runs).await > 0 {
            self.changed();
        }
    }

    /// Runs due schedules, and asks the request sources that are due. Called on a ~30 s tick from app start.
    pub async fn tick(&self) {
        let now = SystemClock.now_ms();
        let started = lotus_automation::scheduler::tick(&self.store, &self.engine, now).await
            + self.requests.tick(&self.engine, now).await;
        if started > 0 {
            self.changed();
        }
    }

    pub fn create_agent_prompt(&self, form: lotus_automation::agent_prompt::AgentPromptForm) -> Result<AutomationView, String> {
        let new = lotus_automation::agent_prompt::new_agent_prompt_automation(form)?;
        let created = self.store.create_automation(new, SystemClock.now_ms()).map_err(|e| e.to_string())?;
        self.changed();
        Ok(AutomationView::from(&created))
    }

    pub fn list_results(&self, limit: usize) -> Result<Vec<DraftView>, String> {
        let results = self.store.list_results("agent_prompt", limit.min(200)).map_err(|e| e.to_string())?;
        Ok(results.iter().map(DraftView::from).collect())
    }

    /// The exact Slack text a scheduled-prompt result would post as, for the Inbox preview.
    pub fn preview_result(&self, draft_id: &str, text: &str) -> Result<String, String> {
        let draft = self.store.get_draft(draft_id).map_err(|e| e.to_string())?.ok_or("no such result")?;
        lotus_automation::agent_prompt::slack_text(&self.store, &draft, text)
    }

    /// Posts a waiting scheduled-prompt result to its Slack channel.
    pub async fn send_result(&self, draft_id: &str, text: Option<String>) -> Result<(), String> {
        let web = self.slack.web().ok_or("Slack is not connected")?;
        let result = lotus_automation::agent_prompt::send_result(&self.store, &web, draft_id, text.as_deref()).await;
        self.changed();
        result
    }

    /// Starts the Slack session from saved tokens. Called once at app start.
    pub async fn resume_slack(&self) {
        self.slack.resume(self.slack_deps()).await;
    }

    pub fn slack_status(&self) -> crate::automation_slack::SlackStatusView {
        self.slack.status()
    }

    pub async fn slack_connect(
        &self,
        app_token: &str,
        user_token: &str,
    ) -> Result<crate::automation_slack::SlackStatusView, String> {
        let status = self.slack.connect(self.slack_deps(), app_token, user_token).await?;
        self.changed();
        Ok(status)
    }

    /// Saves the Lotus bot's token beside the others (CoS 11).
    pub async fn slack_set_bot_token(&self, bot_token: &str) -> Result<crate::automation_slack::SlackStatusView, String> {
        self.slack.set_bot_token(&self.app, bot_token).await
    }

    /// The emoji a Slack review request shows for each state (Connectors → Slack).
    pub fn slack_reactions(&self) -> crate::automation_slack::SlackReactionsView {
        self.slack.reactions()
    }

    /// The workspace's custom emoji for the reaction picker; `refresh` skips the cache.
    pub async fn slack_emoji(&self, refresh: bool) -> Result<crate::automation_slack::SlackEmojiView, String> {
        self.slack.emoji(refresh).await
    }

    pub fn slack_set_reactions(
        &self,
        reactions: lotus_automation::slack::StatusReactions,
    ) -> Result<crate::automation_slack::SlackReactionsView, String> {
        self.slack.set_reactions(&self.app, reactions)
    }

    /// One DM from the bot now, to see it ping the phone.
    pub async fn slack_test_bot(&self) -> Result<(), String> {
        self.slack.test_bot().await
    }

    /// The bot client and the user's Slack id it DMs, for the Chief of Staff's alerts.
    pub fn slack_bot_target(&self) -> Option<(lotus_automation::slack::web::SlackWeb, String)> {
        self.slack.bot_target()
    }

    /// The user-token client, for the Chief of Staff's Slack thread replies (CoS 12).
    pub fn slack_user_web(&self) -> Option<lotus_automation::slack::web::SlackWeb> {
        self.slack.web()
    }

    pub async fn slack_check_now(&self) -> Result<crate::automation_slack::SlackStatusView, String> {
        self.slack.check_now().await
    }

    pub fn slack_disconnect(&self) -> Result<(), String> {
        self.slack.disconnect(&self.app)
    }

    pub fn google_status(&self) -> crate::automation_google::GoogleStatusView {
        self.google.status()
    }

    pub async fn google_connect(&self) -> Result<crate::automation_google::GoogleStatusView, String> {
        self.google.connect(&self.app).await
    }

    pub fn google_cancel_connect(&self) {
        self.google.cancel_connect(&self.app)
    }

    pub async fn google_disconnect(&self) -> Result<(), String> {
        self.google.disconnect(&self.app).await
    }

    /// Readies an `agent_prompt` form's Google outputs before it is saved, from the panel or an
    /// agent alike: Google must be connected (PLAN G18), and a sheet id of `"new"` becomes a sheet
    /// Lotus creates now — named after the automation, the columns as its header — but only once
    /// the rest of the form is valid, so a refused form leaves no stray sheet behind.
    pub async fn google_prepare_form(&self, kind: &str, form: &mut serde_json::Value) -> Result<(), String> {
        let connected = self.google.status().state == "connected";
        lotus_automation::google::output::ready_form(kind, form, connected, |name, tab, columns| async move {
            self.google.create_sheet(&name, &tab, &columns).await.map(|s| s.id)
        })
        .await
    }

    /// The Google Picker: an existing sheet or folder the user chooses in the browser.
    pub async fn google_pick(&self, kind: &str) -> Result<crate::automation_google::PickedView, String> {
        let pick = match kind {
            "sheet" => lotus_automation::google::auth::Pick::Sheet,
            "folder" => lotus_automation::google::auth::Pick::Folder,
            other => return Err(format!("pick: {other:?} is not sheet or folder")),
        };
        self.google.pick(&self.app, pick).await
    }

    pub async fn google_resend(&self, draft_id: &str) -> Result<serde_json::Value, String> {
        self.google.resend(&self.store, draft_id, &self.app).await
    }

    pub async fn slack_channels(&self) -> Result<Vec<lotus_automation::slack::web::SlackChannel>, String> {
        self.slack.channels().await
    }

    pub async fn slack_usergroups(&self) -> Result<Vec<lotus_automation::slack::web::SlackUserGroup>, String> {
        self.slack.usergroups().await
    }

    pub async fn slack_user_names(&self, ids: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
        self.slack.user_names(ids).await
    }

    /// `channels` empty → back to a manual (Run now only) trigger.
    pub fn set_slack_trigger(&self, automation_id: &str, channels: Vec<String>, team: Option<String>) -> Result<AutomationView, String> {
        let existing = self.store.get_automation(automation_id).map_err(|e| e.to_string())?.ok_or("no such automation")?;
        // Moving Slack, or stopping it, leaves what else the review is asked from.
        let trigger =
            lotus_automation::sources::keep_sources(lotus_automation::authoring::slack_trigger(channels, team)?, &existing.trigger);
        self.store.set_trigger(automation_id, &trigger).map_err(|e| e.to_string())?;
        self.changed();
        let automation = self.store.get_automation(automation_id).map_err(|e| e.to_string())?.ok_or("no such automation")?;
        Ok(AutomationView::from(&automation))
    }

    /// Turns request source `source` (`github`) on with `settings`, or off with `None`, for a PR review.
    pub fn set_request_source(&self, automation_id: &str, source: &str, settings: Option<serde_json::Value>) -> Result<AutomationView, String> {
        let existing = self.store.get_automation(automation_id).map_err(|e| e.to_string())?.ok_or("no such automation")?;
        if existing.action.kind != "pr_review" {
            return Err(format!("{source}: only a PR review is asked for reviews there"));
        }
        let known = self.requests.sources().iter().find(|s| s.key() == source).ok_or_else(|| format!("{source}: not a request source"))?;
        if let Some(settings) = &settings {
            known.check(settings)?;
        }
        let trigger = lotus_automation::sources::with_source(&existing.trigger, source, settings)?;
        self.store.set_trigger(automation_id, &trigger).map_err(|e| e.to_string())?;
        self.changed();
        let automation = self.store.get_automation(automation_id).map_err(|e| e.to_string())?.ok_or("no such automation")?;
        Ok(AutomationView::from(&automation))
    }

    /// An agent's new automation (MCP), saved OFF until the user turns it on.
    pub fn propose(&self, proposal: Proposal) -> Result<AutomationView, String> {
        self.check_project(&proposal)?;
        let created = lotus_automation::authoring::propose(&self.store, proposal, SystemClock.now_ms())?;
        self.changed();
        Ok(AutomationView::from(&created))
    }

    /// An agent's change to an automation (MCP); switches it OFF again.
    pub fn revise(&self, automation_id: &str, proposal: Proposal) -> Result<AutomationView, String> {
        self.check_project(&proposal)?;
        let revised = lotus_automation::authoring::revise(&self.store, automation_id, proposal)?;
        self.changed();
        Ok(AutomationView::from(&revised))
    }

    pub fn delete_automation(&self, automation_id: &str) -> Result<bool, String> {
        let deleted = self.store.delete_automation(automation_id).map_err(|e| e.to_string())?;
        self.changed();
        Ok(deleted)
    }

    /// "Run now" on a scheduled prompt.
    pub async fn run_scheduled_now(&self, automation_id: &str) -> Result<RunNowView, String> {
        let submitted = lotus_automation::scheduler::run_now(&self.engine, automation_id, SystemClock.now_ms())
            .await
            .map_err(|e| e.to_string())?;
        self.changed();
        Ok(match submitted {
            Submitted::Started { run_id } => RunNowView::Started { run_id },
            Submitted::Duplicate { existing_run_id } => RunNowView::Duplicate { run_id: existing_run_id },
        })
    }

    /// The user edits the prompt (or review instructions) in place.
    pub fn update_prompt(&self, automation_id: &str, text: &str) -> Result<AutomationView, String> {
        let updated = lotus_automation::authoring::set_prompt_text(&self.store, automation_id, text)?;
        self.changed();
        Ok(AutomationView::at(&updated, SystemClock.now_ms()))
    }

    /// The user picks another agent, model, effort or account in place.
    pub fn update_agent(&self, automation_id: &str, reference: &str) -> Result<AutomationView, String> {
        let updated = lotus_automation::authoring::set_agent(&self.store, automation_id, reference)?;
        self.changed();
        Ok(AutomationView::at(&updated, SystemClock.now_ms()))
    }

    /// The user edits the whole definition from the panel's form; on/off is kept.
    pub fn edit(&self, automation_id: &str, kind: String, form: serde_json::Value) -> Result<AutomationView, String> {
        let proposal = Proposal { kind, form, slack: None, github: None };
        let updated = lotus_automation::authoring::edit_by_user(&self.store, automation_id, proposal)?;
        self.changed();
        Ok(AutomationView::at(&updated, SystemClock.now_ms()))
    }

    /// The user's switch. Never reachable from MCP: an agent cannot turn an automation on.
    pub fn set_enabled(&self, automation_id: &str, enabled: bool) -> Result<AutomationView, String> {
        self.store.set_enabled(automation_id, enabled).map_err(|e| e.to_string())?;
        self.changed();
        let automation = self.store.get_automation(automation_id).map_err(|e| e.to_string())?.ok_or("no such automation")?;
        Ok(AutomationView::from(&automation))
    }

    /// What an agent may fill a proposal with: preset ids, GitHub accounts,
    /// projects, MCP servers, Slack channel and user group ids, and the time
    /// zone to schedule in. Names and ids only — no tokens.
    pub async fn authoring_options(&self) -> serde_json::Value {
        let slack = self.slack.status();
        let connected = slack.state == "connected";
        let (channels, usergroups) = if connected {
            (
                self.slack.channels().await.map_or_else(|e| serde_json::json!({ "error": e }), |c| serde_json::json!(c)),
                self.slack.usergroups().await.map_or_else(|e| serde_json::json!({ "error": e }), |g| serde_json::json!(g)),
            )
        } else {
            (serde_json::json!([]), serde_json::json!([]))
        };
        serde_json::json!({
            "kinds": lotus_automation::authoring::KINDS,
            "timezone": system_timezone(),
            "google": {
                "state": self.google.status().state,
                "email": self.google.status().email,
                "note": "googleSheet.spreadsheetId \"new\" makes a sheet on save; googleDrive.folderId \"root\" is My Drive",
            },
            "presets": list_presets(),
            "githubAccounts": list_gh_accounts(),
            "projects": projects_option(&self.workspaces.all()),
            "mcpServers": {
                "allow": list_mcp_servers(),
                "note": "Values for pr_review mcpTools: a whole server (mcp__server) or one tool (mcp__server__tool). \
                         claude.ai connectors (mcp__claude_ai_<Name>__…) and plugin servers (mcp__plugin_<plugin>_<server>__…) \
                         are not listed here. Suggest only tools that read.",
            },
            "slack": {
                "connected": connected,
                "warning": slack_warning(&slack.state),
                "userId": slack.user_id,
                "channels": channels,
                "usergroups": usergroups,
            },
        })
    }

    /// An agent's `workspaceId` must be a project the rail holds: a guessed id would save
    /// an automation whose runs fail later, far from the conversation that wrote it.
    fn check_project(&self, proposal: &Proposal) -> Result<(), String> {
        let Some(id) = proposal.form.get("workspaceId").and_then(|v| v.as_str()).map(str::trim).filter(|id| !id.is_empty())
        else {
            return Ok(());
        };
        if self.workspaces.all().iter().any(|w| w.id == id) {
            return Ok(());
        }
        Err(format!(
            "workspaceId: {id:?} is not a Lotus project on this machine; use an id from projects in lotus_automation_options, \
             or leave it out"
        ))
    }

    fn changed(&self) {
        let _ = self.app.emit(CHANGED_EVENT, ());
    }

    pub fn list_automations(&self) -> Result<Vec<AutomationView>, String> {
        let all = self.store.list_automations().map_err(|e| e.to_string())?;
        let now = SystemClock.now_ms();
        Ok(all.iter().map(|a| AutomationView::at(a, now)).collect())
    }

    pub fn create_pr_review(&self, form: PrReviewForm) -> Result<AutomationView, String> {
        let new = new_pr_review_automation(form)?;
        let created = self.store.create_automation(new, SystemClock.now_ms()).map_err(|e| e.to_string())?;
        self.changed();
        Ok(AutomationView::from(&created))
    }

    pub async fn run_review_round(&self, automation_id: &str, url: &str, rereview: bool, feedback: &str) -> Result<RunNowView, String> {
        let automation = self
            .store
            .get_automation(automation_id)
            .map_err(|e| e.to_string())?
            .ok_or("no such automation")?;
        let submitted = if rereview {
            pr_review::review_again(&self.engine, &self.store, self.github.as_ref(), &automation, url, feedback).await
        } else { pr_review::run_now(&self.engine, &self.store, self.github.as_ref(), &automation, url).await }.map_err(|e| e.to_string())?;
        self.changed();
        Ok(match submitted {
            Submitted::Started { run_id } => RunNowView::Started { run_id },
            Submitted::Duplicate { existing_run_id } => RunNowView::Duplicate { run_id: existing_run_id },
        })
    }

    /// The frontend's local workspaces, replacing the last list it sent.
    pub fn set_workspaces(&self, workspaces: Vec<WorkspaceFolder>) {
        *self.workspaces.0.lock().unwrap_or_else(|p| p.into_inner()) = workspaces;
    }

    /// A recent run's steps so far (see [`STEP_EVENT`] for the ones that follow).
    pub fn review_worktrees(&self) -> ReviewWorktreesView {
        let (count, bytes) = self.prefetch.worktree_usage();
        ReviewWorktreesView { count, bytes }
    }

    /// A PR review agent's GitHub read, as `account` (see `GhCli::read_for_review`).
    pub async fn github_read(&self, account: &str, path: &str, paginate: bool) -> Result<String, String> {
        self.github.read_for_review(account, path, paginate).await
    }

    pub fn run_steps(&self, run_id: &str) -> Vec<lotus_automation::activity::Step> {
        self.activity.steps(run_id)
    }

    /// The frontend opened a run's pane in workspace `workspace_id`, at `cwd`.
    pub fn pane_opened(&self, token: &str, cwd: &str, workspace_id: &str) -> Result<(), String> {
        // Recorded first: reopening the run later needs the folder its session lives under.
        if let Err(e) = self.store.set_session_place(token, cwd, workspace_id) {
            eprintln!("[automation] could not record the pane folder of {token}: {e}");
        }
        self.panes.opened(token)
    }

    /// The frontend could not open a run's pane; the run fails with `reason`.
    pub fn pane_failed(&self, token: &str, reason: &str) -> Result<(), String> {
        self.panes.failed(token, reason)
    }

    /// The agent in a run's pane submitted its result (the MCP submit tool).
    pub fn submit(&self, token: &str, result: serde_json::Value) -> Result<(), String> {
        self.panes.submit(token, result)
    }

    /// `run_id`'s conversation as a chat thread: the messages of the session it worked in, read
    /// from the agent's transcript, and whether the user can write to it now.
    pub fn run_conversation(&self, run_id: &str) -> Result<RunConversationView, String> {
        let session = self
            .store
            .run_session(run_id)
            .map_err(|e| e.to_string())?
            .ok_or("this run kept no conversation")?;
        let (head, busy) = self.store.session_head(&session.id).map_err(|e| e.to_string())?.unwrap_or_else(|| (run_id.to_string(), false));
        let kind = self
            .store
            .get_run(&head)
            .map_err(|e| e.to_string())?
            .and_then(|run| self.store.get_automation(&run.automation_id).ok().flatten())
            .map(|a| a.action.kind);
        let file = crate::fs_browse::claude_session_file(&session.cwd, &session.id);
        let entries = match &file {
            Some(path) => {
                // A transcript is a few MB at most; one far larger is not read whole into the view.
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                if size > MAX_TRANSCRIPT_BYTES {
                    return Err("this conversation is too long to show here".into());
                }
                let text = std::fs::read_to_string(path).map_err(|e| format!("could not read the conversation: {e}"))?;
                lotus_automation::chat::conversation(&text)
            }
            None => vec![],
        };
        let why_not = if busy {
            None
        } else if file.is_none() {
            Some("This run's conversation was not saved (the agent did not start).".to_string())
        } else if !kind.as_deref().is_some_and(|k| lotus_automation::chat::CHAT_KINDS.contains(&k)) {
            Some("This kind of automation cannot be asked about its work.".to_string())
        } else {
            None
        };
        Ok(RunConversationView { run_id: head, running: busy, can_reply: !busy && why_not.is_none(), why_not, entries })
    }

    /// Sends the user's message to `run_id`'s agent; returns the run that answers it.
    pub async fn send_message(&self, run_id: &str, text: &str, key: &str) -> Result<String, String> {
        let result = lotus_automation::chat::send_message(&self.store, &self.engine, Some(&HostTranscripts), run_id, text, key).await;
        self.changed();
        result
    }

    pub fn list_runs(&self, limit: usize) -> Result<Vec<RunView>, String> {
        let runs = self.store.list_runs(limit.min(500)).map_err(|e| e.to_string())?;
        Ok(runs.iter().map(RunView::from).collect())
    }

    /// Answers an Automation Ask and starts its Follow-up Run; returns that run's id.
    pub async fn answer_ask(&self, ask_id: &str, choice: Option<&str>, note: &str) -> Result<String, String> {
        let result = lotus_automation::ask::answer_ask(&self.store, &self.engine, ask_id, choice, note).await;
        self.changed();
        result
    }

    /// Answered Asks, most recently answered first.
    pub fn list_answered_asks(&self, limit: usize) -> Result<Vec<DraftView>, String> {
        let answered = self.store.list_sent(lotus_automation::ASK_KIND, limit.min(200)).map_err(|e| e.to_string())?;
        Ok(answered.iter().map(DraftView::from).collect())
    }

    /// PR reviews already sent to GitHub, most recent first.
    pub fn list_sent_reviews(&self, limit: usize) -> Result<Vec<DraftView>, String> {
        let sent = self.store.list_sent("pr_review", limit.min(200)).map_err(|e| e.to_string())?;
        Ok(sent.iter().map(DraftView::from).collect())
    }

    pub fn review_room(&self, automation_id: &str, url: &str) -> Result<ReviewRoomView, String> {
        let pr = pr_review::parse_pr_url(url).ok_or("not a GitHub pull request URL")?;
        let automation = self.store.get_automation(automation_id).map_err(|e| e.to_string())?.ok_or("no such automation")?;
        if automation.action.kind != "pr_review" { return Err("not a PR review automation".into()); }
        let config: pr_review::PrReviewConfig = serde_json::from_value(automation.action.config).map_err(|e| e.to_string())?;
        if !pr_review::repo_is_watched(&config.repos, &pr.repo) { return Err("repository is not watched".into()); }
        let history = self.store.review_history(automation_id, &pr.repo, pr.number).map_err(|e| e.to_string())?;
        let feedback = self.store.review_feedback(automation_id, &pr_review::pr_key(&pr)).map_err(|e| e.to_string())?;
        Ok(ReviewRoomView { history: history.iter().map(DraftView::from).collect(), feedback })
    }

    pub fn list_drafts(&self) -> Result<Vec<DraftView>, String> {
        let drafts = self.store.list_drafts(DraftStatus::Pending).map_err(|e| e.to_string())?;
        Ok(drafts
            .iter()
            .map(|d| {
                let mut view = DraftView::from(d);
                if d.kind == "pr_review" {
                    view.slack_group = pr_review::slack_reply::send_group(&self.store, d).len();
                }
                view
            })
            .collect())
    }

    pub fn update_draft(&self, draft_id: &str, edited: EditedReview) -> Result<bool, String> {
        let Some(draft) = self.store.get_draft(draft_id).map_err(|e| e.to_string())? else {
            return Err("no such draft".into());
        };
        let mut content = draft.content;
        content["summary"] = serde_json::Value::String(edited.summary);
        content["comments"] = serde_json::to_value(edited.comments).map_err(|e| e.to_string())?;
        if let Some(reply) = edited.reply {
            let reply = pr_review::brief::keep_lead(reply, &content["reply"]);
            reply.check()?;
            content["reply"] = serde_json::to_value(reply).map_err(|e| e.to_string())?;
        }
        let saved = self.store.update_draft_content(draft_id, &content).map_err(|e| e.to_string())?;
        self.changed();
        Ok(saved)
    }

    /// Posts a finished review draft when its automation is in auto mode: GitHub as
    /// [`pr_review::auto`] decides, then its Slack thread. A draft the rules hold back stays
    /// pending, with the reason on it.
    pub async fn auto_send(&self, draft_id: &str) {
        let Ok(Some(draft)) = self.store.get_draft(draft_id) else { return };
        if draft.kind != "pr_review" || draft.status != DraftStatus::Pending {
            return;
        }
        let Ok(Some(automation)) = self.store.get_automation(&draft.automation_id) else { return };
        let Ok(config) = serde_json::from_value::<lotus_automation::pr_review::PrReviewConfig>(automation.action.config.clone()) else {
            return;
        };
        if !config.auto_send {
            return;
        }
        let now = SystemClock.now_ms();
        let outcome = pr_review::auto::send(&self.store, self.github.as_ref(), &config.account, draft_id, now).await;
        match outcome {
            Ok(pr_review::auto::Outcome::Sent { url, event, note }) => {
                eprintln!("[automation] auto mode posted {} as {}{}", draft.subject, event.as_str(), note.as_deref().map(|n| format!(" · {n}")).unwrap_or_default());
                if let Some(note) = note {
                    let _ = self.store.note_on_sent_draft(draft_id, "auto_note", serde_json::Value::String(note));
                }
                self.slack.react_after_send(&self.store, draft_id).await;
                if draft.content["slack"]["thread_ts"].is_string() {
                    let web = self.slack.web();
                    let slack = web.as_ref().map(|w| w as &dyn lotus_automation::slack::SlackApi);
                    let reply = pr_review::slack_reply::reply_after_send(&self.store, slack, draft_id, &url, None, SystemClock.now_ms()).await;
                    let _ = self.store.note_on_sent_draft(draft_id, "slack_reply", serde_json::Value::String(reply));
                }
            }
            Ok(pr_review::auto::Outcome::Held(reason)) => {
                eprintln!("[automation] auto mode held {}: {reason}", draft.subject);
                let mut content = draft.content.clone();
                content["auto_held"] = serde_json::Value::String(reason);
                let _ = self.store.update_draft_content(draft_id, &content);
            }
            Err(e) => eprintln!("[automation] auto mode could not post {}: {e}", draft.subject),
        }
        self.changed();
    }

    pub async fn send_draft(
        &self,
        draft_id: String,
        edited: Option<EditedReview>,
        send_even_if_stale: bool,
        reply_in_thread: bool,
        approve: bool,
        close_threads: bool,
        // The reviewer's own text for the request thread's message (ADR-0052 §8).
        slack_text: Option<String>,
        // Off: Slack only, nothing posted on GitHub.
        post_github: bool,
    ) -> Result<SendView, String> {
        if !post_github && !reply_in_thread {
            return Err("nothing to send: turn on GitHub or the Slack reply".into());
        }
        // Checked before GitHub: a refused text must not leave a review sent without its reply.
        let slack_text = slack_text.map(|t| pr_review::slack_reply::check_edited(&t)).transpose()?;
        let request = SendRequest { draft_id: draft_id.clone(), edited, send_even_if_stale, approve, request_changes: false, close_threads, post_github };
        let result = pr_review::send_draft(&self.store, self.github.as_ref(), request, SystemClock.now_ms()).await;
        let view = match result {
            Ok(url) => {
                self.slack.react_after_send(&self.store, &draft_id).await;
                // The review is on GitHub whatever happens next; a failed Slack reply is reported, not fatal.
                // A thread gets one message for all its reviews: this one may wait for the others.
                let web = self.slack.web();
                let slack = web.as_ref().map(|w| w as &dyn lotus_automation::slack::SlackApi);
                let now = SystemClock.now_ms();
                let slack_reply = if reply_in_thread {
                    Some(pr_review::slack_reply::reply_after_send(&self.store, slack, &draft_id, &url, slack_text.as_deref(), now).await)
                } else {
                    // No reply of its own: the replies it held up in its threads may go now.
                    if let Ok(Some(draft)) = self.store.get_draft(&draft_id) {
                        pr_review::slack_reply::release(&self.store, slack, &draft, now).await;
                    }
                    None
                };
                // Kept on the draft so the Sent list can say what happened after the panel moved on.
                let note = slack_reply.clone().map_or(serde_json::Value::Null, serde_json::Value::String);
                if let Err(e) = self.store.note_on_sent_draft(&draft_id, "slack_reply", note) {
                    eprintln!("[automation] could not note the Slack reply on draft {draft_id}: {e}");
                }
                Ok(SendView::Sent { url, slack_reply })
            }
            Err(SendError::Stale { reviewed, current }) => Ok(SendView::Stale { reviewed, current }),
            Err(e) => Err(e.to_string()),
        };
        // Only now: the panel re-reads on this event, and the Slack outcome must already be in.
        self.changed();
        view
    }

    /// "Send all" for the Slack thread `draft_id` was asked in: every pending review of that
    /// thread goes to GitHub, then the thread gets one message. Stops at the first that cannot be
    /// sent (stale, invalid); what was sent stays sent, and its reply waits.
    /// Never approves: an approval stays one explicit click per PR (ADR-0042). `close_threads`
    /// applies to each; a draft with no earlier findings has no thread to close.
    /// `slack_text` is used by the send that posts the thread's message, the last one.
    pub async fn send_all(
        &self,
        draft_id: String,
        reply_in_thread: bool,
        close_threads: bool,
        slack_text: Option<String>,
    ) -> Result<Vec<(String, SendView)>, String> {
        let slack_text = slack_text.map(|t| pr_review::slack_reply::check_edited(&t)).transpose()?;
        let draft = self.store.get_draft(&draft_id).map_err(|e| e.to_string())?.ok_or("no such draft")?;
        let mut sent = Vec::new();
        for id in pr_review::slack_reply::send_group(&self.store, &draft) {
            let view = self.send_draft(id.clone(), None, false, reply_in_thread, false, close_threads, slack_text.clone(), true).await?;
            let stop = !matches!(view, SendView::Sent { .. });
            sent.push((id, view));
            if stop {
                break;
            }
        }
        Ok(sent)
    }

    /// What the request thread of `draft_id` will be told if it is sent now (with `all`: its
    /// whole Send all group), or how many reviews still hold the message back.
    pub fn slack_preview(&self, draft_id: &str, all: bool) -> Result<pr_review::slack_reply::Preview, String> {
        let draft = self.store.get_draft(draft_id).map_err(|e| e.to_string())?.ok_or("no such draft")?;
        pr_review::slack_reply::preview(&self.store, &draft, all)
    }

    /// Posts the Slack replies `draft_id` holds now, without waiting for the rest of its thread.
    pub async fn reply_now(&self, draft_id: &str) -> String {
        let web = self.slack.web();
        let slack = web.as_ref().map(|w| w as &dyn lotus_automation::slack::SlackApi);
        let outcome = pr_review::slack_reply::reply_now(&self.store, slack, draft_id, SystemClock.now_ms()).await;
        if let Err(e) = self.store.note_on_sent_draft(draft_id, "slack_reply", serde_json::Value::String(outcome.clone())) {
            eprintln!("[automation] could not note the Slack reply on draft {draft_id}: {e}");
        }
        self.changed();
        outcome
    }

    pub async fn discard_draft(&self, draft_id: &str, reason: Option<&str>) -> Result<(), String> {
        match self.store.discard_draft_because(draft_id, reason, SystemClock.now_ms()).map_err(|e| e.to_string())? {
            Ok(()) => {
                // Dismissed: the replies it held up in its Slack threads may go now.
                if let Ok(Some(draft)) = self.store.get_draft(draft_id) {
                    let web = self.slack.web();
                    let slack = web.as_ref().map(|w| w as &dyn lotus_automation::slack::SlackApi);
                    pr_review::slack_reply::release(&self.store, slack, &draft, SystemClock.now_ms()).await;
                }
                self.changed();
                Ok(())
            }
            Err(status) => Err(format!("the draft is {} and cannot be discarded", status.as_str())),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum RunNowView {
    #[serde(rename_all = "camelCase")]
    Started { run_id: String },
    /// This commit was already reviewed; `run_id` is that run.
    #[serde(rename_all = "camelCase")]
    Duplicate { run_id: String },
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRoomView {
    pub history: Vec<DraftView>,
    pub feedback: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SendView {
    #[serde(rename_all = "camelCase")]
    Sent {
        url: String,
        /// `replied`, or why the Slack thread reply did not happen. Absent when not asked for.
        slack_reply: Option<String>,
    },
    /// Nothing was sent: the PR moved past the reviewed commit.
    Stale { reviewed: String, current: String },
}

/// A delegation preset as the automation form lists it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetView {
    pub id: String,
    pub name: String,
    pub agent: String,
    /// Whether it can run headless for an automation (claude / ccs).
    pub supported: bool,
    /// Why it cannot run, in the user's terms (e.g. its account is gone).
    pub problem: Option<String>,
    /// The `--model` / `--effort` / account the preset itself sets, for the picker's defaults.
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
}

pub fn list_presets() -> Vec<PresetView> {
    read_presets()
        .into_iter()
        .map(|(id, name, raw, account)| {
            let flag = |name: &str| flag_value(&raw.args, name);
            let (model, effort) = (flag("--model"), flag("--effort"));
            let preset = on_claude_account(raw, account.clone(), crate::accounts::find, crate::usage::chosen_account);
            let problem = build_agent_command(&preset, &serde_json::json!({})).err().map(|e| e.to_string());
            PresetView { id, name, agent: preset.agent, supported: problem.is_none(), problem, model, effort, account }
        })
        .collect()
}

/// The value of `--flag v` or `--flag=v` in a preset's args.
fn flag_value(args: &str, flag: &str) -> Option<String> {
    let mut tokens = args.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == flag {
            return tokens.next().map(String::from);
        }
        if let Some(v) = token.strip_prefix(flag).and_then(|rest| rest.strip_prefix('=')) {
            return Some(v.to_string());
        }
    }
    None
}

/// Delegation presets live in Claude settings (`delegation.presets[]`, see
/// `src/modules/tasks/services/delegation-preset.ts`). Read on every lookup so
/// an edited preset applies to the next run without a restart. The id may carry the
/// automation's model, effort and account on top (`agent::parse_agent_ref`).
pub(crate) fn delegation_presets() -> PresetLookup {
    Arc::new(|reference: &str| {
        resolve_agent_ref(reference, read_presets(), crate::accounts::find, crate::usage::chosen_account)
    })
}

fn resolve_agent_ref(
    reference: &str,
    presets: Vec<(String, String, Preset, Option<String>)>,
    find: impl Fn(&str) -> Option<crate::accounts::Account>,
    chosen: impl FnOnce() -> Option<crate::accounts::Account>,
) -> Option<Preset> {
    let (id, choice) = match lotus_automation::agent::parse_agent_ref(reference) {
        Ok(parsed) => parsed,
        // A hand-edited ref that does not parse refuses the run with the reason, never runs a guess.
        Err(e) => return Some(Preset { agent: "claude".into(), unavailable: Some(e), ..Default::default() }),
    };
    let (_, _, mut preset, account) = presets.into_iter().find(|(pid, ..)| pid == id)?;
    if let Some(model) = &choice.model {
        preset.args = lotus_automation::agent::set_flag(&preset.args, "--model", model);
    }
    if let Some(effort) = &choice.effort {
        preset.args = lotus_automation::agent::set_flag(&preset.args, "--effort", effort);
    }
    Some(on_claude_account(preset, choice.account.or(account), find, chosen))
}

/// Raw presets as saved: id, name, preset, and its own account (not yet applied).
fn read_presets() -> Vec<(String, String, Preset, Option<String>)> {
    let Ok(text) = std::fs::read_to_string(paths::claude_dir().join("settings.json")) else {
        return vec![];
    };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    settings["delegation"]["presets"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|p| {
                    let id = p["id"].as_str()?.trim().to_string();
                    let name = p["name"].as_str()?.trim().to_string();
                    let agent = p["agent"].as_str()?.trim().to_string();
                    let args = p["args"].as_str().unwrap_or_default().trim().to_string();
                    let account = p["account"].as_str().map(str::trim).filter(|a| !a.is_empty()).map(String::from);
                    let preset = Preset { agent, args, ..Default::default() };
                    (!id.is_empty() && !preset.agent.is_empty()).then_some((id, name, preset, account))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Runs a Claude preset on a Lotus account, as a pane would (portable-accounts issues/07, 08):
/// `ccs <name>` becomes `claude` on account `<name>`, so a preset saved before ccs was removed
/// keeps working; then the preset's own account, else the one chosen in Lotus. An account that
/// is gone refuses the run: running on another login would bill the wrong one.
fn on_claude_account(
    mut preset: Preset,
    account: Option<String>,
    find: impl Fn(&str) -> Option<crate::accounts::Account>,
    chosen: impl FnOnce() -> Option<crate::accounts::Account>,
) -> Preset {
    let argv = preset.agent.split_whitespace().map(String::from).collect();
    let (argv, account) = crate::pty::legacy_ccs(argv, account, |id| find(id).is_some());
    preset.agent = argv.join(" ");
    if argv.first().map(String::as_str) != Some("claude") {
        return preset;
    }
    let target = match account {
        Some(id) => match find(&id) {
            Some(found) => Some(found),
            None => {
                preset.unavailable =
                    Some(format!("the Claude account {id:?} is not on this machine; pick another account for this agent"));
                return preset;
            }
        },
        None => chosen(),
    };
    match target {
        Some(a) if crate::accounts::is_default(&a.dir) => preset.unset.push("CLAUDE_CONFIG_DIR".into()),
        Some(a) => preset.env.push(("CLAUDE_CONFIG_DIR".into(), a.dir.to_string_lossy().into_owned())),
        // Nothing chosen: the login shell's own setting stands, as in a terminal.
        None => {}
    }
    preset
}

/// The user's MCP servers from `~/.claude.json`, as `mcp__<server>` allow
/// entries for a review's `mcpTools`. Lotus's own server is left out: a run
/// reaches it only to submit, which Lotus allows by itself.
pub fn list_mcp_servers() -> Vec<String> {
    let config = crate::mcp_config::mcp_config_path()
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .unwrap_or_default();
    mcp_server_allow_entries(&config)
}

fn mcp_server_allow_entries(config: &serde_json::Value) -> Vec<String> {
    let mut names: Vec<String> = config["mcpServers"]
        .as_object()
        .into_iter()
        .flat_map(|servers| servers.keys())
        .filter(|name| !matches!(name.as_str(), "lotus" | "lotus-dev"))
        .map(|name| format!("mcp__{name}"))
        .filter(|entry| lotus_automation::agent::check_mcp_tool(entry).is_ok())
        .collect();
    names.sort();
    names
}

/// The github.com accounts gh is logged into, read from its `hosts.yml`
/// (no network, no token). Location follows gh: `$GH_CONFIG_DIR`, else
/// `$XDG_CONFIG_HOME/gh`, else `~/.config/gh`, as seen by the login shell.
pub fn list_gh_accounts() -> Vec<GhAccount> {
    let env = shell_env::user_login_env();
    let dir = env
        .get("GH_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| env.get("XDG_CONFIG_HOME").map(|x| PathBuf::from(x).join("gh")))
        .unwrap_or_else(|| paths::home_dir().join(".config").join("gh"));
    std::fs::read_to_string(dir.join("hosts.yml")).map(|text| parse_gh_hosts(&text)).unwrap_or_default()
}

/// The largest transcript the conversation view reads.
const MAX_TRANSCRIPT_BYTES: u64 = 32 * 1024 * 1024;

/// A run's conversation, as the thread shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConversationView {
    /// The newest run in the conversation: the one a message follows up.
    pub run_id: String,
    /// A run in it is still working; its messages so far are shown.
    pub running: bool,
    pub can_reply: bool,
    /// Why the user cannot write to it, in words they can act on.
    pub why_not: Option<String>,
    pub entries: Vec<lotus_automation::chat::ChatEntry>,
}

/// The GitHub repository (`owner/name`) a folder is a checkout of, from its
/// `origin` remote; `None` when it is not a git checkout of a github.com repo.
/// Lets a PR review's pane open in the workspace that holds that repo.
pub fn folder_repo(cwd: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .no_window()
        .args(["-C", cwd, "remote", "get-url", "origin"])
        .envs(shell_env::user_login_env().iter())
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    pr_review::repo_from_remote_url(&String::from_utf8_lossy(&out.stdout))
}

/// A workspace as the frontend knows it, for [`find_checkout`].
#[derive(Debug, Clone, serde::Deserialize)]
pub struct WorkspaceFolder {
    pub id: String,
    pub cwd: String,
    /// The name the rail shows; only for `options`.
    #[serde(default)]
    pub name: Option<String>,
}

/// The IANA name of this machine's time zone, e.g. `Asia/Jakarta`; `UTC` when unknown.
fn system_timezone() -> String {
    iana_time_zone::get_timezone()
        .ok()
        .filter(|tz| lotus_automation::schedule::Schedule::parse("0 9 * * *", tz).is_ok()).unwrap_or_else(|| "UTC".into())
}

/// The local projects an agent may put an automation in (`form.workspaceId`).
fn projects_option(workspaces: &[WorkspaceFolder]) -> serde_json::Value {
    let projects: Vec<serde_json::Value> = workspaces
        .iter()
        .map(|w| {
            let name = w.name.clone().filter(|n| !n.trim().is_empty()).unwrap_or_else(|| {
                std::path::Path::new(&w.cwd).file_name().map_or_else(|| w.cwd.clone(), |n| n.to_string_lossy().into_owned())
            });
            serde_json::json!({ "id": w.id, "name": name, "folder": w.cwd })
        })
        .collect();
    serde_json::json!({
        "list": projects,
        "note": "Values for form.workspaceId: runs then work in that project's folder (openPane: true shows each run \
                 in a pane there). Leave it out when the user names no project. Empty while no Lotus window is open.",
    })
}

/// Said plainly when Slack is not connected, so the agent tells the user before
/// saving an automation that depends on it; `None` when connected.
fn slack_warning(state: &str) -> Option<String> {
    let why = match state {
        "connected" => return None,
        "not_set_up" => "Slack is not connected to Lotus",
        "connecting" | "retrying" => "Slack is still connecting",
        _ => "Slack is disconnected",
    };
    Some(format!(
        "{why}, so there are no channel or user group ids here. A pr_review Slack trigger, dmSelf and slackChannel \
         will not work until the user connects Slack in Automation → Connectors. Tell the user before saving one."
    ))
}

/// [`lotus_automation::checkout::find_checkout`] on this machine: `origin`
/// read with git, subfolders from the file system. `namesake` also accepts the
/// one checkout of a same-named repo under another owner
/// ([`lotus_automation::checkout::find_checkout_or_namesake`]): for opening an
/// agent on an issue only, never for anything that pushes.
pub fn find_checkout(
    repo: &str,
    workspaces: Vec<WorkspaceFolder>,
    preferred: Option<&str>,
    namesake: bool,
) -> Option<lotus_automation::checkout::Found> {
    use lotus_automation::checkout::{find_checkout_or_namesake, git_subfolders, Candidate};
    let candidates: Vec<Candidate> =
        workspaces.into_iter().map(|w| Candidate { workspace_id: w.id, cwd: PathBuf::from(w.cwd) }).collect();
    let find = if namesake { find_checkout_or_namesake } else { lotus_automation::checkout::find_checkout };
    find(
        repo,
        &candidates,
        preferred,
        &|folder| folder_repo(&folder.to_string_lossy()),
        &|folder| git_subfolders(folder),
    )
}

/// The local workspaces the frontend last reported (it owns the rail).
#[derive(Default)]
pub struct KnownWorkspaces(std::sync::Mutex<Vec<WorkspaceFolder>>);

impl KnownWorkspaces {
    fn all(&self) -> Vec<WorkspaceFolder> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }
}

impl lotus_automation::workspaces::Workspaces for KnownWorkspaces {
    fn folder(&self, workspace_id: &str) -> Option<PathBuf> {
        self.all().into_iter().find(|w| w.id == workspace_id).map(|w| PathBuf::from(w.cwd))
    }

    fn checkout(&self, repo: &str, preferred: Option<&str>) -> Option<lotus_automation::checkout::Found> {
        find_checkout(repo, self.all(), preferred, false)
    }
}

#[cfg(test)]
mod tests {
    use super::WorkspaceFolder;

    mod claude_account {
        use super::super::{on_claude_account, resolve_agent_ref, Preset};
        use crate::accounts::{Account, Source};

        fn account(id: &str, dir: std::path::PathBuf) -> Account {
            Account { id: id.into(), source: Source::Ccs, config_file: dir.join(".claude.json"), dir }
        }
        fn acme() -> Account {
            account("acme", "/u/.ccs/instances/acme".into())
        }
        fn find(id: &str) -> Option<Account> {
            (id == "acme").then(acme)
        }
        fn preset(agent: &str) -> Preset {
            Preset { agent: agent.into(), args: "--effort medium".into(), ..Default::default() }
        }
        fn dir_env(p: &Preset) -> Vec<(String, String)> {
            p.env.clone()
        }

        #[test]
        fn an_automations_choice_goes_on_top_of_its_preset() {
            let saved = || vec![("p".to_string(), "Foreman".to_string(), preset("claude"), Some("gone".to_string()))];
            let p = resolve_agent_ref("p?model=opus&effort=high&account=acme", saved(), find, || None).unwrap();
            assert_eq!(p.args, "--model opus --effort high");
            assert_eq!(dir_env(&p)[0].1, "/u/.ccs/instances/acme");
            // Without a choice the preset's own (missing) account refuses the run.
            assert!(resolve_agent_ref("p", saved(), find, || None).unwrap().unavailable.is_some());
            assert!(resolve_agent_ref("x?model=opus", saved(), find, || None).is_none());
            assert!(resolve_agent_ref("p?model=a;rm", saved(), find, || None).unwrap().unavailable.is_some());
        }

        #[test]
        fn a_ccs_preset_runs_claude_on_that_account() {
            let p = on_claude_account(preset("ccs acme"), None, find, || None);
            assert_eq!(p.agent, "claude");
            assert_eq!(dir_env(&p), [("CLAUDE_CONFIG_DIR".to_string(), "/u/.ccs/instances/acme".to_string())]);
            assert_eq!(p.unavailable, None);
        }

        #[test]
        fn a_plain_claude_preset_runs_on_the_chosen_account() {
            let p = on_claude_account(preset("claude"), None, find, || Some(acme()));
            assert_eq!(dir_env(&p)[0].1, "/u/.ccs/instances/acme");
        }

        #[test]
        fn the_presets_own_account_wins_over_the_chosen_one() {
            let chosen = || Some(account("other", "/u/other".into()));
            let p = on_claude_account(preset("claude"), Some("acme".into()), find, chosen);
            assert_eq!(dir_env(&p)[0].1, "/u/.ccs/instances/acme");
        }

        #[test]
        fn the_default_account_clears_the_variable() {
            let p = on_claude_account(preset("claude"), None, find, || Some(account("default", crate::paths::claude_dir())));
            assert!(p.env.is_empty());
            assert_eq!(p.unset, ["CLAUDE_CONFIG_DIR"]);
        }

        #[test]
        fn a_missing_account_refuses_instead_of_billing_another() {
            let p = on_claude_account(preset("claude"), Some("gone".into()), find, || Some(acme()));
            assert!(p.unavailable.unwrap().contains("gone"));
            assert!(p.env.is_empty());
        }

        #[test]
        fn other_agents_are_left_alone() {
            let p = on_claude_account(preset("codex"), None, find, || Some(acme()));
            assert_eq!(p, preset("codex"));
            // A ccs API profile is no account: it stays ccs.
            assert_eq!(on_claude_account(preset("ccs glm"), None, find, || None).agent, "ccs glm");
        }
    }

    #[test]
    fn the_system_time_zone_is_one_a_schedule_accepts() {
        let tz = super::system_timezone();
        assert!(lotus_automation::schedule::Schedule::parse("0 9 * * *", &tz).is_ok(), "{tz}");
    }

    #[test]
    fn projects_carry_the_rail_name_or_else_the_folder_name() {
        let ws = |id: &str, cwd: &str, name: Option<&str>| WorkspaceFolder { id: id.into(), cwd: cwd.into(), name: name.map(Into::into) };
        let options = super::projects_option(&[
            ws("ws-1", "/Users/a/workspace/orbit-vault", Some("Notes")),
            ws("ws-2", "/Users/a/workspace/acme-api", None),
        ]);
        assert_eq!(
            options["list"],
            serde_json::json!([
                { "id": "ws-1", "name": "Notes", "folder": "/Users/a/workspace/orbit-vault" },
                { "id": "ws-2", "name": "acme-api", "folder": "/Users/a/workspace/acme-api" },
            ])
        );
        assert!(options["note"].as_str().unwrap().contains("workspaceId"));
    }

    #[test]
    fn slack_that_is_not_connected_comes_with_a_warning_naming_where_to_fix_it() {
        assert_eq!(super::slack_warning("connected"), None);
        for state in ["not_set_up", "connecting", "retrying", "stopped"] {
            let warning = super::slack_warning(state).unwrap();
            assert!(warning.contains("Connectors") && warning.contains("dmSelf"), "{state}: {warning}");
        }
    }

    #[test]
    fn mcp_servers_become_allow_entries_without_lotus_itself() {
        let config = serde_json::json!({ "mcpServers": {
            "context7": {}, "lotus": {}, "lotus-dev": {}, "lotus-notes": {}, "claude-mem": {}, "bad name": {}
        }});
        assert_eq!(super::mcp_server_allow_entries(&config), ["mcp__claude-mem", "mcp__context7", "mcp__lotus-notes"]);
        assert!(super::mcp_server_allow_entries(&serde_json::json!({})).is_empty());
    }
}
