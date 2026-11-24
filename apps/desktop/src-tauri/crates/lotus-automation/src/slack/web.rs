//! The Slack Web API over HTTPS, as the user (`xoxp-`). Response parsing is
//! pure and tested; [`SlackWeb`] is the thin network adapter
//! (research/slack-socket-mode.md §4).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::{SlackApi, SlackMessage};
use crate::registry::BoxFuture;
use crate::secrets::Secret;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlackChannel {
    pub id: String,
    pub name: String,
    pub is_private: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlackUserGroup {
    pub id: String,
    pub handle: String,
    pub name: String,
}

/// Who the user token belongs to (`auth.test`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SlackIdentity {
    pub user_id: String,
    pub team: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlackReply {
    Body,
    /// HTTP 429: wait this many seconds, for this method only.
    RetryAfter(u64),
}

impl SlackReply {
    pub fn from_status(status: u16, retry_after: Option<&str>) -> Self {
        if status == 429 {
            Self::RetryAfter(retry_after.and_then(|s| s.trim().parse().ok()).unwrap_or(30))
        } else {
            Self::Body
        }
    }
}

fn ok_body(body: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(body).map_err(|e| format!("unreadable Slack reply: {e}"))?;
    if v["ok"] == true {
        return Ok(v);
    }
    let error = v["error"].as_str().unwrap_or("unknown_error");
    Err(match v["needed"].as_str() {
        Some(needed) => format!("Slack refused: {error} (needs scope {needed})"),
        None => format!("Slack refused: {error}"),
    })
}

fn message_from(v: &Value, channel: &str) -> SlackMessage {
    let text = |k: &str| v[k].as_str().map(str::to_string);
    SlackMessage {
        channel: channel.to_string(),
        user: text("user"),
        text: text("text").unwrap_or_default(),
        ts: text("ts").unwrap_or_default(),
        thread_ts: text("thread_ts"),
        subtype: text("subtype"),
    }
}

/// One `conversations.history` page → (messages oldest first, next cursor).
pub fn parse_history(body: &str, channel: &str) -> Result<(Vec<SlackMessage>, Option<String>), String> {
    let v = ok_body(body)?;
    let mut messages: Vec<SlackMessage> =
        v["messages"].as_array().map(|list| list.iter().map(|m| message_from(m, channel)).collect()).unwrap_or_default();
    messages.reverse(); // Slack returns newest first.
    let next = v["response_metadata"]["next_cursor"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
    Ok((messages, next))
}

/// `conversations.replies` pages → the replies after `oldest`, oldest first. Slack always
/// includes the parent, and lists a thread oldest first (unlike history), so neither the
/// page order nor `oldest` is trusted.
pub fn replies_in_order(mut messages: Vec<SlackMessage>, thread_ts: &str, oldest: &str) -> Vec<SlackMessage> {
    messages.retain(|m| m.ts != thread_ts && super::ts_after(&m.ts, oldest));
    messages.sort_by(|a, b| match (super::ts_after(&a.ts, &b.ts), super::ts_after(&b.ts, &a.ts)) {
        (true, _) => std::cmp::Ordering::Greater,
        (_, true) => std::cmp::Ordering::Less,
        _ => std::cmp::Ordering::Equal,
    });
    messages.dedup_by(|a, b| a.ts == b.ts);
    messages
}

/// One message of a Slack thread as a review reads it: the text as it is now (an edited message
/// carries its new text), the author's name when Slack gives one, and the names of attached files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadMessage {
    pub ts: String,
    pub user: Option<String>,
    /// Display name, else real name; `None` when Slack sent no profile (see [`SlackWeb::thread`]).
    pub name: Option<String>,
    pub text: String,
    pub edited: bool,
    pub files: Vec<String>,
}

/// One `conversations.replies` page → (the thread's messages, parent included, next cursor).
pub fn parse_thread(body: &str) -> Result<(Vec<ThreadMessage>, Option<String>), String> {
    let v = ok_body(body)?;
    let name = |m: &Value| {
        ["display_name", "real_name"]
            .iter()
            .find_map(|k| m["user_profile"][k].as_str().filter(|n| !n.trim().is_empty()))
            .map(str::to_string)
    };
    let messages = v["messages"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|m| ThreadMessage {
                    ts: m["ts"].as_str().unwrap_or_default().to_string(),
                    user: m["user"].as_str().map(str::to_string),
                    name: name(m),
                    text: m["text"].as_str().unwrap_or_default().to_string(),
                    edited: m["edited"].is_object(),
                    files: m["files"]
                        .as_array()
                        .map(|f| f.iter().filter_map(|f| f["name"].as_str().or(f["title"].as_str())).map(str::to_string).collect())
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    let next = v["response_metadata"]["next_cursor"].as_str().filter(|c| !c.is_empty()).map(str::to_string);
    Ok((messages, next))
}

/// A Slack thread a Factory PR's link was shared in (CoS 12): where the Chief of Staff replies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FoundThread {
    pub channel: String,
    /// Without the `#`.
    pub channel_name: String,
    /// The thread's root message.
    pub ts: String,
    /// The match's link, to show the user where it was found.
    pub permalink: String,
}

/// `search.messages` → the thread of the oldest match in a channel, or `None`. A match that is a
/// thread reply names its root in the permalink (`thread_ts=`). DMs and group DMs are skipped:
/// Lotus never writes into someone's DM. So are bots' posts: only a person's share is the thread.
pub fn parse_search_thread(body: &str) -> Result<Option<FoundThread>, String> {
    let v = ok_body(body)?;
    let matches = v["messages"]["matches"].as_array().cloned().unwrap_or_default();
    let found = matches
        .iter()
        .filter(|m| !m["channel"]["is_im"].as_bool().unwrap_or(false) && !m["channel"]["is_mpim"].as_bool().unwrap_or(false))
        // A bot's post (the GitHub app's PR notification) is no thread a reviewer reads.
        .filter(|m| m["bot_id"].as_str().is_none_or(str::is_empty) && m["subtype"].as_str() != Some("bot_message"))
        .filter_map(|m| {
            let ts = m["ts"].as_str()?.to_string();
            let permalink = m["permalink"].as_str().unwrap_or_default().to_string();
            let root = permalink
                .split_once('?')
                .and_then(|(_, query)| query.split('&').find_map(|kv| kv.strip_prefix("thread_ts=")))
                .map_or_else(|| ts.clone(), str::to_string);
            Some(FoundThread {
                channel: m["channel"]["id"].as_str()?.to_string(),
                channel_name: m["channel"]["name"].as_str().unwrap_or_default().to_string(),
                ts: root,
                permalink,
            })
        })
        .reduce(|oldest, t| if super::ts_after(&oldest.ts, &t.ts) { t } else { oldest });
    Ok(found)
}

/// `users.info` → the user's display name, else real name.
pub fn parse_user_name(body: &str) -> Result<Option<String>, String> {
    let v = ok_body(body)?;
    let profile = &v["user"]["profile"];
    Ok(["display_name", "real_name"]
        .iter()
        .find_map(|k| profile[k].as_str().filter(|n| !n.trim().is_empty()))
        .or(v["user"]["real_name"].as_str())
        .map(str::to_string))
}

/// `conversations.list` → the channels the user is a member of.
pub fn parse_channels(body: &str) -> Result<Vec<SlackChannel>, String> {
    let v = ok_body(body)?;
    Ok(v["channels"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter(|c| c["is_member"] == true)
                .filter_map(|c| {
                    Some(SlackChannel {
                        id: c["id"].as_str()?.to_string(),
                        name: c["name"].as_str()?.to_string(),
                        is_private: c["is_private"] == true,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

pub fn parse_usergroups(body: &str) -> Result<Vec<SlackUserGroup>, String> {
    let v = ok_body(body)?;
    Ok(v["usergroups"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|g| {
                    Some(SlackUserGroup {
                        id: g["id"].as_str()?.to_string(),
                        handle: g["handle"].as_str().unwrap_or_default().to_string(),
                        name: g["name"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

/// One custom emoji of the workspace. An alias of another custom emoji carries that one's image;
/// an alias of a standard emoji has no image and names the standard one in `alias_of`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlackEmoji {
    pub name: String,
    pub url: Option<String>,
    pub alias_of: Option<String>,
}

/// `emoji.list` → the custom emoji, by name, with `alias:target` chains followed. A chain that
/// loops or runs past 10 hops is dropped.
pub fn parse_emoji(body: &str) -> Result<Vec<SlackEmoji>, String> {
    let v = ok_body(body)?;
    let Some(map) = v["emoji"].as_object() else { return Ok(Vec::new()) };
    let mut out: Vec<SlackEmoji> = map
        .iter()
        .filter_map(|(name, value)| {
            let mut value = value.as_str()?;
            let mut hops = 0;
            while let Some(target) = value.strip_prefix("alias:") {
                match map.get(target).and_then(Value::as_str) {
                    Some(next) if hops < 10 => {
                        value = next;
                        hops += 1;
                    }
                    // The target is not custom, so it is a standard emoji.
                    None => return Some(SlackEmoji { name: name.clone(), url: None, alias_of: Some(target.to_string()) }),
                    Some(_) => return None,
                }
            }
            Some(SlackEmoji { name: name.clone(), url: Some(value.to_string()), alias_of: None })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Whether an error from [`parse_emoji`] is the app lacking the `emoji:read` scope, which a
/// reinstall of the Slack app fixes.
pub fn is_missing_scope(error: &str) -> bool {
    error.contains("missing_scope")
}

/// Whether a `chat.postMessage` error is Slack refusing the `blocks` (not the message), so the
/// same text may go again without them.
pub fn refused_blocks(error: &str) -> bool {
    ["invalid_blocks", "invalid_blocks_format", "msg_blocks_too_long", "too_many_blocks"].iter().any(|e| error.contains(e))
}

/// The Slack Web API as the user. Not unit-tested (network); parsing above is.
#[derive(Clone)]
pub struct SlackWeb {
    http: reqwest::Client,
    token: Secret,
}

impl SlackWeb {
    pub fn new(token: Secret) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default();
        Self { http, token }
    }

    /// Calls `method` with `form`, honouring one `Retry-After` wait (≤ 60 s).
    async fn call(&self, method: &str, form: &[(&str, &str)]) -> Result<String, String> {
        let (http, token) = (&self.http, &self.token);
        crate::ratelimit::with_rate_limit(
            method,
            || async move {
                let res = http
                    .post(format!("https://slack.com/api/{method}"))
                    .bearer_auth(token.expose())
                    .form(form)
                    .send()
                    .await
                    .map_err(|e| format!("{method}: {}", e.without_url()))?;
                let retry = res.headers().get("retry-after").and_then(|h| h.to_str().ok()).map(str::to_string);
                match SlackReply::from_status(res.status().as_u16(), retry.as_deref()) {
                    SlackReply::RetryAfter(secs) => Ok(crate::ratelimit::Attempt::Wait(Duration::from_secs(secs))),
                    SlackReply::Body => res
                        .text()
                        .await
                        .map(crate::ratelimit::Attempt::Done)
                        .map_err(|e| format!("{method}: {}", e.without_url())),
                }
            },
            tokio::time::sleep,
        )
        .await
    }

    /// `chat.postMessage` with `wire` as the `text` and as one `rich_text` block, the shape
    /// Slack's composer sends (real lists, not `•` characters). `text` stays the notification
    /// fallback; when Slack refuses the blocks, the message goes again as text alone.
    async fn post(&self, target: &[(&str, &str)], wire: &str) -> Result<String, String> {
        let mut form: Vec<(&str, &str)> = target.to_vec();
        form.extend([("text", wire), ("unfurl_links", "false")]);
        let blocks = super::rich_text_blocks(wire).map(|b| b.to_string());
        if let Some(blocks) = &blocks {
            let mut rich = form.clone();
            rich.push(("blocks", blocks));
            match ok_body(&self.call("chat.postMessage", &rich).await?) {
                Ok(v) => return Ok(v["ts"].as_str().unwrap_or_default().to_string()),
                Err(e) if refused_blocks(&e) => eprintln!("[slack] rich_text refused, posting as text: {e}"),
                Err(e) => return Err(e),
            }
        }
        let body = self.call("chat.postMessage", &form).await?;
        Ok(ok_body(&body)?["ts"].as_str().unwrap_or_default().to_string())
    }

    pub async fn identity(&self) -> Result<SlackIdentity, String> {
        let v = ok_body(&self.call("auth.test", &[]).await?)?;
        Ok(SlackIdentity {
            user_id: v["user_id"].as_str().unwrap_or_default().to_string(),
            team: v["team"].as_str().unwrap_or_default().to_string(),
        })
    }

    pub async fn channels(&self) -> Result<Vec<SlackChannel>, String> {
        let mut all = Vec::new();
        let mut cursor = String::new();
        loop {
            let body = self
                .call(
                    "conversations.list",
                    &[
                        ("types", "public_channel,private_channel"),
                        ("exclude_archived", "true"),
                        ("limit", "1000"),
                        ("cursor", &cursor),
                    ],
                )
                .await?;
            all.extend(parse_channels(&body)?);
            let next = ok_body(&body)?["response_metadata"]["next_cursor"].as_str().unwrap_or_default().to_string();
            if next.is_empty() {
                break;
            }
            cursor = next;
        }
        all.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(all)
    }

    /// The workspace's custom emoji (`emoji.list`, scope `emoji:read`, Tier 2).
    pub async fn emoji_list(&self) -> Result<Vec<SlackEmoji>, String> {
        parse_emoji(&self.call("emoji.list", &[]).await?)
    }

    pub async fn usergroups(&self) -> Result<Vec<SlackUserGroup>, String> {
        parse_usergroups(&self.call("usergroups.list", &[]).await?)
    }

    /// The Slack thread the oldest channel message containing `text` (a PR URL) starts or sits in.
    /// Scope `search:read` (user token).
    pub async fn search_thread(&self, text: &str) -> Result<Option<FoundThread>, String> {
        parse_search_thread(
            &self.call("search.messages", &[("query", text), ("sort", "timestamp"), ("sort_dir", "asc"), ("count", "20")]).await?,
        )
    }

    /// User `user`'s display name, else real name (`users.info`, scope `users:read`).
    pub async fn user_name(&self, user: &str) -> Result<Option<String>, String> {
        self.call("users.info", &[("user", user)]).await.and_then(|b| parse_user_name(&b))
    }

    /// Every message of thread `thread_ts`, parent first, as it reads now. An author Slack sent
    /// without a profile is looked up with `users.info` (scope `users:read`); without that scope
    /// the message keeps only the user id.
    pub async fn thread(&self, channel: &str, thread_ts: &str) -> Result<Vec<ThreadMessage>, String> {
        let mut all: Vec<ThreadMessage> = Vec::new();
        let mut cursor = String::new();
        for _ in 0..10 {
            let body = self
                .call("conversations.replies", &[("channel", channel), ("ts", thread_ts), ("limit", "200"), ("cursor", &cursor)])
                .await?;
            let (page, next) = parse_thread(&body)?;
            all.extend(page);
            match next {
                Some(next) => cursor = next,
                None => break,
            }
        }
        all.sort_by(|a, b| match (super::ts_after(&a.ts, &b.ts), super::ts_after(&b.ts, &a.ts)) {
            (true, _) => std::cmp::Ordering::Greater,
            (_, true) => std::cmp::Ordering::Less,
            _ => std::cmp::Ordering::Equal,
        });
        all.dedup_by(|a, b| a.ts == b.ts);
        let mut names: std::collections::HashMap<String, Option<String>> = std::collections::HashMap::new();
        for m in &all {
            if let (Some(user), Some(name)) = (&m.user, &m.name) {
                names.insert(user.clone(), Some(name.clone()));
            }
        }
        for m in &mut all {
            let Some(user) = m.user.clone().filter(|_| m.name.is_none()) else { continue };
            if !names.contains_key(&user) {
                let name = match self.user_name(&user).await {
                    Ok(name) => name,
                    Err(e) => {
                        eprintln!("[automation] slack users.info {user}: {e}");
                        None
                    }
                };
                names.insert(user.clone(), name);
            }
            m.name = names[&user].clone();
        }
        Ok(all)
    }
}

/// `apps.connections.open` with the app-level token: a fresh Socket Mode URL.
pub async fn open_socket_url(app_token: &Secret) -> Result<String, String> {
    let body = SlackWeb::new(app_token.clone()).call("apps.connections.open", &[]).await?;
    ok_body(&body)?["url"].as_str().map(str::to_string).ok_or_else(|| "Slack gave no Socket Mode URL".into())
}

impl SlackApi for SlackWeb {
    fn history(&self, channel: &str, oldest: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        let (this, channel, oldest) = (self.clone(), channel.to_string(), oldest.to_string());
        Box::pin(async move {
            let mut all = Vec::new();
            let mut cursor = String::new();
            // Newest pages first; bounded so a long outage cannot loop forever.
            for _ in 0..20 {
                let body = this
                    .call(
                        "conversations.history",
                        &[("channel", &channel), ("oldest", &oldest), ("limit", "200"), ("cursor", &cursor)],
                    )
                    .await?;
                let (page, next) = parse_history(&body, &channel)?;
                all.splice(0..0, page);
                match next {
                    Some(next) => cursor = next,
                    None => break,
                }
            }
            Ok(all)
        })
    }

    fn replies(&self, channel: &str, thread_ts: &str, oldest: &str) -> BoxFuture<Result<Vec<SlackMessage>, String>> {
        let (this, channel, thread, oldest) = (self.clone(), channel.to_string(), thread_ts.to_string(), oldest.to_string());
        Box::pin(async move {
            let mut all = Vec::new();
            let mut cursor = String::new();
            // Bounded like `history`: a thread with thousands of new replies is not worth looping on.
            for _ in 0..10 {
                let body = this
                    .call(
                        "conversations.replies",
                        &[("channel", &channel), ("ts", &thread), ("oldest", &oldest), ("limit", "200"), ("cursor", &cursor)],
                    )
                    .await?;
                let (page, next) = parse_history(&body, &channel)?;
                all.extend(page);
                match next {
                    Some(next) => cursor = next,
                    None => break,
                }
            }
            Ok(replies_in_order(all, &thread, &oldest))
        })
    }

    fn message(&self, channel: &str, ts: &str) -> BoxFuture<Result<Option<SlackMessage>, String>> {
        let (this, channel, ts) = (self.clone(), channel.to_string(), ts.to_string());
        Box::pin(async move {
            // `conversations.replies` accepts the ts of a parent OR of a reply.
            let body = this
                .call("conversations.replies", &[("channel", &channel), ("ts", &ts), ("inclusive", "true"), ("limit", "200")])
                .await?;
            let (messages, _) = parse_history(&body, &channel)?;
            Ok(messages.into_iter().find(|m| m.ts == ts))
        })
    }

    fn add_reaction(&self, channel: &str, ts: &str, name: &str) -> BoxFuture<Result<(), String>> {
        let (this, channel, ts, name) = (self.clone(), channel.to_string(), ts.to_string(), name.to_string());
        Box::pin(async move {
            let body = this.call("reactions.add", &[("channel", &channel), ("timestamp", &ts), ("name", &name)]).await?;
            match ok_body(&body) {
                Ok(_) => Ok(()),
                // Already there (added by hand): fine.
                Err(e) if e.contains("already_reacted") => Ok(()),
                Err(e) => Err(e),
            }
        })
    }

    fn remove_reaction(&self, channel: &str, ts: &str, name: &str) -> BoxFuture<Result<(), String>> {
        let (this, channel, ts, name) = (self.clone(), channel.to_string(), ts.to_string(), name.to_string());
        Box::pin(async move {
            let body = this.call("reactions.remove", &[("channel", &channel), ("timestamp", &ts), ("name", &name)]).await?;
            match ok_body(&body) {
                Ok(_) => Ok(()),
                // Already gone (taken off by hand): fine.
                Err(e) if e.contains("no_reaction") => Ok(()),
                Err(e) => Err(e),
            }
        })
    }

    fn post_reply(&self, channel: &str, thread_ts: &str, text: &str) -> BoxFuture<Result<String, String>> {
        let (this, channel, thread, text) = (self.clone(), channel.to_string(), thread_ts.to_string(), text.to_string());
        Box::pin(async move {
            this.post(&[("channel", &channel), ("thread_ts", &thread)], &text).await
        })
    }

    fn post_message(&self, channel: &str, text: &str) -> BoxFuture<Result<String, String>> {
        let (this, channel, text) = (self.clone(), channel.to_string(), text.to_string());
        Box::pin(async move {
            this.post(&[("channel", &channel)], &text).await
        })
    }
}
