//! Hosts the Rust Graph Run engine (`lotus-graph-run`, ADR-0049 §6) in the app.
//!
//! Contract with the UI (F1 decision, see `plans/factory-run/CHECKPOINTS.md`):
//! - The record in `codecanvas_graph_runs` is the truth. The UI reads it with the existing
//!   `codecanvas_get_graph_run` / `codecanvas_list_graph_runs`, same JSON shape as TS runs.
//! - After every write the engine emits [`CHANGED_EVENT`] `{ id, projectId, status }`. A UI that is
//!   open reads the record again; a UI that was closed reads it when it opens. Nothing waits on
//!   the UI, so runs continue with no webview.
//! - The UI sends decisions as commands: `graph_run_raise_cap`, `graph_run_abort`, and for a run
//!   `waiting` on its intake (FI2) `graph_run_decide` ([`Decision`]).
//!
//! Steps run as Factory Runs (F2, [`lotus_graph_run::factory::FactoryRunner`]): worktree →
//! implementer → the repo's gate → draft PR. The ports are in [`crate::factory_host`]. Finished
//! runs' worktrees are reaped at start (after recovery reconciliation) and every [`REAP_EVERY`].

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use std::time::Duration;

use lotus_graph_run::factory::alerts::{Alert, Alerts, Notifier};
use lotus_graph_run::factory::chief::{ChiefOfStaff, SIGNALS_EVERY};
use lotus_graph_run::factory::pr_watch::PrWatcher;
use lotus_graph_run::factory::revision::{RoundPolicies, RoundPolicy};
use lotus_graph_run::factory::{reap, record_pr_outcome, FactoryConfig, FactoryRunner};
use lotus_graph_run::{
    Answer, Engine, EngineConfig, IntakeDecision, RunChanged, RunEvents, RunStore, SqliteRunStore, StepRunner, SystemClock,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const CHANGED_EVENT: &str = "graph-run://changed";

/// What the UI decided for a run waiting on its intake, as `graph_run_decide` receives it.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Decision {
    Answer { answers: Vec<Answer> },
    /// `spec` = the user's edited spec; absent = approved as written.
    Approve { spec: Option<String> },
    SendBack { note: String },
    /// "Continue anyway" on a run its triage stopped (FI3).
    Proceed,
}

impl From<Decision> for IntakeDecision {
    fn from(decision: Decision) -> Self {
        match decision {
            Decision::Answer { answers } => IntakeDecision::Answer(answers),
            Decision::Approve { spec } => IntakeDecision::Approve(spec),
            Decision::SendBack { note } => IntakeDecision::SendBack(note),
            Decision::Proceed => IntakeDecision::Proceed,
        }
    }
}

pub struct GraphRunHost {
    pub engine: Arc<Engine>,
    /// Completed runs' records, which the PR watcher and the pane's label edits write directly.
    pub store: Arc<SqliteRunStore>,
    /// When the Chief of Staff last looked at the runs (Unix ms); 0 before its first look.
    pub chief_checked_at: Arc<AtomicI64>,
    /// Held while a Factory PR's record is changed, by the PR watcher or by Start round (CoS 6).
    pub pr_edits: lotus_graph_run::factory::revision::PrEdits,
    /// Posts the reply drafts as the user's `gh` login (CoS 9).
    pub pull_requests: Arc<dyn lotus_graph_run::factory::PullRequests>,
    /// Posts the Slack thread reply as the user (CoS 12).
    pub slack: Arc<ChiefNotifier>,
    /// The one GitHub → Slack identity file, shared with the PR watcher so its lock covers both.
    pub slack_identities: Arc<lotus_graph_run::factory::slack_reply::FileSlackIdentities>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload {
    id: String,
    project_id: String,
    status: &'static str,
}

struct TauriEvents(AppHandle);

impl RunEvents for TauriEvents {
    fn changed(&self, event: RunChanged) {
        // No window open is fine: the record is already written.
        let _ = self.0.emit(
            CHANGED_EVENT,
            ChangedPayload { id: event.id, project_id: event.project_id, status: event.status.as_str() },
        );
    }
}

/// The Chief of Staff's alerts (CoS 11): a macOS notification, and a DM from the Lotus bot when
/// its token is saved in Connectors › Slack. Also its Slack thread replies, as the user (CoS 12).
/// Looks the Slack session up on every call, so a token added later is used without a restart.
pub struct ChiefNotifier(pub AppHandle);

impl ChiefNotifier {
    fn bot(&self) -> Option<(lotus_automation::slack::web::SlackWeb, String)> {
        use tauri::Manager;
        self.0.try_state::<crate::automation_host::AutomationRuntime>()?.slack_bot_target()
    }

