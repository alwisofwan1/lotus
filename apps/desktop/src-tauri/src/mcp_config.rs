//! Filesystem side of the Lotus MCP integration:
//! 1. Writes the discovery file (`<lotus_state_dir>/lotus-mcp-ipc.json`) — port
//!    + secret + pid consumed by the MCP sidecar. Release: `~/.lotus/`. Dev:
//!    `~/.lotus-dev/`.
//! 2. Merges an `mcpServers.<key>` entry into `~/.claude.json` so Claude CLI
//!    auto-discovers the sidecar on startup. Key is `lotus` for release and
//!    `lotus-dev` for debug builds, so dev and release coexist without
//!    overwriting each other's pointer.
//!
//! We aim to be idempotent and non-destructive: existing keys in the user's
//! `~/.claude.json` must survive verbatim.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::paths;

#[derive(Debug, thiserror::Error)]
pub enum McpConfigError {
    #[error("cannot resolve user home directory")]
    NoHome,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Shape of `~/.claude/lotus-mcp-ipc.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IpcDiscoveryFile {
    pub version: u32,
    pub port: u16,
    pub secret: String,
    pub pid: u32,
    /// Phase 7.3 profile invariant: which instance owns this file ("lotus" | "lotus-dev"). The
    /// MCP sidecar compares it against the agent's `LOTUS_PROFILE_KEY` env and refuses to serve a
    /// mismatched instance's fleet. `#[serde(default)]` so an older file (no key) deserializes and
    /// simply leaves the guard off.
    #[serde(default)]
    pub profile_key: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LotusMcpLaunchConfig {
    pub profile_key: String,
    pub config: Value,
}

/// Discovery file consumed by the MCP sidecar — release writes
/// `~/.lotus/lotus-mcp-ipc.json`, dev writes `~/.lotus-dev/lotus-mcp-ipc.json`.
/// Sidecar location is communicated to the sidecar via the `--discovery <path>`
/// argv we register in `~/.claude.json` (see [`build_lotus_sidecar_args`]).
pub fn ipc_discovery_path() -> Result<PathBuf, McpConfigError> {
    Ok(paths::lotus_state_dir().join("lotus-mcp-ipc.json"))
}

/// Path to Claude CLI's per-user config — owned by Claude CLI itself, not
/// Lotus. Lotus only merges its `mcpServers.<key>` entry here.
pub fn mcp_config_path() -> Result<PathBuf, McpConfigError> {
    Ok(dirs::home_dir()
        .ok_or(McpConfigError::NoHome)?
        .join(".claude.json"))
}

pub fn lotus_mcp_server_path() -> Result<PathBuf, McpConfigError> {
    Ok(paths::lotus_state_dir().join("lotus-mcp-server.mjs"))
}

/// `mcpServers` key used by this Lotus instance. Release: `"lotus"`. Dev:
/// `"lotus-dev"`. Splitting the key lets a developer run `tauri dev` while
/// the bundled `Lotus.app` is still open — Claude CLI sees both registrations
/// and routes each to its own running instance.
pub fn mcp_server_key() -> &'static str {
    if paths::is_dev_profile() {
        "lotus-dev"
    } else {
        "lotus"
    }
}

/// Build the command + args we register in `~/.claude.json` for our sidecar.
/// The sidecar uses `--discovery` to find this Lotus's discovery file (release
/// vs dev have different paths). Returns `None` when home cannot be resolved.
pub fn build_lotus_sidecar_args(command: &str, script_path: &Path) -> (String, Vec<String>) {
    let mut args = vec![script_path.to_string_lossy().into_owned()];
    if let Ok(disc) = ipc_discovery_path() {
        args.push("--discovery".to_string());
        args.push(disc.to_string_lossy().into_owned());
    }
    (command.to_string(), args)
}

pub fn build_lotus_mcp_launch_config(command: &str, args: &[String]) -> LotusMcpLaunchConfig {
    let key = mcp_server_key().to_string();
    LotusMcpLaunchConfig {
        profile_key: key.clone(),
        config: json!({
            "mcpServers": {
                key: {
                    "type": "stdio",
                    "command": command,
                    "args": args,
                },
            },
        }),
    }
}

/// Atomic write: stage to `{target}.tmp` then rename. Also sets `0600` perms on
/// Unix so the secret is not world-readable.
pub(crate) fn atomic_write<P: AsRef<Path>>(target: P, contents: &[u8]) -> std::io::Result<()> {
    let target = target.as_ref();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("tmp");
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&tmp, perms)?;
    }
    fs::rename(tmp, target)?;
    Ok(())
}

pub fn write_ipc_discovery(file: &IpcDiscoveryFile) -> Result<PathBuf, McpConfigError> {
    let path = ipc_discovery_path()?;
    let body = serde_json::to_vec_pretty(file)?;
    atomic_write(&path, &body)?;
    Ok(path)
}

pub fn remove_ipc_discovery_if_ours(pid: u32) -> Result<(), McpConfigError> {
    let path = ipc_discovery_path()?;
    let existing = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err.into()),
    };
    if let Ok(parsed) = serde_json::from_slice::<IpcDiscoveryFile>(&existing) {
        if parsed.pid == pid {
            let _ = fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Merge a `lotus` MCP server entry into `~/.claude.json`. Preserves unrelated
/// keys (statusLine, theme, other mcpServers, etc.). Writes nothing if the
/// file is unreadable but already contains the exact entry we would insert.
pub fn install_mcp_config_entry(command: &str, args: &[String]) -> Result<PathBuf, McpConfigError> {
    let path = mcp_config_path()?;
    install_mcp_config_entry_at(&path, command, args)
}

/// Install the `mcpServers.lotus` entry into a SPECIFIC Claude config file. Lets the keeper register
/// the sidecar into a 2nd-account / profile config (a `CLAUDE_CONFIG_DIR` Claude), not just the
/// default `~/.claude.json`, so a custom-but-Claude runner actually has the lotus tools available.
pub fn install_mcp_config_entry_at(
    path: &Path,
    command: &str,
    args: &[String],
) -> Result<PathBuf, McpConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut root = read_or_empty_object(path)?;
    apply_lotus_entry(&mut root, command, args);
    let body = serde_json::to_vec_pretty(&Value::Object(root))?;
    atomic_write(path, &body)?;
    Ok(path.to_path_buf())
}

/// Remove an arbitrary `mcpServers.<key>` entry written by a *different* profile.
/// Used by the keeper to evict stale `lotus-dev` / `lotus` entries whose
/// Lotus instance has died without running its own cleanup.
pub fn remove_mcp_entry_by_key(key: &str) -> Result<(), McpConfigError> {
    let path = mcp_config_path()?;
    remove_mcp_entry_by_key_at(&path, key)
}

/// Remove an `mcpServers.<key>` entry from a SPECIFIC Claude config (a profile/`CLAUDE_CONFIG_DIR`
/// file), so a dead other-profile sidecar (e.g. a `lotus` release entry while only dev runs) is
/// evicted everywhere it was mirrored — not just the default `~/.claude.json`. No-op if the file is
/// missing or the key is absent.
pub fn remove_mcp_entry_by_key_at(path: &Path, key: &str) -> Result<(), McpConfigError> {
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(());
    };
    let Ok(Value::Object(mut root)) = serde_json::from_str::<Value>(&text) else {
        return Ok(());
    };
    let removed = if let Some(Value::Object(servers)) = root.get_mut("mcpServers") {
        let had = servers.contains_key(key);
        if had {
            servers.remove(key);
            if servers.is_empty() {
                root.remove("mcpServers");
            }
        }
        had
    } else {
        false
    };
    if removed {
        let body = serde_json::to_vec_pretty(&Value::Object(root))?;
        atomic_write(path, &body)?;
    }
    Ok(())
}

pub fn uninstall_mcp_config_entry() -> Result<(), McpConfigError> {
    let path = mcp_config_path()?;
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let Ok(Value::Object(mut root)) = serde_json::from_str::<Value>(&text) else {
        return Ok(());
    };
    if let Some(Value::Object(servers)) = root.get_mut("mcpServers") {
        servers.remove(mcp_server_key());
        if servers.is_empty() {
            root.remove("mcpServers");
        }
    }
    let body = serde_json::to_vec_pretty(&Value::Object(root))?;
    atomic_write(&path, &body)?;
    Ok(())
}

const LOTUS_MCP_SERVER_SCRIPT: &str = include_str!("../../scripts/lotus-mcp-server.bundle.mjs");

/// Write the bundled MCP stdio sidecar into a stable user-owned location.
/// Release/dev Claude sessions often start from arbitrary project directories,
/// so this file must be dependency self-contained and runnable with `node`
/// without relying on repo-local `node_modules` or Bun's cwd-dependent resolver.
pub fn install_lotus_mcp_server_script() -> Result<PathBuf, McpConfigError> {
    let path = lotus_mcp_server_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, LOTUS_MCP_SERVER_SCRIPT)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms)?;
    }
    Ok(path)
}

// ── Codex MCP integration ──────────────────────────────────────────────────

pub fn codex_mcp_server_key() -> &'static str {
    mcp_server_key()
}

/// Whether a TOML header belongs to `mcp_servers.<key>` — the table itself **or any of
/// its sub-tables**.
///
/// The sub-tables are the whole reason this is a function. Removing only the exact header
/// leaves `[mcp_servers.<key>.tools.…]` behind, and in TOML a surviving child re-creates
/// its parent as an empty table: a server with no `command` and no `url`. Codex reads that
/// as a server with no transport and refuses to load `config.toml` **at all**, so one
/// orphaned line kills every Codex cell on the machine, not just this entry.
///
/// Seen on 2026-08-10: launching the release app ran the sibling cleanup against
/// `lotus-dev`, which left `[mcp_servers.lotus-dev.tools.lotus_read_cell_output]` alone in
/// the file and every Codex cell started with
/// `Error loading config.toml: invalid transport in mcp_servers.lotus-dev`.
///
/// The trailing dot in the prefix is load-bearing: `lotus` must not match
/// `[mcp_servers.lotus-dev]`, and those two keys are exactly what this codebase installs.
fn is_codex_target_table(trimmed_header: &str, key: &str) -> bool {
    trimmed_header == format!("[mcp_servers.{key}]")
        || trimmed_header.starts_with(&format!("[mcp_servers.{key}."))
}

pub fn apply_codex_mcp_entry(
    config_str: &str,
    key: &str,
    command: &str,
    args: &[String],
) -> String {
    let target_header = format!("[mcp_servers.{key}]");
    let mut out = String::new();
    let mut skipping_target = false;

    for line in config_str.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping_target = is_codex_target_table(trimmed, key);
            if skipping_target {
                continue;
            }
        }
        if !skipping_target {
            out.push_str(line);
            out.push('\n');
        }
    }

    while out.ends_with("\n\n\n") {
        out.pop();
    }
    if !out.is_empty() && !out.ends_with("\n\n") {
        out.push('\n');
    }

    out.push_str(&target_header);
    out.push('\n');
    out.push_str("command = ");
    out.push_str(&toml_string(command));
    out.push('\n');
    out.push_str("args = [");
    for (idx, arg) in args.iter().enumerate() {
        if idx > 0 {
            out.push_str(", ");
        }
        out.push_str(&toml_string(arg));
    }
    out.push_str("]\n");
    out
}

pub fn has_exact_codex_mcp_entry(
    config_str: &str,
    key: &str,
    command: &str,
    args: &[String],
) -> bool {
    let target_header = format!("[mcp_servers.{key}]");
    let mut in_target = false;
    let mut found_command = false;
    let mut found_args = false;
    let expected_command = format!("command = {}", toml_string(command));
    let expected_args = format!(
        "args = [{}]",
        args.iter()
            .map(|arg| toml_string(arg))
            .collect::<Vec<_>>()
            .join(", ")
    );

    for line in config_str.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_target {
                break;
            }
            in_target = trimmed == target_header;
            continue;
        }
        if !in_target {
            continue;
        }
        if trimmed == expected_command {
            found_command = true;
        }
        if trimmed == expected_args {
            found_args = true;
        }
    }

    found_command && found_args
}

