use super::SlackMessage;
use crate::registry::BoxFuture;

/// The Slack Web API calls automations need, as the user. Every method maps
/// to one Web API method; the real adapter is `slack::web::SlackWeb`.
pub trait SlackApi: Send + Sync {
    /// Top-level messages in `channel` newer than `oldest`, oldest first
    /// (`conversations.history`, all pages).
    fn history(&self, channel: &str, oldest: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>>;
    /// Replies in thread `thread_ts` newer than `oldest`, oldest first, the
    /// parent left out (`conversations.replies`, all pages). History never
    /// holds replies, so this is how a catch-up sees them.
    fn replies(&self, channel: &str, thread_ts: &str, oldest: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>>;
    /// The one message at `ts`, top-level or a thread reply.
    fn message(&self, channel: &str, ts: &str) -> BoxFuture<Result<Option<SlackMessage>, String>>;
    /// `reactions.add` as the user.
    fn add_reaction(&self, channel: &str, ts: &str, name: &str) -> BoxFuture<Result<(), String>>;
    /// `reactions.remove` as the user.
    fn remove_reaction(&self, channel: &str, ts: &str, name: &str) -> BoxFuture<Result<(), String>>;
    /// `chat.postMessage` into `thread_ts`, as the user. Returns the new ts.
    fn post_reply(&self, channel: &str, thread_ts: &str, text: &str) -> BoxFuture<Result<String, String>>;
    /// `chat.postMessage` as a new message in `channel`, as the user.
    fn post_message(&self, channel: &str, text: &str) -> BoxFuture<Result<String, String>>;
}

/// Whether Slack timestamp `a` (`"secs.micros"`) is later than `b`.
/// Compared as numbers: string order breaks when the digit counts differ.
pub fn ts_after(a: &str, b: &str) -> bool {
    parse_ts(a) > parse_ts(b)
}

fn parse_ts(ts: &str) -> (u64, u64) {
    let (secs, micros) = ts.split_once('.').unwrap_or((ts, "0"));
    (secs.parse().unwrap_or(0), format!("{micros:0<6}")[..6].parse().unwrap_or(0))
}

/// `now_ms` as a Slack timestamp.
pub fn ts_from_ms(now_ms: i64) -> String {
    let ms = now_ms.max(0) as u64;
    format!("{}.{:06}", ms / 1000, (ms % 1000) * 1000)
}
