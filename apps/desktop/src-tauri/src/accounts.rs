//! The one list of Claude and Codex logins this machine has. Everything that used to scan
//! `~/.ccs/instances` itself (usage, chat, PTY env, hooks, MCP keeper) reads this instead.
//!
//! Discovery only: no secret and no file content is read here (identity, i.e. email and
//! organisation, is read lazily where an account is shown, never per spawn).

use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// `~/.claude`: what Claude uses with no `CLAUDE_CONFIG_DIR` at all.
    Default,
    /// The login shell's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
    Env,
    Ccs,
    /// `<lotus state>/accounts/claude/<name>`, made by Lotus itself.
    Lotus,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    /// `default`, else the folder name; a clash becomes `ccs-` / `lotus-` / `env-<name>`.
    pub id: String,
    pub source: Source,
    pub dir: PathBuf,
    /// The file Lotus keeps trust and MCP entries in: `~/.claude.json` for the default
    /// account, `<dir>/.claude.json` otherwise (`<dir>/config.toml` for Codex).
    pub config_file: PathBuf,
}

pub const DEFAULT: &str = "default";

/// Which CLI an account signs in: one account = one home dir, picked by `env_key`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
}

impl Provider {
    pub fn env_key(self) -> &'static str {
        match self {
            Provider::Claude => "CLAUDE_CONFIG_DIR",
            Provider::Codex => "CODEX_HOME",
        }
    }
    fn folder(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
    fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
        }
    }
}

pub fn accounts(provider: Provider) -> Vec<Account> {
    match provider {
        Provider::Claude => claude_accounts(),
        Provider::Codex => codex_accounts(),
    }
}

fn accounts_in(provider: Provider, home: &Path, state_dir: &Path, env: &[PathBuf]) -> Vec<Account> {
    match provider {
        Provider::Claude => claude_accounts_in(home, state_dir, env),
        Provider::Codex => codex_accounts_in(home, state_dir, env),
    }
}

pub fn find_for(provider: Provider, id: &str) -> Option<Account> {
    accounts(provider).into_iter().find(|a| a.id == id)
}

/// True for the dir of the `default` account. Claude must run with no `CLAUDE_CONFIG_DIR` there:
/// with it set, Claude reads `$dir/.claude.json` instead of `~/.claude.json` and looks signed out.
pub fn is_default(dir: &Path) -> bool {
    dir == crate::paths::claude_dir()
}

/// Dirs named by `key` in the RAW login shell (what the user chose, before Lotus blanks it for
/// agents) and in this process, like `trust_reconciler::env_dirs`. Production only: tests pass
/// their own list so none of them spawns a login shell.
pub fn env_dirs(key: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [crate::shell_env::raw_login_var(key), std::env::var(key).ok()]
        .into_iter()
        .flatten()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    dirs.dedup();
    dirs
}

pub fn claude_accounts() -> Vec<Account> {
    claude_accounts_in(&crate::paths::home_dir(), &crate::paths::lotus_state_dir(), &env_dirs("CLAUDE_CONFIG_DIR"))
}

pub fn find(id: &str) -> Option<Account> {
    claude_accounts().into_iter().find(|a| a.id == id)
}

pub fn codex_accounts() -> Vec<Account> {
    codex_accounts_in(&crate::paths::home_dir(), &crate::paths::lotus_state_dir(), &env_dirs("CODEX_HOME"))
}

pub fn claude_accounts_in(home: &Path, state_dir: &Path, env_dirs: &[PathBuf]) -> Vec<Account> {
    let mut out = vec![plain(DEFAULT, Source::Default, home.join(".claude"), home.join(".claude.json"))];
    for (source, prefix, root) in [
        (Source::Ccs, "ccs", home.join(".ccs/instances")),
        (Source::Lotus, "lotus", state_dir.join("accounts/claude")),
    ] {
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            // A Lotus folder is an account from the moment Lotus makes it, so it can show "Sign in".
            .filter(|p| p.join(".claude.json").is_file() || (source == Source::Lotus && p.is_dir()))
            .collect();
        dirs.sort();
        for dir in dirs {
            let config = dir.join(".claude.json");
            push(&mut out, source, prefix, dir, config);
        }
    }
    for dir in env_dirs.iter().filter(|d| d.is_dir()) {
        let config = dir.join(".claude.json");
        push(&mut out, Source::Env, "env", dir.clone(), config);
    }
    sorted(out)
}

pub fn codex_accounts_in(home: &Path, state_dir: &Path, env_dirs: &[PathBuf]) -> Vec<Account> {
    let mut out = vec![plain(DEFAULT, Source::Default, home.join(".codex"), home.join(".codex/config.toml"))];
    let mut dirs: Vec<PathBuf> =
        std::fs::read_dir(state_dir.join("accounts/codex")).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for dir in dirs {
        let config = dir.join("config.toml");
        push(&mut out, Source::Lotus, "lotus", dir, config);
    }
    for dir in env_dirs.iter().filter(|d| d.is_dir()) {
        let config = dir.join("config.toml");
        push(&mut out, Source::Env, "env", dir.clone(), config);
    }
    sorted(out)
}

