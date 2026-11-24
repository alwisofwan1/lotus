//! Slack for automations, on the Tauri side (ADR-0038, PLAN §2.2).
//!
//! Tokens live in the OS keychain ([`KeychainStore`]) — one entry for both, read
//! only when [`SavedFlag`] says they exist. While they exist, one
//! Socket Mode session runs in the background: it catches up on every
//! (re)connect and hands live events to the crate's `SlackListener`. The
//! decisions are all in `crates/lotus-automation/src/slack`; this file only
//! owns the session's lifetime and its status line for the UI.
//!
//! A catch-up also runs every [`CATCH_UP_EVERY`] while connected. Slack hands
//! each event to ONE of the app's open connections, so a second app on the
//! same Slack app (a `tauri dev` build, found 2026-10-07) silently takes
//! events while this socket still says connected. The periodic catch-up
//! reviews those anyway and turns the status line into a warning.
//!
//! A dev build therefore does not listen unless `LOTUS_DEV_SLACK_LISTEN=1`:
//! its Slack session still posts replies and lists channels, but leaves the
//! events to the installed Lotus.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lotus_automation::github::GhCli;
use lotus_automation::secrets::{
    forget_slack_tokens_flagged, load_slack_tokens_flagged, save_slack_tokens_flagged, FileStore, SavedFlag,
    SecretStore, SlackTokens,
};
use lotus_automation::slack::client::{run_socket_mode, SocketState};
use lotus_automation::slack::web::{is_missing_scope, open_socket_url, SlackChannel, SlackEmoji, SlackUserGroup, SlackWeb};
use lotus_automation::slack::{ReactionSettings, SlackListener, StatusReactions};
use lotus_automation::{Clock, Engine, Store, SystemClock};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

use crate::automation_host::CHANGED_EVENT;
use crate::paths;

/// The OS credential store (macOS Keychain, Windows Credential Manager,
/// Secret Service), one entry per secret name under a Lotus service name.
/// Dev and release builds use different services so they never share tokens.
pub struct KeychainStore {
    service: &'static str,
}

impl KeychainStore {
    pub fn new() -> Self {
        let service = if paths::is_dev_profile() { "dev.lotus-dev.automation" } else { "dev.lotus.automation" };
        Self { service }
    }

    fn entry(&self, name: &str) -> Result<keyring::v1::Entry, String> {
        keyring::v1::Entry::new(self.service, name).map_err(|e| format!("keychain: {e}"))
    }
}

impl SecretStore for KeychainStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match self.entry(name)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::v1::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keychain: {e}")),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.entry(name)?.set_password(value).map_err(|e| format!("keychain: {e}"))
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::v1::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain: {e}")),
        }
    }
}

/// The Slack line in the Automation panel. Never carries a token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackStatusView {
    /// `not_set_up` | `standby` | `connecting` | `connected` | `retrying` | `stopped`.
    /// `standby`: a dev build that posts but does not listen. `connected` with a
    /// `detail` is a warning: messages are arriving only through catch-up.
    pub state: String,
    pub detail: Option<String>,
    pub user_id: Option<String>,
    pub team: Option<String>,
    /// When history was last checked for missed messages; `None` before the first check.
    pub checked_at_ms: Option<i64>,
    /// How often that check runs; `None` when this build does not listen.
    pub check_every_ms: Option<i64>,
    /// Slack's count of open sockets for this Slack app at the last connect, ours included.
    /// More than 1: another app takes some events. 1 with missed messages: Slack is not sending them live.
    pub connections: Option<u64>,
    /// A bot token is saved: Chief of Staff alerts also arrive as a DM from the Lotus bot (CoS 11).
    pub bot: bool,
}

impl SlackStatusView {
    fn not_set_up() -> Self {
        Self { state: "not_set_up".into(), detail: None, user_id: None, team: None, checked_at_ms: None, check_every_ms: None, connections: None, bot: false }
    }
}

/// What a session needs from the automation runtime.
#[derive(Clone)]
pub struct SlackDeps {
    pub store: Arc<Store>,
    pub engine: Arc<Engine>,
    pub github: Arc<GhCli>,
    pub app: AppHandle,
}

