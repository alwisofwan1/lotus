//! How to start the chat bridge.
//!
//! - `LOTUS_CHAT_BRIDGE_BIN` set: run that binary (to test a compiled bridge in dev).
//! - Debug build: `bun run scripts/chat-bridge/main.ts` from the source tree, so a bridge edit needs
//!   no rebuild.
//! - Release build: the bridge bundle embedded in Lotus (~2 MB), run by the host runtime's
//!   Bun-compiled binary with `BUN_BE_BUN=1`, which makes it act as plain `bun`. One Bun runtime
//!   serves both, instead of a second 62 MB binary. Verified 8/8 with the live smoke test
//!   (plans/chat-runtime/CHECKPOINTS.md, 2026-10-28).
//!
//! The bridge gets the user's login-shell environment: a Finder-launched app has a bare PATH, and
//! `claude` / `bun` live in the user's own bin dirs.

use std::collections::HashMap;
use std::path::PathBuf;

pub struct LaunchCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
}

pub fn launch_command() -> Result<LaunchCommand, String> {
    let env = bridge_env(crate::shell_env::user_login_env());
    if let Some(bin) = std::env::var_os("LOTUS_CHAT_BRIDGE_BIN") {
        return Ok(LaunchCommand {
            program: bin.into(),
            args: vec![],
            env,
        });
    }
    #[cfg(debug_assertions)]
    {
        let script =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/chat-bridge/main.ts");
        Ok(LaunchCommand {
            program: "bun".into(),
            args: vec!["run".into(), script.to_string_lossy().into_owned()],
            env,
        })
    }
    #[cfg(not(debug_assertions))]
    {
        let (program, script) = embedded::materialize()?;
        let mut env = env;
        env.insert("BUN_BE_BUN".into(), "1".into());
        Ok(LaunchCommand {
            program,
            args: vec![script.to_string_lossy().into_owned()],
            env,
        })
    }
}

/// The login env with the variables a parent Claude Code session sets removed, so a Lotus started
/// from a Claude terminal does not make the bridge think it is nested.
fn bridge_env(login: &HashMap<String, String>) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.extend(login.iter().map(|(k, v)| (k.clone(), v.clone())));
    for key in [
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_AGENT_SDK_CLIENT_APP",
        "LOTUS_CHAT_BRIDGE_RAW",
    ] {
        env.remove(key);
    }
    // An empty login value means "unset", and it also masks a profile Lotus itself inherited
    // (see `shell_env::user_login_env`), so it is removed after the merge, not skipped before it.
    env.retain(|_, value| !value.is_empty());
    // A Lotus started from another instance's terminal inherits that instance's key; the agent's
    // MCP sidecar would then refuse this instance's tools ("profile mismatch"). Same reset as pty.rs.
    env.insert("LOTUS_PROFILE_KEY".into(), crate::mcp_config::mcp_server_key().into());
    env
}

#[cfg(not(debug_assertions))]
mod embedded {
    use std::path::PathBuf;

    use crate::host_runtime::bundle;

    /// Built by `bun run chat-bridge:bundle` (part of `tauri:build:exec`).
    const BRIDGE_BUNDLE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../scripts/chat-bridge/dist/chat-bridge.mjs"
    ));

    /// Returns (Bun runtime, bridge script).
    pub fn materialize() -> Result<(PathBuf, PathBuf), String> {
        let script = crate::paths::lotus_state_dir().join("chat-bridge.mjs");
        bundle::write_if_needed(&script, BRIDGE_BUNDLE)
            .map_err(|e| format!("write {}: {e}", script.display()))?;
        let runtime =
            bundle::ensure_default().map_err(|e| format!("prepare the Bun runtime: {e}"))?;
        Ok((runtime, script))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_nesting_variables_and_prefers_the_login_env() {
        let login = HashMap::from([
            ("PATH".to_string(), "/login/bin".to_string()),
            ("CLAUDECODE".to_string(), "1".to_string()),
        ]);
        let env = bridge_env(&login);
        assert_eq!(env.get("PATH").map(String::as_str), Some("/login/bin"));
        assert!(!env.contains_key("CLAUDECODE"));
    }

    #[test]
    fn an_empty_login_value_unsets_the_variable() {
        let login = HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), String::new())]);
        assert!(!bridge_env(&login).contains_key("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn carries_this_instances_profile_key_not_an_inherited_one() {
        let login = HashMap::from([("LOTUS_PROFILE_KEY".to_string(), "someone-else".to_string())]);
        assert_eq!(
            bridge_env(&login).get("LOTUS_PROFILE_KEY").map(String::as_str),
            Some(crate::mcp_config::mcp_server_key())
        );
    }

}
