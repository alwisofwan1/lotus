//! The Socket Mode wire protocol, as pure functions
//! (research/slack-socket-mode.md §2). The connection loop that uses them
//! lives in `slack::client`.

use std::time::Duration;

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    /// `connections`: Slack's `num_connections`, every open socket of this Slack app, ours included.
    Hello { connections: Option<u64> },
    /// Slack is about to close this connection; `reason` says whether to come back.
    Disconnect { reason: String },
    /// Anything Slack wants acknowledged. `event` is set for `events_api`.
    Envelope { envelope_id: String, kind: String, event_id: Option<String>, event: Option<Value> },
    Unknown,
}

pub fn read_frame(text: &str) -> Frame {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Frame::Unknown;
    };
    match v["type"].as_str() {
        Some("hello") => Frame::Hello { connections: v["num_connections"].as_u64() },
        Some("disconnect") => Frame::Disconnect { reason: v["reason"].as_str().unwrap_or_default().to_string() },
        Some(kind) => match v["envelope_id"].as_str() {
            Some(id) => Frame::Envelope {
                envelope_id: id.to_string(),
                kind: kind.to_string(),
                event_id: v["payload"]["event_id"].as_str().map(str::to_string),
                event: v["payload"].get("event").cloned(),
            },
            None => Frame::Unknown,
        },
        None => Frame::Unknown,
    }
}

/// The acknowledgement for an envelope. Sent for every envelope, handled or
/// not, or Slack redelivers it.
pub fn ack(envelope_id: &str) -> String {
    serde_json::json!({ "envelope_id": envelope_id }).to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reconnect {
    Now,
    After(Duration),
    /// Do not reconnect; tell the user why.
    Stop(String),
}

pub fn after_disconnect(reason: &str) -> Reconnect {
    match reason {
        // Routine: Slack rotates connections every few hours and warns ~10 s ahead.
        "refresh_requested" | "warning" => Reconnect::Now,
        "link_disabled" => Reconnect::Stop("Socket Mode was turned off for this Slack app".into()),
        _ => Reconnect::After(backoff(0)),
    }
}

/// Wait before reconnect attempt `attempt` (0-based) after a failure.
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs(1u64.checked_shl(attempt).unwrap_or(u64::MAX).min(60))
}
