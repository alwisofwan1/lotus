//! Secrets never leave this module by accident: [`Secret`] prints as
//! `[redacted]`, and the only way to read one is [`Secret::expose`], called
//! where the value goes on the wire. Storage is behind [`SecretStore`] — the
//! OS keychain in the app (ADR-0038, PLAN §2.2 Q18).

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;

/// A credential. Debug and Display never show the value.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// For credentials Lotus receives itself (a Google token grant), not pasted ones.
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("[redacted]")
    }
}

/// Where secrets are kept, by name.
pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TokenError {
    /// The value pasted into `field` is not the expected token. `looks_like`
    /// is derived from the public prefix only.
    #[error("the {field} token should start with {expected}, but this looks like {looks_like}")]
    WrongKind { field: &'static str, expected: &'static str, looks_like: String },
}

/// The tokens of the user's Slack app: `xapp-` for Socket Mode, `xoxp-` to read, react and reply
/// as the user, and optionally `xoxb-` for the Lotus bot, which DMs the user Chief of Staff alerts
/// (CoS 11): a DM from yourself does not ping your phone, one from a bot does.
#[derive(Debug, Clone)]
pub struct SlackTokens {
    app: Secret,
    user: Secret,
    bot: Option<Secret>,
}

impl SlackTokens {
    /// Forgives pasted whitespace and quotes; refuses the wrong kind of token.
    pub fn new(app: &str, user: &str) -> Result<Self, TokenError> {
        Ok(Self { app: Secret(check(app, "app", "xapp-")?), user: Secret(check(user, "user", "xoxp-")?), bot: None })
    }

    /// Adds the bot token; refuses any other kind.
    pub fn with_bot(mut self, bot: &str) -> Result<Self, TokenError> {
        self.bot = Some(Secret(check(bot, "bot", "xoxb-")?));
        Ok(self)
    }

    pub fn bot(&self) -> Option<&Secret> {
        self.bot.as_ref()
    }

    pub fn app(&self) -> &Secret {
        &self.app
    }

    pub fn user(&self) -> &Secret {
        &self.user
    }
}

fn check(raw: &str, field: &'static str, expected: &'static str) -> Result<String, TokenError> {
    let token = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim();
    if token.starts_with(expected) && token.len() > expected.len() {
        return Ok(token.to_string());
    }
    Err(TokenError::WrongKind { field, expected, looks_like: looks_like(token) })
}

fn looks_like(token: &str) -> String {
    match token.split('-').next().unwrap_or("") {
        _ if token.is_empty() => "nothing (it is empty)".into(),
        "xapp" => "an app-level token (xapp-)".into(),
        "xoxp" => "a user token (xoxp-)".into(),
        "xoxb" => "a bot token (xoxb-)".into(),
        "xoxe" => "a rotating refresh token (xoxe-)".into(),
        _ if token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit()) => {
            "a 32-character hex value — the Signing Secret or Client Secret, not a token".into()
        }
        _ => format!("something else ({} characters, no token prefix)", token.chars().count()),
    }
}

/// Both tokens in one entry, so a launch reads the OS store once, not twice
/// (on macOS every read of an item the build is not trusted for prompts).
const SLACK_TOKENS: &str = "slack-tokens";
/// The entries used before `SLACK_TOKENS`; read once to migrate, then removed.
const LEGACY_APP_TOKEN: &str = "slack-app-token";
const LEGACY_USER_TOKEN: &str = "slack-user-token";

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredSlackTokens {
    app: String,
    user: String,
    /// Absent in tokens saved before the bot (CoS 11).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bot: Option<String>,
}

pub fn save_slack_tokens(store: &dyn SecretStore, tokens: &SlackTokens) -> Result<(), String> {
    let stored = StoredSlackTokens {
        app: tokens.app.expose().into(),
        user: tokens.user.expose().into(),
        bot: tokens.bot.as_ref().map(|b| b.expose().into()),
    };
    store.set(SLACK_TOKENS, &serde_json::to_string(&stored).map_err(|e| e.to_string())?)
}

/// `None` until both tokens are saved. Tokens saved as two entries by an
/// older Lotus are moved into the single entry on first load.
pub fn load_slack_tokens(store: &dyn SecretStore) -> Result<Option<SlackTokens>, String> {
    if let Some(json) = store.get(SLACK_TOKENS)? {
        let stored: StoredSlackTokens =
            serde_json::from_str(&json).map_err(|_| "the saved Slack tokens are unreadable".to_string())?;
        let tokens = SlackTokens::new(&stored.app, &stored.user).map_err(|e| e.to_string())?;
        return match stored.bot {
            Some(bot) => tokens.with_bot(&bot).map(Some).map_err(|e| e.to_string()),
            None => Ok(Some(tokens)),
        };
    }
    match (store.get(LEGACY_APP_TOKEN)?, store.get(LEGACY_USER_TOKEN)?) {
        (Some(app), Some(user)) => {
            let tokens = SlackTokens::new(&app, &user).map_err(|e| e.to_string())?;
            save_slack_tokens(store, &tokens)?;
            forget_legacy(store)?;
            Ok(Some(tokens))
        }
        _ => Ok(None),
    }
}