// ── Accounts made by Lotus (PLAN step 4) ──────────────────────────────────────────────────────

/// Who an account is signed in as, from its state file's `oauthAccount`; `None` = not signed in.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Identity {
    pub email: String,
    pub org: Option<String>,
}

/// Read where an account is shown (Settings, the usage fetch), never per spawn: the state file is
/// 100–200 KB. No secret is read; the token lives in the keychain or `.credentials.json`.
pub fn identity(account: &Account) -> Option<Identity> {
    if account.config_file.ends_with("config.toml") {
        return codex_identity(&account.dir);
    }
    let text = std::fs::read_to_string(&account.config_file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let oauth = json.get("oauthAccount")?;
    Some(Identity {
        email: oauth.get("emailAddress")?.as_str()?.to_string(),
        org: oauth.get("organizationName").and_then(|v| v.as_str()).map(str::to_string),
    })
}

/// Codex keeps its login in `<CODEX_HOME>/auth.json`; who it is lives in the `id_token` JWT. The
/// token is only decoded, never sent. An API-key login has no person, so it reads as "API key".
pub fn codex_identity(dir: &Path) -> Option<Identity> {
    use base64::Engine;
    let auth: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("auth.json")).ok()?).ok()?;
    if auth.get("OPENAI_API_KEY").and_then(|v| v.as_str()).is_some_and(|k| !k.is_empty()) {
        return Some(Identity { email: "API key".into(), org: None });
    }
    let payload = auth.pointer("/tokens/id_token")?.as_str()?.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let plan = claims.pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type").and_then(|v| v.as_str());
    Some(Identity {
        email: claims.get("email")?.as_str()?.to_string(),
        org: plan.filter(|p| !p.is_empty()).map(|p| {
            // `self_serve_business_usage_based` is what a Business seat reports (seen 2026-11-19).
            let p = if p.contains("business") { "business".to_string() } else { p.replace('_', " ") };
            format!("ChatGPT {}{}", p[..1].to_uppercase(), &p[1..])
        }),
    })
}

/// A new, empty config dir under `<state>/accounts/claude/<name>`. Signing in is the CLI's own
/// (`login_command`), so Lotus never sees a password or token.
pub fn create(provider: Provider, name: &str, isolated: bool) -> Result<Account, String> {
    create_in(&crate::paths::home_dir(), &crate::paths::lotus_state_dir(), provider, name, isolated)
}

/// `isolated`: its own config and context; otherwise linked to `~/.claude` (`account_context`).
/// Claude only: a Codex home has nothing to share, so it is always its own.
pub fn create_in(home: &Path, state_dir: &Path, provider: Provider, name: &str, isolated: bool) -> Result<Account, String> {
    let valid = name.len() <= 32
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !valid {
        return Err("use lowercase letters, digits, - or _ (up to 32), starting with a letter or digit".into());
    }
    // A taken name would be listed as `lotus-<name>`, which reads as a different account.
    if accounts_in(provider, home, state_dir, &[]).iter().any(|a| a.id == name) {
        return Err(format!("an account named {name} already exists"));
    }
    let dir = state_dir.join("accounts").join(provider.folder()).join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    if provider == Provider::Codex {
        Ok(())
    } else if isolated {
        crate::account_context::mark_isolated(&dir)
    } else {
        crate::account_context::keep(&home.join(".claude"), &dir)
    }
    .map_err(|e| format!("could not set up {}: {e}", dir.display()))?;
    accounts_in(provider, home, state_dir, &[]).into_iter().find(|a| a.dir == dir).ok_or_else(|| "created, but not listed".into())
}

/// What `remove` did: a hidden account keeps its folder and login, a deleted one has neither.
#[derive(Debug, PartialEq)]
pub enum Removal {
    Hidden(Account),
    Deleted(Account),
}

/// Settings › Accounts › Delete / Remove. A Lotus-made account is deleted. A ccs or env account is
/// hidden from every list, unless `purge` (ccs only) deletes its folder too. The keychain item goes
/// with a deleted folder: it is keyed by the folder's path, so nothing could ever use it again.
pub fn remove(provider: Provider, id: &str, purge: bool) -> Result<Removal, String> {
    let in_use = in_use_dir(provider);
    let env = env_dirs(provider.env_key());
    let busy = |dir: &Path| busy_processes(provider.env_key(), dir);
    let removal = remove_in(&crate::paths::home_dir(), &crate::paths::lotus_state_dir(), provider, &env, id, &in_use, purge, busy)?;
    #[cfg(target_os = "macos")]
    if let (Provider::Claude, Removal::Deleted(account)) = (provider, &removal) {
        // Ignored when absent (never signed in). `/usr/bin/security` wrote it, so no prompt.
        let _ = std::process::Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", &crate::usage::keychain_services(&account.dir, false)[0]])
            .output();
    }
    Ok(removal)
}