struct Session {
    stop: watch::Sender<bool>,
    web: SlackWeb,
    /// The user's own Slack id (`auth.test`).
    me: String,
    /// The Lotus bot, when its token is saved: it DMs `me` the Chief of Staff's alerts (CoS 11).
    bot: Option<SlackWeb>,
    /// The missed-message check; `None` when this build does not listen.
    checker: Option<Checker>,
}

type SharedSession = Arc<Mutex<Option<Session>>>;

/// Where the tokens are kept. Release builds (every OS) and dev builds off
/// macOS use the OS store. A macOS dev build uses a 0600 file in
/// `~/.lotus-dev/`, because each rebuild changes the ad-hoc signature the
/// keychain trusts and would prompt again on every launch.
pub(crate) fn secret_store() -> Box<dyn SecretStore> {
    if let Some(path) = dev_secrets_file() {
        Box::new(FileStore::new(path))
    } else {
        Box::new(KeychainStore::new())
    }
}

/// The file [`secret_store`] uses instead of the OS store, when it does.
pub(crate) fn dev_secrets_file() -> Option<std::path::PathBuf> {
    (cfg!(target_os = "macos") && paths::is_dev_profile()).then(|| paths::lotus_state_dir().join("dev-secrets.json"))
}

/// How often a connected session checks history (channels, review threads, retries) for
/// messages the socket missed.
const CATCH_UP_EVERY: Duration = Duration::from_secs(5 * 60);

/// While the socket is not delivering (the missed-message warning is up), the watched channels
/// alone are also read this often: one `conversations.history` call per channel. Measured
/// 2026-11-19: #proj-orbit (Slack Connect) got 0 live events in 3 days, so this check was the
/// only path and every request waited up to 5 min. A healthy socket costs nothing extra.
const QUICK_CHECK_EVERY: Duration = Duration::from_secs(60);

/// Reads the thread replies the rules cannot place (ADR-0059): the automation's own preset, forced
/// to the cheap model. Checked live 2026-10-15: `ccs acme --model haiku -p ...` answers in about 5 s.
fn intake_classifier() -> Arc<dyn lotus_automation::slack::intake::ReplyClassifier> {
    use lotus_automation::agent::CliAgentRunner;
    let presets = crate::factory_host::with_model(
        &crate::automation_host::delegation_presets(),
        Some(lotus_graph_run::factory::CHEAP_MODEL.to_string()),
    );
    let runner = CliAgentRunner::new(presets, crate::shell_env::login_env_without_unset());
    Arc::new(lotus_automation::slack::intake::AgentClassifier::new(Arc::new(runner)))
}

/// Whether this build opens Socket Mode. Off for dev builds unless asked, so a
/// `tauri dev` running beside the installed Lotus does not take its events.
fn listens_for_events() -> bool {
    !paths::is_dev_profile() || std::env::var("LOTUS_DEV_SLACK_LISTEN").as_deref() == Ok("1")
}

const STANDBY_DETAIL: &str =
    "Not listening in this dev build, so the installed Lotus gets every Slack event. Set LOTUS_DEV_SLACK_LISTEN=1 to listen here.";

fn missed_detail(missed: usize, connections: Option<u64>) -> String {
    let what = if missed == 1 { "1 message".to_string() } else { format!("{missed} messages") };
    let why = match connections {
        Some(n) if n > 1 => format!(
            "Slack reports {n} open connections to this Slack app, so another app takes some events — a Lotus dev build started with LOTUS_DEV_SLACK_LISTEN=1, or Lotus on another computer. Quit it; this clears after the next check that misses nothing."
        ),
        Some(1) => "Slack reports Lotus is the only connection to this Slack app, so Slack itself did not send these messages live (a Slack Connect channel can do this). The check every few minutes still reads them.".to_string(),
        _ => "Another app is probably connected to the same Slack app — a Lotus dev build started with LOTUS_DEV_SLACK_LISTEN=1, or a second copy of Lotus. Quit it; this clears after the next check that misses nothing.".to_string(),
    };
    format!("{what} reached Lotus only through the missed-message check, not live. {why}")
}

