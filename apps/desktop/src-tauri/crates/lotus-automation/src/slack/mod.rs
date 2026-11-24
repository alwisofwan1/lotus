//! Slack as a trigger source: reading messages, deciding what they ask for,
//! the Socket Mode protocol, catching up after downtime, and replying.
//! Everything here is pure or behind the [`SlackApi`] port; the WebSocket
//! and HTTP adapters live at the bottom of the stack.

mod api;
pub mod client;
pub mod intake;
mod listener;
mod outgoing;
mod reactions;
mod reply;
mod rich;
pub mod socket;
mod text;
mod trigger;
pub mod web;

pub use text::{read_message_text, MessageText};
pub use trigger::{
    decide, decide_reacted, decide_with, parse_event, Decision, ReviewRequest, SlackEvent, SlackMessage, SlackReaction, SlackTrigger,
    QUEUED_REACTION, REVIEW_REACTION, SKIPPED_REACTION,
};
pub use api::{ts_after, ts_from_ms, SlackApi};
pub use listener::{SlackListener, LIVE_GRACE_MS};
pub use reactions::{ReactionSettings, SentReactions, StatusReactions, MAX_SENT_REACTIONS};
pub use outgoing::{outgoing, trusted_targets};
pub use rich::rich_text_blocks;
pub use reply::{escape as escape_markup, group_item_text, reply_in_thread, reply_in_threads, thread_reply_text};

/// The Slack app manifest users paste at api.slack.com (user token only, no bot).
pub const MANIFEST: &str = include_str!("../../slack/manifest.yaml");
