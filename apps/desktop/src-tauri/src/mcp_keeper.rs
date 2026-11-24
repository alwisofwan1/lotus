//! Periodic discovery-file + MCP server entry keeper.
//!
//! Runs every 30s while Lotus is alive. If the discovery file
//! (`<lotus_state_dir>/lotus-mcp-ipc.json`) or the Claude/Codex MCP entries
//! (`<key>` = `lotus` for release, `lotus-dev` for debug builds) have gone
//! missing — e.g. an external tool, a buggy lifecycle event, or a partial
//! teardown — re-write them so the MCP sidecar can reach the still-running IPC
//! server without requiring a Lotus restart.
//!
//! The keeper also re-asserts the Codex `notify` hook: Codex owns a SINGLE
//! top-level `notify` slot and rewrites `config.toml` whenever its settings
//! change, which silently drops our line (field failure: Codex turn-end
//! signals stop until the next Lotus restart). The re-assert is marker-based
//! and write-free when our line is present, so it never churns user config.
//!
//! The Claude Stop hook stays out of the keeper — settings.json entries are
//! keyed on an instance-unique script path and Claude Code does not rewrite
//! them out from under us.

use std::path::Path;
use std::time::Duration;

use crate::mcp_config::{
    self, ipc_discovery_path, mcp_config_path, write_ipc_discovery, IpcDiscoveryFile,
};
use crate::paths;

#[cfg(unix)]
extern crate libc;

const KEEPER_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OtherProfileCleanupDecision {
    Keep,
    RemoveConfigEntry,
    RemoveDiscoveryAndConfig,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct OtherProfileCleanupReport {
    pub profile_key: String,
    pub discovery_removed: bool,
    pub config_removed: bool,
    pub process_killed: bool,
    pub message: String,
}

fn decide_other_profile_cleanup(
    discovery_present: bool,
    discovery_pid_alive: Option<bool>,
) -> OtherProfileCleanupDecision {
    if !discovery_present {
        return OtherProfileCleanupDecision::RemoveConfigEntry;
    }
    match discovery_pid_alive {
        Some(false) => OtherProfileCleanupDecision::RemoveDiscoveryAndConfig,
        _ => OtherProfileCleanupDecision::Keep,
    }
}

fn build_other_profile_cleanup_report(
    profile_key: &str,
    decision: OtherProfileCleanupDecision,
) -> OtherProfileCleanupReport {
    let (discovery_removed, config_removed, message) = match decision {
        OtherProfileCleanupDecision::Keep => (
            false,
            false,
            format!("Other Lotus MCP profile {profile_key} is live or not proven stale; no cleanup was applied."),
        ),
        OtherProfileCleanupDecision::RemoveConfigEntry => (
            false,
            true,
            format!("Removed stale mcpServers.{profile_key} because its discovery file is missing."),
        ),
        OtherProfileCleanupDecision::RemoveDiscoveryAndConfig => (
            true,
            true,
            format!("Removed stale {profile_key} discovery file and MCP config because its recorded PID is dead."),
        ),
    };

    OtherProfileCleanupReport {
        profile_key: profile_key.to_string(),
        discovery_removed,
        config_removed,
        process_killed: false,
        message,
    }
}

pub struct KeeperConfig {
    pub port: u16,
    pub secret: String,
    pub pid: u32,
    pub sidecar_command: String,
    pub sidecar_args: Vec<String>,
}

pub fn spawn(cfg: KeeperConfig) {
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(KEEPER_INTERVAL);
        // First tick fires immediately; skip it to avoid racing the
        // initial bootstrap that already wrote both files.
        tick.tick().await;
        loop {
            tick.tick().await;
            ensure_discovery(&cfg);
            ensure_claude_mcp_servers_entry(&cfg);
            ensure_codex_mcp_servers_entry(&cfg);
            ensure_codex_notify_hook(&cfg);
            // A CLI that saves by rename-over turns a Shared account's link into a real file.
            crate::account_context::keep_all();
            let _ = cleanup_other_profile_if_stale();
        }
    });
}

/// Restore the Codex `notify` line if a Codex config rewrite dropped it — a
/// dead notify hook means no instant turn-end signal from Codex panes (the
/// frontend's byte-idle backstop still fires, but ~8s late). Write-free when
/// the line is present (see `mcp_config::ensure_codex_notify`).
fn ensure_codex_notify_hook(cfg: &KeeperConfig) {
    match mcp_config::ensure_codex_notify(cfg.port, &cfg.secret) {
        Ok(true) => eprintln!("[mcp-keeper] re-asserted Codex notify hook (line was missing)"),
        Ok(false) => {}
        Err(err) => eprintln!("[mcp-keeper] re-assert Codex notify failed: {err}"),
    }
}