pub fn install_codex_mcp_config_entry(
    command: &str,
    args: &[String],
) -> Result<PathBuf, McpConfigError> {
    let path = codex_config_path()?;
    install_codex_mcp_config_entry_at(&path, command, args)
}

/// Codex counterpart of [`install_mcp_config_entry_at`] — install the lotus MCP entry into a specific
/// `config.toml` (a `CODEX_HOME` profile), preserving other servers and the notify hook.
pub fn install_codex_mcp_config_entry_at(
    path: &Path,
    command: &str,
    args: &[String],
) -> Result<PathBuf, McpConfigError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let prior = read_or_empty(path)?;
    let merged = apply_codex_mcp_entry(&prior, codex_mcp_server_key(), command, args);
    atomic_write(path, merged.as_bytes())?;
    Ok(path.to_path_buf())
}

/// Read a config file, treating only a missing file as empty: any other read error must surface,
/// or the caller rewrites the file from "" and the user's settings are gone.
fn read_or_empty(path: &Path) -> std::io::Result<String> {
    match fs::read_to_string(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        other => other,
    }
}

/// Pure string-level removal of an `[mcp_servers.<key>]` table (and its body) from a Codex
/// `config.toml`, mirroring the skip logic of [`apply_codex_mcp_entry`]. Everything else — the
/// `notify` line, other `mcp_servers.*` tables, unknown user keys — is preserved verbatim; we never
/// round-trip the file through a TOML re-serializer.
pub fn strip_codex_mcp_entry(config_str: &str, key: &str) -> String {
    let mut out = String::new();
    let mut skipping_target = false;

    for line in config_str.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping_target = is_codex_target_table(trimmed, key);
            if skipping_target {
                continue;
            }
        }
        if !skipping_target {
            out.push_str(line);
            out.push('\n');
        }
    }

    while out.ends_with("\n\n\n") {
        out.pop();
    }
    out
}

/// Remove the `[mcp_servers.<key>]` table from Codex's default `config.toml`. Returns whether a
/// change was written. No-op if the file or the table is absent.
pub fn remove_codex_mcp_entry_by_key(key: &str) -> Result<bool, McpConfigError> {
    let path = codex_config_path()?;
    remove_codex_mcp_entry_by_key_at(&path, key)
}