/// `in_use`: the dir new work starts on, which is never removed. `busy`: processes running on a dir
/// (`busy_processes`), so a folder an agent is using is never deleted under it.
#[allow(clippy::too_many_arguments)]
pub fn remove_in(
    home: &Path,
    state_dir: &Path,
    provider: Provider,
    env: &[PathBuf],
    id: &str,
    in_use: &Path,
    purge: bool,
    busy: impl Fn(&Path) -> Vec<String>,
) -> Result<Removal, String> {
    let account =
        accounts_in(provider, home, state_dir, env).into_iter().find(|a| a.id == id).ok_or_else(|| format!("no account named {id}"))?;
    if account.source == Source::Default {
        return Err(format!("default is {}'s own login (~/.{}); sign out instead", provider.name(), provider.folder()));
    }
    if account.dir == in_use {
        return Err(format!("{id} is the default for new work; make another account the default first"));
    }
    let delete = match account.source {
        Source::Lotus => true,
        Source::Ccs => purge,
        // The login shell still names it, and it can be any folder the user picked.
        Source::Env if purge => return Err(format!("{id} comes from {} in your shell; Lotus can only hide it", provider.env_key())),
        _ => false,
    };
    if !delete {
        set_hidden_in(state_dir, &account.dir, true)?;
        return Ok(Removal::Hidden(account));
    }
    let running = busy(&account.dir);
    if !running.is_empty() {
        return Err(format!("still running on {id}: {}; close them first", running.join(", ")));
    }
    // Never follows a link (a shared account's `projects` points into ~/.claude): only the link goes.
    std::fs::remove_dir_all(&account.dir).map_err(|e| format!("could not remove {}: {e}", account.dir.display()))?;
    set_hidden_in(state_dir, &account.dir, false)?;
    Ok(Removal::Deleted(account))
}

/// Shows a hidden account again.
pub fn unhide(provider: Provider, id: &str) -> Result<(), String> {
    let account = find_for(provider, id).ok_or_else(|| format!("no account named {id}"))?;
    set_hidden_in(&crate::paths::lotus_state_dir(), &account.dir, false)
}

// ── Hidden accounts ("Remove from Lotus") ─────────────────────────────────────────────────────
// Kept by folder, not id: an id can change (`ccs-<name>` after a clash), the folder does not.

fn hidden_file(state_dir: &Path) -> PathBuf {
    state_dir.join("claude-accounts-hidden.json")
}

pub fn hidden_dirs() -> Vec<PathBuf> {
    hidden_in(&crate::paths::lotus_state_dir())
}

pub fn hidden_in(state_dir: &Path) -> Vec<PathBuf> {
    crate::json::read_json::<Vec<PathBuf>>(&hidden_file(state_dir)).unwrap_or_default()
}

fn set_hidden_in(state_dir: &Path, dir: &Path, hidden: bool) -> Result<(), String> {
    let mut dirs = hidden_in(state_dir);
    let had = dirs.iter().any(|d| d == dir);
    if hidden == had {
        return Ok(());
    }
    if hidden {
        dirs.push(dir.to_path_buf());
    } else {
        dirs.retain(|d| d != dir);
    }
    crate::json::write_json(&hidden_file(state_dir), &dirs).map_err(|e| e.to_string())
}

/// What deleting an account's folder would touch, for the confirm in Settings.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalCheck {
    /// `<pid> <name>` of each process running with this account's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.
    pub running: Vec<String>,
    /// The folder keeps its own chat history (a real `projects` folder, not a link into ~/.claude),
    /// so deleting it loses chats that exist nowhere else.
    pub own_history: bool,
}

pub fn removal_check(provider: Provider, id: &str) -> Result<RemovalCheck, String> {
    let account = find_for(provider, id).ok_or_else(|| format!("no account named {id}"))?;
    // Codex keeps its chats in `sessions`, Claude in `projects`.
    let history = if provider == Provider::Codex { "sessions" } else { "projects" };
    Ok(RemovalCheck { running: busy_processes(provider.env_key(), &account.dir), own_history: own_history(&account.dir, history) })
}

/// The dir new work of `provider` starts on, which is never removed.
pub fn in_use_dir(provider: Provider) -> PathBuf {
    match provider {
        Provider::Claude => crate::settings::spawned_agent_claude_dir(),
        Provider::Codex => crate::usage::spawned_codex_dir(),
    }
}

fn own_history(dir: &Path, folder: &str) -> bool {
    let projects = dir.join(folder);
    projects.symlink_metadata().is_ok_and(|m| m.is_dir()) && std::fs::read_dir(&projects).is_ok_and(|mut e| e.next().is_some())
}