fn saved_flag() -> SavedFlag {
    SavedFlag::new(paths::lotus_state_dir().join("slack-tokens-saved"))
}

pub struct SlackHost {
    secrets: Box<dyn SecretStore>,
    flag: SavedFlag,
    session: SharedSession,
    status: Arc<Mutex<SlackStatusView>>,
    /// The emoji a review request shows for each state, shared with the running session.
    reactions: Arc<ReactionSettings>,
    /// The workspace's custom emoji and when they were read, for [`EMOJI_TTL`].
    emoji: Mutex<Option<(std::time::Instant, SlackEmojiView)>>,
    /// User id → name, for the session: `None` is a lookup that found none (or failed), so the
    /// Inbox does not ask Slack again for it on every refresh.
    user_names: Mutex<std::collections::HashMap<String, Option<String>>>,
}

/// New user ids one [`SlackHost::user_names`] call looks up; the rest wait for the next call.
const USER_NAMES_PER_CALL: usize = 20;

/// How long the custom emoji list is reused before the picker reads Slack again.
const EMOJI_TTL: Duration = Duration::from_secs(10 * 60);

/// The workspace's custom emoji for the reaction picker. `state` is `ok`, or `missing_scope` when
/// the Slack app was installed before Lotus asked for `emoji:read` (a reinstall fixes it).
/// Adding or removing an emoji shows after the TTL or a refresh: Slack's `emoji_changed` event
/// would need an Events API subscription change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackEmojiView {
    pub state: String,
    pub emoji: Vec<SlackEmoji>,
}

/// The status reactions for Connectors → Slack: the ones in use, the defaults, and the last
/// reaction Slack refused (a name it does not know fails only when used).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackReactionsView {
    pub reactions: StatusReactions,
    pub defaults: StatusReactions,
    pub last_error: Option<String>,
}

fn reactions_file() -> std::path::PathBuf {
    paths::lotus_state_dir().join("slack-reactions.json")
}

/// The saved reactions, or the defaults when none were saved or the file cannot be used.
fn load_reactions() -> StatusReactions {
    let Ok(text) = std::fs::read_to_string(reactions_file()) else { return StatusReactions::default() };
    match serde_json::from_str::<StatusReactions>(&text).map_err(|e| e.to_string()).and_then(|r| r.normalized()) {
        Ok(reactions) => reactions,
        Err(e) => {
            eprintln!("[automation] slack-reactions.json is not usable, using the defaults: {e}");
            StatusReactions::default()
        }
    }
}

/// DMs the user themself through the running session; errors when Slack is
/// not connected. Handed to the `agent_prompt` action at startup, before any
/// session exists, so it looks the session up on every send.
pub struct SlackSelfMessenger(SharedSession);

impl lotus_automation::agent_prompt::SelfMessenger for SlackSelfMessenger {
    fn dm_self(&self, text: &str) -> lotus_automation::BoxFuture<Result<(), String>> {
        let target = self.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|s| (s.web.clone(), s.me.clone()));
        let text = text.to_string();
        Box::pin(async move {
            use lotus_automation::slack::SlackApi;
            let (web, me) = target.ok_or("Slack is not connected")?;
            // A user id as the channel is the user's own DM.
            web.post_message(&me, &text).await.map(|_| ())
        })
    }
}

/// Reads a review's Slack threads through the running session (ADR-0052 §8). Handed to the
/// `pr_review` action at startup, before any session exists, so it looks the session up per read.
pub struct SlackThreadReader(SharedSession);

impl lotus_automation::pr_review::thread::ThreadReader for SlackThreadReader {
    fn read(
        &self,
        channel: &str,
        thread_ts: &str,
    ) -> lotus_automation::BoxFuture<Result<Vec<lotus_automation::slack::web::ThreadMessage>, String>> {
        let web = self.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|s| s.web.clone());
        let (channel, thread_ts) = (channel.to_string(), thread_ts.to_string());
        Box::pin(async move { web.ok_or("Slack is not connected")?.thread(&channel, &thread_ts).await })
    }
}