    fn user(&self) -> Result<lotus_automation::slack::web::SlackWeb, String> {
        use tauri::Manager;
        self.0.try_state::<crate::automation_host::AutomationRuntime>().and_then(|r| r.slack_user_web()).ok_or_else(|| "Slack is not connected".into())
    }
}

impl Notifier for ChiefNotifier {
    fn slack_user(&self) -> Option<String> {
        self.bot().map(|(_, me)| me)
    }

    fn desktop(&self, alert: &Alert) -> Result<(), String> {
        use tauri_plugin_notification::NotificationExt;
        self.0.notification().builder().title(alert.title()).body(alert.body()).show().map_err(|e| e.to_string())
    }

    fn slack_dm(&self, user: &str, alert: &Alert) -> lotus_graph_run::BoxFuture<Result<(), String>> {
        let bot = self.bot().map(|(web, _)| web);
        let (user, text) = (user.to_string(), alert.slack_text());
        Box::pin(async move {
            use lotus_automation::slack::SlackApi;
            // A user id as the channel: the bot's DM with that user (its Messages tab).
            bot.ok_or("the Slack bot is gone")?.post_message(&user, &text).await.map(|_| ())
        })
    }

    fn find_thread(&self, pr_url: &str) -> lotus_graph_run::BoxFuture<Result<Option<lotus_graph_run::SlackThread>, String>> {
        let (web, url) = (self.user(), pr_url.to_string());
        Box::pin(async move {
            let found = web?.search_thread(&url).await?;
            Ok(found.map(|t| lotus_graph_run::SlackThread { channel: t.channel, channel_name: t.channel_name, ts: t.ts, permalink: t.permalink }))
        })
    }