fn ensure_discovery(cfg: &KeeperConfig) {
    let Ok(path) = ipc_discovery_path() else {
        return;
    };
    if path.exists() {
        return;
    }
    let file = IpcDiscoveryFile {
        version: 1,
        port: cfg.port,
        secret: cfg.secret.clone(),
        pid: cfg.pid,
        profile_key: crate::mcp_config::mcp_server_key().to_string(),
    };
    match write_ipc_discovery(&file) {
        Ok(_) => eprintln!("[mcp-keeper] re-wrote discovery file (was missing)"),
        Err(err) => eprintln!("[mcp-keeper] re-write discovery failed: {err}"),
    }
}

/// Whether the keeper may write to a candidate config. The default config is always fair game (prior
/// behaviour). A profile config (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`) is only written when it already
/// exists or its directory does — so we register the lotus entry for real 2nd-account profiles without
/// scattering empty config files into directories the user never set up.
fn candidate_writable(path: &Path, default_path: Option<&Path>) -> bool {
    if default_path == Some(path) {
        return true;
    }
    if path.exists() {
        return true;
    }
    path.parent().is_some_and(Path::exists)
}

fn ensure_claude_mcp_servers_entry(cfg: &KeeperConfig) {
    let default_path = mcp_config_path().ok();
    let mut paths = crate::trust_reconciler::all_claude_config_paths();
    // Fall back to the default path alone if enumeration yields nothing (no home dir, etc.).
    if paths.is_empty() {
        paths.extend(default_path.clone());
    }
    for path in paths {
        if !candidate_writable(&path, default_path.as_deref()) {
            continue;
        }
        let needs_install = match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(root) => !mcp_config::has_exact_lotus_entry(
                    &root,
                    &cfg.sidecar_command,
                    &cfg.sidecar_args,
                ),
                _ => true,
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        };
        if !needs_install {
            continue;
        }
        match mcp_config::install_mcp_config_entry_at(
            &path,
            &cfg.sidecar_command,
            &cfg.sidecar_args,
        ) {
            Ok(_) => eprintln!(
                "[mcp-keeper] re-installed mcpServers.{} at {path:?} (was missing or stale)",
                mcp_config::mcp_server_key()
            ),
            Err(err) => eprintln!(
                "[mcp-keeper] re-install mcpServers.{} at {path:?} failed: {err}",
                mcp_config::mcp_server_key()
            ),
        }
    }
}

fn ensure_codex_mcp_servers_entry(cfg: &KeeperConfig) {
    let key = mcp_config::codex_mcp_server_key();
    let default_path = mcp_config::codex_config_path().ok();
    let mut paths = crate::trust_reconciler::all_codex_config_paths();
    if paths.is_empty() {
        paths.extend(default_path.clone());
    }
    for path in paths {
        if !candidate_writable(&path, default_path.as_deref()) {
            continue;
        }
        let needs_install = match std::fs::read_to_string(&path) {
            Ok(text) => !mcp_config::has_exact_codex_mcp_entry(
                &text,
                key,
                &cfg.sidecar_command,
                &cfg.sidecar_args,
            ),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => true,
            Err(_) => false,
        };
        if !needs_install {
            continue;
        }
        match mcp_config::install_codex_mcp_config_entry_at(
            &path,
            &cfg.sidecar_command,
            &cfg.sidecar_args,
        ) {
            Ok(_) => eprintln!(
                "[mcp-keeper] re-installed Codex MCP {key} at {path:?} (was missing or stale)"
            ),
            Err(err) => {
                eprintln!("[mcp-keeper] re-install Codex MCP {key} at {path:?} failed: {err}")
            }
        }
    }
}

