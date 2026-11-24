//! Google Sheets and Drive, as the user, with Lotus's own sign-in
//! (plans/google-connector/PLAN.md, research/google-workspace-connector.md).
//!
//! - [`auth`]: loopback + PKCE sign-in, scope `drive.file` only, the refresh
//!   token in the [`crate::secrets::SecretStore`], access tokens in memory.
//! - [`api`]: the few Sheets and Drive calls an Automation output needs.
//!
//! Tokens never reach an agent process: an agent returns rows or text, and
//! Rust writes them (PLAN G8).

pub mod api;
pub mod auth;
pub mod loopback;
pub mod output;

use std::fmt;

/// Where each Google service lives. [`Endpoints::google`] in the app; tests
/// point every service at one fake server with [`Endpoints::at`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub revoke: String,
    pub sheets: String,
    pub drive: String,
    pub upload: String,
}

impl Endpoints {
    pub fn google() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            sheets: "https://sheets.googleapis.com/v4".into(),
            drive: "https://www.googleapis.com/drive/v3".into(),
            upload: "https://www.googleapis.com/upload/drive/v3".into(),
        }
    }

    /// Every service under one base URL, at the same paths the real ones use.
    pub fn at(base: &str) -> Self {
        let base = base.trim_end_matches('/');
        Self {
            auth: format!("{base}/o/oauth2/v2/auth"),
            token: format!("{base}/token"),
            revoke: format!("{base}/revoke"),
            sheets: format!("{base}/v4"),
            drive: format!("{base}/drive/v3"),
            upload: format!("{base}/upload/drive/v3"),
        }
    }
}

/// Why a Google call did not work. [`GoogleError::Reconnect`] is the one the
/// user must act on in Connectors; everything else is about one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GoogleError {
    /// The sign-in is gone or lacks Drive access: connect Google again.
    Reconnect(String),
    /// This call failed; the connection itself may be fine.
    Failed(String),
}

impl GoogleError {
    pub fn needs_reconnect(&self) -> bool {
        matches!(self, Self::Reconnect(_))
    }
}

impl fmt::Display for GoogleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Reconnect(m) | Self::Failed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for GoogleError {}