/// Processes of this user whose environment names `dir` as `key` (`CLAUDE_CONFIG_DIR`), as `<pid> <name>`.
/// `ps -E` prints each process's environment after its command (same user only, no prompt).
// shortcut: macOS only (`ps -E`); elsewhere nothing is reported, so a delete is not blocked there.
pub fn busy_processes(key: &str, dir: &Path) -> Vec<String> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    let output = std::process::Command::new("/bin/ps")
        .args(["-Eww", "-x", "-o", "pid=,command="])
        // So ps's own environment cannot match.
        .env_remove(key)
        .output();
    let Ok(output) = output else { return Vec::new() };
    running_on(&String::from_utf8_lossy(&output.stdout), key, dir, std::process::id())
}

/// Lines of `ps -E` output that carry `<key>=<dir>` as a whole value, minus `own_pid`.
fn running_on(ps: &str, key: &str, dir: &Path, own_pid: u32) -> Vec<String> {
    let dir = dir.to_string_lossy();
    let dir = dir.trim_end_matches('/');
    let needle = format!("{key}={dir}");
    ps.lines()
        // A GUI app (a browser the sign-in pane opened) inherits the pane's env but never runs an agent.
        .filter(|line| !line.contains(".app/Contents/"))
        .filter(|line| {
            line.match_indices(&needle).any(|(at, _)| {
                let rest = &line[at + needle.len()..];
                rest.is_empty() || rest.starts_with(' ') || rest.starts_with("/ ") || rest == "/"
            })
        })
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?;
            let name = parts.next().map(|p| p.rsplit('/').next().unwrap_or(p)).unwrap_or("?");
            (pid.parse::<u32>().ok()? != own_pid).then(|| format!("{pid} {name}"))
        })
        .collect()
}

/// One row of Settings › Accounts.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub id: String,
    /// `default`, `env`, `ccs` or `lotus`: where Lotus found it.
    pub source: &'static str,
    pub dir: String,
    pub identity: Option<Identity>,
    /// New chats and terminals start on it (the chosen account, else what the login shell names).
    pub in_use: bool,
    pub login_command: String,
    /// `shared` or `isolated` for a Lotus-made account; the others are not Lotus's to link.
    pub context: Option<&'static str>,
    /// Removed from Lotus: shown only in Settings, under "hidden", so it can come back.
    pub hidden: bool,
}

/// `signed_in`: the dir holds a Claude login (`usage::has_claude_login`). Without one, the state
/// file's `oauthAccount` is a leftover (e.g. `~/.claude.json` after only an MCP sign-in), not who runs.
pub fn view(provider: Provider, account: &Account, in_use: &Path, signed_in: bool) -> AccountView {
    AccountView {
        id: account.id.clone(),
        source: match account.source {
            Source::Default => "default",
            Source::Env => "env",
            Source::Ccs => "ccs",
            Source::Lotus => "lotus",
        },
        dir: account.dir.to_string_lossy().into_owned(),
        identity: identity(account).filter(|_| signed_in),
        in_use: account.dir == in_use,
        login_command: login_command(provider, account),
        context: (provider == Provider::Claude && account.source == Source::Lotus)
            .then(|| if crate::account_context::is_isolated(&account.dir) { "isolated" } else { "shared" }),
        hidden: false,
    }
}

/// Every account of `provider` for Settings; reads each state file and login, so only when Settings asks. Blocking.
pub fn views(provider: Provider) -> Vec<AccountView> {
    let in_use = in_use_dir(provider);
    let hidden = hidden_dirs();
    accounts(provider)
        .iter()
        .map(|a| {
            // Codex: a readable `auth.json` is the login, so `identity` itself answers.
            let signed_in = provider == Provider::Codex || crate::usage::has_claude_login(&a.dir, a.id == DEFAULT);
            AccountView { hidden: hidden.contains(&a.dir), ..view(provider, a, &in_use, signed_in) }
        })
        .collect()
}

/// What a terminal pane runs to sign `account` in. Panes inherit the chosen account's
/// `CLAUDE_CONFIG_DIR`, so `default` must unset it rather than leave it out.
// shortcut: POSIX shells only (`env -u`, `VAR=… cmd`); Windows gets this text to copy until a PowerShell form exists.
pub fn login_command(provider: Provider, account: &Account) -> String {
    let (key, login) = match provider {
        Provider::Claude => ("CLAUDE_CONFIG_DIR", "claude auth login"),
        Provider::Codex => ("CODEX_HOME", "codex login"),
    };
    if account.id == DEFAULT {
        return format!("env -u {key} {login}");
    }
    let dir = account.dir.to_string_lossy().replace('\'', r"'\''");
    format!("{key}='{dir}' {login}")
}

// ── One login per Mac user (Antigravity) ───────────────────────────────────────────────────────

