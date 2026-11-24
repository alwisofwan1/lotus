//! Subscription limits per account: every Claude login (see `accounts.rs`) plus the Codex login.
//!
//! Claude: `GET /api/oauth/usage` with each account's own OAuth token. The endpoint is
//! undocumented (verified 2026-11-01, `plans/subscription-usage/claude-oauth-usage.fixture.json`);
//! we read its `limits[]` list, the one the server itself draws, so new limit kinds show up
//! without a code change. Codex: the newest `rate_limits` snapshot the CLI wrote into its own
//! session files — no token needed, as fresh as the last Codex turn.
//!
//! Lotus never refreshes an expired Claude token: refreshing rotates the refresh token the CLI
//! also holds, which would log that account out of the CLI. It reports "expired" instead.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const SESSION_MINUTES: u32 = 300;
const WEEK_MINUTES: u32 = 10_080;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageAccount {
    /// `claude` or `codex`.
    pub provider: &'static str,
    /// The ccs account name, or `ChatGPT` for Codex.
    pub account: String,
    /// `team`, `max`, `pro`, `plus`, … as the provider names it.
    pub plan: Option<String>,
    /// True for the Claude account new terminal agents run under (`CLAUDE_CONFIG_DIR`).
    pub in_use: bool,
    pub windows: Vec<UsageWindow>,
    /// Why `windows` is empty or old: expired token, no network, … Shown as-is.
    pub error: Option<String>,
    /// Set when `windows` are the last numbers saved, not fresh ones: when they were fetched.
    pub as_of_ms: Option<i64>,
    /// Who a Claude account is signed in as (email · organization); read with each fresh fetch.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<crate::accounts::Identity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// The provider's own name: `session`, `weekly_all`, `weekly_opus`, `primary`, …
    pub kind: String,
    /// `session` (5 h) or `weekly` (7 d): what the UI labels and paces by.
    pub group: String,
    pub used_percent: f64,
    /// Unix milliseconds; `None` when the window has not started.
    pub resets_at_ms: Option<i64>,
    pub window_minutes: u32,
    /// The model a scoped limit covers ("Fable" for `weekly_scoped`); `None` for account-wide ones.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// The usage endpoint answers 429 after a handful of calls (seen 2026-11-01), so each account is
/// asked at most once per [`CACHE_FOR`], and a 429 keeps showing the last good numbers.
const CACHE_FOR: Duration = Duration::from_secs(300);
const ERROR_CACHE_FOR: Duration = Duration::from_secs(60);
/// The access token lives ~8 h and only the CLI refreshes it (see the module doc), so an account
/// unused that long is still signed in — it just cannot be asked. Not a `sign-in` message on
/// purpose: `signedOut()` in ChatAccount.tsx would disable the account.
const IDLE: &str = "idle — not used in the last 8 h; numbers update on its next use";
const NOT_SIGNED_IN: &str = "not signed in";
const RATE_LIMITED: &str = "Anthropic is rate-limiting usage checks — try again in a few minutes";

type ClaudeCache = HashMap<String, (Instant, UsageAccount)>;
static CLAUDE_CACHE: Mutex<Option<ClaudeCache>> = Mutex::new(None);

/// One snapshot at a time. Code and Chat mode both keep a rail mounted, so two chips (four under
/// dev StrictMode) ask at once on start; without this they all missed the empty cache and fired
/// parallel requests per account, and the extras came back 429 (seen 2026-11-02).
static SNAPSHOT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn snapshot() -> Vec<UsageAccount> {
    let _one_at_a_time = SNAPSHOT_LOCK.lock().await;
    let in_use = crate::settings::spawned_agent_claude_dir();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().ok();
    let mut out = Vec::new();
    let hidden = crate::accounts::hidden_dirs();
    // A hidden account is out of every picker; Settings lists it from `accounts_list`.
    for found in crate::accounts::claude_accounts().into_iter().filter(|a| !hidden.contains(&a.dir)) {
        let identity = || crate::accounts::identity(&found);
        let (name, dir) = (found.id.clone(), found.dir.clone());
        let cached = CLAUDE_CACHE.lock().as_ref().and_then(|c| c.get(&name).cloned());
        let mut account = match cached {
            // An error is retried sooner: a re-login or a passing 429 should not stick for 5 min.
            Some((at, account)) if at.elapsed() < if account.error.is_some() { ERROR_CACHE_FOR } else { CACHE_FOR } => account,
            _ => {
                let mut fresh = claude_account(client.as_ref(), &name, &dir).await;
                fresh.identity = identity();
                let last_good = cached.map(|(_, a)| a).filter(|a| a.error.is_none());
                match last_good {
                    Some(mut good) if fresh.error.as_deref() == Some(RATE_LIMITED) => {
                        good.error = fresh.error.take();
                        fresh = good;
                    }
                    _ => {}
                }
                CLAUDE_CACHE.lock().get_or_insert_with(HashMap::new).insert(name.clone(), (Instant::now(), fresh.clone()));
                fresh
            }
        };
        account.in_use = same_dir(&dir, &in_use);
        if !hidden_unsigned_default(&account) {
            out.push(account);
        }
    }
    for codex in crate::accounts::codex_accounts() {
        let name = codex_label(&codex.id);
        match codex_account(&name, &codex.dir.join("sessions"), now_ms()) {
            Some(account) => out.push(account),
            // Signed in but never used: Codex writes its limits only into a finished turn.
            None if crate::accounts::codex_identity(&codex.dir).is_some() => out.push(UsageAccount {
                provider: "codex",
                account: name,
                plan: None,
                in_use: false,
                windows: Vec::new(),
                error: Some(NO_CODEX_NUMBERS.into()),
                as_of_ms: None,
                identity: crate::accounts::codex_identity(&codex.dir),
            }),
            None => {}
        }
    }
    out.extend(antigravity_account().await);
    out
}

const NO_CODEX_NUMBERS: &str = "no numbers yet — they appear after its first Codex turn";

// ── Antigravity (`agy -p /usage`) ─────────────────────────────────────────────────────────────
// `agy -p /usage --output-format json` answers in ~3.5 s with 0 tokens (probed 2026-11-20). One
// login per Mac (accounts::antigravity_login), so one entry, cached like a Claude account.

static AGY_CACHE: Mutex<Option<(Instant, UsageAccount)>> = Mutex::new(None);

async fn antigravity_account() -> Option<UsageAccount> {
    if let Some((at, account)) = AGY_CACHE.lock().clone() {
        if at.elapsed() < if account.error.is_some() { ERROR_CACHE_FOR } else { CACHE_FOR } {
            return Some(account);
        }
    }
    let login = tokio::task::spawn_blocking(crate::accounts::antigravity_login).await.ok()??;
    if !login.signed_in {
        return None;
    }
    let mut account = UsageAccount {
        provider: "antigravity",
        account: crate::accounts::DEFAULT.into(),
        plan: None,
        in_use: false,
        windows: Vec::new(),
        error: None,
        as_of_ms: None,
        identity: login.email.map(|email| crate::accounts::Identity { email, org: None }),
    };
    let path = crate::cli_detect::find_executable("agy")?;
    let run = tokio::process::Command::new(path)
        .args(["-p", "/usage", "--output-format", "json"])
        .current_dir(crate::paths::home_dir())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(Duration::from_secs(20), run).await {
        Ok(Ok(out)) => match serde_json::from_slice::<Value>(&out.stdout) {
            Ok(json) => account.windows = agy_windows(&json),
            Err(_) => account.error = Some("agy /usage gave no numbers".into()),
        },
        Ok(Err(e)) => account.error = Some(format!("could not run agy: {e}")),
        Err(_) => account.error = Some("agy /usage took over 20 s".into()),
    }
    AGY_CACHE.lock().replace((Instant::now(), account.clone()));
    Some(account)
}

/// Each group's bucket ("Gemini Models" → weekly 22% used), named by its group.
fn agy_windows(json: &Value) -> Vec<UsageWindow> {
    let groups = json.pointer("/command/data/groups").and_then(Value::as_array).cloned().unwrap_or_default();
    groups
        .iter()
        .flat_map(|g| {
            let scope = g.get("name").and_then(Value::as_str).unwrap_or("").trim_end_matches(" models").trim_end_matches(" Models").replace(" and ", " & ");
            g.get("buckets").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(move |b| {
                let weekly = b.get("window").and_then(Value::as_str) != Some("session");
                Some(UsageWindow {
                    kind: b.get("id")?.as_str()?.to_string(),
                    group: if weekly { "weekly" } else { "session" }.into(),
                    used_percent: ((1.0 - b.get("remaining_fraction")?.as_f64()?) * 100.0).clamp(0.0, 100.0),
                    resets_at_ms: b.get("reset_time").and_then(Value::as_str).and_then(rfc3339_utc_ms),
                    window_minutes: if weekly { 7 * 24 * 60 } else { SESSION_MINUTES },
                    scope: Some(scope.clone()),
                })
            })
        })
        .collect()
}

/// `2026-11-26T13:28:53Z` (UTC, what agy sends) → Unix ms. No offset or fraction support.
fn rfc3339_utc_ms(s: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    if s.len() != 20 || !s.ends_with('Z') {
        return None;
    }
    let (y, m, d) = (n(0..4)?, n(5..7)?, n(8..10)?);
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(((days * 24 + n(11..13)?) * 60 + n(14..16)?) * 60_000 + n(17..19)? * 1000)
}

/// A `default` login that was never signed in is noise in the popover (a machine that only uses
/// ccs). It stays in the account list, so it can still be picked.
fn hidden_unsigned_default(account: &UsageAccount) -> bool {
    account.account == crate::accounts::DEFAULT && !account.in_use && account.error.as_deref() == Some(NOT_SIGNED_IN)
}

// ── Which account new Lotus work runs as (PLAN step 3) ───────────────────────────────────────
// A Lotus-only choice in `<state dir>/claude-account.json`; ccs's own default is left alone.
// `default` is a valid value: it means no `CLAUDE_CONFIG_DIR` (see `accounts::is_default`).

#[derive(serde::Deserialize, Serialize)]
struct AccountFile {
    account: String,
}

pub fn account_file() -> PathBuf {
    crate::paths::lotus_state_dir().join("claude-account.json")
}

/// The account new chats and terminals run as, or `None` when nothing is chosen.
pub fn chosen_account() -> Option<crate::accounts::Account> {
    chosen_in(&account_file(), crate::accounts::claude_accounts)
}

pub fn chosen_claude_dir() -> Option<PathBuf> {
    chosen_account().map(|a| a.dir)
}

/// Codex's own choice, kept apart from Claude's: `<state dir>/codex-account.json`.
fn codex_account_file() -> PathBuf {
    crate::paths::lotus_state_dir().join("codex-account.json")
}

pub fn chosen_codex_account() -> Option<crate::accounts::Account> {
    chosen_in(&codex_account_file(), crate::accounts::codex_accounts)
}

pub fn set_codex_account(account: Option<String>) -> Result<(), String> {
    set_in(&codex_account_file(), crate::accounts::codex_accounts, account)
}

/// The `CODEX_HOME` new Codex work starts on: the chosen account, else the shell's, else `~/.codex`.
pub fn spawned_codex_dir() -> PathBuf {
    chosen_codex_account()
        .map(|a| a.dir)
        .or_else(|| crate::accounts::env_dirs("CODEX_HOME").into_iter().next())
        .unwrap_or_else(|| crate::paths::home_dir().join(".codex"))
}

/// Only an id that is a live account resolves, so a stale or edited file falls back safely.
/// `accounts` is not called when nothing is stored, so the common case lists nothing.
pub fn chosen_in(file: &Path, accounts: impl FnOnce() -> Vec<crate::accounts::Account>) -> Option<crate::accounts::Account> {
    let id = crate::json::read_json::<AccountFile>(&file.to_path_buf())?.account;
    accounts().into_iter().find(|a| a.id == id)
}

/// The dir of a live account, by id. Ids come from the webview and the chat store.
pub fn account_dir(id: &str) -> Option<PathBuf> {
    crate::accounts::find(id).map(|a| a.dir)
}

/// `None` clears the choice. The id comes from the webview, so it must be a known account.
pub fn set_claude_account(account: Option<String>) -> Result<(), String> {
    set_in(&account_file(), crate::accounts::claude_accounts, account)
}

fn set_in(file: &Path, accounts: impl FnOnce() -> Vec<crate::accounts::Account>, account: Option<String>) -> Result<(), String> {
    let Some(account) = account else {
        return match std::fs::remove_file(file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    };
    if !accounts().iter().any(|a| a.id == account) {
        return Err(format!("no account named {account}"));
    }
    crate::json::write_json(&file.to_path_buf(), &AccountFile { account }).map_err(|e| e.to_string())
}

async fn claude_account(client: Option<&reqwest::Client>, name: &str, dir: &Path) -> UsageAccount {
    let mut account = UsageAccount {
        provider: "claude",
        account: name.to_string(),
        plan: None,
        in_use: false,
        windows: Vec::new(),
        error: None,
        as_of_ms: None,
        identity: None,
    };
    let result = async {
        let creds = read_credentials(dir, name == crate::accounts::DEFAULT).await?;
        let oauth = creds.get("claudeAiOauth").ok_or(NOT_SIGNED_IN)?;
        account.plan = oauth.get("subscriptionType").and_then(Value::as_str).map(str::to_string);
        // A past `expiresAt` gets 429, not 401, from this endpoint (2026-11-02: globex −50 h and work
        // −1251 h → 429; acme and initech, valid → 200), so it is not worth a request. 0 means
        // "not recorded", which the server decides.
        if oauth.get("expiresAt").and_then(Value::as_i64).is_some_and(|at| at > 0 && at < now_ms()) {
            return Err(IDLE.to_string());
        }
        let token = oauth.get("accessToken").and_then(Value::as_str).ok_or(NOT_SIGNED_IN)?;
        let response = client
            .ok_or("no HTTP client")?
            .get(USAGE_URL)
            .bearer_auth(token)
            .header("anthropic-beta", "oauth-2025-04-20")
            .send()
            .await
            .map_err(|e| format!("network: {e}"))?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 => return Err("sign-in expired — open Claude on this account once".to_string()),
            429 => return Err(RATE_LIMITED.to_string()),
            code => return Err(format!("usage API: HTTP {code}")),
        }
        let body: Value = response.json().await.map_err(|e| format!("usage API: {e}"))?;
        Ok::<_, String>(parse_claude_limits(&body))
    }
    .await;
    let saved = last_known_file();
    match result {
        Ok(windows) => {
            save_last_known(&saved, name, &windows, now_ms());
            account.windows = windows;
        }
        Err(e) => {
            if e == IDLE {
                if let Some((at, windows)) = load_last_known(&saved, name, now_ms()) {
                    account.windows = windows;
                    account.as_of_ms = Some(at);
                }
            }
            account.error = Some(e);
        }
    }
    account
}

// ── Last good numbers per account, so an idle account still shows where it stood ────────────

#[derive(serde::Deserialize, Serialize)]
struct LastKnown {
    at_ms: i64,
    windows: Vec<UsageWindow>,
}

/// A removed account: its cached row and saved numbers go, so an account re-created under the same
/// name starts empty instead of showing the old login's identity and limits.
pub fn forget(name: &str) {
    if let Some(cache) = CLAUDE_CACHE.lock().as_mut() {
        cache.remove(name);
    }
    let file = last_known_file();
    if let Some(mut all) = crate::json::read_json::<HashMap<String, LastKnown>>(&file) {
        if all.remove(name).is_some() {
            let _ = crate::json::write_json(&file, &all);
        }
    }
}

fn last_known_file() -> PathBuf {
    crate::paths::lotus_state_dir().join("claude-usage-last.json")
}

fn save_last_known(file: &Path, name: &str, windows: &[UsageWindow], at_ms: i64) {
    let mut all = crate::json::read_json::<HashMap<String, LastKnown>>(&file.to_path_buf()).unwrap_or_default();
    all.insert(name.to_string(), LastKnown { at_ms, windows: windows.to_vec() });
    let _ = crate::json::write_json(&file.to_path_buf(), &all);
}

/// A window that has reset since the save is empty now, like Codex's snapshot.
fn load_last_known(file: &Path, name: &str, now_ms: i64) -> Option<(i64, Vec<UsageWindow>)> {
    let mut all = crate::json::read_json::<HashMap<String, LastKnown>>(&file.to_path_buf())?;
    let last = all.remove(name)?;
    let windows = last
        .windows
        .into_iter()
        .map(|mut w| {
            if w.resets_at_ms.is_some_and(|at| at <= now_ms) {
                w.used_percent = 0.0;
                w.resets_at_ms = None;
            }
            w
        })
        .collect();
    Some((last.at_ms, windows))
}

/// Claude Code keeps one keychain item per config dir: `Claude Code-credentials-<sha256(dir)[..8]>`,
/// and plain `Claude Code-credentials` when `CLAUDE_CONFIG_DIR` is unset. Only the default account
/// may fall back to the unsuffixed item: for any other account it would show the default login's
/// numbers under another name.
pub(crate) fn keychain_services(dir: &Path, is_default: bool) -> Vec<String> {
    let suffixed = format!("Claude Code-credentials-{}", &hex::encode(Sha256::digest(dir.to_string_lossy().as_bytes()))[..8]);
    if is_default { vec!["Claude Code-credentials".to_string(), suffixed] } else { vec![suffixed] }
}

/// `security find-generic-password` argument lists to try, in order. Claude Code 2.1 writes its
/// item with `-a $USER`, and an older item of the same service (`acct=unknown`, seen 2026-11-17
/// holding only `mcpOAuth`) can sit beside it; without `-a` security returns that older one.
pub(crate) fn keychain_queries(dir: &Path, is_default: bool) -> Vec<Vec<String>> {
    let user = std::env::var("USER").ok().filter(|u| !u.is_empty());
    keychain_services(dir, is_default)
        .into_iter()
        .flat_map(|service| {
            let by_user = user.clone().map(|u| vec!["find-generic-password".into(), "-s".into(), service.clone(), "-a".into(), u, "-w".into()]);
            by_user.into_iter().chain([vec!["find-generic-password".into(), "-s".into(), service, "-w".into()]])
        })
        .collect()
}

fn is_claude_login(v: &Value) -> bool {
    v.get("claudeAiOauth").is_some()
}

/// Read through `/usr/bin/security` because that binary is already on the item's access list —
/// Claude Code wrote the item with it — so no keychain prompt appears; a direct keychain API call
/// from Lotus would prompt once per account. Other platforms keep `.credentials.json` in the dir.
async fn read_credentials(dir: &Path, is_default: bool) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    for query in keychain_queries(dir, is_default) {
        let output = tokio::process::Command::new("/usr/bin/security")
            .args(&query)
            .output()
            .await
            .map_err(|e| format!("keychain: {e}"))?;
        // An item without a login (MCP tokens only) is not this account's sign-in: try the next.
        if let Some(creds) = output.status.success().then(|| serde_json::from_slice::<Value>(&output.stdout).ok()).flatten() {
            if is_claude_login(&creds) {
                return Ok(creds);
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = is_default;
    let raw = tokio::fs::read(dir.join(".credentials.json")).await.map_err(|_| NOT_SIGNED_IN.to_string())?;
    serde_json::from_slice(&raw).map_err(|_| "credentials file is not JSON".to_string())
}

/// Whether `dir` holds a Claude login (an expired one counts: the CLI refreshes it). Same lookup as
/// `read_credentials`, blocking, for Settings. The token is parsed, never kept or returned.
pub(crate) fn has_claude_login(dir: &Path, is_default: bool) -> bool {
    let has = |raw: &[u8]| serde_json::from_slice::<Value>(raw).is_ok_and(|v| is_claude_login(&v));
    #[cfg(target_os = "macos")]
    for query in keychain_queries(dir, is_default) {
        let found = std::process::Command::new("/usr/bin/security").args(&query).output();
        if found.ok().filter(|o| o.status.success()).is_some_and(|o| has(&o.stdout)) {
            return true;
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = is_default;
    std::fs::read(dir.join(".credentials.json")).is_ok_and(|raw| has(&raw))
}

fn parse_claude_limits(body: &Value) -> Vec<UsageWindow> {
    let Some(limits) = body.get("limits").and_then(Value::as_array) else { return Vec::new() };
    limits
        .iter()
        .filter_map(|limit| {
            let group = limit.get("group").and_then(Value::as_str)?.to_string();
            Some(UsageWindow {
                kind: limit.get("kind").and_then(Value::as_str)?.to_string(),
                window_minutes: if group == "session" { SESSION_MINUTES } else { WEEK_MINUTES },
                group,
                used_percent: limit.get("percent").and_then(Value::as_f64)?,
                resets_at_ms: limit.get("resets_at").and_then(Value::as_str).and_then(iso_to_ms),
                scope: limit.pointer("/scope/model/display_name").and_then(Value::as_str).map(str::to_string),
            })
        })
        .collect()
}

/// `ChatGPT` for `~/.codex`, as before, so a hidden Codex row stays hidden; the account id otherwise.
fn codex_label(id: &str) -> String {
    if id == crate::accounts::DEFAULT { "ChatGPT".to_string() } else { id.to_string() }
}

/// The newest `rate_limits` in the newest session files that carry one, under `<CODEX_HOME>/sessions`.
fn codex_account(name: &str, sessions: &Path, now_ms: i64) -> Option<UsageAccount> {
    let mut files = Vec::new();
    collect_jsonl(sessions, &mut files);
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    // A session that never finished a turn has none; a few files back is plenty.
    let limits = files.iter().take(20).find_map(|(_, path)| last_rate_limits(path))?;
    Some(UsageAccount {
        provider: "codex",
        account: name.to_string(),
        plan: limits.get("plan_type").and_then(Value::as_str).map(str::to_string),
        in_use: false,
        windows: ["primary", "secondary"].iter().filter_map(|k| codex_window(k, limits.get(*k)?, now_ms)).collect(),
        error: None,
        as_of_ms: None,
        identity: None,
    })
}

fn collect_jsonl(dir: &Path, out: &mut Vec<(SystemTime, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
                out.push((modified, path));
            }
        }
    }
}

fn last_rate_limits(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    text.lines().rev().filter(|l| l.contains("\"rate_limits\"")).find_map(|line| {
        let mut event: Value = serde_json::from_str(line).ok()?;
        let limits = event.get_mut("payload")?.get_mut("rate_limits")?.take();
        limits.is_object().then_some(limits)
    })
}

fn codex_window(kind: &str, window: &Value, now_ms: i64) -> Option<UsageWindow> {
    let minutes = window.get("window_minutes").and_then(Value::as_u64)? as u32;
    let resets_at_ms = window.get("resets_at").and_then(Value::as_i64).map(|s| s * 1000);
    // The snapshot is from the last turn; a window that has reset since then is empty now.
    let reset = resets_at_ms.is_some_and(|at| at <= now_ms);
    Some(UsageWindow {
        kind: kind.to_string(),
        group: if minutes <= SESSION_MINUTES { "session" } else { "weekly" }.to_string(),
        used_percent: if reset { 0.0 } else { window.get("used_percent").and_then(Value::as_f64)? },
        resets_at_ms: if reset { None } else { resets_at_ms },
        window_minutes: minutes,
        scope: None,
    })
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b || matches!((a.canonicalize(), b.canonicalize()), (Ok(x), Ok(y)) if x == y)
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `2026-11-07T00:00:00.290308+00:00` → unix ms. Only the shapes this API sends: an RFC 3339
/// time with optional fraction and a `Z` or `±HH:MM` offset.
fn iso_to_ms(s: &str) -> Option<i64> {
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, sec) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    let rest = s.get(19..)?;
    let (frac, zone) = match rest.strip_prefix('.') {
        Some(r) => r.split_at(r.find(|c: char| !c.is_ascii_digit()).unwrap_or(r.len())),
        None => ("", rest),
    };
    let millis = format!("{frac:0<3}").get(..3)?.parse::<i64>().ok()?;
    let offset_min = match zone {
        "Z" | "" => 0,
        z => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            sign * (z.get(1..3)?.parse::<i64>().ok()? * 60 + z.get(4..6)?.parse::<i64>().ok()?)
        }
    };
    // Days from civil (Howard Hinnant's algorithm).
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (mo + if mo > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60) * 1000) + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/usage_fixtures/claude-oauth-usage.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn claude_limits_come_from_the_limits_list() {
        let windows = parse_claude_limits(&fixture());
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].kind, "session");
        assert_eq!(windows[0].group, "session");
        assert_eq!(windows[0].window_minutes, 300);
        assert_eq!(windows[1].kind, "weekly_all");
        assert_eq!(windows[1].window_minutes, 10_080);
        assert_eq!(windows[1].resets_at_ms, Some(1_794_009_599_659)); // 2026-11-06T23:59:59.659824Z
    }

    /// `contract/fixtures/usage-snapshot.json` is what Lotus Host's `/v1/usage` sends; the desktop's own
    /// rows must serialize to the same JSON, so a remote row and a local one are one type (PLAN §5).
    #[test]
    fn rows_serialize_like_the_host_usage_fixture() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../contract/fixtures/usage-snapshot.json");
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let w = |kind: &str, group: &str, used: f64, at: Option<i64>, minutes: u32, scope: Option<&str>| UsageWindow {
            kind: kind.into(),
            group: group.into(),
            used_percent: used,
            resets_at_ms: at,
            window_minutes: minutes,
            scope: scope.map(str::to_string),
        };
        let who = |email: &str, org: &str| Some(crate::accounts::Identity { email: email.into(), org: Some(org.into()) });
        let rows = vec![
            UsageAccount {
                provider: "claude",
                account: "default".into(),
                plan: Some("team".into()),
                in_use: true,
                windows: vec![
                    w("session", "session", 25.0, Some(1_793_545_200_000), 300, None),
                    w("weekly_all", "weekly", 40.5, Some(1_793_923_200_000), 10_080, None),
                    w("weekly_scoped", "weekly", 10.0, Some(1_793_923_200_000), 10_080, Some("Fable")),
                ],
                error: None,
                as_of_ms: None,
                identity: who("me@example.com", "Acme"),
            },
            UsageAccount {
                provider: "claude",
                account: "work".into(),
                plan: Some("max".into()),
                in_use: false,
                windows: vec![
                    w("session", "session", 0.0, None, 300, None),
                    w("weekly_all", "weekly", 12.0, Some(1_793_552_400_000), 10_080, None),
                ],
                error: Some(IDLE.into()),
                as_of_ms: Some(1_793_527_200_000),
                identity: who("work@example.com", "Acme"),
            },
            UsageAccount {
                provider: "codex",
                account: "ChatGPT".into(),
                plan: Some("plus".into()),
                in_use: false,
                windows: vec![
                    w("primary", "session", 8.0, Some(1_793_541_600_000), 300, None),
                    w("secondary", "weekly", 21.0, Some(1_793_707_200_000), 10_080, None),
                ],
                error: None,
                as_of_ms: None,
                identity: None,
            },
        ];
        // JSON has one number type: Rust writes `25.0` for an f64 where the host writes `25`.
        fn norm(v: Value) -> Value {
            match v {
                Value::Number(n) => serde_json::json!(n.as_f64()),
                Value::Array(a) => Value::Array(a.into_iter().map(norm).collect()),
                Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v))).collect()),
                v => v,
            }
        }
        assert_eq!(norm(serde_json::to_value(&rows).unwrap()), norm(fixture["accounts"].clone()));
    }

    #[test]
    fn a_scoped_limit_keeps_its_model_name() {
        // Shape seen live 2026-11-07 on a Max account.
        let body = serde_json::json!({ "limits": [
            { "group": "weekly", "kind": "weekly_all", "percent": 74, "resets_at": "2026-11-08T11:00:00+00:00", "scope": null },
            { "group": "weekly", "kind": "weekly_scoped", "percent": 0, "resets_at": "2026-11-08T11:00:00+00:00",
              "scope": { "model": { "display_name": "Fable", "id": null }, "surface": null } },
        ]});
        let windows = parse_claude_limits(&body);
        assert_eq!(windows[0].scope, None);
        assert_eq!(windows[1].scope.as_deref(), Some("Fable"));
    }

    #[test]
    fn iso_times_with_offsets_and_fractions() {
        assert_eq!(iso_to_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_to_ms("2026-11-07T00:00:00.290308+00:00"), Some(1_794_009_600_290));
        assert_eq!(iso_to_ms("2026-11-07T07:00:00+07:00"), Some(1_794_009_600_000));
        assert_eq!(iso_to_ms("garbage"), None);
    }

    #[test]
    fn codex_reads_the_newest_snapshot_and_zeroes_a_window_that_reset() {
        let dir = std::env::temp_dir().join(format!("lotus-usage-{}", std::process::id()));
        let day = dir.join("2026/11/01");
        std::fs::create_dir_all(&day).unwrap();
        let line = |used: f64| {
            format!(
                r#"{{"type":"event_msg","payload":{{"type":"token_count","rate_limits":{{"plan_type":"plus","primary":{{"used_percent":{used},"window_minutes":300,"resets_at":100}},"secondary":{{"used_percent":16.0,"window_minutes":10080,"resets_at":2000000000}}}}}}}}"#
            )
        };
        std::fs::write(day.join("rollout-a.jsonl"), format!("{}\n{}\n{{\"type\":\"other\"}}\n", line(10.0), line(26.0))).unwrap();

        let account = codex_account("ChatGPT", &dir, 1_000_000).unwrap();
        assert_eq!(account.plan.as_deref(), Some("plus"));
        assert_eq!(account.windows[0].used_percent, 0.0, "primary reset at 100 s, now is 1000 s");
        assert_eq!(account.windows[0].resets_at_ms, None);
        assert_eq!(account.windows[1].group, "weekly");
        assert_eq!(account.windows[1].used_percent, 16.0);

        let fresh = codex_account("work", &dir, 50_000).unwrap();
        assert_eq!(fresh.windows[0].used_percent, 26.0, "the last snapshot in the file wins");
        assert_eq!(fresh.account, "work", "a CODEX_HOME account is named by its id");
        assert_eq!(codex_label("default"), "ChatGPT");
        assert_eq!(codex_label("work"), "work");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn last_known_numbers_round_trip_and_zero_a_window_that_reset() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("last.json");
        let w = |kind: &str, at: i64| UsageWindow { kind: kind.into(), group: "session".into(), used_percent: 40.0, resets_at_ms: Some(at), window_minutes: 300, scope: None };
        save_last_known(&file, "globex", &[w("session", 100), w("weekly_all", 5_000)], 50);
        save_last_known(&file, "other", &[], 60);

        let (at, windows) = load_last_known(&file, "globex", 1_000).unwrap();
        assert_eq!(at, 50);
        assert_eq!((windows[0].used_percent, windows[0].resets_at_ms), (0.0, None), "reset at 100, now 1000");
        assert_eq!((windows[1].used_percent, windows[1].resets_at_ms), (40.0, Some(5_000)));
        assert!(load_last_known(&file, "nobody", 1_000).is_none());
    }

    fn ccs(home: &Path, name: &str) -> PathBuf {
        let dir = home.join(".ccs/instances").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".claude.json"), "{}").unwrap();
        dir
    }

    #[test]
    fn the_chosen_account_must_be_a_live_account() {
        let home = tempfile::tempdir().unwrap();
        let dir = ccs(home.path(), "acme");
        let file = home.path().join("state/claude-account.json");
        let list = || crate::accounts::claude_accounts_in(home.path(), &home.path().join("state"), &[]);

        assert!(chosen_in(&file, list).is_none());
        assert!(set_in(&file, list, Some("../../etc".into())).is_err());
        set_in(&file, list, Some("acme".into())).unwrap();
        assert_eq!(chosen_in(&file, list).unwrap().dir, dir);

        // `default` is always live and means ~/.claude.
        set_in(&file, list, Some("default".into())).unwrap();
        assert_eq!(chosen_in(&file, list).unwrap().dir, home.path().join(".claude"));

        // Removed later with ccs: Lotus falls back to the default login.
        set_in(&file, list, Some("acme".into())).unwrap();
        std::fs::remove_file(dir.join(".claude.json")).unwrap();
        assert!(chosen_in(&file, list).is_none());
        set_in(&file, list, None).unwrap();
        set_in(&file, list, None).unwrap();
        assert!(!file.exists());
    }

    /// An `env-acme` pick must stay `env-acme`, not collapse to the ccs `acme`.
    #[test]
    fn the_chosen_id_is_the_stored_id_even_when_the_folder_name_clashes() {
        let home = tempfile::tempdir().unwrap();
        ccs(home.path(), "acme");
        let clash = home.path().join("cfg/acme");
        std::fs::create_dir_all(&clash).unwrap();
        let file = home.path().join("state/claude-account.json");
        let list = || crate::accounts::claude_accounts_in(home.path(), &home.path().join("state"), &[clash.clone()]);

        set_in(&file, list, Some("env-acme".into())).unwrap();
        let chosen = chosen_in(&file, list).unwrap();
        assert_eq!((chosen.id.as_str(), chosen.dir), ("env-acme", clash.clone()));
    }

    #[test]
    fn a_default_that_never_signed_in_is_left_out_unless_in_use() {
        let row = |account: &str, in_use: bool, error: Option<&str>| UsageAccount {
            provider: "claude",
            account: account.into(),
            plan: None,
            in_use,
            windows: Vec::new(),
            error: error.map(str::to_string),
            as_of_ms: None,
            identity: None,
        };
        assert!(hidden_unsigned_default(&row("default", false, Some(NOT_SIGNED_IN))));
        assert!(!hidden_unsigned_default(&row("default", true, Some(NOT_SIGNED_IN))));
        assert!(!hidden_unsigned_default(&row("default", false, Some(IDLE))));
        assert!(!hidden_unsigned_default(&row("work", false, Some(NOT_SIGNED_IN))));
    }

    #[test]
    fn only_the_default_account_may_read_the_unsuffixed_keychain_item() {
        let dir = Path::new("/h/.ccs/instances/acme");
        let suffixed = keychain_services(dir, false);
        assert_eq!(suffixed.len(), 1);
        assert!(suffixed[0].starts_with("Claude Code-credentials-"));
        assert_eq!(keychain_services(dir, true), ["Claude Code-credentials".to_string(), suffixed[0].clone()]);
        // The $USER-scoped item (Claude Code 2.1) is asked for before the bare service.
        if let Ok(user) = std::env::var("USER") {
            let q = keychain_queries(dir, true);
            assert_eq!(q[0], ["find-generic-password", "-s", "Claude Code-credentials", "-a", user.as_str(), "-w"]);
            assert_eq!(q[1], ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
        }
    }

    #[test]
    fn agy_usage_becomes_one_weekly_window_per_group() {
        let json: Value = serde_json::from_str(r#"{"command":{"data":{"groups":[
            {"name":"Gemini Models","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.78,"reset_time":"2026-11-26T13:28:53Z"}]},
            {"name":"Claude and GPT models","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":0.32,"reset_time":"1970-01-02T00:00:01Z"}]}]}}}"#).unwrap();
        let w = agy_windows(&json);
        assert_eq!(w.iter().map(|w| w.scope.clone().unwrap()).collect::<Vec<_>>(), ["Gemini", "Claude & GPT"]);
        assert_eq!(w[0].group, "weekly");
        assert!((w[0].used_percent - 22.0).abs() < 0.01);
        assert_eq!(w[1].resets_at_ms, Some(86_401_000));
        assert_eq!(rfc3339_utc_ms("2026-11-26T13:28:53Z"), Some(1_795_699_733_000));
        assert_eq!(rfc3339_utc_ms("2026-11-26T13:28:53+07:00"), None);
        assert!(agy_windows(&serde_json::json!({})).is_empty());
    }
}
