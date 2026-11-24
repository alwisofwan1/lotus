//! The token someone pastes into Connectors, checked before it is sent.
//!
//! Notion's tokens start with `ntn_` — personal access tokens and integration
//! tokens alike — and integration tokens made before that prefix start with
//! `secret_`. A pasted value is forgiven its whitespace and quotes, and a value
//! that is plainly some other service's token is named, so the error says what
//! was pasted instead of just "invalid".

use crate::secrets::Secret;

/// Shortest token body worth sending; real ones are ~40+ characters.
const MIN_BODY: usize = 20;

/// A Notion token, checked for shape. Prints as `[redacted]`.
#[derive(Debug, Clone)]
pub struct NotionToken(Secret);

impl NotionToken {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let token = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
        for prefix in ["ntn_", "secret_"] {
            if let Some(body) = token.strip_prefix(prefix) {
                if body.len() >= MIN_BODY && body.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Ok(Self(Secret::new(token.to_string())));
                }
                return Err(format!(
                    "that starts like a Notion token but is incomplete ({} characters after {prefix}); copy the whole token",
                    body.chars().count()
                ));
            }
        }
        Err(format!("a Notion token starts with ntn_, but this looks like {}", looks_like(token)))
    }

    pub fn secret(&self) -> &Secret {
        &self.0
    }
}

fn looks_like(token: &str) -> String {
    const OTHERS: &[(&str, &str)] = &[
        ("xoxp-", "a Slack user token"),
        ("xoxb-", "a Slack bot token"),
        ("xapp-", "a Slack app token"),
        ("github_pat_", "a GitHub token"),
        ("ghp_", "a GitHub token"),
        ("gho_", "a GitHub token"),
        ("ya29.", "a Google access token"),
    ];
    if token.is_empty() {
        return "nothing (it is empty)".into();
    }
    if let Some((_, name)) = OTHERS.iter().find(|(prefix, _)| token.starts_with(prefix)) {
        return (*name).into();
    }
    if token.starts_with("https://") || token.starts_with("http://") {
        return "a link, not a token".into();
    }
    format!("something else ({} characters)", token.chars().count())
}