    fn reply_in_thread(&self, thread: &lotus_graph_run::SlackThread, text: &str) -> lotus_graph_run::BoxFuture<Result<String, String>> {
        let (web, channel, ts, text) = (self.user(), thread.channel.clone(), thread.ts.clone(), text.to_string());
        Box::pin(async move {
            use lotus_automation::slack::SlackApi;
            web?.post_reply(&channel, &ts, &text).await
        })
    }
}

/// GitHub login → Slack member ID, as the user answered "Who is GitHub @x on Slack?" (CoS 12).
fn slack_identities() -> Arc<lotus_graph_run::factory::slack_reply::FileSlackIdentities> {
    Arc::new(lotus_graph_run::factory::slack_reply::FileSlackIdentities::new(crate::paths::lotus_state_dir().join("factory-slack-identities.json")))
}

/// How often finished runs' worktrees are looked for.
const REAP_EVERY: Duration = Duration::from_secs(30 * 60);
/// The longest the repo's gate may run (Lotus' own `tools/gates.sh` with a cold cargo build).
const GATE_TIMEOUT: Duration = Duration::from_secs(40 * 60);

/// Opens the engine and reconciles unfinished runs. Interrupted Factory work is held for inspection.
/// Where the Factory finds the user's skills and MCP servers (FI4): the agent CLI's own places.
pub fn factory_kit_sources() -> lotus_graph_run::factory::kit::KitSources {
    lotus_graph_run::factory::kit::KitSources {
        claude_dir: Some(crate::paths::claude_dir()),
        claude_json: Some(crate::paths::home_dir().join(".claude.json")),
        // Outside the repo and outside every run's worktree (`factory/`): an agent cannot edit it.
        private_root: Some(crate::paths::lotus_state_dir().join("factory-private")),
    }
}

pub fn start(app: &AppHandle) -> Result<GraphRunHost, String> {
    let path = crate::codecanvas_store::database_path(app).map_err(|e| e.to_string())?;
    // Run the app's migrations first so the table exists with its foreign key.
    crate::codecanvas_store::open_store(&path).map_err(|e| e.to_string())?;
    let store = Arc::new(SqliteRunStore::open(&path).map_err(|e| e.to_string())?);
    let events = Arc::new(TauriEvents(app.clone()));
    // The engine's actor lives on Tauri's tokio runtime; setup itself is not inside it.
    let runtime = tauri::async_runtime::handle();
    let _inside = runtime.inner().enter();
    let env = crate::shell_env::login_env_without_unset();
    let pull_requests = Arc::new(crate::factory_host::GhPullRequests {
        gh: lotus_automation::github::Gh::new("gh").with_base_env(env.clone()),
    });
    let root = crate::factory_host::factory_root();
    let presets = crate::automation_host::delegation_presets();
    let judge = Arc::new(crate::factory_host::CliJudge { presets: Arc::clone(&presets), env: env.clone(), kit: factory_kit_sources() });
    let runner = Arc::new(
        FactoryRunner::new(
            FactoryConfig { root: root.clone(), gate_timeout: GATE_TIMEOUT, env: env.clone(), push_to_github: true, kit: factory_kit_sources() },
            Arc::new(crate::factory_host::CliImplementer { presets: Arc::clone(&presets), env: env.clone() }),
            pull_requests.clone(),
        )
        .with_spec_agent(Arc::new(crate::factory_host::CliSpecAgent { presets: Arc::clone(&presets), env: env.clone() }))
        // Triage runs as the same read-only agent, as the triage role's preset, with no MCP (FI3).
        .with_triage_agent(Arc::new(crate::factory_host::CliSpecAgent { presets: Arc::clone(&presets), env: env.clone() }))
        // So does the review against the spec, as the review role's preset and model (FI7).
        .with_review_agent(Arc::new(crate::factory_host::CliSpecAgent { presets, env })),
    );
    let engine = Arc::new(Engine::spawn(
        Arc::clone(&store) as Arc<dyn RunStore>,
        Arc::clone(&runner) as Arc<dyn StepRunner>,
        Some(Arc::clone(&events) as Arc<dyn RunEvents>),
        Arc::new(SystemClock),
        EngineConfig::default(),
    ));
    // The Chief of Staff (ADR-0056): its own loop beside the reaper, on the same store and engine.
    let chief_checked_at = Arc::new(AtomicI64::new(0));
    let chief = ChiefOfStaff::new(Arc::clone(&store) as Arc<dyn RunStore>, Arc::clone(&engine));
    // It also watches each completed run's PR: all at once now (the catch-up), then every
    // `poll_minutes` per repo. Only runs in this store: another Mac's PRs are not ours.
    let pr_edits = lotus_graph_run::factory::revision::PrEdits::default();
    let host_prs = pull_requests.clone() as Arc<dyn lotus_graph_run::factory::PullRequests>;
    // A batch the routing rule passes starts its round by itself (CoS 7): the only engine action
    // the Chief of Staff takes on its own (ADR-0056 §5).
    let notifier = Arc::new(ChiefNotifier(app.clone()));
    let identities = slack_identities();
    let pr_watcher = PrWatcher::new(Arc::clone(&store) as Arc<dyn RunStore>, pull_requests.clone())
        .with_judge(judge)
        .with_edits(Arc::clone(&pr_edits))
        .with_rounds(Arc::clone(&engine), Arc::new(DefinitionRounds))
        .with_slack(Arc::clone(&notifier) as Arc<dyn Notifier>, Arc::clone(&identities) as _);
    // Only what is raised from now on pings: the last session already alerted the rest.
    let alerts = Alerts::new(Arc::clone(&store) as Arc<dyn RunStore>, Arc::clone(&notifier) as Arc<dyn Notifier>, now_ms());
    let checked = Arc::clone(&chief_checked_at);
    let pr_events = Arc::clone(&events);
    tauri::async_runtime::spawn(async move {
        loop {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
            match chief.tick(now).await {
                Ok(_) => checked.store(now, Ordering::Relaxed),
                Err(e) => eprintln!("[chief-of-staff] skipped a look, cannot read runs: {e}"),
            }
            match pr_watcher.tick(now).await {
                Ok(tick) => {
                    for record in tick.changed {
                        pr_events.changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
                    }
                    for (id, why) in tick.failed {
                        eprintln!("[chief-of-staff] could not read the PR of {id}: {why}");
                    }
                }
                Err(e) => eprintln!("[chief-of-staff] skipped the PRs, cannot read runs: {e}"),
            }
            if let Err(e) = alerts.tick(now).await {
                eprintln!("[chief-of-staff] skipped the alerts, cannot read runs: {e}");
            }
            tokio::time::sleep(SIGNALS_EVERY).await;
        }
    });
    let host_store = Arc::clone(&store);
    let resuming = Arc::clone(&engine);
    tauri::async_runtime::spawn(async move {
        match resuming.resume_interrupted().await {
            Ok(ids) if !ids.is_empty() => eprintln!("[graph-run] resumed {} run(s) cut off by the last shutdown", ids.len()),
            Ok(_) => {}
            Err(e) => eprintln!("[graph-run] could not resume interrupted runs: {e}"),
        }
        // After reconciliation, so held Factory worktrees are protected from reaping.
        loop {
            // Live = unfinished on the record (running or paused: a paused run keeps its worktree for
            // Raise cap), or a step still in progress here. Interrupted Factory runs are held; other eligible Rust runs were resumed above.
            let live: std::collections::HashSet<String> = match store.list_unfinished() {
                Ok(records) => records.into_iter().map(|r| r.id).collect(),
                Err(e) => {
                    eprintln!("[graph-run] reaper skipped, cannot read runs: {e}");
                    tokio::time::sleep(REAP_EVERY).await;
                    continue;
                }
            };
            let active = Arc::clone(&runner);
            let report = reap(&root, pull_requests.as_ref(), &move |id: &str| live.contains(id) || active.is_active(id)).await;
            if !report.removed.is_empty() {
                eprintln!("[graph-run] reaped {} Factory worktree(s)", report.removed.len());
            }
            // A merged or closed PR moves its run out of "Ready to review" (#147).
            for (id, outcome) in report.ended_prs {
                match record_pr_outcome(store.as_ref(), &id, outcome) {
                    Ok(Some(record)) => events.changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status }),
                    Ok(None) => {}
                    Err(e) => eprintln!("[graph-run] could not record the PR of {id}: {e}"),
                }
            }
            tokio::time::sleep(REAP_EVERY).await;
        }
    });
    Ok(GraphRunHost { engine, store: host_store, chief_checked_at, pr_edits, pull_requests: host_prs, slack: notifier, slack_identities: identities })
}