/// A CLI that keeps one login per Mac user, so Settings shows who it is and never offers Add.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleLogin {
    pub signed_in: bool,
    pub email: Option<String>,
    pub login_command: String,
}

/// `agy` keeps its login in the Keychain as `gemini` / `antigravity`, a fixed name no env var moves
/// (probed 2026-11-19 with `ANTIGRAVITY_EXECUTABLE_DATA_DIR` and `ANTIGRAVITY_CONFIG_REL_DIR`).
/// `None` when `agy` is not installed. No secret is read: the lookup has no `-w`. Blocking.
pub fn antigravity_login() -> Option<SingleLogin> {
    crate::cli_detect::find_executable("agy")?;
    let signed_in = cfg!(target_os = "macos")
        && std::process::Command::new("/usr/bin/security")
            .args(["find-generic-password", "-s", "gemini", "-a", "antigravity"])
            .output()
            .is_ok_and(|o| o.status.success());
    let logs = crate::paths::home_dir().join(".gemini/antigravity-cli/log");
    Some(SingleLogin { signed_in, email: signed_in.then(|| last_agy_email(&logs)).flatten(), login_command: "agy".into() })
}

/// The newest "authenticated successfully as <email>" line in agy's own logs.
// shortcut: agy offers no `status` command; if every recent log lacks the line, the row says only "Signed in".
fn last_agy_email(log_dir: &Path) -> Option<String> {
    let mut logs: Vec<PathBuf> = std::fs::read_dir(log_dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("cli-")))
        .collect();
    logs.sort();
    logs.iter().rev().take(20).find_map(|log| {
        let text = std::fs::read_to_string(log).ok()?;
        text.lines().rev().find_map(|l| l.split_once("authenticated successfully as ").map(|(_, e)| e.trim().to_string()))
    })
}

/// Adds `dir` under its folder name, or `<prefix>-<name>` when that id is taken (a ccs instance
/// called `default` is `ccs-default`, never dropped). An env dir that is the same directory as a
/// listed account adds nothing: the listed one keeps its own, more specific, source.
fn push(out: &mut Vec<Account>, source: Source, prefix: &str, dir: PathBuf, config_file: PathBuf) {
    let same = |a: &Path, b: &Path| a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y);
    if out.iter().any(|a| same(&a.dir, &dir)) {
        return;
    }
    let name = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let id = if out.iter().any(|a| a.id == name) { format!("{prefix}-{name}") } else { name };
    out.push(plain(&id, source, dir, config_file));
}

fn sorted(mut accounts: Vec<Account>) -> Vec<Account> {
    // `default` is first; the rest by id.
    accounts.sort_by(|a, b| (a.id != DEFAULT, &a.id).cmp(&(b.id != DEFAULT, &b.id)));
    accounts
}

