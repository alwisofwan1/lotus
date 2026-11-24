//! Where the Notion connection is kept. The token goes to the
//! [`SecretStore`] (the OS keychain in the app), under its own entry. Who it
//! acts as — no secret — goes to a [`NotionAccountSummary`] the host keeps in a
//! plain file, so drawing Connectors never reads the keychain (each read can
//! prompt on macOS), the same arrangement as Google's.

use super::api::NotionIdentity;
use super::token::NotionToken;
use crate::secrets::SecretStore;

const NOTION_TOKEN: &str = "notion-token";

/// Who is connected, without the token.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionAccountSummary {
    /// `personal` for a personal access token, `integration` for a bot.
    pub kind: String,
    pub name: Option<String>,
    /// A personal token's owner's email. Integrations have none.
    pub email: Option<String>,
    /// The workspace an integration belongs to. Notion does not tell a
    /// personal token which workspace it is for.
    pub workspace: Option<String>,
    pub connected_at_ms: i64,
}

impl NotionAccountSummary {
    pub fn new(identity: &NotionIdentity, connected_at_ms: i64) -> Self {
        match identity {
            NotionIdentity::Person { name, email } => Self {
                kind: "personal".into(),
                name: name.clone(),
                email: email.clone(),
                workspace: None,
                connected_at_ms,
            },
            NotionIdentity::Integration { name, workspace } => Self {
                kind: "integration".into(),
                name: name.clone(),
                email: None,
                workspace: workspace.clone(),
                connected_at_ms,
            },
        }
    }
}

pub fn save_notion_token(store: &dyn SecretStore, token: &NotionToken) -> Result<(), String> {
    store.set(NOTION_TOKEN, token.secret().expose())
}

/// `None` when no token is saved. A saved value that no longer parses (edited
/// by hand) is an error, not a silent disconnect.
pub fn load_notion_token(store: &dyn SecretStore) -> Result<Option<NotionToken>, String> {
    match store.get(NOTION_TOKEN)? {
        Some(raw) => NotionToken::parse(&raw).map(Some).map_err(|_| "the saved Notion token is unreadable; connect Notion again".into()),
        None => Ok(None),
    }
}

pub fn forget_notion_token(store: &dyn SecretStore) -> Result<(), String> {
    store.delete(NOTION_TOKEN)
}