/// When the other Lotus profile (dev/release) died without clean shutdown, its
/// `mcpServers` entry and discovery file can linger. New Claude CLI sessions then
/// start a dead-port or no-discovery sidecar for the missing profile, causing
/// tool-call failures. This function removes the stale other-profile MCP entry
/// when discovery is missing, and removes discovery plus config when the recorded
/// discovery PID is dead.
pub fn cleanup_other_profile_if_stale() -> OtherProfileCleanupReport {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => {
            return build_other_profile_cleanup_report("unknown", OtherProfileCleanupDecision::Keep)
        }
    };
    let (other_key, other_disc) = if paths::is_dev_profile() {
        ("lotus", home.join(".lotus").join("lotus-mcp-ipc.json"))
    } else {
        (
            "lotus-dev",
            home.join(".lotus-dev").join("lotus-mcp-ipc.json"),
        )
    };

    let file = if other_disc.exists() {
        let bytes = match std::fs::read(&other_disc) {
            Ok(b) => b,
            Err(_) => {
                return build_other_profile_cleanup_report(
                    other_key,
                    OtherProfileCleanupDecision::Keep,
                )
            }
        };
        match serde_json::from_slice::<IpcDiscoveryFile>(&bytes) {
            Ok(f) => Some(f),
            Err(_) => {
                return build_other_profile_cleanup_report(
                    other_key,
                    OtherProfileCleanupDecision::Keep,
                )
            }
        }
    } else {
        None
    };

    let decision = decide_other_profile_cleanup(
        file.is_some(),
        file.as_ref().map(|discovery| is_pid_alive(discovery.pid)),
    );
    let report = build_other_profile_cleanup_report(other_key, decision);

    match decision {
        OtherProfileCleanupDecision::Keep => {}
        OtherProfileCleanupDecision::RemoveConfigEntry => {
            remove_other_profile_mcp_entries(other_key, "discovery missing");
        }
        OtherProfileCleanupDecision::RemoveDiscoveryAndConfig => {
            if let Some(discovery) = file {
                let _ = std::fs::remove_file(&other_disc);
                eprintln!(
                    "[mcp-keeper] removed stale {other_key} discovery file (pid {} dead)",
                    discovery.pid
                );
            }
            remove_other_profile_mcp_entries(other_key, "discovery PID dead");
        }
    }

    report
}

fn remove_other_profile_mcp_entries(other_key: &str, reason: &str) {
    // 1. Claude configs (default + any CLAUDE_CONFIG_DIR profiles).
    let paths = crate::trust_reconciler::all_claude_config_paths();
    if paths.is_empty() {
        match mcp_config::remove_mcp_entry_by_key(other_key) {
            Ok(_) => eprintln!("[mcp-keeper] removed stale mcpServers.{other_key} ({reason})"),
            Err(err) => {
                eprintln!("[mcp-keeper] failed to remove stale mcpServers.{other_key}: {err}")
            }
        }
    } else {
        for path in paths {
            match mcp_config::remove_mcp_entry_by_key_at(&path, other_key) {
                Ok(_) => eprintln!(
                    "[mcp-keeper] removed stale mcpServers.{other_key} at {path:?} ({reason})"
                ),
                Err(err) => eprintln!(
                    "[mcp-keeper] failed to remove stale mcpServers.{other_key} at {path:?}: {err}"
                ),
            }
        }
    }

    // 2. Codex `config.toml` — its own MCP registry, which the Claude cleanup above never touched.
    //    A dead `lotus`/`lotus-dev` table lingered here (RC5), so a Codex agent wasted a tool call
    //    on the dead endpoint and reported a confusing "IPC unavailable".
    match mcp_config::remove_codex_mcp_entry_by_key(other_key) {
        Ok(true) => {
            eprintln!("[mcp-keeper] removed stale codex mcp_servers.{other_key} ({reason})")
        }
        Ok(false) => {}
        Err(err) => {
            eprintln!("[mcp-keeper] failed to remove stale codex mcp_servers.{other_key}: {err}")
        }
    }
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // kill(pid, 0) returns 0 if the process exists and we have permission,
    // ESRCH if no such process, EPERM if it exists but we lack permission.
    // Both 0 and EPERM mean "alive"; only ESRCH means "dead".
    unsafe { libc::kill(pid as libc::pid_t, 0) != -1 || *libc::__error() != libc::ESRCH }
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    true // conservative: don't evict on platforms without kill(2)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An account discovered by `accounts.rs` always has its `.claude.json`, so the keeper writes it.
    #[test]
    fn a_discovered_account_config_is_writable() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".claude.json");
        std::fs::write(&file, "{}").unwrap();
        assert!(candidate_writable(&file, None));
    }

    #[test]
    fn other_profile_cleanup_report_marks_safe_actions_without_process_kill() {
        let report = build_other_profile_cleanup_report(
            "lotus",
            decide_other_profile_cleanup(true, Some(false)),
        );

        assert_eq!(report.profile_key, "lotus");
        assert!(report.discovery_removed);
        assert!(report.config_removed);
        assert!(!report.process_killed);
    }

    #[test]
    fn other_profile_cleanup_removes_config_when_discovery_is_missing() {
        let decision = decide_other_profile_cleanup(false, None);

        assert_eq!(decision, OtherProfileCleanupDecision::RemoveConfigEntry);
    }

    #[test]
    fn other_profile_cleanup_keeps_live_discovery() {
        let decision = decide_other_profile_cleanup(true, Some(true));

        assert_eq!(decision, OtherProfileCleanupDecision::Keep);
    }

    #[test]
    fn other_profile_cleanup_removes_dead_discovery_and_config() {
        let decision = decide_other_profile_cleanup(true, Some(false));

        assert_eq!(
            decision,
            OtherProfileCleanupDecision::RemoveDiscoveryAndConfig
        );
    }
}