impl SlackHost {
    pub fn new() -> Self {
        Self {
            secrets: secret_store(),
            flag: saved_flag(),
            session: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(SlackStatusView::not_set_up())),
            reactions: Arc::new(ReactionSettings::new(load_reactions())),
            emoji: Mutex::new(None),
            user_names: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// The custom emoji, from the cache while it is fresh and `refresh` is false.
    pub async fn emoji(&self, refresh: bool) -> Result<SlackEmojiView, String> {
        if !refresh {
            let cached = self.emoji.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some((_, view)) = cached.filter(|(at, _)| at.elapsed() < EMOJI_TTL) {
                return Ok(view);
            }
        }
        let web = self.web().ok_or("Slack is not connected")?;
        match web.emoji_list().await {
            Ok(emoji) => {
                let view = SlackEmojiView { state: "ok".into(), emoji };
                *self.emoji.lock().unwrap_or_else(|p| p.into_inner()) = Some((std::time::Instant::now(), view.clone()));
                Ok(view)
            }
            Err(e) if is_missing_scope(&e) => Ok(SlackEmojiView { state: "missing_scope".into(), emoji: Vec::new() }),
            Err(e) => Err(e),
        }
    }

    pub fn reactions(&self) -> SlackReactionsView {
        SlackReactionsView {
            reactions: self.reactions.get(),
            defaults: StatusReactions::default(),
            last_error: self.reactions.last_error(),
        }
    }

    /// Checks and saves the user's reactions; the next review request uses them, no reconnect.
    pub fn set_reactions(&self, app: &AppHandle, reactions: StatusReactions) -> Result<SlackReactionsView, String> {
        let reactions = reactions.normalized()?;
        let text = serde_json::to_string_pretty(&reactions).map_err(|e| e.to_string())?;
        let file = reactions_file();
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("saving the reactions: {e}"))?;
        }
        std::fs::write(&file, text).map_err(|e| format!("saving the reactions: {e}"))?;
        self.reactions.set(reactions);
        let _ = app.emit(CHANGED_EVENT, ());
        Ok(self.reactions())
    }

    /// Adds the emoji chosen for the verdict `draft_id` was sent with to its request messages.
    pub async fn react_after_send(&self, store: &lotus_automation::Store, draft_id: &str) {
        let web = self.web();
        let slack = web.as_ref().map(|w| w as &dyn lotus_automation::slack::SlackApi);
        lotus_automation::pr_review::slack_reply::react_after_send(store, slack, &self.reactions, draft_id).await;
    }

    pub fn messenger(&self) -> SlackSelfMessenger {
        SlackSelfMessenger(Arc::clone(&self.session))
    }

    pub fn thread_reader(&self) -> SlackThreadReader {
        SlackThreadReader(Arc::clone(&self.session))
    }

    pub fn status(&self) -> SlackStatusView {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// The bot client and the user's Slack id it DMs; `None` without a bot token (CoS 11).
    pub fn bot_target(&self) -> Option<(SlackWeb, String)> {
        let session = self.session.lock().unwrap_or_else(|p| p.into_inner());
        session.as_ref().and_then(|s| Some((s.bot.clone()?, s.me.clone())))
    }

    /// Checks the bot token against Slack, saves it beside the other two, and lets the running
    /// session use it. Slack must be connected first: the bot DMs the user that session acts as.
    pub async fn set_bot_token(&self, app: &AppHandle, bot_token: &str) -> Result<SlackStatusView, String> {
        let tokens = load_slack_tokens_flagged(self.secrets.as_ref(), &self.flag)?.ok_or("Connect Slack first")?;
        let tokens = tokens.with_bot(bot_token).map_err(|e| e.to_string())?;
        let bot = SlackWeb::new(tokens.bot().expect("just set").clone());
        bot.identity().await.map_err(|e| format!("bot token: {e}"))?;
        save_slack_tokens_flagged(self.secrets.as_ref(), &self.flag, &tokens)?;
        if let Some(session) = self.session.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
            session.bot = Some(bot);
        }
        self.status.lock().unwrap_or_else(|p| p.into_inner()).bot = true;
        let _ = app.emit(CHANGED_EVENT, ());
        Ok(self.status())
    }

    /// Sends one DM from the bot now, so the user can see it ping their phone (the CoS 11 live check).
    pub async fn test_bot(&self) -> Result<(), String> {
        use lotus_automation::slack::SlackApi;
        let (bot, me) = self.bot_target().ok_or("No bot token is saved")?;
        bot.post_message(&me, "Lotus test: Factory alerts reach you here. Nothing needs you now.").await.map(|_| ())
    }

    /// The user-token client of the running session, for replies and pickers.
    pub fn web(&self) -> Option<SlackWeb> {
        self.session.lock().unwrap_or_else(|p| p.into_inner()).as_ref().map(|s| s.web.clone())
    }

    /// Starts the session from saved tokens, if any. Called at app start.
    pub async fn resume(&self, deps: SlackDeps) {
        match load_slack_tokens_flagged(self.secrets.as_ref(), &self.flag) {
            Ok(Some(tokens)) => {
                if let Err(e) = self.start(deps, tokens).await {
                    self.set_status(&None, SlackStatusView { state: "stopped".into(), detail: Some(e), ..SlackStatusView::not_set_up() });
                }
            }
            Ok(None) => {}
            Err(e) => eprintln!("[automation] reading Slack tokens: {e}"),
        }
    }

    /// Checks both tokens against Slack, saves them, and (re)starts the session.
    pub async fn connect(&self, deps: SlackDeps, app_token: &str, user_token: &str) -> Result<SlackStatusView, String> {
        let tokens = SlackTokens::new(app_token, user_token).map_err(|e| e.to_string())?;
        // Prove both work before anything is saved.
        SlackWeb::new(tokens.user().clone()).identity().await.map_err(|e| format!("user token: {e}"))?;
        open_socket_url(tokens.app()).await.map_err(|e| format!("app token: {e}"))?;
        save_slack_tokens_flagged(self.secrets.as_ref(), &self.flag, &tokens)?;
        self.start(deps, tokens).await?;
        Ok(self.status())
    }

    pub fn disconnect(&self, app: &AppHandle) -> Result<(), String> {
        self.stop();
        forget_slack_tokens_flagged(self.secrets.as_ref(), &self.flag)?;
        self.set_status(&Some(app.clone()), SlackStatusView::not_set_up());
        Ok(())
    }

    /// Runs the missed-message check now, instead of waiting for the next one.
    pub async fn check_now(&self) -> Result<SlackStatusView, String> {
        let checker = {
            let session = self.session.lock().unwrap_or_else(|p| p.into_inner());
            let session = session.as_ref().ok_or("Slack is not connected")?;
            session.checker.clone().ok_or("This dev build does not listen to Slack, so there is nothing to check")?
        };
        if self.status().state != "connected" {
            return Err("Slack is reconnecting; it checks for missed messages as soon as it is back".into());
        }
        checker.run(Check::Asked).await;
        Ok(self.status())
    }

    pub async fn channels(&self) -> Result<Vec<SlackChannel>, String> {
        self.web().ok_or("Slack is not connected")?.channels().await
    }

    pub async fn usergroups(&self) -> Result<Vec<SlackUserGroup>, String> {
        self.web().ok_or("Slack is not connected")?.usergroups().await
    }

    /// The names of users `ids` that Slack knows (`users.info`, scope `users:read`); an id it
    /// does not know, or a failed lookup, is left out and the caller shows a fallback. Looked up
    /// once per session, at most [`USER_NAMES_PER_CALL`] new ids per call.
    pub async fn user_names(&self, ids: Vec<String>) -> Result<std::collections::HashMap<String, String>, String> {
        let web = self.web().ok_or("Slack is not connected")?;
        let unknown: Vec<String> = {
            let cache = self.user_names.lock().unwrap_or_else(|p| p.into_inner());
            let mut unknown: Vec<String> = ids.iter().filter(|id| !cache.contains_key(*id)).cloned().collect();
            unknown.sort();
            unknown.dedup();
            unknown.truncate(USER_NAMES_PER_CALL);
            unknown
        };
        for id in unknown {
            let name = web.user_name(&id).await.unwrap_or_else(|e| {
                eprintln!("[automation] slack users.info {id}: {e}");
                None
            });
            self.user_names.lock().unwrap_or_else(|p| p.into_inner()).insert(id, name);
        }
        let cache = self.user_names.lock().unwrap_or_else(|p| p.into_inner());
        Ok(ids.into_iter().filter_map(|id| cache.get(&id).cloned().flatten().map(|name| (id, name))).collect())
    }

    fn stop(&self) {
        *self.emoji.lock().unwrap_or_else(|p| p.into_inner()) = None;
        self.user_names.lock().unwrap_or_else(|p| p.into_inner()).clear();
        if let Some(old) = self.session.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = old.stop.send(true);
        }
    }

    async fn start(&self, deps: SlackDeps, tokens: SlackTokens) -> Result<(), String> {
        self.stop();
        let web = SlackWeb::new(tokens.user().clone());
        let me = web.identity().await?;
        let bot = tokens.bot().cloned().map(SlackWeb::new);
        let has_bot = bot.is_some();
        let listener = Arc::new(SlackListener::new(
            Arc::clone(&deps.store),
            deps.github.clone(),
            Arc::new(web.clone()),
            me.user_id.clone(),
        )
        .with_reactions(Arc::clone(&self.reactions))
        .with_intake(intake_classifier()));
        let (stop_tx, stop_rx) = watch::channel(false);
        let listens = listens_for_events();
        let checker = listens.then(|| Checker {
            listener: Arc::clone(&listener),
            engine: Arc::clone(&deps.engine),
            status: Arc::clone(&self.status),
            app: deps.app.clone(),
            live_events: Arc::new(AtomicU64::new(0)),
            running: Arc::new(tokio::sync::Mutex::new(())),
        });
        *self.session.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(Session { stop: stop_tx, web, me: me.user_id.clone(), bot, checker: checker.clone() });

        let Some(checker) = checker else {
            self.set_status(
                &Some(deps.app.clone()),
                SlackStatusView {
                    state: "standby".into(),
                    detail: Some(STANDBY_DETAIL.into()),
                    user_id: Some(me.user_id),
                    team: Some(me.team),
                    bot: has_bot,
                    ..SlackStatusView::not_set_up()
                },
            );
            return Ok(());
        };

        self.status.lock().unwrap_or_else(|p| p.into_inner()).bot = has_bot;
        let status = Arc::clone(&self.status);
        let app = deps.app.clone();
        let (user_id, team) = (me.user_id, me.team);
        let app_token = tokens.app().clone();
        tauri::async_runtime::spawn(periodic_check(checker.clone(), stop_rx.clone()));
        tauri::async_runtime::spawn(async move {
            let on_state = {
                let (status, app, checker) = (status.clone(), app.clone(), checker.clone());
                let (user_id, team) = (user_id.clone(), team.clone());
                move |state: SocketState| {
                    let (label, detail) = match &state {
                        SocketState::Connecting => ("connecting", None),
                        SocketState::Connected(n) => {
                            eprintln!("[automation] slack: connected; Slack reports {n:?} open connection(s) for this Slack app");
                            ("connected", None)
                        }
                        SocketState::Retrying(why) => ("retrying", Some(why.clone())),
                        SocketState::Stopped(why) => ("stopped", Some(why.clone())),
                    };
                    if let Ok(mut s) = status.lock() {
                        *s = SlackStatusView {
                            state: label.into(),
                            detail,
                            user_id: Some(user_id.clone()),
                            team: Some(team.clone()),
                            checked_at_ms: s.checked_at_ms,
                            check_every_ms: Some(CATCH_UP_EVERY.as_millis() as i64),
                            connections: match &state {
                                SocketState::Connected(n) => *n,
                                _ => s.connections,
                            },
                            // Kept: a bot token added while connected sets it.
                            bot: s.bot,
                        };
                    }
                    let _ = app.emit(CHANGED_EVENT, ());
                    if matches!(state, SocketState::Connected(_)) {
                        // Every (re)connect closes the gap the socket missed. That gap is
                        // expected, so it is not reported as messages the socket missed.
                        let checker = checker.clone();
                        tauri::async_runtime::spawn(async move {
                            checker.run(Check::AfterConnect).await;
                        });
                    }
                }
            };
            let live_events = Arc::clone(&checker.live_events);
            run_socket_mode(app_token, stop_rx, on_state, |event| {
                live_events.fetch_add(1, Ordering::Relaxed);
                let (listener, engine) = (listener.clone(), Arc::clone(&checker.engine));
                async move { listener.handle_event(&engine, &event).await }
            })
            .await;
        });
        Ok(())
    }

    fn set_status(&self, app: &Option<AppHandle>, view: SlackStatusView) {
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = view;
        if let Some(app) = app {
            let _ = app.emit(CHANGED_EVENT, ());
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Check {
    /// Right after a (re)connect: what it finds is the expected gap, not a miss.
    AfterConnect,
    Periodic,
    /// The channels only, every [`QUICK_CHECK_EVERY`] while the socket is not delivering.
    Quick,
    /// "Check now" in Connectors.
    Asked,
}

/// The missed-message check of one session: a catch-up, and the status line
/// that says whether the socket is really delivering.
#[derive(Clone)]
struct Checker {
    listener: Arc<SlackListener>,
    engine: Arc<Engine>,
    status: Arc<Mutex<SlackStatusView>>,
    app: AppHandle,
    /// Live events since the last check: proof the socket delivers again.
    live_events: Arc<AtomicU64>,
    /// One check at a time, so two never read the same messages.
    running: Arc<tokio::sync::Mutex<()>>,
}

impl Checker {
    async fn run(&self, why: Check) {
        let _one = self.running.lock().await;
        let now = SystemClock.now_ms();
        let missed = match why {
            Check::Quick => self.listener.catch_up_channels(&self.engine, now).await,
            _ => self.listener.catch_up(&self.engine, now).await,
        };
        let live = self.live_events.swap(0, Ordering::Relaxed);
        if missed > 0 && why != Check::AfterConnect {
            eprintln!("[automation] slack: {missed} message(s) reached Lotus only through the missed-message check");
        }
        let Ok(mut s) = self.status.lock() else { return };
        if s.state != "connected" {
            return;
        }
        s.checked_at_ms = Some(SystemClock.now_ms());
        // The warning stays until a check misses nothing AND live events arrived in between.
        s.detail = match (why, missed, live) {
            (Check::AfterConnect, _, _) => s.detail.take(),
            (_, 0, 0) => s.detail.take(),
            (_, 0, _) => None,
            _ => Some(missed_detail(missed, s.connections)),
        };
        // The UI's "Every N min" follows what the session actually does now.
        let every = if s.detail.is_some() { QUICK_CHECK_EVERY } else { CATCH_UP_EVERY };
        s.check_every_ms = Some(every.as_millis() as i64);
        drop(s);
        let _ = self.app.emit(CHANGED_EVENT, ());
    }
}

/// Every [`CATCH_UP_EVERY`] while connected, and the channels every [`QUICK_CHECK_EVERY`]
/// while the socket is not delivering. Ends with the session.
async fn periodic_check(checker: Checker, mut stop: watch::Receiver<bool>) {
    let full_every = (CATCH_UP_EVERY.as_secs() / QUICK_CHECK_EVERY.as_secs()).max(1);
    let mut ticks: u64 = 0;
    let mut tick = tokio::time::interval(QUICK_CHECK_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await; // The first tick is immediate; the (re)connect already checked.
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            changed = stop.changed() => if changed.is_err() || *stop.borrow() { return },
        }
        ticks += 1;
        // A reconnect checks by itself. `detail` while connected = the missed-message warning.
        let (connected, degraded) =
            checker.status.lock().map(|s| (s.state == "connected", s.detail.is_some())).unwrap_or((false, false));
        if !connected {
            continue;
        }
        if ticks % full_every == 0 {
            checker.run(Check::Periodic).await;
        } else if degraded {
            checker.run(Check::Quick).await;
        }
    }
}