pub fn forget_slack_tokens(store: &dyn SecretStore) -> Result<(), String> {
    store.delete(SLACK_TOKENS)?;
    forget_legacy(store)
}

fn forget_legacy(store: &dyn SecretStore) -> Result<(), String> {
    store.delete(LEGACY_APP_TOKEN)?;
    store.delete(LEGACY_USER_TOKEN)
}

/// Whether Slack tokens are saved, kept as a plain file beside the app's
/// state so a launch without Slack never touches the OS store. Holds no secret.
/// A missing file means "not known yet" (first launch after an upgrade): the
/// store is read once and the answer written down.
pub struct SavedFlag(PathBuf);

impl SavedFlag {
    pub fn new(path: PathBuf) -> Self {
        Self(path)
    }

    fn read(&self) -> Option<bool> {
        match std::fs::read_to_string(&self.0).ok()?.trim() {
            "saved" => Some(true),
            "none" => Some(false),
            _ => None,
        }
    }

    fn write(&self, saved: bool) -> Result<(), String> {
        if let Some(dir) = self.0.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.0, if saved { "saved\n" } else { "none\n" }).map_err(|e| e.to_string())
    }
}

/// [`load_slack_tokens`], skipped when the flag says nothing is saved.
pub fn load_slack_tokens_flagged(store: &dyn SecretStore, flag: &SavedFlag) -> Result<Option<SlackTokens>, String> {
    if flag.read() == Some(false) {
        return Ok(None);
    }
    let tokens = load_slack_tokens(store)?;
    flag.write(tokens.is_some())?;
    Ok(tokens)
}

pub fn save_slack_tokens_flagged(store: &dyn SecretStore, flag: &SavedFlag, tokens: &SlackTokens) -> Result<(), String> {
    save_slack_tokens(store, tokens)?;
    flag.write(true)
}

pub fn forget_slack_tokens_flagged(store: &dyn SecretStore, flag: &SavedFlag) -> Result<(), String> {
    forget_slack_tokens(store)?;
    flag.write(false)
}

/// A [`SecretStore`] in one JSON file, readable only by the user. For dev
/// builds on macOS, whose every rebuild would otherwise re-prompt for the
/// keychain; never used by a release build.
pub struct FileStore(PathBuf);

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        Self(path)
    }

    fn load(&self) -> Result<HashMap<String, String>, String> {
        match std::fs::read_to_string(&self.0) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", self.0.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
            Err(e) => Err(format!("{}: {e}", self.0.display())),
        }
    }

    fn save(&self, map: &HashMap<String, String>) -> Result<(), String> {
        use std::io::Write;
        if let Some(dir) = self.0.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&self.0).map_err(|e| e.to_string())?;
        file.write_all(serde_json::to_string(map).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())
    }
}

impl SecretStore for FileStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.load()?.remove(name))
    }

    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let mut map = self.load()?;
        map.insert(name.into(), value.into());
        self.save(&map)
    }

    fn delete(&self, name: &str) -> Result<(), String> {
        let mut map = self.load()?;
        if map.remove(name).is_some() {
            self.save(&map)?;
        }
        Ok(())
    }
}

/// Token shapes Lotus ever handles: Slack app/user/bot tokens, GitHub OAuth,
/// personal, user-to-server, server and refresh tokens, Google access
/// (`ya29.`) and refresh (`1//`) tokens, and Notion tokens (`ntn_`, and the
/// older integration tokens' `secret_`).
const TOKEN_PREFIXES: &[&str] = &[
    "xapp-", "xoxp-", "xoxb-", "xoxa-", "xoxe-", "xoxs-", "github_pat_", "gho_", "ghp_", "ghu_", "ghs_", "ghr_", "ya29.", "1//",
    "ntn_", "secret_",
];

/// `secret_` is also an ordinary word in identifiers (`secret_store`), so it
/// only counts as a token when a token-length body follows it.
const SECRET_PREFIX_MIN_BODY: usize = 20;

/// Masks every token-shaped word in `text`, keeping its prefix so the error
/// still says which credential was involved. Applied to everything stored
/// as a run's reason and to what reaches a notification.
pub fn redact(text: &str) -> String {
    let is_token_char = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    // Google tokens also carry dots; a trailing one is kept as punctuation.
    let body_len = |prefix: &str, body: &str| {
        let dots = prefix.starts_with("ya29") || prefix.starts_with("1//");
        let len = body.find(|c: char| !(is_token_char(c) || (dots && c == '.'))).unwrap_or(body.len());
        if dots { body[..len].trim_end_matches('.').len() } else { len }
    };
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    'scan: while !rest.is_empty() {
        let at_word_start = out.chars().last().is_none_or(|c| !is_token_char(c));
        if at_word_start {
            for prefix in TOKEN_PREFIXES {
                if let Some(body) = rest.strip_prefix(prefix) {
                    let len = body_len(prefix, body);
                    let long_enough = *prefix != "secret_" || len >= SECRET_PREFIX_MIN_BODY;
                    if len > 0 && long_enough {
                        out.push_str(prefix);
                        out.push_str("[redacted]");
                        rest = &body[len..];
                        continue 'scan;
                    }
                }
            }
        }
        let c = rest.chars().next().expect("rest is not empty");
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out
}
