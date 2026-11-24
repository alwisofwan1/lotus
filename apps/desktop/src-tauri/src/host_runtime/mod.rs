//! Supervision of the embedded host runtime.
//!
//! Renamed from `telegram_bot` on 2026-08-02 (ADR-2). The name was always
//! misleading: only the config was Telegram-specific. Everything here — writing
//! the embedded bundle to disk, spawning it, reporting its status — is the
//! mechanism by which the desktop runs `packages/host` as a child process, and
//! that is exactly the capability Lotus Pocket depends on: for the desktop to be
//! reachable from a phone, the desktop must be running the host.
//!
//! Pattern (mirrors `mcp_config` + `mcp_keeper`):
//!
//! 1. `config`       — load/save `~/.lotus/host-runtime.json`.
//! 2. `bundle`       — write the embedded host runtime to disk.
//! 3. `supervisor`   — spawn/kill/status of the child process.
//! 4. `interfaces`  — bind candidates, classified by who can reach them.
//! 5. `keep_awake`  — holds idle sleep off while the runtime is meant to be reachable.
//!
//! The runtime itself lives in `packages/host/` (TypeScript). Here we only
//! manage its lifecycle from inside the Tauri app so the operator does not have
//! to run it by hand.

pub mod admin_client;
pub mod bundle;
pub mod config;
pub mod integration;
pub mod interfaces;
pub mod keep_awake;
pub mod stale;
pub mod supervisor;

#[cfg(test)]
mod tests {
    const MAIN_APP_COMMANDS_PERMISSION: &str =
        include_str!("../../permissions/main-app-commands.toml");

    #[test]
    fn tauri_acl_allows_host_runtime_commands() {
        for command in [
            "host_runtime_status",
            "host_runtime_sleep_hold",
            "host_runtime_bind_candidates",
            "host_runtime_get_config",
            "host_runtime_save_config",
            "host_runtime_apply",
            "host_runtime_stop",
            "host_runtime_create_pairing_code",
            "host_runtime_list_devices",
            "host_runtime_revoke_device",
            "host_runtime_admin_health",
        ] {
            assert!(
                MAIN_APP_COMMANDS_PERMISSION.contains(&format!("\"{command}\"")),
                "missing Tauri ACL allowlist entry for {command}",
            );
        }
    }
}