/// The user's label for a Feedback Item, from the Chief of Staff pane (CoS 5).
pub fn set_feedback_label(app: &AppHandle, host: &GraphRunHost, run_id: &str, item_id: &str, label: &str) -> Result<(), String> {
    let label = lotus_graph_run::FeedbackLabel::parse(label).ok_or_else(|| format!("\"{label}\" is not a label"))?;
    let record = lotus_graph_run::factory::pr_watch::set_feedback_label(host.store.as_ref(), run_id, item_id, label)?;
    TauriEvents(app.clone()).changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
    Ok(())
}

/// Accepts a spec change: its criteria become an Amendment on the approved spec (CoS 8).
pub async fn accept_spec_change(app: &AppHandle, host: &GraphRunHost, run_id: &str, item_id: &str, criteria: &[String]) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let record = lotus_graph_run::factory::revision::accept_spec_change(host.store.as_ref(), &host.pr_edits, run_id, item_id, criteria, now).await?;
    TauriEvents(app.clone()).changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
    Ok(())
}

/// Declines a spec change as out of scope and drafts the reply (CoS 8). Nothing is posted.
pub async fn decline_spec_change(app: &AppHandle, host: &GraphRunHost, run_id: &str, item_id: &str) -> Result<(), String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let record = lotus_graph_run::factory::revision::decline_spec_change(host.store.as_ref(), &host.pr_edits, run_id, item_id, now).await?;
    TauriEvents(app.clone()).changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// The user's text for a reply draft or round summary; empty discards it (CoS 9).
pub async fn edit_draft(app: &AppHandle, host: &GraphRunHost, run_id: &str, key: &str, text: &str) -> Result<(), String> {
    let record = lotus_graph_run::factory::replies::edit_draft(host.store.as_ref(), &host.pr_edits, run_id, key, text).await?;
    TauriEvents(app.clone()).changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
    Ok(())
}

/// Send (one draft, `key`) or Send all (`None`: every draft, then the re-request), posted as the
/// user with the repo's `reply_footer` (CoS 9).
pub async fn send_drafts(app: &AppHandle, host: &GraphRunHost, run_id: &str, key: Option<&str>) -> Result<(), String> {
    use lotus_graph_run::factory::replies::{send, Outgoing};
    let record = host.store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let ticket = record.checkpoint.engine.as_ref().and_then(|m| m.factory.clone()).ok_or("the run is not a Factory Run")?;
    let footer = DefinitionRounds.policy(&ticket).await?.reply_footer;
    let what = key.map_or(Outgoing::All, |key| Outgoing::One(key.to_string()));
    let sent = send(host.store.as_ref(), host.pull_requests.as_ref(), Some(host.slack.as_ref() as &dyn Notifier), &host.pr_edits, run_id, what, footer.as_deref(), now_ms()).await;
    // A failed send saved what went and the reason: the pane shows both.
    if let Ok(Some(record)) = host.store.get(run_id) {
        TauriEvents(app.clone()).changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
    }
    sent.map(|_| ())
}

