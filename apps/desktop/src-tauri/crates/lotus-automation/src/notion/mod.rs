//! Notion, as the person who connected it (plans/ticket-sources/PLAN.md §2.2).
//!
//! - [`token`]: the pasted token — a personal access token (`ntn_…`) or an
//!   integration token — checked for shape before anything is sent.
//! - [`api`]: the REST calls, starting with `users/me` to learn who the token
//!   acts as.
//! - [`account`]: where the token and "who is connected" are kept.
//!
//! The token never reaches an agent process: agents read Notion through
//! Notion's hosted MCP with their own sign-in (PLAN S13, S15).

pub mod account;
pub mod api;
pub mod body;
pub mod reference;
pub mod rows;
pub mod schema;
pub mod sync;
pub mod write;
pub mod token;

use std::fmt;

/// The API version every request pins (PLAN S36). One version for all calls.
pub const NOTION_VERSION: &str = "2026-03-11";

/// Where Notion's REST API lives. Tests point it at a fake server.
pub const NOTION_API: &str = "https://api.notion.com";

/// Why a Notion call did not work. [`NotionError::Reconnect`] is the one the
/// person must act on in Connectors: the token is wrong, expired or revoked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotionError {
    Reconnect(String),
    /// 404: the thing is gone, or this token was never shown it — unshared, or moved to trash.
    NotFound(String),
    /// Notion could not be reached at all: no network, DNS, a timeout.
    Offline(String),
    /// Notion asked Lotus to wait this long before asking again.
    RateLimited { retry_after: std::time::Duration, message: String },
    /// This call failed; the connection itself may be fine.
    Failed(String),
}

impl NotionError {
    pub fn needs_reconnect(&self) -> bool {
        matches!(self, Self::Reconnect(_))
    }
}

impl fmt::Display for NotionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Reconnect(m) | Self::NotFound(m) | Self::Offline(m) | Self::Failed(m) | Self::RateLimited { message: m, .. } => f.write_str(m),
        }
    }
}

impl std::error::Error for NotionError {}
