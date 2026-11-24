//! Which sign-in a new chat session uses (#277, mockup page "04c Sign-in"): the user's own Claude
//! login, or an Anthropic API key. One app-wide setting, read when a session starts, so a running
//! chat keeps its sign-in until it restarts.
//!
//! The key is a secret and goes to the same store as the Slack tokens
//! ([`crate::automation_slack::secret_store`]); the mode is not, and sits in
//! `<state dir>/chat-auth.json`. The UI only ever sees the key's last four characters.

use std::path::PathBuf;

use lotus_automation::secrets::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const KEY_NAME: &str = "chat.anthropic-api-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    #[default]
    Login,
    ApiKey,
}

/// What the sign-in popover shows. Never carries the key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
    pub mode: AuthMode,
    /// Last four characters of the saved key; `None` when no key is saved.
    pub key_hint: Option<String>,
    /// Where the key is kept: `None` for the OS keychain, else the file a macOS dev build uses.
    pub stored_in_file: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ModeFile {
    mode: AuthMode,
}

pub struct ChatAuth {
    secrets: Box<dyn SecretStore>,
    mode_path: PathBuf,
    secrets_file: Option<PathBuf>,
    /// The Claude account picked in the usage popover ([`crate::usage::account_file`]).
    account_path: PathBuf,
}

impl ChatAuth {
    pub fn open() -> Self {
        Self {
            secrets: crate::automation_slack::secret_store(),
            mode_path: crate::paths::lotus_state_dir().join("chat-auth.json"),
            secrets_file: crate::automation_slack::dev_secrets_file(),
            account_path: crate::usage::account_file(),
        }
    }

    fn mode(&self) -> AuthMode {
        std::fs::read(&self.mode_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ModeFile>(&bytes).ok())
            .map(|file| file.mode)
            .unwrap_or_default()
    }

    fn write_mode(&self, mode: AuthMode) -> Result<(), String> {
        if let Some(dir) = self.mode_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let body = serde_json::to_vec(&ModeFile { mode }).map_err(|e| e.to_string())?;
        std::fs::write(&self.mode_path, body).map_err(|e| format!("write {}: {e}", self.mode_path.display()))
    }

    pub fn view(&self) -> Result<AuthView, String> {
        let key = self.secrets.get(KEY_NAME)?;
        Ok(AuthView {
            // API key mode without a key would start sessions on the login anyway; say so.
            mode: if key.is_some() { self.mode() } else { AuthMode::Login },
            key_hint: key.as_deref().map(last_four),
            stored_in_file: self.secrets_file.as_ref().map(|p| p.display().to_string()),
        })
    }

    /// Saving a key also switches to it. No test call: the first turn shows whether it works.
    pub fn save_key(&self, key: &str) -> Result<AuthView, String> {
        let key = key.trim();
        if !key.starts_with("sk-ant-") || key.len() < 20 || key.chars().any(char::is_whitespace) {
            return Err("That is not an Anthropic API key — it starts with sk-ant-".into());
        }
        self.secrets.set(KEY_NAME, key)?;
        self.write_mode(AuthMode::ApiKey)?;
        self.view()
    }

    pub fn remove_key(&self) -> Result<AuthView, String> {
        self.secrets.delete(KEY_NAME)?;
        self.write_mode(AuthMode::Login)?;
        self.view()
    }

    pub fn set_mode(&self, mode: AuthMode) -> Result<AuthView, String> {
        if mode == AuthMode::ApiKey && self.secrets.get(KEY_NAME)?.is_none() {
            return Err("Save an API key first".into());
        }
        self.write_mode(mode)?;
        self.view()
    }

    /// The `auth` param of `thread/start`. Reads the secret only in API key mode. `account`: the
    /// thread's own ccs account (step 4); else the one picked in the usage popover.
    pub fn session_auth(&self, account: Option<&str>) -> Result<Value, String> {
        if self.mode() == AuthMode::ApiKey {
            if let Some(key) = self.secrets.get(KEY_NAME)? {
                return Ok(json!({ "mode": "apiKey", "apiKey": key }));
            }
        }
        let dir = account
            .and_then(crate::usage::account_dir)
            .or_else(|| crate::usage::chosen_in(&self.account_path, crate::accounts::claude_accounts).map(|a| a.dir));
        match dir {
            // `default` is no `configDir` at all, not `~/.claude` (see `accounts::is_default`).
            Some(dir) if !crate::accounts::is_default(&dir) => Ok(json!({ "mode": "login", "configDir": dir })),
            _ => Ok(json!({ "mode": "login" })),
        }
    }
}

fn last_four(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    chars[chars.len().saturating_sub(4)..].iter().collect()
}

#[cfg(test)]
mod tests {
    use lotus_automation::secrets::FileStore;

    use super::*;

    const KEY: &str = "sk-ant-api03-abcdefghijklmnop-4f2a";

    fn auth(dir: &tempfile::TempDir) -> ChatAuth {
        ChatAuth {
            secrets: Box::new(FileStore::new(dir.path().join("secrets.json"))),
            mode_path: dir.path().join("chat-auth.json"),
            secrets_file: None,
            account_path: dir.path().join("claude-account.json"),
        }
    }

    #[test]
    fn defaults_to_the_login_and_never_reads_a_key_for_it() {
        let dir = tempfile::tempdir().unwrap();
        let auth = auth(&dir);
        assert_eq!(auth.view().unwrap(), AuthView { mode: AuthMode::Login, key_hint: None, stored_in_file: None });
        assert_eq!(auth.session_auth(None).unwrap(), json!({ "mode": "login" }));
        assert!(auth.set_mode(AuthMode::ApiKey).is_err());
    }

    #[test]
    fn a_saved_key_is_used_and_shown_only_by_its_last_four() {
        let dir = tempfile::tempdir().unwrap();
        let auth = auth(&dir);
        let view = auth.save_key(&format!("  {KEY}\n")).unwrap();
        assert_eq!(view, AuthView { mode: AuthMode::ApiKey, key_hint: Some("4f2a".into()), stored_in_file: None });
        assert_eq!(auth.session_auth(None).unwrap(), json!({ "mode": "apiKey", "apiKey": KEY }));

        // Switching to the login keeps the key for later.
        assert_eq!(auth.set_mode(AuthMode::Login).unwrap().key_hint.as_deref(), Some("4f2a"));
        assert_eq!(auth.session_auth(None).unwrap(), json!({ "mode": "login" }));

        assert_eq!(auth.remove_key().unwrap(), AuthView { mode: AuthMode::Login, key_hint: None, stored_in_file: None });
    }

    #[test]
    fn rejects_what_is_not_an_api_key() {
        let dir = tempfile::tempdir().unwrap();
        let auth = auth(&dir);
        for bad in ["", "hello", "sk-ant-short", "sk-ant-api03 with spaces in it"] {
            assert!(auth.save_key(bad).is_err(), "{bad:?}");
        }
        assert_eq!(auth.view().unwrap().key_hint, None);
    }
}