/// The user's answer to "Who is GitHub @x on Slack?": remembered, and put into every Slack reply
/// that waits (CoS 12).
pub async fn set_slack_identity(app: &AppHandle, host: &GraphRunHost, github: &str, slack: &str) -> Result<(), String> {
    use lotus_graph_run::factory::slack_reply::remember_identity;
    let changed = remember_identity(host.store.as_ref(), &host.pr_edits, host.slack_identities.as_ref(), github, slack, now_ms()).await?;
    for id in changed {
        if let Ok(Some(record)) = host.store.get(&id) {
            TauriEvents(app.clone()).changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
        }
    }
    Ok(())
}

/// The Slack thread run `run_id`'s PR link was shared in, as Slack search finds it now: the live
/// check that search finds an unfurled link (CoS 12).
pub async fn find_slack_thread(host: &GraphRunHost, run_id: &str) -> Result<Option<lotus_graph_run::SlackThread>, String> {
    let record = host.store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let url = record.checkpoint.engine.as_ref().and_then(|m| m.pr_watch.as_ref()).map(|w| w.url.clone()).ok_or("the Chief of Staff has not looked at the PR yet")?;
    host.slack.find_thread(&url).await
}

/// A repo's round settings, read from its factory definition at `origin/<base>` each time.
struct DefinitionRounds;

impl RoundPolicies for DefinitionRounds {
    fn policy(&self, ticket: &lotus_graph_run::FactoryTicket) -> lotus_graph_run::BoxFuture<Result<RoundPolicy, String>> {
        use lotus_graph_run::factory::{read_definition_for, DEFAULT_MAX_ROUNDS};
        let (checkout, base, env) = (ticket.checkout.clone(), ticket.base.clone(), crate::shell_env::user_login_env().clone());
        let private = factory_kit_sources().private_dir(&ticket.repo);
        Box::pin(async move {
            let definition = tokio::task::spawn_blocking(move || read_definition_for(&checkout, &base, private.as_deref(), &env))
                .await
                .map_err(|e| format!("cannot read the factory definition: {e}"))??;
            Ok(RoundPolicy {
                revise: definition.revise,
                replies: definition.replies,
                reply_footer: definition.reply_footer,
                cap_usd: definition.cap_usd,
                max_rounds: definition.max_rounds.unwrap_or(DEFAULT_MAX_ROUNDS),
            })
        })
    }
}

/// Starts the next Revision Run of the Factory PR that run `run_id` opened ("Start round", CoS 6).
/// The round gets the repo's `cap_usd` (else the cap the PR's run had) and the repo's `max_rounds`.
/// `revise` does not matter here: the user asked.
pub async fn start_round(app: &AppHandle, host: &GraphRunHost, run_id: &str) -> Result<String, String> {
    use lotus_graph_run::factory::revision;
    let record = host.store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let meta = record.checkpoint.engine.as_ref().ok_or("the run has no engine data")?;
    let ticket = meta.factory.clone().ok_or("the run is not a Factory Run")?;
    let policy = DefinitionRounds.policy(&ticket).await?;
    let cap = policy.cap_usd.or(meta.budget_cap).ok_or("the repo has no cap_usd and the PR's run had no cap")?;
    let max_rounds = policy.max_rounds;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
    let (round_id, record) = revision::start_round(&host.engine, host.store.as_ref(), &host.pr_edits, run_id, cap, max_rounds, now).await?;
    TauriEvents(app.clone()).changed(RunChanged { id: record.id, project_id: record.project_id, status: record.status });
    Ok(round_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_decision_reads_the_shape_the_ui_sends() {
        let decide = |raw: serde_json::Value| IntakeDecision::from(serde_json::from_value::<Decision>(raw).unwrap());
        let answers = decide(serde_json::json!({ "kind": "answer", "answers": [{ "choice": "Plain" }, { "note": "my own" }] }));
        assert_eq!(
            answers,
            IntakeDecision::Answer(vec![
                Answer { choice: Some("Plain".into()), note: String::new() },
                Answer { choice: None, note: "my own".into() }
            ])
        );
        assert_eq!(decide(serde_json::json!({ "kind": "approve" })), IntakeDecision::Approve(None));
        assert_eq!(decide(serde_json::json!({ "kind": "approve", "spec": "edited" })), IntakeDecision::Approve(Some("edited".into())));
        assert_eq!(decide(serde_json::json!({ "kind": "send-back", "note": "more" })), IntakeDecision::SendBack("more".into()));
        assert!(serde_json::from_value::<Decision>(serde_json::json!({ "kind": "save-spec", "spec": "s" })).is_err(), "only Brainstorm live saves a spec");
        assert_eq!(decide(serde_json::json!({ "kind": "proceed" })), IntakeDecision::Proceed);
        assert!(serde_json::from_value::<Decision>(serde_json::json!({ "kind": "merge" })).is_err());
    }
}
