//! The Chief of Staff's alerts to the user (CoS 11, ADR-0058 §7): when something lands in Needs
//! you, a macOS notification and, with a bot token set up, a Slack DM from the Lotus bot, so the
//! phone pings too.
//!
//! The host calls [`Alerts::tick`] right after the watchers' ticks, so a signal whose condition
//! ended is already cleared. A Needs-you item is a signal still raised on a run (the pane also
//! hides one whose condition ended before the watcher's next look); it is new when the note that
//! raised it is newer than the last alert. The first new item after a quiet spell pings at once. New items wait, batched, until at most one ping per
//! [`ALERT_EVERY_MS`]; an item cleared meanwhile is dropped. Without a bot token: macOS only.

use std::sync::{Arc, Mutex};

use crate::{BoxFuture, ChiefSignal, GraphRunRecord, RunStore, SlackThread};

/// At most one ping per this many ms (15 minutes).
pub const ALERT_EVERY_MS: i64 = 15 * 60_000;

/// One Needs-you item an alert names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertItem {
    pub run_id: String,
    /// The ticket's title.
    pub ticket: String,
    pub signal: ChiefSignal,
    /// Why, from the note that raised it.
    pub text: String,
    /// When it was raised (Unix ms).
    pub at: i64,
}

/// One ping: every new Needs-you item since the last one, oldest first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    pub items: Vec<AlertItem>,
}

impl Alert {
    /// The macOS notification's title: "Needs you: Add ok file", or "3 items need you".
    pub fn title(&self) -> String {
        match self.items.as_slice() {
            [one] => format!("Needs you: {}", one.ticket),
            many => format!("{} items need you", many.len()),
        }
    }

    /// The macOS notification's body: the reason, or one line per item.
    pub fn body(&self) -> String {
        match self.items.as_slice() {
            [one] => one.text.clone(),
            many => many.iter().map(|i| format!("{}: {}", i.ticket, i.text)).collect::<Vec<_>>().join("\n"),
        }
    }

    /// The bot DM, in Slack mrkdwn.
    pub fn slack_text(&self) -> String {
        let n = self.items.len();
        let head = format!("*Lotus Factory: {n} {} need{} you*", if n == 1 { "item" } else { "items" }, if n == 1 { "s" } else { "" });
        let lines = self.items.iter().map(|i| format!("• *{}*: {}", i.ticket, i.text));
        std::iter::once(head).chain(lines).collect::<Vec<_>>().join("\n")
    }
}

/// Where alerts go, and the Slack the Chief of Staff writes in. The real one is in the app (macOS
/// notification, Slack as the bot for DMs and as the user in threads); tests fake it.
pub trait Notifier: Send + Sync {
    /// The user's Slack id the bot DMs. `None` without a bot token: alerts go to macOS only.
    fn slack_user(&self) -> Option<String>;
    /// Shows the macOS notification.
    fn desktop(&self, alert: &Alert) -> Result<(), String>;
    /// DMs `user` as the Lotus bot.
    fn slack_dm(&self, user: &str, alert: &Alert) -> BoxFuture<Result<(), String>>;
    /// The Slack thread `pr_url` was shared in, by `search.messages` as the user (CoS 12). `None`:
    /// no channel message has the link.
    fn find_thread(&self, pr_url: &str) -> BoxFuture<Result<Option<SlackThread>, String>>;
    /// Posts `text` in `thread` as the user (`xoxp-`). Returns the new message's ts.
    fn reply_in_thread(&self, thread: &SlackThread, text: &str) -> BoxFuture<Result<String, String>>;
}

struct State {
    /// Items raised at or before this were alerted already, or were raised before the app started.
    seen_through: i64,
    last_ping: Option<i64>,
}

pub struct Alerts {
    store: Arc<dyn RunStore>,
    notifier: Arc<dyn Notifier>,
    state: Mutex<State>,
}

impl Alerts {
    /// `since` = Unix ms the app started: items raised before it were alerted by the last session
    /// (or wait in the pane), so a restart does not ping them again.
    pub fn new(store: Arc<dyn RunStore>, notifier: Arc<dyn Notifier>, since: i64) -> Self {
        Self { store, notifier, state: Mutex::new(State { seen_through: since, last_ping: None }) }
    }

    /// Pings once for the new Needs-you items, unless the last ping is under [`ALERT_EVERY_MS`]
    /// old: they wait for the next tick past it. Returns what was sent.
    pub async fn tick(&self, now: i64) -> Result<Option<Alert>, String> {
        let since = {
            let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            if state.last_ping.is_some_and(|at| now - at < ALERT_EVERY_MS) {
                return Ok(None);
            }
            state.seen_through
        };
        let mut records = self.store.list_unfinished().map_err(|e| e.to_string())?;
        records.extend(self.store.list_completed().map_err(|e| e.to_string())?);
        let mut items: Vec<AlertItem> = records.iter().flat_map(needs_you).filter(|i| i.at > since && i.at <= now).collect();
        if items.is_empty() {
            return Ok(None);
        }
        items.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.run_id.cmp(&b.run_id)));
        {
            let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
            state.seen_through = now;
            state.last_ping = Some(now);
        }
        let alert = Alert { items };
        if let Err(e) = self.notifier.desktop(&alert) {
            eprintln!("[chief-of-staff] macOS notification failed: {e}");
        }
        if let Some(user) = self.notifier.slack_user() {
            if let Err(e) = self.notifier.slack_dm(&user, &alert).await {
                eprintln!("[chief-of-staff] Slack DM failed: {e}");
            }
        }
        Ok(Some(alert))
    }
}

/// The run's raised signals, each with the newest note that raised it.
fn needs_you(record: &GraphRunRecord) -> Vec<AlertItem> {
    let Some(meta) = record.checkpoint.engine.as_ref() else { return Vec::new() };
    let (Some(chief), Some(ticket)) = (meta.chief.as_ref(), meta.factory.as_ref()) else { return Vec::new() };
    chief
        .open
        .iter()
        .filter_map(|signal| {
            let entry = chief.raised_by(*signal)?;
            Some(AlertItem { run_id: record.id.clone(), ticket: ticket.title.clone(), signal: *signal, text: entry.text.clone(), at: entry.at })
        })
        .collect()
}