fn plain(id: &str, source: Source, dir: PathBuf, config_file: PathBuf) -> Account {
    Account { id: id.into(), source, dir, config_file }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marked(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(".claude.json"), "{}").unwrap();
    }

    fn ids(accounts: &[Account]) -> Vec<&str> {
        accounts.iter().map(|a| a.id.as_str()).collect()
    }

    #[test]
    fn without_ccs_the_list_is_the_default_login() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let claude = claude_accounts_in(home.path(), &state, &[]);
        assert_eq!(ids(&claude), ["default"]);
        assert_eq!(claude[0].source, Source::Default);
        assert_eq!(claude[0].dir, home.path().join(".claude"));
        assert_eq!(claude[0].config_file, home.path().join(".claude.json"));
        assert_eq!(ids(&codex_accounts_in(home.path(), &home.path().join("state"), &[])), ["default"]);
    }

    #[test]
    fn unmarked_folders_are_skipped_and_name_clashes_get_a_prefix() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        for name in ["b", "a", "default"] {
            marked(&home.path().join(".ccs/instances").join(name));
        }
        std::fs::create_dir_all(home.path().join(".ccs/instances/unmarked")).unwrap();
        marked(&state.join("accounts/claude/work"));
        marked(&state.join("accounts/claude/a"));

        let accounts = claude_accounts_in(home.path(), &state, &[]);
        assert_eq!(ids(&accounts), ["default", "a", "b", "ccs-default", "lotus-a", "work"]);
        let source = |id: &str| accounts.iter().find(|a| a.id == id).unwrap().source;
        assert_eq!((source("ccs-default"), source("lotus-a"), source("work")), (Source::Ccs, Source::Lotus, Source::Lotus));
    }

    #[test]
    fn env_inside_ccs_is_one_ccs_entry_and_env_elsewhere_is_an_env_entry() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let acme = home.path().join(".ccs/instances/acme");
        marked(&acme);

        let accounts = claude_accounts_in(home.path(), &state, &[acme.clone()]);
        assert_eq!(ids(&accounts), ["default", "acme"]);
        assert_eq!(accounts[1].source, Source::Ccs);

        let elsewhere = home.path().join("cfg/work");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let accounts = claude_accounts_in(home.path(), &state, &[elsewhere]);
        assert_eq!(ids(&accounts), ["default", "acme", "work"]);
        assert_eq!(accounts[2].source, Source::Env);

        // A missing dir is no account; a clash with a listed id gets the prefix.
        assert_eq!(claude_accounts_in(home.path(), &state, &[home.path().join("nope")]).len(), 2);
        let clash = home.path().join("cfg/acme");
        std::fs::create_dir_all(&clash).unwrap();
        let accounts = claude_accounts_in(home.path(), &state, &[clash]);
        assert_eq!(ids(&accounts), ["default", "acme", "env-acme"]);
    }

    #[test]
    fn env_pointing_at_the_default_dir_adds_nothing() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".claude");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(ids(&claude_accounts_in(home.path(), &home.path().join("s"), &[dir])), ["default"]);
    }

    #[test]
    fn a_new_lotus_account_is_listed_before_it_signs_in() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let created = create_in(home.path(), &state, Provider::Claude, "client-x", false).unwrap();
        assert_eq!(created.id, "client-x");
        assert_eq!(created.source, Source::Lotus);
        assert_eq!(created.dir, state.join("accounts/claude/client-x"));
        assert!(created.dir.is_dir());
        assert_eq!(ids(&claude_accounts_in(home.path(), &state, &[])), ["default", "client-x"]);
    }

    #[test]
    fn create_refuses_bad_or_taken_names() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        marked(&home.path().join(".ccs/instances/acme"));
        for bad in ["", "default", "acme", "Has Space", "../up", "-dash", "x".repeat(33).as_str()] {
            assert!(create_in(home.path(), &state, Provider::Claude, bad, false).is_err(), "{bad:?} must be refused");
        }
        assert!(create_in(home.path(), &state, Provider::Claude, "ok_name-2", false).is_ok());
        assert!(create_in(home.path(), &state, Provider::Claude, "ok_name-2", false).is_err(), "taken now");
    }

    fn idle(_: &Path) -> Vec<String> {
        Vec::new()
    }

    /// `remove_in` with nothing running and `~/.claude` as the default for new work.
    fn rm(home: &Path, state: &Path, id: &str, purge: bool) -> Result<Removal, String> {
        remove_in(home, state, Provider::Claude, &[], id, &home.join(".claude"), purge, idle)
    }

    #[test]
    fn a_lotus_account_is_deleted_and_a_ccs_account_is_only_hidden() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let acme = home.path().join(".ccs/instances/acme");
        marked(&acme);
        let made = create_in(home.path(), &state, Provider::Claude, "temp", false).unwrap();

        assert!(rm(home.path(), &state, DEFAULT, true).is_err(), "~/.claude is Claude's own");
        assert!(rm(home.path(), &state, "nope", false).is_err());
        assert!(matches!(rm(home.path(), &state, "temp", false), Ok(Removal::Deleted(a)) if a.dir == made.dir));
        assert!(!made.dir.exists());

        assert!(matches!(rm(home.path(), &state, "acme", false), Ok(Removal::Hidden(_))));
        assert!(acme.is_dir(), "hiding touches no file");
        assert_eq!(hidden_in(&state), [acme.clone()]);
        assert!(rm(home.path(), &state, "acme", false).is_ok(), "hiding twice is fine");
        assert_eq!(hidden_in(&state).len(), 1);
    }

    #[test]
    fn purge_deletes_a_ccs_folder_and_forgets_that_it_was_hidden() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let globex = home.path().join(".ccs/instances/globex");
        marked(&globex);
        rm(home.path(), &state, "globex", false).unwrap();
        assert!(matches!(rm(home.path(), &state, "globex", true), Ok(Removal::Deleted(_))));
        assert!(!globex.exists());
        assert!(hidden_in(&state).is_empty());
    }

    #[test]
    fn the_default_for_new_work_and_a_busy_folder_are_never_removed() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let acme = home.path().join(".ccs/instances/acme");
        marked(&acme);
        let err = remove_in(home.path(), &state, Provider::Claude, &[], "acme", &acme, false, idle).unwrap_err();
        assert!(err.contains("make another account the default"), "{err}");

        let busy = |_: &Path| vec!["48770 claude".to_string()];
        let err = remove_in(home.path(), &state, Provider::Claude, &[], "acme", &home.path().join(".claude"), true, busy).unwrap_err();
        assert!(err.contains("48770 claude"), "{err}");
        assert!(acme.is_dir());
        // Hiding only is fine while it runs: nothing is taken away from the running agent.
        assert!(remove_in(home.path(), &state, Provider::Claude, &[], "acme", &home.path().join(".claude"), false, busy).is_ok());
    }

    #[test]
    fn an_env_account_can_be_hidden_but_never_purged() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let work = home.path().join("cfg/work");
        std::fs::create_dir_all(&work).unwrap();
        let env = [work.clone()];
        let err = remove_in(home.path(), &state, Provider::Claude, &env, "work", &home.path().join(".claude"), true, idle).unwrap_err();
        assert!(err.contains("can only hide"), "{err}");
        assert!(matches!(remove_in(home.path(), &state, Provider::Claude, &env, "work", &home.path().join(".claude"), false, idle), Ok(Removal::Hidden(_))));
        assert!(work.is_dir());
    }

    #[test]
    fn ps_lines_match_the_whole_config_dir_only() {
        let ps = "\
  48770 /Users/a/.local/bin/claude --resume x TERM=xterm CLAUDE_CONFIG_DIR=/u/.ccs/instances/acme HOME=/u
  48771 node x.js CLAUDE_CONFIG_DIR=/u/.ccs/instances/acme2 HOME=/u
  48772 bun run CLAUDE_CONFIG_DIR=/u/.ccs/instances/acme/
  900 lotus CLAUDE_CONFIG_DIR=/u/.ccs/instances/acme
  60933 /Applications/Dia.app/Contents/MacOS/Dia OSLogRateLimit=64 CLAUDE_CONFIG_DIR=/u/.ccs/instances/acme HOME=/u";
        let dir = Path::new("/u/.ccs/instances/acme");
        assert_eq!(running_on(ps, "CLAUDE_CONFIG_DIR", dir, 900), ["48770 claude", "48772 bun"]);
        assert!(running_on("", "CLAUDE_CONFIG_DIR", dir, 1).is_empty());
    }

    #[test]
    fn own_history_is_a_real_projects_folder_with_something_in_it() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("acct");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!own_history(&dir, "projects"));
        std::fs::create_dir_all(home.path().join("shared/p1")).unwrap();
        std::os::unix::fs::symlink(home.path().join("shared"), dir.join("projects")).unwrap();
        assert!(!own_history(&dir, "projects"), "a link into ~/.claude is not this folder's own");
        std::fs::remove_file(dir.join("projects")).unwrap();
        std::fs::create_dir_all(dir.join("projects")).unwrap();
        assert!(!own_history(&dir, "projects"), "empty");
        std::fs::create_dir_all(dir.join("projects/-Users-a-x")).unwrap();
        assert!(own_history(&dir, "projects"));
    }

    #[test]
    fn the_login_command_names_the_dir_or_unsets_it_for_default() {
        let named = plain("o'brien", Source::Lotus, PathBuf::from("/s/accounts/claude/o'brien"), PathBuf::new());
        assert_eq!(login_command(Provider::Claude, &named), r#"CLAUDE_CONFIG_DIR='/s/accounts/claude/o'\''brien' claude auth login"#);
        let default = plain(DEFAULT, Source::Default, PathBuf::from("/h/.claude"), PathBuf::new());
        assert_eq!(login_command(Provider::Claude, &default), "env -u CLAUDE_CONFIG_DIR claude auth login");
    }

    #[test]
    fn identity_comes_from_the_state_file() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join(".claude.json");
        let account = plain("a", Source::Ccs, home.path().to_path_buf(), file.clone());
        assert_eq!(identity(&account), None, "no file: not signed in");
        std::fs::write(&file, r#"{"oauthAccount":{"emailAddress":"me@example.com","organizationName":"Acme","accountUuid":"u1"}}"#).unwrap();
        assert_eq!(
            identity(&account),
            Some(Identity { email: "me@example.com".into(), org: Some("Acme".into()) })
        );
        std::fs::write(&file, r#"{"projects":{}}"#).unwrap();
        assert_eq!(identity(&account), None, "a file without oauthAccount is not signed in");
    }

    #[test]
    fn a_settings_row_says_where_it_came_from_and_whether_it_is_in_use() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let made = create_in(home.path(), &state, Provider::Claude, "x", false).unwrap();
        let row = view(Provider::Claude, &made, &made.dir, false);
        assert_eq!((row.id.as_str(), row.source, row.in_use, row.identity), ("x", "lotus", true, None));
        assert!(row.login_command.ends_with("claude auth login"));
        assert!(!view(Provider::Claude, &made, &home.path().join(".claude"), false).in_use);
    }

    #[test]
    fn an_identity_without_a_login_is_not_shown() {
        let home = tempfile::tempdir().unwrap();
        let made = create_in(home.path(), &home.path().join("state"), Provider::Claude, "x", false).unwrap();
        std::fs::write(&made.config_file, r#"{"oauthAccount":{"emailAddress":"a@b.c"}}"#).unwrap();
        assert_eq!(view(Provider::Claude, &made, &made.dir, false).identity, None);
        assert_eq!(view(Provider::Claude, &made, &made.dir, true).identity.map(|i| i.email), Some("a@b.c".to_string()));
    }

    #[test]
    fn a_new_account_shares_context_unless_made_isolated_and_removing_it_keeps_the_shared_dir() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let shared = create_in(home.path(), &state, Provider::Claude, "a", false).unwrap();
        let isolated = create_in(home.path(), &state, Provider::Claude, "b", true).unwrap();
        assert_eq!(std::fs::read_link(shared.dir.join("projects")).unwrap(), home.path().join(".claude/projects"));
        assert!(!isolated.dir.join("projects").exists());
        let in_use = home.path().join(".claude");
        assert_eq!(view(Provider::Claude, &shared, &in_use, false).context, Some("shared"));
        assert_eq!(view(Provider::Claude, &isolated, &in_use, false).context, Some("isolated"));
        assert_eq!(view(Provider::Claude, &claude_accounts_in(home.path(), &state, &[])[0], &in_use, false).context, None);

        std::fs::write(home.path().join(".claude/projects/kept.jsonl"), "x").unwrap();
        rm(home.path(), &state, "a", false).unwrap();
        assert!(home.path().join(".claude/projects/kept.jsonl").is_file(), "a link is removed, never what it points to");
    }

    #[test]
    fn codex_env_is_listed() {
        let home = tempfile::tempdir().unwrap();
        let codex = home.path().join("codex-alt");
        std::fs::create_dir_all(&codex).unwrap();
        let accounts = codex_accounts_in(home.path(), &home.path().join("state"), &[codex.clone()]);
        assert_eq!(ids(&accounts), ["default", "codex-alt"]);
        assert_eq!(accounts[1].config_file, codex.join("config.toml"));
    }

    #[test]
    fn codex_accounts_made_by_lotus_are_listed_removed_and_signed_in_via_codex_home() {
        use base64::Engine;
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        let made = create_in(home.path(), &state, Provider::Codex, "work", true).unwrap();
        assert_eq!(made.dir, state.join("accounts/codex/work"));
        assert!(!made.dir.join(".claude-isolated").exists() && std::fs::read_dir(&made.dir).unwrap().next().is_none(), "nothing linked");
        assert_eq!(ids(&codex_accounts_in(home.path(), &state, &[])), ["default", "work"]);
        assert!(create_in(home.path(), &state, Provider::Codex, "work", false).is_err(), "taken");
        assert_eq!(login_command(Provider::Codex, &made), format!("CODEX_HOME='{}' codex login", made.dir.display()));

        assert_eq!(codex_identity(&made.dir), None, "not signed in");
        let claims = serde_json::json!({"email": "a@b.c", "https://api.openai.com/auth": {"chatgpt_plan_type": "plus"}});
        let jwt = format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string()));
        std::fs::write(made.dir.join("auth.json"), serde_json::json!({"OPENAI_API_KEY": null, "tokens": {"id_token": jwt}}).to_string()).unwrap();
        assert_eq!(identity(&made), Some(Identity { email: "a@b.c".into(), org: Some("ChatGPT Plus".into()) }));
        let claims = serde_json::json!({"email": "a@b.c", "https://api.openai.com/auth": {"chatgpt_plan_type": "self_serve_business_usage_based"}});
        let jwt = format!("x.{}.y", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string()));
        std::fs::write(made.dir.join("auth.json"), serde_json::json!({"tokens": {"id_token": jwt}}).to_string()).unwrap();
        assert_eq!(identity(&made).and_then(|i| i.org), Some("ChatGPT Business".into()));

        let idle = |_: &Path| Vec::new();
        let err = remove_in(home.path(), &state, Provider::Codex, &[], "default", Path::new("/x"), false, idle).unwrap_err();
        assert!(err.contains("Codex's own login"), "{err}");
        assert!(matches!(remove_in(home.path(), &state, Provider::Codex, &[], "work", Path::new("/x"), false, idle), Ok(Removal::Deleted(_))));
        assert!(!made.dir.exists());
    }

    #[test]
    fn the_antigravity_email_is_the_newest_sign_in_in_its_logs() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(last_agy_email(dir.path()), None);
        let line = |e: &str| format!("I1119 server_oauth.go:226] OAuth: authenticated successfully as {e}\n");
        std::fs::write(dir.path().join("cli-20261118_1.log"), line("old@x.io")).unwrap();
        std::fs::write(dir.path().join("cli-20261119_1.log"), format!("{}{}", line("a@x.io"), line("b@x.io"))).unwrap();
        std::fs::write(dir.path().join("cli-20261119_2.log"), "nothing here\n").unwrap();
        assert_eq!(last_agy_email(dir.path()).as_deref(), Some("b@x.io"));
    }

    #[test]
    fn codex_busy_check_matches_codex_home() {
        let ps = "10 /bin/codex CODEX_HOME=/s/accounts/codex/w X=1\n11 /bin/claude CLAUDE_CONFIG_DIR=/s/accounts/codex/w";
        assert_eq!(running_on(ps, "CODEX_HOME", Path::new("/s/accounts/codex/w"), 1), ["10 codex"]);
    }
}