/// Remove the `[mcp_servers.<key>]` table from a SPECIFIC Codex `config.toml`. Codex keeps its own
/// MCP registry, so a dead `lotus`/`lotus-dev` table lingers here even after the Claude-config
/// cleanup runs — evicting it stops agents from wasting a call on (and reporting) a dead endpoint.
pub fn remove_codex_mcp_entry_by_key_at(path: &Path, key: &str) -> Result<bool, McpConfigError> {
    let Ok(prior) = fs::read_to_string(path) else {
        return Ok(false);
    };
    let target_header = format!("[mcp_servers.{key}]");
    if !prior.contains(&target_header) {
        return Ok(false);
    }
    let next = strip_codex_mcp_entry(&prior, key);
    atomic_write(path, next.as_bytes())?;
    Ok(true)
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

// ── Codex `notify` integration ──────────────────────────────────────────────
//
// Codex's `~/.codex/config.toml` exposes a `notify = ["program", "arg", ...]`
// hook fired with `{"type": "agent-turn-complete", ...}` on stdin when a turn
// finishes. We install a tiny shell script that re-posts to our own
// `/v1/hook/stop` so the desktop app gets the same instant signal we get from
// Claude Code's Stop hook. See `settings::install_stop_hook` for the Claude
// counterpart.

const LOTUS_NOTIFY_SCRIPT_NAME: &str = "codex-notify.sh";
/// Windows cannot exec a `.sh`, so the notify hook there is a PowerShell script.
const LOTUS_NOTIFY_PS1_NAME: &str = "codex-notify.ps1";

/// True when a `notify` entry points at either Lotus script (Unix `.sh` or Windows `.ps1`).
fn is_lotus_notify_text(text: &str) -> bool {
    text.contains(LOTUS_NOTIFY_SCRIPT_NAME) || text.contains(LOTUS_NOTIFY_PS1_NAME)
}
const LOTUS_NOTIFY_FALLBACK_NAME: &str = "codex-notify-fallback.sh";

/// Lotus's own state root. Re-exported from [`paths::lotus_state_dir`] so the
/// few mcp_config helpers that already returned `Result<PathBuf>` keep their
/// error type for backward compatibility with their callers.
pub fn lotus_dir() -> Result<PathBuf, McpConfigError> {
    Ok(paths::lotus_state_dir())
}

pub fn codex_notify_script_path() -> Result<PathBuf, McpConfigError> {
    let name = if cfg!(windows) {
        LOTUS_NOTIFY_PS1_NAME
    } else {
        LOTUS_NOTIFY_SCRIPT_NAME
    };
    Ok(lotus_dir()?.join(name))
}

/// The `notify` argv Codex runs. Windows has no shebang, so the `.ps1` goes through PowerShell.
pub fn codex_notify_argv(script_path: &str, windows: bool) -> Vec<String> {
    if !windows {
        return vec![script_path.to_string()];
    }
    [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script_path,
    ]
    .map(String::from)
    .to_vec()
}

pub fn codex_notify_fallback_path() -> Result<PathBuf, McpConfigError> {
    Ok(lotus_dir()?.join(LOTUS_NOTIFY_FALLBACK_NAME))
}

pub fn codex_config_path() -> Result<PathBuf, McpConfigError> {
    Ok(dirs::home_dir()
        .ok_or(McpConfigError::NoHome)?
        .join(".codex")
        .join("config.toml"))
}

/// Cursor reads MCP servers from `~/.cursor/mcp.json` using the same
/// `{"mcpServers": {...}}` shape as Claude's `~/.claude.json`, so the JSON
/// installer ([`install_mcp_config_entry_at`]) applies verbatim.
pub fn cursor_mcp_config_path() -> Result<PathBuf, McpConfigError> {
    Ok(dirs::home_dir()
        .ok_or(McpConfigError::NoHome)?
        .join(".cursor")
        .join("mcp.json"))
}

/// Body of the notify script we drop at `~/.lotus/codex-notify.sh`. The
/// trailing `|| true` keeps Codex's turn from failing when Lotus is offline.
/// `LOTUS_PANE_ID` is inherited from the PTY env (see `pty::build_*`).
///
/// WHY the fan-out loop: `~/.codex/config.toml` has a SINGLE `notify` slot,
/// so the dev and release instances used to overwrite each other's script
/// path and whichever installed last "won" — the other instance went deaf to
/// Codex turn-complete events. Instead of baking one instance's port/secret,
/// the script now loops over BOTH instance state dirs (`~/.lotus`,
/// `~/.lotus-dev` — the literal dirs behind `paths::lotus_state_dir`) and
/// posts to every instance whose `lotus-mcp-ipc.json` discovery file exists,
/// reading port+secret at RUN time. Both scripts are content-identical, so
/// it no longer matters which instance's path sits in the notify line — and
/// nothing baked can go stale across app restarts.
///
/// After posting to Lotus the wrapper chains to a fallback script if one
/// exists at `~/.lotus/codex-notify-fallback.sh`. The fallback is written
/// at install time when we displaced a pre-existing `notify` entry (e.g.
/// BridgeSpace's `bs-agent-notify.cjs`), so users who run multiple agent
/// IDEs keep their previous hook firing alongside Lotus.
pub fn build_codex_notify_script() -> String {
    format!(
        "#!/bin/sh\n\
         # Lotus Codex notify hook — managed by Lotus, do not edit manually.\n\
         # Codex passes the notification JSON as the FINAL ARGV ARGUMENT with stdin at\n\
         # /dev/null (legacy_notify.rs) — never read stdin here, it is always empty.\n\
         _LOTUS_NOTIFY_PAYLOAD=\"${{1:-}}\"\n\
         if printf '%s' \"$_LOTUS_NOTIFY_PAYLOAD\" | grep -q '\"type\"[[:space:]]*:[[:space:]]*\"agent-turn-complete\"'; then\n\
           # Fan out to every running Lotus instance (release + dev): each\n\
           # state dir advertises its live port/secret in lotus-mcp-ipc.json.\n\
           for _LOTUS_STATE_DIR in \"$HOME/.lotus\" \"$HOME/.lotus-dev\"; do\n\
             _LOTUS_IPC=\"$_LOTUS_STATE_DIR/lotus-mcp-ipc.json\"\n\
             [ -f \"$_LOTUS_IPC\" ] || continue\n\
             _LOTUS_PORT=$(sed -n 's/.*\"port\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' \"$_LOTUS_IPC\")\n\
             _LOTUS_SECRET=$(sed -n 's/.*\"secret\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p' \"$_LOTUS_IPC\")\n\
             [ -n \"$_LOTUS_PORT\" ] || continue\n\
             curl -s -m 3 -X POST \"http://127.0.0.1:$_LOTUS_PORT/v1/hook/stop\" \\\n  \
             -H \"Authorization: Bearer $_LOTUS_SECRET\" \\\n  \
             -H \"Content-Type: application/json\" \\\n  \
             -d \"{{\\\"pane_id\\\": \\\"${{LOTUS_PANE_ID}}\\\"}}\" 2>/dev/null || true\n\
           done\n\
         fi\n\
         \n\
         # Chain to any pre-existing notify hook captured at install time so\n\
         # users coexisting with BridgeSpace / custom hooks keep theirs. Use\n\
         # `dirname $0` so dev/release builds resolve to their own state dir\n\
         # (~/.lotus vs ~/.lotus-dev) without a second template branch.\n\
         _LOTUS_FALLBACK=\"$(dirname \"$0\")/{LOTUS_NOTIFY_FALLBACK_NAME}\"\n\
         [ -x \"$_LOTUS_FALLBACK\" ] && printf '%s' \"$_LOTUS_NOTIFY_PAYLOAD\" | \"$_LOTUS_FALLBACK\" \"$@\" 2>/dev/null\n\
         exit 0\n",
    )
}

/// Windows twin of [`build_codex_notify_script`]: same fan-out to every instance's
/// `lotus-mcp-ipc.json`, same "never fail Codex's turn" rule. The payload is the last argv.
pub fn build_codex_notify_ps1() -> String {
    r#"# Lotus Codex notify hook - managed by Lotus, do not edit manually.
$payload = if ($args.Count -gt 0) { [string]$args[-1] } else { '' }
if ($payload -notmatch '"type"\s*:\s*"agent-turn-complete"') { exit 0 }
foreach ($dir in @("$HOME\.lotus", "$HOME\.lotus-dev")) {
  $ipc = Join-Path $dir 'lotus-mcp-ipc.json'
  if (-not (Test-Path $ipc)) { continue }
  try {
    $cfg = Get-Content $ipc -Raw | ConvertFrom-Json
    if (-not $cfg.port) { continue }
    $body = @{ pane_id = "$env:LOTUS_PANE_ID" } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($cfg.port)/v1/hook/stop" `
      -Headers @{ Authorization = "Bearer $($cfg.secret)" } `
      -ContentType 'application/json' -Body $body -TimeoutSec 3 | Out-Null
  } catch {}
}
exit 0
"#
    .to_string()
}

/// Name of the Claude Stop-hook script dropped into the instance state dir
/// (`~/.lotus/claude-stop-hook.sh`, dev: `~/.lotus-dev/...`). The file name is
/// shared between instances but the *path* is instance-unique — settings.json
/// hook ownership is keyed on that full path (see `settings::apply_stop_hook`).
const LOTUS_CLAUDE_STOP_HOOK_NAME: &str = "claude-stop-hook.sh";

/// Absolute path of this instance's Claude Stop-hook script.
pub fn claude_stop_hook_script_path() -> Result<PathBuf, McpConfigError> {
    Ok(lotus_dir()?.join(LOTUS_CLAUDE_STOP_HOOK_NAME))
}

/// Body of the Claude Stop hook dropped at `<state dir>/claude-stop-hook.sh`.
///
/// WHY a script instead of the old inline `curl` command in settings.json:
/// the IPC port/secret rotate on every app start, so an inline command goes
/// stale the moment Lotus restarts (the hook then posts into the void until
/// the next settings rewrite). The script instead reads the live discovery
/// file (`lotus-mcp-ipc.json`) *next to itself* at RUN time — `dirname $0`
/// resolves to the owning instance's state dir, so dev and release each post
/// to their own server and the settings.json entry never goes stale.
///
/// Payload is richer than the old inline hook:
/// - `session_id` — parsed from the Stop-hook JSON Claude pipes on stdin,
///   forwarded so the frontend can correlate turn-end with a conversation.
/// - `agent_pid` — `$PPID` = the hook shell's parent = the `claude` process
///   that fired the hook. Lets the receiver detect nested `claude -p`
///   children that inherited LOTUS_PANE_ID (see `mcp_ipc::nested_stop`).
///
/// sed (not jq) keeps the script dependency-free; `-m 3` bounds curl so a
/// wedged listener can never stall the agent's turn; every path exits 0.
pub fn build_claude_stop_hook_script() -> String {
    "#!/bin/sh\n\
     # Lotus Claude Stop hook — managed by Lotus, do not edit manually.\n\
     # Reads the live IPC discovery file next to this script at RUN time so\n\
     # the port/secret never go stale across Lotus restarts.\n\
     _P=$(cat)\n\
     sid=$(printf '%s' \"$_P\" | sed -n 's/.*\"session_id\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p')\n\
     # StopFailure (a usage limit) carries its error type and the CLI's message; Stop carries neither.\n\
     err=$(printf '%s' \"$_P\" | sed -n 's/.*\"error\"[[:space:]]*:[[:space:]]*\"\\([a-z_]*\\)\".*/\\1/p')\n\
     [ -n \"$err\" ] && msg=$(printf '%s' \"$_P\" | sed -n 's/.*\"last_assistant_message\"[[:space:]]*:[[:space:]]*\"\\([^\"\\\\]*\\)\".*/\\1/p' | head -c 300)\n\
     _IPC=\"$(dirname \"$0\")/lotus-mcp-ipc.json\"\n\
     [ -f \"$_IPC\" ] || exit 0\n\
     port=$(sed -n 's/.*\"port\"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' \"$_IPC\")\n\
     secret=$(sed -n 's/.*\"secret\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p' \"$_IPC\")\n\
     [ -n \"$port\" ] || exit 0\n\
     curl -s -m 3 -X POST \"http://127.0.0.1:$port/v1/hook/stop\" \\\n  \
     -H \"Authorization: Bearer $secret\" \\\n  \
     -H \"Content-Type: application/json\" \\\n  \
     -d \"{\\\"pane_id\\\": \\\"$LOTUS_PANE_ID\\\", \\\"session_id\\\": \\\"$sid\\\", \\\"agent_pid\\\": $PPID, \\\"error\\\": \\\"$err\\\", \\\"message\\\": \\\"$msg\\\"}\" 2>/dev/null || true\n\
     exit 0\n"
        .to_string()
}

/// Body of the shared Claude tool hook, dropped at `<state dir>/claude-tool-hook.sh`.
///
/// Invoked as `claude-tool-hook.sh pre|post`; one script serves both `PreToolUse` and
/// `PostToolUse` so there is a single body to keep in sync.
///
/// **WHY the `LOTUS_PANE_ID` guard is the very first thing, and why a shell wrapper still exists at
/// all.** The hook is registered in the GLOBAL `~/.claude/settings.json`, so it fires in every
/// Claude Code session on the machine, including ones with nothing to do with Lotus. `sh -c 'exit 0'`
/// costs ~16 ms here while `node -e ''` costs ~86 ms, so the guard is what keeps unrelated sessions
/// cheap. Measured with an identical harness, before and after this change: **16 ms outside a Lotus
/// pane either way.** Keeping the wrapper is the entire reason that number did not move.
///
/// **WHY it hands the rest to Node instead of assembling the JSON itself.** Same harness, inside a
/// pane: the old `printf` + `sed` body cost **~106 ms**, this one costs **~123 ms**. So the honest
/// price is **~17 ms per tool call** in a Lotus pane, roughly half a second across a thirty-call
/// turn. What it buys: `toolTarget` (a step can say `rm src/legacy/shim.ts` instead of just `Bash`),
/// `linesAdded` / `linesRemoved` from a real `structuredPatch`, JSON encoding that keeps a quote in a
/// path instead of stripping it, and the extractors in `payload-extractors.mjs` under unit test
/// rather than six sed heuristics that only integration tests could reach.
///
/// **WHERE the failure classification went.** It moved to `looksLikeToolFailure` in
/// `payload-extractors.mjs`, shapes unchanged, and is now unit-tested from both sides — including
/// the case the shell body got right and a naive rewrite gets wrong: the word `error` inside
/// `tool_input` (grepping for it, editing error-handling code) must never read as a failure that
/// did not happen.
///
/// It was tempting to delete instead. The old doc comment admitted the shapes had never been
/// checked against a captured failing payload, and three capture runs against Claude Code 2.1.221
/// produced none of them: a tool that fails emits **no** `PostToolUse` at all, so a failure is
/// visible as a `tool-pre` with no matching `tool-post`. (One apparent counter-example dissolved on
/// inspection — a `Bash` call that looked like a failing grep had `; echo "exit=$?"` appended, so
/// the shell exited 0 and the tool genuinely succeeded.) It was kept regardless: carrying an unused
/// branch is cheaper than losing a failure signal, and three observations are not enough to delete
/// evidence someone else gathered from a different agent.
///
/// **WHY `node` is not `exec`'d and its failure is swallowed.** A `PreToolUse` hook that exits
/// non-zero can BLOCK the tool call (confirmed by the ADR-8 spike, which used exactly that to
/// implement gating). `exec` would surface a broken Node invocation as a non-zero exit and start
/// silently blocking real work, so the call is made normally, its status discarded, and the script
/// always `exit 0`. No amount of saved milliseconds is worth that risk.
pub fn build_claude_tool_hook_script(drop_dir: &Path, notify_index: &Path) -> String {
    format!(
        "#!/bin/sh\n\
         # Lotus Claude tool hook — managed by Lotus, do not edit manually.\n\
         # Fires per tool call in EVERY Claude session on this machine. The guard is what keeps that\n\
         # cheap for sessions that are not Lotus panes: one shell spawn and exit, no stdin read.\n\
         [ -n \"$LOTUS_PANE_ID\" ] || exit 0\n\
         # LOTUS_AGENT_PID preserves the agentPid the previous shell body derived from $PPID.\n\
         # Failure is swallowed and the exit is always 0: a non-zero PreToolUse hook BLOCKS the tool.\n\
         # The phase names the event. `user` is UserPromptSubmit, which is not a tool call\n\
         # and must not be reported as one.\n\
         case \"$1\" in user) EV=prompt-submit ;; *) EV=\"tool-$1\" ;; esac\n\
         LOTUS_AGENT_PID=\"$PPID\" node \"{notify_index}\" \\\n  \
         --agent claude --event \"$EV\" --drop-dir \"{drop_dir}\" 2>/dev/null || true\n\
         exit 0\n",
        drop_dir = drop_dir.display(),
        notify_index = notify_index.display()
    )
}

/// Filename of this instance's Claude tool-hook script.
const LOTUS_CLAUDE_TOOL_HOOK_NAME: &str = "claude-tool-hook.sh";

/// Absolute path of this instance's Claude tool-hook script.
pub fn claude_tool_hook_script_path() -> Result<PathBuf, McpConfigError> {
    Ok(lotus_dir()?.join(LOTUS_CLAUDE_TOOL_HOOK_NAME))
}

/// Write this instance's Claude tool-hook script (mode 0755) and return its path for embedding in
/// `~/.claude/settings.json`. Idempotent — re-running on app restart refreshes the body, so script
/// fixes ship without the user doing anything.
pub fn install_claude_tool_hook_script() -> Result<PathBuf, McpConfigError> {
    let script_path = claude_tool_hook_script_path()?;
    if let Some(parent) = script_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let drop_dir = crate::agent_hooks::default_drop_dir().ok_or(McpConfigError::NoHome)?;
    // The script now shells out to the agent-notify entry, so it needs its path.
    let notify_index = agent_notify_index_path()?;
    fs::write(
        &script_path,
        build_claude_tool_hook_script(&drop_dir, &notify_index),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms)?;
    }
    Ok(script_path)
}

/// Write this instance's Claude Stop-hook script (mode 0755) and return its
/// path for embedding in `~/.claude/settings.json`. Idempotent — re-running on
/// app restart refreshes the body so script updates ship automatically.
pub fn install_claude_stop_hook_script() -> Result<PathBuf, McpConfigError> {
    let script_path = claude_stop_hook_script_path()?;
    if let Some(parent) = script_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&script_path, build_claude_stop_hook_script())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms)?;
    }
    Ok(script_path)
}

/// Build the fallback wrapper that chains to a previously-installed notify
/// command. `notify_args_raw` is the literal bracket content from the
/// existing TOML line (e.g. `"\"…/bs-agent-notify.cjs\""`). Codex uses
/// double-quoted TOML strings which double as valid shell tokens, so we
/// just strip the commas to convert TOML array → shell argv.
pub fn build_codex_notify_fallback_script(notify_args_raw: &str) -> String {
    let shell_args = notify_args_raw
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "#!/bin/sh\n\
         # Pre-existing Codex notify hook captured by Lotus during install.\n\
         # If you uninstall Lotus, restore your ~/.codex/config.toml notify\n\
         # line to:\n\
         #   notify = [{notify_args_raw}]\n\
         exec {shell_args} \"$@\"\n",
    )
}

/// Result of [`apply_codex_notify_line`].
///
/// `displaced` carries the literal bracket content of the previous notify
/// line when we overrode a non-Lotus hook (e.g. BridgeSpace). The caller is
/// expected to write that into a fallback script so Codex still triggers
/// the displaced command after Lotus.
#[derive(Debug, PartialEq, Eq)]
pub struct CodexNotifyMerge {
    pub config: String,
    pub displaced: Option<String>,
}

/// Pure string-level merge for `~/.codex/config.toml`. We deliberately avoid a
/// full TOML parse to preserve user formatting, comments, and ordering — the
/// notify key is top-level and a one-line replace is enough.
///
/// When the existing notify is non-Lotus, we still overwrite it but return
/// the displaced bracket content so the installer can chain to it via a
/// fallback wrapper. This is the BridgeSpace / custom-hook coexistence path.
/// The top-level `notify = [...]` entry, which may span several lines — Codex
/// Computer Use rewrites it as a multi-line array that wraps the previous hook
/// (`SkyComputerUseClient turn-ended --previous-notify '[…]'`). Replacing only
/// the `notify = [` line left the array's tail behind as orphan lines and made
/// `config.toml` unparseable ("key with no value, expected `=`").
struct CodexNotifySpan {
    /// First and last line index (inclusive) of the entry.
    first: usize,
    last: usize,
    /// The whole entry, lines joined with `\n`.
    text: String,
}

impl CodexNotifySpan {
    fn is_lotus(&self) -> bool {
        is_lotus_notify_text(&self.text)
    }

    /// The array's bracket content, trimmed.
    fn inside(&self) -> Option<String> {
        let start = self.text.find('[')?;
        let end = self.text.rfind(']')?;
        (end > start).then(|| self.text[start + 1..end].trim().to_string())
    }
}

fn is_notify_key_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    trimmed.starts_with("notify =") || trimmed.starts_with("notify=")
}

/// Bracket depth after scanning `line`, ignoring brackets inside TOML basic
/// (`"…"`, with escapes) and literal (`'…'`) strings.
fn notify_bracket_depth(line: &str, mut depth: i32) -> i32 {
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in line.chars() {
        match quote {
            Some('"') if escaped => escaped = false,
            Some('"') if ch == '\\' => escaped = true,
            Some(q) if ch == q => quote = None,
            Some(_) => {}
            None => match ch {
                '"' | '\'' => quote = Some(ch),
                '[' => depth += 1,
                ']' => depth -= 1,
                '#' => break,
                _ => {}
            },
        }
    }
    depth
}

fn find_codex_notify_span(lines: &[&str]) -> Option<CodexNotifySpan> {
    let first = lines.iter().position(|line| is_notify_key_line(line))?;
    let mut depth = 0;
    let mut last = first;
    for (idx, line) in lines.iter().enumerate().skip(first) {
        depth = notify_bracket_depth(line, depth);
        last = idx;
        if depth <= 0 {
            break;
        }
    }
    Some(CodexNotifySpan {
        first,
        last,
        text: lines[first..=last].join("\n"),
    })
}

pub fn apply_codex_notify_line(config_str: &str, argv: &[&str]) -> CodexNotifyMerge {
    // Escaped basic strings: a raw Windows path (`C:\Users`) is a TOML `\U` escape error.
    let quoted: Vec<String> = argv
        .iter()
        .map(|arg| format!("\"{}\"", arg.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    let target_line = format!("notify = [{}]", quoted.join(", "));
    let lines: Vec<&str> = config_str.lines().collect();

    if let Some(span) = find_codex_notify_span(&lines) {
        let mut replaced: Vec<&str> = Vec::with_capacity(lines.len());
        replaced.extend_from_slice(&lines[..span.first]);
        replaced.push(&target_line);
        replaced.extend_from_slice(&lines[span.last + 1..]);
        let mut joined = replaced.join("\n");
        if config_str.ends_with('\n') {
            joined.push('\n');
        }
        // A wrapper that already chains to a Lotus script (Computer Use's
        // `--previous-notify`) counts as Lotus: displacing it would chain
        // lotus → wrapper → lotus and loop.
        let displaced = if span.is_lotus() { None } else { span.inside() };
        return CodexNotifyMerge {
            config: joined,
            displaced,
        };
    }

    // No existing notify — prepend ours so it stays visible at the top of the
    // file. Preserve trailing newline conventions.
    let config = if config_str.is_empty() {
        format!("{target_line}\n")
    } else {
        let prefix = if config_str.starts_with('\n') {
            ""
        } else {
            "\n"
        };
        format!("{target_line}{prefix}{config_str}")
    };
    CodexNotifyMerge {
        config,
        displaced: None,
    }
}

/// Inverse of [`apply_codex_notify_line`]. Strips a Lotus-owned notify line
/// from the TOML body and returns the new string. User-owned notify lines are
/// left untouched.
pub fn strip_codex_notify_line(config_str: &str) -> String {
    let lines: Vec<&str> = config_str.lines().collect();
    let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
    for line in &lines {
        let trimmed = line.trim_start();
        let is_lotus_notify = (trimmed.starts_with("notify =") || trimmed.starts_with("notify="))
            && is_lotus_notify_text(trimmed);
        if !is_lotus_notify {
            kept.push(line);
        }
    }
    let mut out = kept.join("\n");
    if config_str.ends_with('\n') && !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// True when `config.toml` already carries a `notify` line pointing at the
/// Lotus notify script. The check is marker-based (the script's file name),
/// matching how [`apply_codex_notify_line`] recognises its own line — a
/// user-owned notify command does NOT count as present.
pub fn codex_notify_line_present(config_str: &str) -> bool {
    config_str.lines().any(|line| {
        let trimmed = line.trim_start();
        (trimmed.starts_with("notify =") || trimmed.starts_with("notify="))
            && is_lotus_notify_text(trimmed)
    })
}

/// Re-assert the Codex notify hook when it has gone missing — Codex's
/// `config.toml` has a SINGLE top-level `notify` slot and the CLI rewrites the
/// file when its settings change, which can drop our line long after the
/// startup install ran (observed in the field: turn-end signals from Codex
/// panes silently stop until the next Lotus restart). No-op (`Ok(false)`) when
/// the Lotus line and script are both in place; otherwise runs the full
/// [`install_codex_notify`] (script + merge + displaced-hook chaining) and
/// returns `Ok(true)`.
pub fn ensure_codex_notify(port: u16, secret: &str) -> Result<bool, McpConfigError> {
    let prior = read_or_empty(&codex_config_path()?)?;
    if codex_notify_line_present(&prior) && codex_notify_script_path()?.exists() {
        return Ok(false);
    }
    install_codex_notify(port, secret)?;
    Ok(true)
}

/// Write the notify script to `~/.lotus/codex-notify.sh` and merge the
/// `notify` line into `~/.codex/config.toml`. Idempotent across restarts.
///
/// `_port` / `_secret` are intentionally unused: the script fans out to every
/// instance's discovery file at RUN time (see [`build_codex_notify_script`]),
/// so nothing baked at install time can go stale. The parameters are kept so
/// the bootstrap call site in `lib.rs` stays source-compatible.
pub fn install_codex_notify(_port: u16, _secret: &str) -> Result<(), McpConfigError> {
    let script_path = codex_notify_script_path()?;
    if let Some(parent) = script_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = if cfg!(windows) {
        build_codex_notify_ps1()
    } else {
        build_codex_notify_script()
    };
    fs::write(&script_path, body)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms)?;
    }

    let cfg_path = codex_config_path()?;
    if let Some(parent) = cfg_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let prior = read_or_empty(&cfg_path)?;
    let script_str = script_path.to_string_lossy().into_owned();
    let argv = codex_notify_argv(&script_str, cfg!(windows));
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    let merged = apply_codex_notify_line(&prior, &argv);

    // Captured a pre-existing non-Lotus notify (e.g. BridgeSpace)? Persist a
    // fallback wrapper so Lotus's `codex-notify.sh` can chain through to it.
    // No displaced → ensure no stale fallback is left behind from a prior
    // install where the user had a custom hook but has since removed it.
    let fallback_path = codex_notify_fallback_path()?;
    match merged.displaced.as_deref() {
        // shortcut: the fallback chain is a `sh` script, so on Windows a displaced hook is
        // only logged, not chained; port it to PowerShell if a Windows user needs both.
        Some(args) if !args.is_empty() && cfg!(windows) => {
            eprintln!("[codex-notify] replaced a pre-existing notify hook (not chained on Windows): [{args}]");
        }
        Some(args) if !args.is_empty() => {
            fs::write(&fallback_path, build_codex_notify_fallback_script(args))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&fallback_path)?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&fallback_path, perms)?;
            }
            eprintln!(
                "[codex-notify] captured pre-existing notify hook into {} — Lotus will chain to it",
                fallback_path.display()
            );
        }
        _ => {
            // Idempotent cleanup: only remove if the file exists and we did
            // NOT just write it. Ignore not-found errors.
            let _ = fs::remove_file(&fallback_path);
        }
    }

    fs::write(&cfg_path, merged.config)?;
    Ok(())
}

/// Best-effort uninstall: strip Lotus's notify line + remove the script.
pub fn uninstall_codex_notify() -> Result<(), McpConfigError> {
    let cfg_path = codex_config_path()?;
    if cfg_path.exists() {
        let prior = fs::read_to_string(&cfg_path)?;
        let next = strip_codex_notify_line(&prior);
        if next != prior {
            fs::write(&cfg_path, next)?;
        }
    }
    if let Ok(script_path) = codex_notify_script_path() {
        let _ = fs::remove_file(script_path);
    }
    if let Ok(fallback_path) = codex_notify_fallback_path() {
        let _ = fs::remove_file(fallback_path);
    }
    Ok(())
}

// ── Agent-notify scripts ─────────────────────────────────────────────────────

const AGENT_NOTIFY_INDEX: &str = include_str!("../../scripts/agent-notify/index.mjs");
const AGENT_NOTIFY_PARSE_ARGS: &str = include_str!("../../scripts/agent-notify/parse-args.mjs");
const AGENT_NOTIFY_PAYLOAD_EXT: &str =
    include_str!("../../scripts/agent-notify/payload-extractors.mjs");
const AGENT_NOTIFY_EVENT_MAP: &str = include_str!("../../scripts/agent-notify/event-mapping.mjs");
const AGENT_NOTIFY_DROP_FILE: &str = include_str!("../../scripts/agent-notify/drop-file.mjs");
const AGENT_NOTIFY_RUN_HOOK: &str = include_str!("../../scripts/agent-notify/run-hook.mjs");

/// `~/.lotus/agent-notify/` — stable home for the drop-file hook scripts.
pub fn agent_notify_dir() -> Result<PathBuf, McpConfigError> {
    Ok(lotus_dir()?.join("agent-notify"))
}

pub fn agent_notify_index_path() -> Result<PathBuf, McpConfigError> {
    Ok(agent_notify_dir()?.join("index.mjs"))
}

/// Write the six agent-notify ES modules to `~/.lotus/agent-notify/`, creating
/// the directory if needed. Returns the path to `index.mjs` for use in hook
/// commands. Idempotent — re-running on app restart overwrites the previous
/// install, picking up any script updates automatically.
pub fn install_agent_notify_scripts() -> Result<PathBuf, McpConfigError> {
    let dir = agent_notify_dir()?;
    fs::create_dir_all(&dir)?;
    let files: &[(&str, &str)] = &[
        ("index.mjs", AGENT_NOTIFY_INDEX),
        ("parse-args.mjs", AGENT_NOTIFY_PARSE_ARGS),
        ("payload-extractors.mjs", AGENT_NOTIFY_PAYLOAD_EXT),
        ("event-mapping.mjs", AGENT_NOTIFY_EVENT_MAP),
        ("drop-file.mjs", AGENT_NOTIFY_DROP_FILE),
        ("run-hook.mjs", AGENT_NOTIFY_RUN_HOOK),
    ];
    for (name, content) in files {
        fs::write(dir.join(name), content)?;
    }
    Ok(dir.join("index.mjs"))
}

fn read_or_empty_object(path: &Path) -> Result<Map<String, Value>, McpConfigError> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Map::new()),
        Ok(text) => match serde_json::from_str::<Value>(&text)? {
            Value::Object(map) => Ok(map),
            other => {
                eprintln!(
                    "[mcp-config] {} is not a JSON object (type {:?}); replacing.",
                    path.display(),
                    std::mem::discriminant(&other)
                );
                Ok(Map::new())
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(err) => Err(err.into()),
    }
}

fn apply_lotus_entry(root: &mut Map<String, Value>, command: &str, args: &[String]) {
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let servers_map = match servers {
        Value::Object(m) => m,
        _ => {
            *servers = Value::Object(Map::new());
            match servers {
                Value::Object(m) => m,
                _ => unreachable!(),
            }
        }
    };
    servers_map.insert(
        mcp_server_key().to_string(),
        json!({
            "type": "stdio",
            "command": command,
            "args": args,
        }),
    );
}

pub fn has_exact_lotus_entry(root: &Value, command: &str, args: &[String]) -> bool {
    let Some(entry) = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get(mcp_server_key()))
        .and_then(Value::as_object)
    else {
        return false;
    };

    let args_value = Value::Array(args.iter().cloned().map(Value::String).collect());
    entry.get("type") == Some(&Value::String("stdio".to_string()))
        && entry.get("command") == Some(&Value::String(command.to_string()))
        && entry.get("args") == Some(&args_value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Tests mutate `~/.claude.json` + `~/.claude/lotus-mcp-ipc.json`, so we
    /// serialize them behind a global mutex to avoid cross-test races.
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// The keeper writes into every account's `.claude.json`, which a running CLI also writes, so
    /// an up-to-date or unrelated file must not be rewritten at all.
    #[test]
    fn an_up_to_date_config_is_never_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".claude.json");
        let args = vec!["x.mjs".to_string()];
        // Compact on purpose: a rewrite would pretty-print it and change the bytes.
        let mut root = serde_json::json!({"a":1});
        apply_lotus_entry(root.as_object_mut().unwrap(), "bun", &args);
        let text = serde_json::to_string(&root).unwrap();
        std::fs::write(&file, &text).unwrap();

        // The keeper's guard: an exact entry means no install call.
        assert!(has_exact_lotus_entry(&serde_json::from_str(&text).unwrap(), "bun", &args));
        // Removing a key that is absent writes nothing.
        remove_mcp_entry_by_key_at(&file, "lotus-other").unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    }

    #[test]
    fn ipc_discovery_roundtrip() {
        let _g = TEST_LOCK.lock().unwrap();
        let file = IpcDiscoveryFile {
            version: 1,
            port: 4242,
            secret: "deadbeef".into(),
            pid: 9999,
            profile_key: "lotus".into(),
        };
        let path = write_ipc_discovery(&file).expect("write");
        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: IpcDiscoveryFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed, file);
        let _ = remove_ipc_discovery_if_ours(9999);
    }

    #[test]
    fn remove_only_if_pid_matches() {
        let _g = TEST_LOCK.lock().unwrap();
        let file = IpcDiscoveryFile {
            version: 1,
            port: 1,
            secret: "x".into(),
            pid: 123,
            profile_key: "lotus".into(),
        };
        let path = write_ipc_discovery(&file).unwrap();
        // Different pid should not delete.
        remove_ipc_discovery_if_ours(999).unwrap();
        assert!(path.exists());
        // Matching pid deletes.
        remove_ipc_discovery_if_ours(123).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn apply_lotus_entry_preserves_other_keys() {
        let mut root = Map::new();
        root.insert("theme".into(), json!("dark"));
        root.insert(
            "mcpServers".into(),
            json!({ "existing": { "command": "keep" } }),
        );
        apply_lotus_entry(&mut root, "bun", &["run".into(), "script.mjs".into()]);
        assert_eq!(root["theme"], json!("dark"));
        let servers = root["mcpServers"].as_object().unwrap();
        assert_eq!(servers["existing"]["command"], json!("keep"));
        let key = mcp_server_key();
        assert_eq!(servers[key]["type"], json!("stdio"));
        assert_eq!(servers[key]["command"], json!("bun"));
        assert_eq!(servers[key]["args"][1], json!("script.mjs"));
    }

    #[test]
    fn apply_lotus_entry_creates_container_when_absent() {
        let mut root = Map::new();
        apply_lotus_entry(&mut root, "bun", &["a".into()]);
        assert!(root["mcpServers"][mcp_server_key()].is_object());
    }

    #[test]
    fn apply_lotus_entry_is_idempotent_and_preserves_other_lotus_profile() {
        let mut root = Map::new();
        let current_key = mcp_server_key();
        let other_key = if current_key == "lotus" {
            "lotus-dev"
        } else {
            "lotus"
        };
        root.insert(
            "mcpServers".into(),
            json!({ other_key: { "type": "stdio", "command": "other-node", "args": ["other-script"] } }),
        );
        let args = vec![
            "script.mjs".to_string(),
            "--discovery".to_string(),
            "ipc.json".to_string(),
        ];

        apply_lotus_entry(&mut root, "node", &args);
        let once = Value::Object(root.clone());
        apply_lotus_entry(&mut root, "node", &args);
        let twice = Value::Object(root.clone());

        assert_eq!(twice, once);
        assert_eq!(
            root["mcpServers"][other_key]["command"],
            json!("other-node")
        );
        assert!(has_exact_lotus_entry(&twice, "node", &args));
    }

    #[test]
    fn apply_lotus_entry_replaces_existing_lotus() {
        let mut root = Map::new();
        let key = mcp_server_key();
        root.insert(
            "mcpServers".into(),
            json!({ key: { "command": "OLD", "args": ["stale"] } }),
        );
        apply_lotus_entry(&mut root, "bun", &["fresh".into()]);
        assert_eq!(root["mcpServers"][key]["command"], json!("bun"));
        assert_eq!(root["mcpServers"][key]["args"][0], json!("fresh"));
    }

    #[test]
    fn mcp_server_key_branches_on_profile() {
        let key = mcp_server_key();
        if paths::is_dev_profile() {
            assert_eq!(key, "lotus-dev");
        } else {
            assert_eq!(key, "lotus");
        }
    }

    #[test]
    fn build_lotus_sidecar_args_appends_discovery_path() {
        let script = Path::new("/tmp/lotus-mcp-server.mjs");
        let (cmd, args) = build_lotus_sidecar_args("node", script);
        assert_eq!(cmd, "node");
        assert_eq!(args[0], "/tmp/lotus-mcp-server.mjs");
        // Discovery flag is best-effort: present iff home resolves; in CI/test
        // it normally does. Tolerate the fallback case but validate flag shape
        // when it is included.
        if args.len() >= 3 {
            assert_eq!(args[1], "--discovery");
            assert!(args[2].ends_with("lotus-mcp-ipc.json"));
        }
    }

    #[test]
    fn build_lotus_mcp_launch_config_contains_only_current_profile() {
        let config = build_lotus_mcp_launch_config("node", &["/tmp/lotus-mcp-server.mjs".into()]);
        let key = mcp_server_key();
        assert_eq!(config.profile_key, key);
        assert_eq!(config.config["mcpServers"][key]["type"], json!("stdio"));
        assert_eq!(config.config["mcpServers"][key]["command"], json!("node"));
        assert_eq!(
            config.config["mcpServers"][key]["args"][0],
            json!("/tmp/lotus-mcp-server.mjs")
        );
        assert_eq!(config.config["mcpServers"].as_object().unwrap().len(), 1);
    }

    #[test]
    fn embedded_lotus_mcp_server_is_bundled_for_node_runtime() {
        assert!(LOTUS_MCP_SERVER_SCRIPT.contains("lotus_list_fleet"));
        assert!(!LOTUS_MCP_SERVER_SCRIPT.contains("from \"@modelcontextprotocol/sdk"));
        assert!(!LOTUS_MCP_SERVER_SCRIPT.contains("from '@modelcontextprotocol/sdk"));
    }

    #[test]
    fn exact_lotus_entry_requires_type_command_and_args_match() {
        let mut root = Map::new();
        let args = vec!["/home/u/.lotus/lotus-mcp-server.mjs".to_string()];
        apply_lotus_entry(&mut root, "node", &args);
        let root = Value::Object(root);

        assert!(has_exact_lotus_entry(&root, "node", &args));
        assert!(!has_exact_lotus_entry(&root, "bun", &args));
        assert!(!has_exact_lotus_entry(
            &root,
            "node",
            &["/stale/lotus-mcp-server.mjs".to_string()]
        ));
    }

    #[test]
    fn embedded_lotus_mcp_server_wires_tool_surface() {
        // The embedded sidecar is the exact bundled script installed for Claude CLI.
        // Bun may strip comments, so assert runtime-visible tool and SDK symbols.
        assert!(LOTUS_MCP_SERVER_SCRIPT.contains("lotus_list_fleet"));
        assert!(LOTUS_MCP_SERVER_SCRIPT.contains("ListToolsRequestSchema"));
        assert!(LOTUS_MCP_SERVER_SCRIPT.contains("CallToolRequestSchema"));
    }

    #[test]
    fn read_or_empty_returns_empty_for_missing() {
        let _g = TEST_LOCK.lock().unwrap();
        let path =
            std::env::temp_dir().join(format!("lotus-mcp-test-{}.json", rand::random::<u64>()));
        let result = read_or_empty_object(&path).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn read_or_empty_returns_empty_for_blank() {
        let _g = TEST_LOCK.lock().unwrap();
        let path = std::env::temp_dir().join(format!(
            "lotus-mcp-test-blank-{}.json",
            rand::random::<u64>()
        ));
        std::fs::write(&path, "   \n  ").unwrap();
        let result = read_or_empty_object(&path).unwrap();
        assert!(result.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    // ── Codex notify ────────────────────────────────────────────────────────

    #[test]
    fn codex_notify_script_fans_out_to_both_instance_state_dirs() {
        // The ~/.codex/config.toml notify line is a single slot: whichever
        // instance (dev/release) installed last owns the script path. The
        // script therefore posts to EVERY instance whose discovery file
        // exists, reading port+secret at RUN time — the losing instance no
        // longer goes deaf, and nothing is baked in that can go stale.
        let s = build_codex_notify_script();
        assert!(s.starts_with("#!/bin/sh"));
        assert!(s.contains("\"$HOME/.lotus\""));
        assert!(s.contains("\"$HOME/.lotus-dev\""));
        assert!(s.contains("lotus-mcp-ipc.json"));
        // Runtime-extracted values, not literals.
        assert!(s.contains(r#""port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\)"#));
        assert!(s.contains(r#""secret"[[:space:]]*:[[:space:]]*"\([^"]*\)""#));
        assert!(s.contains("http://127.0.0.1:$_LOTUS_PORT/v1/hook/stop"));
        assert!(s.contains("Authorization: Bearer $_LOTUS_SECRET"));
        assert!(s.contains("${LOTUS_PANE_ID}"));
        assert!(s.contains("-m 3"), "curl must be bounded per instance");
        assert!(s.contains("|| true"));
    }

    #[test]
    fn codex_notify_script_reads_payload_from_argv_not_stdin() {
        // Codex invokes the notify program with the JSON as the FINAL ARGV ARGUMENT and stdin
        // wired to Stdio::null() (codex-rs/hooks/src/legacy_notify.rs). A `$(cat)` reader sees an
        // empty string, so the turn-complete filter never matched and the hook NEVER fired —
        // field failure: Codex panes only ever toasted via the slow byte-idle fallback.
        let s = build_codex_notify_script();
        assert!(s.contains(r#"_LOTUS_NOTIFY_PAYLOAD="${1:-}""#));
        assert!(!s.contains("$(cat)"));
        assert!(s.contains("agent-turn-complete"));
        assert!(s.contains("grep -q"));
    }

    #[test]
    fn codex_notify_script_chains_to_fallback_when_present() {
        let s = build_codex_notify_script();
        assert!(s.contains("_LOTUS_FALLBACK"));
        assert!(s.contains("codex-notify-fallback.sh"));
        // Forwards the JSON payload Codex passes on stdin to the fallback.
        assert!(s.contains("printf '%s' \"$_LOTUS_NOTIFY_PAYLOAD\""));
        assert!(s.contains("\"$@\""));
    }

    #[test]
    fn build_codex_notify_fallback_script_chains_single_arg() {
        let s = build_codex_notify_fallback_script("\"/usr/local/bin/buzz\"");
        assert!(s.starts_with("#!/bin/sh"));
        assert!(s.contains("exec \"/usr/local/bin/buzz\" \"$@\""));
    }

    #[test]
    fn build_codex_notify_fallback_script_chains_multi_args() {
        // Strip commas → shell argv. TOML double-quoted strings are valid
        // shell tokens already.
        let s =
            build_codex_notify_fallback_script("\"/usr/local/bin/notifier\", \"--mode\", \"loud\"");
        assert!(s.contains("exec \"/usr/local/bin/notifier\" \"--mode\" \"loud\" \"$@\""));
    }

    // ── Claude stop-hook script (runtime-config, instance-scoped) ──────────

    #[test]
    fn claude_stop_hook_script_reads_stdin_and_extracts_session_id() {
        let s = build_claude_stop_hook_script();
        assert!(s.starts_with("#!/bin/sh"));
        // Claude's Stop hook pipes a JSON payload on stdin — read it ONCE.
        assert!(s.contains("_P=$(cat)"));
        // session_id extraction via sed (no jq dependency on user machines).
        assert!(s.contains(r#"s/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p"#));
    }

    #[test]
    fn claude_stop_hook_script_reads_own_dir_ipc_config_at_runtime() {
        let s = build_claude_stop_hook_script();
        // The script lives in the instance state dir next to the discovery
        // file, so `dirname $0` scopes it to its own instance (dev/release).
        assert!(s.contains(r#"$(dirname "$0")/lotus-mcp-ipc.json"#));
        // Port is a bare number, secret a quoted string in the discovery file.
        assert!(s.contains(r#""port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\)"#));
        assert!(s.contains(r#""secret"[[:space:]]*:[[:space:]]*"\([^"]*\)""#));
        // Lotus not running / never installed → silent no-op, never an error.
        assert!(s.contains("exit 0"));
    }

    #[test]
    fn claude_stop_hook_script_posts_rich_payload_with_timeout() {
        let s = build_claude_stop_hook_script();
        assert!(s.contains("/v1/hook/stop"));
        assert!(
            s.contains("-m 3"),
            "curl must be bounded so a dead listener never stalls the agent turn"
        );
        assert!(s.contains(r#"\"pane_id\": \"$LOTUS_PANE_ID\""#));
        assert!(s.contains(r#"\"session_id\": \"$sid\""#));
        // $PPID = the hook shell's parent = the claude process that fired the
        // Stop hook. Lets the receiver detect nested `claude -p` children.
        assert!(s.contains(r#"\"agent_pid\": $PPID"#));
        assert!(s.contains("|| true"));
        assert!(s.trim_end().ends_with("exit 0"));
    }

    /// End-to-end: run the real script under /bin/sh with a curl shim and a
    /// fake discovery file, and assert it posts the runtime port/secret —
    /// this is the property that makes the settings.json entry restart-proof.
    #[cfg(unix)]
    #[test]
    fn claude_stop_hook_script_end_to_end_posts_runtime_config() {
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("lotus-stop-hook-e2e-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude-stop-hook.sh");
        std::fs::write(&script, build_claude_stop_hook_script()).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            dir.join("lotus-mcp-ipc.json"),
            r#"{ "port": 43210, "secret": "s3cr3t-e2e", "pid": 1 }"#,
        )
        .unwrap();
        // curl shim: records argv instead of doing network IO.
        let capture = dir.join("curl-args.txt");
        let shim = dir.join("curl");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\n",
                capture.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();

        let run = |payload: &[u8]| {
            let mut child = std::process::Command::new("/bin/sh")
                .arg(&script)
                .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
                .env("LOTUS_PANE_ID", "pane-42")
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(payload).unwrap();
            assert!(child.wait().unwrap().success(), "hook must always exit 0");
            std::fs::read_to_string(&capture).expect("curl shim invoked")
        };

        let args = run(br#"{"session_id": "sess-abc", "transcript_path": "/x"}"#);
        assert!(args.contains("http://127.0.0.1:43210/v1/hook/stop"));
        assert!(args.contains("Bearer s3cr3t-e2e"));
        assert!(args.contains(r#""pane_id": "pane-42""#));
        assert!(args.contains(r#""session_id": "sess-abc""#));
        assert!(args.contains(r#""agent_pid": "#));
        assert!(args.contains(r#""error": """#), "a plain Stop carries no error: {args}");

        // StopFailure on a usage limit: the error type and the CLI's message ride along.
        let args = run(
            r#"{"session_id":"sess-abc","hook_event_name":"StopFailure","error":"rate_limit","error_details":"429","last_assistant_message":"You've hit your 5-hour limit · resets 2:20pm (Asia/Jakarta)"}"#
                .as_bytes(),
        );
        assert!(args.contains(r#""error": "rate_limit""#), "{args}");
        assert!(args.contains(r#""message": "You've hit your 5-hour limit · resets 2:20pm (Asia/Jakarta)""#), "{args}");
        serde_json::from_str::<serde_json::Value>(args.lines().find(|l| l.starts_with('{')).unwrap())
            .expect("body stays valid JSON");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Missing discovery file (Lotus uninstalled or never started) must be a
    /// clean exit-0 no-op: curl is never invoked, the agent turn never fails.
    #[cfg(unix)]
    #[test]
    fn claude_stop_hook_script_exits_zero_when_ipc_file_missing() {
        use std::io::Write as _;
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("lotus-stop-hook-noipc-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("claude-stop-hook.sh");
        std::fs::write(&script, build_claude_stop_hook_script()).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let capture = dir.join("curl-args.txt");
        let shim = dir.join("curl");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\n",
                capture.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut child = std::process::Command::new("/bin/sh")
            .arg(&script)
            .env("PATH", format!("{}:/usr/bin:/bin", dir.display()))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"{}").unwrap();
        let status = child.wait().unwrap();
        assert!(
            status.success(),
            "must exit 0 even without a discovery file"
        );
        assert!(!capture.exists(), "curl must not be invoked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn apply_codex_notify_writes_into_empty_config() {
        let merged = apply_codex_notify_line("", &["/home/u/.lotus/codex-notify.sh"]);
        assert_eq!(
            merged.config,
            "notify = [\"/home/u/.lotus/codex-notify.sh\"]\n"
        );
        assert_eq!(merged.displaced, None);
    }

    #[test]
    fn windows_notify_runs_powershell_and_stays_lotus_owned() {
        let script = r"C:\Users\u\.lotus\codex-notify.ps1";
        assert_eq!(
            codex_notify_argv("/h/.lotus/codex-notify.sh", false),
            ["/h/.lotus/codex-notify.sh"]
        );
        let argv = codex_notify_argv(script, true);
        assert_eq!(
            argv,
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                script
            ]
        );
        let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
        let first = apply_codex_notify_line("", &argv);
        let again = apply_codex_notify_line(&first.config, &argv);
        assert_eq!(again.config, first.config);
        assert_eq!(
            again.displaced, None,
            "its own line must not be chained back to itself"
        );
        assert!(codex_notify_line_present(&first.config));
        assert!(!strip_codex_notify_line(&first.config).contains("notify"));
    }

    #[test]
    fn apply_codex_notify_escapes_windows_backslashes() {
        // A raw `"C:\Users…"` is a TOML parse error: `\U` reads as a unicode escape.
        let merged = apply_codex_notify_line("", &[r"C:\Users\alwi\.lotus\codex-notify.ps1"]);
        assert_eq!(
            merged.config,
            "notify = [\"C:\\\\Users\\\\alwi\\\\.lotus\\\\codex-notify.ps1\"]\n"
        );
    }

    #[test]
    fn apply_codex_notify_prepends_when_no_notify_present() {
        let prior = "model = \"o4-mini\"\nsandbox_mode = \"workspace\"\n";
        let merged = apply_codex_notify_line(prior, &["/h/.lotus/codex-notify.sh"]);
        assert!(merged
            .config
            .starts_with("notify = [\"/h/.lotus/codex-notify.sh\"]"));
        assert!(merged.config.contains("model = \"o4-mini\""));
        assert!(merged.config.contains("sandbox_mode = \"workspace\""));
        assert_eq!(merged.displaced, None);
    }

    #[test]
    fn apply_codex_notify_replaces_existing_lotus_line_only() {
        let prior =
            "model = \"o4-mini\"\nnotify = [\"/old/path/codex-notify.sh\"]\nsandbox = \"ro\"\n";
        let merged = apply_codex_notify_line(prior, &["/new/path/codex-notify.sh"]);
        assert!(merged
            .config
            .contains("notify = [\"/new/path/codex-notify.sh\"]"));
        assert!(!merged.config.contains("/old/path/codex-notify.sh"));
        assert!(merged.config.contains("model = \"o4-mini\""));
        assert!(merged.config.contains("sandbox = \"ro\""));
        // Old Lotus line → no fallback needed.
        assert_eq!(merged.displaced, None);
    }

    #[test]
    fn apply_codex_notify_captures_displaced_non_lotus_notify() {
        // Real-world failure: BridgeSpace owned `~/.codex/config.toml` notify
        // line. Old behavior refused to overwrite, leaving Lotus silent.
        // New behavior: overwrite + capture displaced args so the install
        // step can chain to BridgeSpace via a fallback script.
        let prior = "notify = [\"/usr/local/bin/buzz\"]\nmodel = \"o4-mini\"\n";
        let merged = apply_codex_notify_line(prior, &["/h/.lotus/codex-notify.sh"]);
        assert!(merged
            .config
            .contains("notify = [\"/h/.lotus/codex-notify.sh\"]"));
        assert!(!merged.config.contains("/usr/local/bin/buzz"));
        assert_eq!(merged.displaced.as_deref(), Some("\"/usr/local/bin/buzz\""));
    }

    #[test]
    fn apply_codex_notify_is_idempotent_when_already_lotus() {
        let prior = "notify = [\"/h/.lotus/codex-notify.sh\"]\n";
        let merged = apply_codex_notify_line(prior, &["/h/.lotus/codex-notify.sh"]);
        assert_eq!(merged.config, prior);
        assert_eq!(merged.displaced, None);
    }

    #[test]
    fn codex_notify_line_present_detects_lotus_line() {
        assert!(codex_notify_line_present(
            "model = \"o4-mini\"\nnotify = [\"/h/.lotus/codex-notify.sh\"]\n"
        ));
        assert!(codex_notify_line_present(
            "notify=[\"/h/.lotus-dev/codex-notify.sh\"]\n"
        ));
    }

    #[test]
    fn codex_notify_line_present_is_false_when_wiped_or_user_owned() {
        // The field failure: Codex rewrote config.toml and dropped our line entirely.
        assert!(!codex_notify_line_present("model = \"o4-mini\"\n"));
        assert!(!codex_notify_line_present(""));
        // A user-owned notify command is NOT ours — ensure_codex_notify must go
        // through the full install path so it gets displaced-and-chained.
        assert!(!codex_notify_line_present(
            "notify = [\"/usr/local/bin/buzz\"]\n"
        ));
        // The marker inside a comment or another key must not count.
        assert!(!codex_notify_line_present(
            "# notify used to be codex-notify.sh\nmodel = \"o4-mini\"\n"
        ));
    }

    #[test]
    fn apply_codex_notify_replaces_other_instance_lotus_line_without_displacement() {
        // Dev/release coexistence: the other instance's codex-notify.sh is
        // Lotus-owned and content-equivalent (both fan out to all instances),
        // so we replace it WITHOUT capturing it as a displaced fallback —
        // capturing it would chain lotus→lotus and risk a notify loop.
        let prior = "notify = [\"/h/.lotus/codex-notify.sh\"]\nmodel = \"o4-mini\"\n";
        let merged = apply_codex_notify_line(prior, &["/h/.lotus-dev/codex-notify.sh"]);
        assert!(merged
            .config
            .contains("notify = [\"/h/.lotus-dev/codex-notify.sh\"]"));
        assert!(!merged
            .config
            .contains("notify = [\"/h/.lotus/codex-notify.sh\"]"));
        assert_eq!(
            merged.displaced, None,
            "other-instance lotus line must not become a fallback"
        );
    }

    #[test]
    fn apply_codex_mcp_entry_preserves_existing_servers_and_notify() {
        let prior = r#"notify = ["/custom/hook"]
model = "gpt-5.5"

[mcp_servers.computer-use]
command = "computer"
args = ["mcp"]
"#;
        let args = vec!["/h/.lotus-dev/lotus-mcp-server.mjs".to_string()];
        let merged = apply_codex_mcp_entry(prior, "lotus-dev", "node", &args);

        assert!(merged.contains("notify = [\"/custom/hook\"]"));
        assert!(merged.contains("model = \"gpt-5.5\""));
        assert!(merged.contains("[mcp_servers.computer-use]"));
        assert!(merged.contains("command = \"computer\""));
        assert!(merged.contains("[mcp_servers.lotus-dev]"));
        assert!(merged.contains("command = \"node\""));
        assert!(merged.contains("args = [\"/h/.lotus-dev/lotus-mcp-server.mjs\"]"));
    }

    #[test]
    fn apply_codex_mcp_entry_is_idempotent_and_preserves_other_lotus_profile() {
        let prior = r#"notify = ["/custom/hook"]

[mcp_servers.lotus]
command = "release-node"
args = ["release-script"]
"#;
        let args = vec!["/h/.lotus-dev/lotus-mcp-server.mjs".to_string()];

        let once = apply_codex_mcp_entry(prior, "lotus-dev", "node", &args);
        let twice = apply_codex_mcp_entry(&once, "lotus-dev", "node", &args);

        assert_eq!(twice, once);
        assert!(twice.contains("notify = [\"/custom/hook\"]"));
        assert!(twice.contains("[mcp_servers.lotus]"));
        assert!(twice.contains("command = \"release-node\""));
        assert!(has_exact_codex_mcp_entry(
            &twice,
            "lotus-dev",
            "node",
            &args
        ));
    }

    #[test]
    fn apply_codex_mcp_entry_replaces_only_current_lotus_profile_block() {
        let prior = r#"[mcp_servers.lotus-dev]
command = "old"
args = ["stale"]

[mcp_servers.other]
command = "keep"
"#;
        let args = vec!["fresh".to_string()];
        let merged = apply_codex_mcp_entry(prior, "lotus-dev", "node", &args);

        assert!(!merged.contains("command = \"old\""));
        assert!(!merged.contains("args = [\"stale\"]"));
        assert!(merged.contains("[mcp_servers.other]"));
        assert!(merged.contains("command = \"keep\""));
        assert!(merged.contains("[mcp_servers.lotus-dev]"));
        assert!(merged.contains("command = \"node\""));
        assert!(merged.contains("args = [\"fresh\"]"));
    }

    #[test]
    fn has_exact_codex_mcp_entry_matches_command_and_args() {
        let args = vec![
            "/h/.lotus-dev/lotus-mcp-server.mjs".to_string(),
            "--discovery".to_string(),
            "/h/.lotus-dev/lotus-mcp-ipc.json".to_string(),
        ];
        let config = apply_codex_mcp_entry("", "lotus-dev", "node", &args);

        assert!(has_exact_codex_mcp_entry(
            &config,
            "lotus-dev",
            "node",
            &args
        ));
        assert!(!has_exact_codex_mcp_entry(&config, "lotus", "node", &args));
        assert!(!has_exact_codex_mcp_entry(
            &config,
            "lotus-dev",
            "bun",
            &args
        ));
        assert!(!has_exact_codex_mcp_entry(
            &config,
            "lotus-dev",
            "node",
            &["stale".to_string()]
        ));
    }

    #[test]
    fn strip_codex_notify_removes_only_lotus_line() {
        let prior =
            "model = \"o4-mini\"\nnotify = [\"/h/.lotus/codex-notify.sh\"]\nsandbox = \"ro\"\n";
        let out = strip_codex_notify_line(prior);
        assert!(!out.contains("notify = ["));
        assert!(out.contains("model = \"o4-mini\""));
        assert!(out.contains("sandbox = \"ro\""));
    }

    #[test]
    fn strip_codex_notify_leaves_user_owned_notify_alone() {
        let prior = "notify = [\"/usr/local/bin/buzz\"]\nmodel = \"o4-mini\"\n";
        let out = strip_codex_notify_line(prior);
        assert_eq!(out, prior);
    }

    #[test]
    fn install_mcp_config_entry_at_writes_to_given_path_creating_parents() {
        // Profile-aware install (a 2nd-account CLAUDE_CONFIG_DIR): writes the lotus entry into an
        // arbitrary .claude.json, creating missing parent dirs.
        let base = std::env::temp_dir().join("lotus_mcp_at_test_9f3a2");
        let _ = std::fs::remove_dir_all(&base);
        let path = base.join("profile").join(".claude.json");
        let args = vec![
            "/x/server.mjs".to_string(),
            "--discovery".to_string(),
            "/y/ipc.json".to_string(),
        ];
        let written = install_mcp_config_entry_at(&path, "node", &args).unwrap();
        assert_eq!(written, path);
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(has_exact_lotus_entry(&root, "node", &args));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn remove_mcp_entry_by_key_at_evicts_only_the_named_key() {
        // A profile config with a dead `lotus` (release) entry alongside a live `lotus-dev` — evicting
        // the dead key must leave the live one intact.
        let base = std::env::temp_dir().join("lotus_remove_at_test_9f3a2");
        let _ = std::fs::remove_dir_all(&base);
        let path = base.join(".claude.json");
        let live = vec!["/dev/server.mjs".to_string()];
        install_mcp_config_entry_at(&path, "node", &live).unwrap();
        // Add a second (stale) server key by hand.
        let mut root: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        root["mcpServers"]["lotus"] =
            serde_json::json!({ "command": "node", "args": ["/rel/server.mjs"] });
        std::fs::write(&path, serde_json::to_vec_pretty(&root).unwrap()).unwrap();

        remove_mcp_entry_by_key_at(&path, "lotus").unwrap();

        let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let servers = after["mcpServers"].as_object().unwrap();
        assert!(!servers.contains_key("lotus"), "dead key removed");
        assert!(servers.contains_key(mcp_server_key()), "live key preserved");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn cursor_mcp_config_path_points_at_dot_cursor_mcp_json() {
        let path = cursor_mcp_config_path().unwrap();
        assert!(path.ends_with(".cursor/mcp.json"));
    }

    #[test]
    fn cursor_mcp_entry_uses_claude_json_shape() {
        // Cursor's mcp.json is the same {"mcpServers": {...}} shape, so the JSON
        // installer produces a Cursor-valid file.
        let base = std::env::temp_dir().join("lotus_cursor_mcp_test_9f3a2");
        let _ = std::fs::remove_dir_all(&base);
        let path = base.join(".cursor").join("mcp.json");
        let args = vec![
            "/x/server.mjs".to_string(),
            "--discovery".to_string(),
            "/y/ipc.json".to_string(),
        ];
        install_mcp_config_entry_at(&path, "node", &args).unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(has_exact_lotus_entry(&root, "node", &args));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn install_codex_mcp_config_entry_at_writes_to_given_path() {
        let base = std::env::temp_dir().join("lotus_codex_at_test_9f3a2");
        let _ = std::fs::remove_dir_all(&base);
        let path = base.join("codexhome").join("config.toml");
        let args = vec!["/x/server.mjs".to_string()];
        let written = install_codex_mcp_config_entry_at(&path, "node", &args).unwrap();
        assert_eq!(written, path);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(has_exact_codex_mcp_entry(
            &text,
            codex_mcp_server_key(),
            "node",
            &args
        ));
        let _ = std::fs::remove_dir_all(&base);
    }

    // ── F8/F9: codex config.toml MCP entry removal (RC5 registration hygiene) ──

    const CODEX_CONFIG_SAMPLE: &str = "notify = [\"hook.sh\"]\n\
\n\
[mcp_servers.node_repl]\n\
command = \"bun\"\n\
args = [\"repl\"]\n\
\n\
[mcp_servers.lotus-dev]\n\
command = \"node\"\n\
args = [\"/Users/x/.lotus-dev/lotus-mcp-server.mjs\", \"--discovery\", \"/Users/x/.lotus-dev/lotus-mcp-ipc.json\"]\n\
\n\
[mcp_servers.lotus-dev.tools.lotus_read_cell_output]\n\
approval_mode = \"approve\"\n\
\n\
[mcp_servers.lotus]\n\
command = \"node\"\n\
args = [\"/Users/x/.lotus/lotus-mcp-server.mjs\", \"--discovery\", \"/Users/x/.lotus/lotus-mcp-ipc.json\"]\n";

    #[test]
    fn strip_codex_mcp_entry_removes_only_the_target_table() {
        let out = strip_codex_mcp_entry(CODEX_CONFIG_SAMPLE, "lotus-dev");
        assert!(
            !out.contains("[mcp_servers.lotus-dev]"),
            "target table gone"
        );
        // Siblings and the notify line survive intact.
        assert!(out.contains("[mcp_servers.lotus]"));
        assert!(out.contains("/Users/x/.lotus/lotus-mcp-ipc.json"));
        assert!(out.contains("[mcp_servers.node_repl]"));
        assert!(out.contains("notify = [\"hook.sh\"]"));
        // No orphaned body line from the removed table.
        assert!(!out.contains("/Users/x/.lotus-dev/lotus-mcp-ipc.json"));
    }

    /// The bug that killed every Codex cell on 2026-08-10.
    ///
    /// A sub-table left behind re-creates its parent in TOML, so `mcp_servers.lotus-dev`
    /// came back as a table with no `command` and no `url`. Codex reads that as a server
    /// with no transport and refuses the whole file — `Error loading config.toml: invalid
    /// transport in mcp_servers.lotus-dev` — so the blast radius is every Codex cell, not
    /// just the entry being removed.
    #[test]
    fn strip_codex_mcp_entry_takes_the_sub_tables_with_it() {
        let out = strip_codex_mcp_entry(CODEX_CONFIG_SAMPLE, "lotus-dev");

        assert!(
            !out.contains("[mcp_servers.lotus-dev.tools.lotus_read_cell_output]"),
            "a surviving child re-creates the parent as a transport-less server"
        );
        assert!(!out.contains("approval_mode"));
        // And the sibling whose key merely shares a prefix is untouched.
        assert!(out.contains("[mcp_servers.lotus]"));
    }

    /// `lotus` is a prefix of `lotus-dev`, and both are keys this codebase installs. A
    /// prefix match without the dot would delete the live entry while cleaning the dead one.
    #[test]
    fn strip_codex_mcp_entry_does_not_treat_a_prefix_as_a_sub_table() {
        let out = strip_codex_mcp_entry(CODEX_CONFIG_SAMPLE, "lotus");

        assert!(!out.contains("[mcp_servers.lotus]"));
        assert!(out.contains("[mcp_servers.lotus-dev]"));
        assert!(out.contains("[mcp_servers.lotus-dev.tools.lotus_read_cell_output]"));
    }

    /// Re-installing has to reclaim the same ground the removal does, or a stale sub-table
    /// outlives the rewrite and the file is broken again on the next launch.
    #[test]
    fn apply_codex_mcp_entry_replaces_sub_tables_too() {
        let out = apply_codex_mcp_entry(
            CODEX_CONFIG_SAMPLE,
            "lotus-dev",
            "node",
            &["/new/server.mjs".to_string()],
        );

        assert!(!out.contains("[mcp_servers.lotus-dev.tools.lotus_read_cell_output]"));
        assert!(out.contains("[mcp_servers.lotus-dev]"));
        assert!(out.contains("/new/server.mjs"));
        assert!(out.contains("[mcp_servers.lotus]"));
    }

    #[test]
    fn strip_codex_mcp_entry_is_noop_when_target_absent() {
        let out = strip_codex_mcp_entry(CODEX_CONFIG_SAMPLE, "not-here");
        assert!(out.contains("[mcp_servers.lotus]"));
        assert!(out.contains("[mcp_servers.lotus-dev]"));
        assert!(out.contains("[mcp_servers.node_repl]"));
    }

    #[test]
    fn remove_codex_mcp_entry_by_key_at_evicts_the_dead_profile() {
        let base =
            std::env::temp_dir().join(format!("lotus_codex_strip_test_{}", rand::random::<u64>()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let path = base.join("config.toml");
        std::fs::write(&path, CODEX_CONFIG_SAMPLE).unwrap();

        let changed = remove_codex_mcp_entry_by_key_at(&path, "lotus-dev").unwrap();
        assert!(changed, "removal should report a write");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("[mcp_servers.lotus-dev]"));
        assert!(text.contains("[mcp_servers.lotus]"));

        // Idempotent: a second call is a no-op.
        let changed_again = remove_codex_mcp_entry_by_key_at(&path, "lotus-dev").unwrap();
        assert!(!changed_again);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn install_codex_mcp_entry_does_not_wipe_a_config_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        // Not valid UTF-8: read_to_string fails, which must not be mistaken for "empty file".
        std::fs::write(&path, b"model = \"\xff\"\n").unwrap();

        assert!(install_codex_mcp_config_entry_at(&path, "bun", &[]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"model = \"\xff\"\n");
    }

    #[test]
    fn remove_codex_mcp_entry_by_key_at_is_noop_when_file_missing() {
        let path = std::env::temp_dir().join(format!(
            "lotus_codex_missing_{}.toml",
            rand::random::<u64>()
        ));
        let _ = std::fs::remove_file(&path);
        assert!(!remove_codex_mcp_entry_by_key_at(&path, "lotus").unwrap());
    }
}

#[cfg(all(test, unix))]
mod tool_hook_script_tests {
    use super::*;
    use std::io::Write;
    use std::process::{Command, Stdio};

    /// Write the script + a drop dir into a fresh temp dir and run it for real. Substring
    /// assertions on a shell body prove nothing about what it does; executing it does.
    /// `label` must be unique per test: tests run concurrently, and keying the temp dir on the
    /// phase alone let the two `post` tests share one directory and delete each other's drops.
    fn run(
        label: &str,
        phase: &str,
        stdin: &str,
        pane_id: Option<&str>,
    ) -> (PathBuf, Vec<PathBuf>) {
        let base =
            std::env::temp_dir().join(format!("lotus-toolhook-{}-{}", std::process::id(), label));
        let _ = fs::remove_dir_all(&base);
        let drop_dir = base.join("drops");
        fs::create_dir_all(&drop_dir).expect("drop dir");
        let script = base.join("claude-tool-hook.sh");
        // The real entry point, so this exercises the generated script AND the Node
        // producer it now delegates to — the pair is what ships.
        let notify_index = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/agent-notify/index.mjs");
        fs::write(
            &script,
            build_claude_tool_hook_script(&drop_dir, &notify_index),
        )
        .expect("write script");
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod");
        }

        let mut cmd = Command::new("sh");
        cmd.arg(&script)
            .arg(phase)
            .stdin(Stdio::piped())
            .stdout(Stdio::null());
        cmd.env_remove("LOTUS_PANE_ID");
        if let Some(p) = pane_id {
            cmd.env("LOTUS_PANE_ID", p);
        }
        let mut child = cmd.spawn().expect("spawn sh");
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(stdin.as_bytes())
            .ok();
        let status = child.wait().expect("wait");
        assert!(status.success(), "hook must always exit 0");

        let mut files: Vec<PathBuf> = fs::read_dir(&drop_dir)
            .expect("read drop dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        files.sort();
        (drop_dir, files)
    }

    fn payload_of(path: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(path).expect("read drop")).expect("valid JSON")
    }

    /// The reason the script now delegates to Node: the shell body could carry the
    /// tool NAME and a file path and nothing else. A step that reads `Bash` is a
    /// noun; one that reads `rm src/legacy/shim.ts` is a decision an operator can
    /// act on from a phone.
    #[test]
    fn carries_the_tool_argument_the_shell_body_could_not() {
        let (_dir, files) = run(
            "target-bash",
            "post",
            r#"{"tool_name":"Bash","tool_input":{"command":"rm src/legacy/shim.ts"},"tool_response":{"stdout":"","stderr":""}}"#,
            Some("pane-1"),
        );

        let p = payload_of(&files[0]);
        assert_eq!(p["toolTarget"], "rm src/legacy/shim.ts");
        assert_eq!(p["title"], "Bash");
    }

    /// Diff counts come from `structuredPatch`, whose shape was established by
    /// capture rather than guessed. The shell body had no way to count them.
    #[test]
    fn carries_the_diff_stat_from_a_real_structured_patch() {
        let (_dir, files) = run(
            "diff-stat",
            "post",
            r#"{"tool_name":"Edit","tool_input":{"file_path":"/repo/a.ts"},"tool_response":{"structuredPatch":[{"lines":[" keep","-gone","-gone2","+added"]}]}}"#,
            Some("pane-1"),
        );

        let p = payload_of(&files[0]);
        assert_eq!(p["linesAdded"], 1);
        assert_eq!(p["linesRemoved"], 2);
        // `body` still holds the path, because narration-event.ts reads it there.
        assert_eq!(p["body"], "/repo/a.ts");
    }

    /// A tool with no diff must not wear `+0 -0`: "changed nothing" and "no diff
    /// applies" are different claims.
    #[test]
    fn omits_the_diff_stat_when_no_diff_applies() {
        let (_dir, files) = run(
            "no-diff",
            "post",
            r#"{"tool_name":"Read","tool_input":{"file_path":"/repo/a.ts"},"tool_response":{"type":"text","file":{"content":"x"}}}"#,
            Some("pane-1"),
        );

        let p = payload_of(&files[0]);
        assert!(p["linesAdded"].is_null(), "got {p}");
        assert!(p["linesRemoved"].is_null());
    }

    /// The path is now JSON-encoded rather than stripped by `tr`, so a quote
    /// survives instead of being mangled into a different filename.
    #[test]
    fn a_quote_in_a_path_survives_instead_of_being_stripped() {
        let (_dir, files) = run(
            "quote-kept",
            "post",
            r#"{"tool_name":"Edit","tool_input":{"file_path":"/repo/we\"ird.ts"},"tool_response":{}}"#,
            Some("pane-1"),
        );

        assert_eq!(payload_of(&files[0])["body"], "/repo/we\"ird.ts");
    }

    #[test]
    fn writes_nothing_outside_a_lotus_pane() {
        // The hook is registered in the GLOBAL ~/.claude/settings.json, so it fires in every
        // Claude session on the machine. A session that is not a Lotus pane must cost one shell
        // spawn and nothing else — no stdin read, no filesystem touch.
        let (_dir, files) = run("no-pane", "pre", r#"{"tool_name":"Edit"}"#, None);
        assert!(files.is_empty(), "no drop written without LOTUS_PANE_ID");
    }

    #[test]
    fn writes_a_v1_drop_for_a_pre_tool_call() {
        let (_dir, files) = run(
            "pre-ok",
            "pre",
            r#"{"session_id":"s-1","tool_name":"Edit"}"#,
            Some("canvas:projA:a1"),
        );
        assert_eq!(files.len(), 1, "exactly one drop");
        let p = payload_of(&files[0]);
        assert_eq!(p["version"], 1);
        assert_eq!(p["event"], "tool-pre");
        assert_eq!(p["title"], "Edit", "tool name carries the routing tag");
        assert_eq!(p["paneId"], "canvas:projA:a1");
        assert_eq!(
            p["status"], "running",
            "never idle/error: codespace reads those as agent completed/failed"
        );
        assert_eq!(p["sessionId"], "s-1");
    }

    #[test]
    fn flags_a_failed_tool_result_by_event_name() {
        let (_dir, files) = run(
            "post-failed",
            "post",
            r#"{"tool_name":"Bash","tool_response":{"is_error":true}}"#,
            Some("canvas:projA:a1"),
        );
        let p = payload_of(&files[0]);
        assert_eq!(p["event"], "tool-post-failed");
        assert_eq!(
            p["status"], "running",
            "failure rides the event name, never the status"
        );
    }

    #[test]
    fn carries_the_edited_file_path_as_the_body() {
        // The agent-state layer derives filesTouched and the per-agent AREA label from these
        // paths; without them it can only ever say "the repo".
        let (_dir, files) = run(
            "pre-path",
            "pre",
            r#"{"tool_name":"Edit","tool_input":{"file_path":"/repo/src/auth.ts"}}"#,
            Some("pane-1"),
        );
        assert_eq!(payload_of(&files[0])["body"], "/repo/src/auth.ts");
    }

    #[test]
    fn survives_a_path_containing_a_quote() {
        // The drop is assembled by printf, not a JSON encoder. An unescaped quote would produce
        // invalid JSON, parse_drop_payload would reject the file, and the event would vanish with
        // only a log line. Strip rather than escape — a mangled path still narrates usefully.
        let (_dir, files) = run(
            "pre-quote",
            "pre",
            r#"{"tool_name":"Edit","tool_input":{"file_path":"/repo/we"ird.ts"}}"#,
            Some("pane-1"),
        );
        let raw = fs::read_to_string(&files[0]).expect("read");
        serde_json::from_str::<serde_json::Value>(&raw).expect("drop must stay valid JSON");
    }

    /// Ground truth for these cases comes from Heard's shipped `templates.post_tool_event`
    /// (`success is False`, an `error` key, or a non-zero `exit_code` / `exitCode`) — not from
    /// guesswork. An earlier draft matched `is_error`, which Claude Code does not appear to use,
    /// and missed the failing-Bash case entirely: the most common failure of all.
    #[test]
    fn detects_every_failure_shape_claude_actually_emits() {
        for (label, stdin) in [
            (
                "exit_code",
                r#"{"tool_name":"Bash","tool_response":{"exit_code":1}}"#,
            ),
            (
                "exitCode",
                r#"{"tool_name":"Bash","tool_response":{"exitCode":127}}"#,
            ),
            (
                "success false",
                r#"{"tool_name":"Edit","tool_response":{"success":false}}"#,
            ),
            (
                "error key",
                r#"{"tool_name":"Read","tool_response":{"error":"ENOENT"}}"#,
            ),
        ] {
            let (_d, files) = run(
                &format!("fail-{}", label.replace(' ', "-")),
                "post",
                stdin,
                Some("pane-1"),
            );
            assert_eq!(
                payload_of(&files[0])["event"],
                "tool-post-failed",
                "{label} must read as a failure"
            );
        }
    }

    /// The body is generated code that only ever runs inside Claude's hook runner, where
    /// a syntax error is swallowed: the wrapper always exits 0 on purpose, so a broken
    /// script would silently stop reporting instead of failing loudly. Parsed here so the
    /// one thing that cannot report its own breakage is checked before it ships.
    #[test]
    fn the_generated_script_is_valid_shell() {
        let script = build_claude_tool_hook_script(
            Path::new("/home/user/.lotus-dev/agent-hooks/global"),
            Path::new("/home/user/.lotus-dev/agent-notify/index.mjs"),
        );

        let mut child = std::process::Command::new("sh")
            .arg("-n")
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn sh");
        {
            use std::io::Write;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(script.as_bytes())
                .unwrap();
        }
        let out = child.wait_with_output().expect("wait sh");

        assert!(
            out.status.success(),
            "sh -n rejected the script: {}\n---\n{script}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// The phase argument decides which event is reported, and `user` must not arrive as
    /// a tool call: `UserPromptSubmit` is a turn beginning, not a tool.
    #[test]
    fn the_phase_selects_the_event_name() {
        let script = build_claude_tool_hook_script(Path::new("/d"), Path::new("/i.mjs"));

        assert!(
            script.contains("case \"$1\" in user) EV=prompt-submit ;; *) EV=\"tool-$1\" ;; esac")
        );
        assert!(script.contains("--event \"$EV\""));
    }

    #[test]
    fn does_not_cry_failure_over_a_successful_call() {
        for (label, stdin) in [
            (
                "exit 0",
                r#"{"tool_name":"Bash","tool_response":{"exit_code":0}}"#,
            ),
            (
                "plain ok",
                r#"{"tool_name":"Edit","tool_response":{"success":true}}"#,
            ),
        ] {
            let (_d, files) = run(
                &format!("ok-{}", label.replace(' ', "-")),
                "post",
                stdin,
                Some("pane-1"),
            );
            assert_eq!(
                payload_of(&files[0])["event"],
                "tool-post",
                "{label} must stay routine"
            );
        }
    }

    #[test]
    fn ignores_the_word_error_in_the_tools_own_input() {
        // Grepping for "error", or editing error-handling code, must not announce a failure that
        // never happened. A false pierce is worse than a missed one: it sends the user looking for
        // a bug that does not exist, and it teaches them to distrust the channel.
        let (_d, files) = run(
            "input-word-error",
            "post",
            r#"{"tool_name":"Grep","tool_input":{"pattern":"error"},"tool_response":{"matches":3}}"#,
            Some("pane-1"),
        );
        assert_eq!(payload_of(&files[0])["event"], "tool-post");
    }

    #[test]
    fn leaves_no_tmp_file_behind() {
        // The watcher skips `.tmp`; a leftover would sit in the drop dir until the next drain.
        let (_dir, files) = run(
            "post-tmp",
            "post",
            r#"{"tool_name":"Read"}"#,
            Some("pane-1"),
        );
        assert!(
            files
                .iter()
                .all(|f| f.extension().and_then(|e| e.to_str()) == Some("json")),
            "only .json files remain: {files:?}"
        );
    }
}
