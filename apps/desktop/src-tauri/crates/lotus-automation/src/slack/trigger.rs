use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::read_message_text;
use crate::pr_review::PrRef;

/// A Slack event, reduced to what the trigger reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlackEvent {
    Message(SlackMessage),
    Reaction(SlackReaction),
    /// Any other event type, kept only to say why nothing happened.
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlackMessage {
    pub channel: String,
    pub user: Option<String>,
    pub text: String,
    pub ts: String,
    /// Set on replies. Slack sends replies without a subtype, so this is how
    /// a reply is recognised (research/slack-socket-mode.md §3).
    pub thread_ts: Option<String>,
    pub subtype: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlackReaction {
    pub user: String,
    pub reaction: String,
    pub channel: String,
    pub ts: String,
}

/// `automation.trigger.config` for kind `slack`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SlackTrigger {
    /// Channel ids whose messages count.
    pub channels: Vec<String>,
    /// A user group (`S…`) whose mention counts as a mention of me.
    #[serde(default)]
    pub team: Option<String>,
    /// Where else the automation is asked for reviews (see [`crate::sources`]). Not Slack's to
    /// read, but named so a trigger that has them still parses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<serde_json::Value>,
}

/// What a request in Slack asks for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewRequest {
    pub pull_requests: Vec<PrRef>,
    pub channel: String,
    /// The message the request is in.
    pub message_ts: String,
    /// Where a reply belongs: the thread root.
    pub thread_ts: String,
    /// Who asked, to be tagged in the reply.
    pub requester: Option<String>,
    /// I asked (my 👀), rather than a mention by someone else.
    pub by_me: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Review(ReviewRequest),
    /// My 👀 on a message: fetch that message, then [`decide_reacted`].
    LookUp { channel: String, ts: String },
    Ignore(String),
}

/// The emoji that means "review this", by me only (PLAN §2.2, Q15). The default: the user can
/// choose others (`StatusReactions`).
pub const REVIEW_REACTION: &str = "eyes";
/// On a request whose review waits for a free slot; taken off when it starts (⏳).
pub const QUEUED_REACTION: &str = "hourglass_flowing_sand";
/// On a request whose review was skipped, such as a PR that moved while it waited (⏭️).
pub const SKIPPED_REACTION: &str = "black_right_pointing_double_triangle_with_vertical_bar";

pub fn parse_event(event: &Value) -> SlackEvent {
    let text = |v: &Value| v.as_str().map(str::to_string);
    match event["type"].as_str().unwrap_or_default() {
        "message" => SlackEvent::Message(SlackMessage {
            channel: text(&event["channel"]).unwrap_or_default(),
            user: text(&event["user"]),
            text: text(&event["text"]).unwrap_or_default(),
            ts: text(&event["ts"]).unwrap_or_default(),
            thread_ts: text(&event["thread_ts"]),
            subtype: text(&event["subtype"]),
        }),
        "reaction_added" => SlackEvent::Reaction(SlackReaction {
            user: text(&event["user"]).unwrap_or_default(),
            reaction: text(&event["reaction"]).unwrap_or_default(),
            channel: text(&event["item"]["channel"]).unwrap_or_default(),
            ts: text(&event["item"]["ts"]).unwrap_or_default(),
        }),
        other => SlackEvent::Other(other.to_string()),
    }
}

/// Whether `event` asks `me` for a review, under `trigger`.
pub fn decide(event: &SlackEvent, trigger: &SlackTrigger, me: &str) -> Decision {
    decide_with(event, trigger, me, REVIEW_REACTION)
}

/// [`decide`], with `review_reaction` as the reaction that asks for a review (the user's choice).
pub fn decide_with(event: &SlackEvent, trigger: &SlackTrigger, me: &str, review_reaction: &str) -> Decision {
    match event {
        SlackEvent::Message(message) => decide_message(message, trigger, me, true),
        SlackEvent::Reaction(r) => {
            if r.user != me {
                Decision::Ignore("a reaction by someone else".into())
            } else if r.reaction != review_reaction {
                Decision::Ignore(format!("the :{}: reaction does not ask for a review", r.reaction))
            } else if !trigger.channels.contains(&r.channel) {
                Decision::Ignore(format!("channel {} is not watched", r.channel))
            } else {
                Decision::LookUp { channel: r.channel.clone(), ts: r.ts.clone() }
            }
        }
        SlackEvent::Other(kind) => Decision::Ignore(format!("{kind} events do not start reviews")),
    }
}

/// A message I put 👀 on: my reaction is the request, no mention needed.
pub fn decide_reacted(message: &SlackMessage, trigger: &SlackTrigger, me: &str) -> Decision {
    decide_message(message, trigger, me, false)
}

fn decide_message(m: &SlackMessage, trigger: &SlackTrigger, me: &str, needs_mention: bool) -> Decision {
    if let Some(subtype) = &m.subtype {
        // `thread_broadcast` is a reply also sent to the channel: still a person's message.
        if subtype != "thread_broadcast" {
            return Decision::Ignore(format!("a {subtype} message"));
        }
    }
    if !trigger.channels.contains(&m.channel) {
        return Decision::Ignore(format!("channel {} is not watched", m.channel));
    }
    if needs_mention && m.user.as_deref() == Some(me) {
        // Includes Lotus's own replies, which are posted as me.
        return Decision::Ignore("your own message".into());
    }
    let read = read_message_text(&m.text);
    if read.pull_requests.is_empty() {
        return Decision::Ignore("no pull request link".into());
    }
    if needs_mention {
        let asked_me = read.users.iter().any(|u| u == me);
        let asked_team = trigger.team.as_ref().is_some_and(|t| read.teams.contains(t));
        if !asked_me && !asked_team {
            return Decision::Ignore("does not mention you or your team".into());
        }
    }
    Decision::Review(ReviewRequest {
        pull_requests: read.pull_requests,
        channel: m.channel.clone(),
        message_ts: m.ts.clone(),
        thread_ts: m.thread_ts.clone().unwrap_or_else(|| m.ts.clone()),
        requester: m.user.clone().filter(|u| u != me),
        by_me: !needs_mention,
    })
}
