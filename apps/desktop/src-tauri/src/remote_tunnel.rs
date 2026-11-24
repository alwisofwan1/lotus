//! The way home: one `ssh -R` per machine, so a process on the VPS can call this desktop back.
//!
//! **Why one mechanism closes three gaps.** An agent running on another machine is blind in three
//! ways — it cannot report a turn, it cannot reach the `lotus_*` MCP tools, and its session id lives
//! on the wrong disk. All three are the same problem: it has no route back. And the route is cheap,
//! because both services this desktop exposes already bind loopback and nothing else:
//!
//! - the HTTP API on `127.0.0.1:<port>`, its port and key file advertised in `api-server.json`;
//! - the MCP IPC on `127.0.0.1:<port>`, advertised in `lotus-mcp-ipc.json`.
//!
//! `ssh -R` points the *remote* loopback at the *local* one, which is precisely the shape both
//! already expect. No bind changes, no public port, no firewall rule.
//!
//! **The trap this module steps around** is recorded in [`crate::remote_transport`]: sharing a
//! control socket with another `ssh` made both sides race to be master, and the loser got
//! `"Connection to UNKNOWN port 65535 timed out"`. This connection therefore refuses multiplexing
//! outright (`ControlMaster=no`, `ControlPath=none`) rather than hoping it will not collide.

use crate::no_window::NoWindow;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;

use crate::cli_tools::{format_ssh_target, SshToolTarget};
use crate::error::AppError;
use crate::paths;

// ── Status ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelState {
    /// The forward is up: a process on the machine can reach this desktop on those ports.
    Open,
    /// Nothing is running for this machine, and nothing tried to.
    Closed,
    /// It ran and stopped. `detail` carries what ssh said, because "it just stopped" is not usable.
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub state: TunnelState,
    /// The loopback ports forwarded, identical on both ends.
    pub ports: Vec<u16>,
    pub detail: Option<String>,
}

impl TunnelStatus {
    fn closed() -> Self {
        Self {
            state: TunnelState::Closed,
            ports: Vec::new(),
            detail: None,
        }
    }
}

// ── Key ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TunnelKey {
    host: String,
    user: Option<String>,
    port: Option<u16>,
}

impl From<&SshToolTarget> for TunnelKey {
    fn from(target: &SshToolTarget) -> Self {
        TunnelKey {
            host: target.host.trim().to_ascii_lowercase(),
            user: target
                .user
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_ascii_lowercase),
            port: target.port,
        }
    }
}

struct TunnelHandle {
    process: Child,
    ports: Vec<u16>,
}

// ── The ports worth forwarding ────────────────────────────────────────────────

/// The loopback ports this desktop wants reachable from the machine.
///
/// Read from the discovery files the app writes for itself rather than from a constant: the HTTP API
/// falls back to a different port when 9877 is taken (a dev instance beside a release one does this
/// every time), and the MCP IPC binds port 0 and is only ever known at runtime. A hardcoded 9877
/// would forward the *other* instance's port and look like it worked.
pub fn local_ports() -> Vec<u16> {
    ports_in(&paths::lotus_state_dir())
}

pub(crate) fn ports_in(state_dir: &Path) -> Vec<u16> {
    let mut ports: Vec<u16> = Vec::new();
    for file in ["api-server.json", "lotus-mcp-ipc.json"] {
        let Ok(raw) = std::fs::read_to_string(state_dir.join(file)) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(port) = value.get("port").and_then(serde_json::Value::as_u64) {
            if let Ok(port) = u16::try_from(port) {
                if port != 0 && !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
    }
    ports
}

// ── The command ───────────────────────────────────────────────────────────────

/// The `ssh` invocation for a tunnel, as argv.
///
/// Every option here is load-bearing:
///
/// - `-N` / `-T`: no command, no tty. This connection carries forwards and nothing else.
/// - `ExitOnForwardFailure=yes`: without it, a remote port that is already taken leaves ssh running
///   happily with no forward — a tunnel that reports itself open and delivers nothing. With it, ssh
///   exits and the failure is visible.
/// - `ControlMaster=no` + `ControlPath=none`: never multiplex. See the module docs.
/// - `BatchMode=yes`: fail instead of blocking forever on a password prompt nobody can answer.
/// - `ServerAliveInterval` / `ServerAliveCountMax`: a dropped network is noticed in ~45 s instead of
///   hanging half-open, which is what makes the UI able to say "putus" at all.
pub(crate) fn build_tunnel_command(
    target: &SshToolTarget,
    ports: &[u16],
) -> Result<Vec<String>, AppError> {
    let mut argv: Vec<String> = vec![
        "ssh".into(),
        "-N".into(),
        "-T".into(),
        "-o".into(),
        "ExitOnForwardFailure=yes".into(),
        "-o".into(),
        "ControlMaster=no".into(),
        "-o".into(),
        "ControlPath=none".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "ServerAliveInterval=15".into(),
        "-o".into(),
        "ServerAliveCountMax=3".into(),
    ];
    if let Some(port) = target.port {
        argv.push("-p".into());
        argv.push(port.to_string());
    }
    for port in ports {
        argv.push("-R".into());
        // The same number on both ends: the remote reads our discovery files' ports verbatim, so a
        // different remote port would mean rewriting them for the far side.
        argv.push(format!("{port}:127.0.0.1:{port}"));
    }
    argv.push(format_ssh_target(target)?);
    Ok(argv)
}

// ── Manager ───────────────────────────────────────────────────────────────────

pub struct RemoteTunnel {
    tunnels: Mutex<HashMap<TunnelKey, TunnelHandle>>,
}

impl Default for RemoteTunnel {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteTunnel {
    pub fn new() -> Self {
        RemoteTunnel {
            tunnels: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<TunnelKey, TunnelHandle>> {
        match self.tunnels.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Open the tunnel for `target`, or report the one already open.
    ///
    /// Idempotent on purpose: every surface that needs the way home (opening a remote project,
    /// waking a dormant agent, a retry button) can simply ask, and only the first ask spawns.
    pub fn open(&self, target: &SshToolTarget, ports: Vec<u16>) -> Result<TunnelStatus, AppError> {
        if ports.is_empty() {
            return Err(crate::error::other(
                "No local service ports to forward — the desktop's API has not started yet.",
            ));
        }
        let key = TunnelKey::from(target);
        let mut tunnels = self.lock();

        if let Some(handle) = tunnels.get_mut(&key) {
            match handle.process.try_wait() {
                Ok(None) => {
                    return Ok(TunnelStatus {
                        state: TunnelState::Open,
                        ports: handle.ports.clone(),
                        detail: None,
                    })
                }
                // It died since we last looked; fall through and start a new one.
                _ => {
                    tunnels.remove(&key);
                }
            }
        }

        let argv = build_tunnel_command(target, &ports)?;
        let child = Command::new(&argv[0])
            .no_window()
            .args(&argv[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(AppError::Io)?;

        tunnels.insert(
            key,
            TunnelHandle {
                process: child,
                ports: ports.clone(),
            },
        );
        Ok(TunnelStatus {
            state: TunnelState::Open,
            ports,
            detail: None,
        })
    }

    /// What the tunnel for `target` is doing right now — asked of the process, never remembered.
    ///
    /// A handle whose process has exited is removed here rather than left to look open: a status
    /// that lies is worse than no status, because the operator's next move depends on it.
    pub fn status(&self, target: &SshToolTarget) -> TunnelStatus {
        let key = TunnelKey::from(target);
        let mut tunnels = self.lock();
        let Some(handle) = tunnels.get_mut(&key) else {
            return TunnelStatus::closed();
        };

        match handle.process.try_wait() {
            Ok(None) => TunnelStatus {
                state: TunnelState::Open,
                ports: handle.ports.clone(),
                detail: None,
            },
            Ok(Some(status)) => {
                let mut handle = tunnels.remove(&key).expect("just borrowed");
                let detail = drain_stderr(&mut handle).or_else(|| Some(format!("ssh exited: {status}")));
                TunnelStatus {
                    state: TunnelState::Failed,
                    ports: handle.ports,
                    detail,
                }
            }
            Err(error) => {
                tunnels.remove(&key);
                TunnelStatus {
                    state: TunnelState::Failed,
                    ports: Vec::new(),
                    detail: Some(error.to_string()),
                }
            }
        }
    }

    /// Close the tunnel for `target`. Safe to call when none is open.
    pub fn close(&self, target: &SshToolTarget) -> TunnelStatus {
        let key = TunnelKey::from(target);
        let mut tunnels = self.lock();
        if let Some(mut handle) = tunnels.remove(&key) {
            let _ = handle.process.kill();
            let _ = handle.process.wait();
        }
        TunnelStatus::closed()
    }

    /// Close every tunnel — app shutdown, or an operator switching everything off.
    pub fn close_all(&self) -> usize {
        let mut tunnels = self.lock();
        let count = tunnels.len();
        for (_, mut handle) in tunnels.drain() {
            let _ = handle.process.kill();
            let _ = handle.process.wait();
        }
        count
    }
}

/// Leaving an `ssh -R` behind is the one failure this module must not have: it would hold a remote
/// port and quietly outlive the app that opened it.
impl Drop for RemoteTunnel {
    fn drop(&mut self) {
        self.close_all();
    }
}

fn drain_stderr(handle: &mut TunnelHandle) -> Option<String> {
    let mut stderr = handle.process.stderr.take()?;
    let mut text = String::new();
    stderr.read_to_string(&mut text).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str, user: Option<&str>, port: Option<u16>) -> SshToolTarget {
        SshToolTarget {
            host: host.to_string(),
            user: user.map(str::to_string),
            port,
        }
    }

    #[test]
    fn the_tunnel_never_multiplexes_over_another_connections_socket() {
        let argv = build_tunnel_command(&target("h", None, None), &[9877]).expect("argv");
        let joined = argv.join(" ");
        assert!(joined.contains("ControlMaster=no"));
        assert!(joined.contains("ControlPath=none"));
    }

    #[test]
    fn a_forward_that_cannot_be_established_takes_the_connection_down_with_it() {
        let argv = build_tunnel_command(&target("h", None, None), &[9877]).expect("argv");
        assert!(
            argv.join(" ").contains("ExitOnForwardFailure=yes"),
            "without this, a taken remote port leaves ssh running with no forward at all"
        );
    }

    #[test]
    fn every_port_is_forwarded_onto_the_same_number_on_the_far_side() {
        let argv = build_tunnel_command(&target("h", None, None), &[9877, 51590]).expect("argv");
        assert!(argv.windows(2).any(|w| w == ["-R", "9877:127.0.0.1:9877"]));
        assert!(argv.windows(2).any(|w| w == ["-R", "51590:127.0.0.1:51590"]));
    }

    #[test]
    fn the_target_is_last_and_the_port_flag_precedes_it() {
        let argv = build_tunnel_command(&target("staging", Some("deploy"), Some(2222)), &[9877]).expect("argv");
        assert_eq!(argv.last().unwrap(), "deploy@staging");
        let p = argv.iter().position(|a| a == "-p").expect("-p");
        assert_eq!(argv[p + 1], "2222");
        assert!(p < argv.len() - 1);
    }

    #[test]
    fn it_carries_no_command_and_asks_for_no_tty() {
        let argv = build_tunnel_command(&target("h", None, None), &[9877]).expect("argv");
        assert!(argv.contains(&"-N".to_string()));
        assert!(argv.contains(&"-T".to_string()));
    }

    #[test]
    fn it_never_waits_on_a_prompt_nobody_can_answer() {
        let argv = build_tunnel_command(&target("h", None, None), &[9877]).expect("argv");
        assert!(argv.join(" ").contains("BatchMode=yes"));
    }

    #[test]
    fn ports_come_from_what_this_instance_actually_bound() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("api-server.json"), r#"{"port":9880}"#).unwrap();
        std::fs::write(
            dir.path().join("lotus-mcp-ipc.json"),
            r#"{"port":51590,"secret":"x"}"#,
        )
        .unwrap();
        assert_eq!(ports_in(dir.path()), vec![9880, 51590]);
    }

    #[test]
    fn a_missing_or_broken_discovery_file_contributes_nothing_rather_than_a_guess() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert!(ports_in(dir.path()).is_empty());

        std::fs::write(dir.path().join("api-server.json"), "not json").unwrap();
        std::fs::write(dir.path().join("lotus-mcp-ipc.json"), r#"{"port":0}"#).unwrap();
        assert!(
            ports_in(dir.path()).is_empty(),
            "port 0 means 'not bound yet', and must never be forwarded"
        );
    }

    #[test]
    fn the_same_port_twice_is_forwarded_once() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(dir.path().join("api-server.json"), r#"{"port":9877}"#).unwrap();
        std::fs::write(dir.path().join("lotus-mcp-ipc.json"), r#"{"port":9877}"#).unwrap();
        assert_eq!(ports_in(dir.path()), vec![9877]);
    }

    #[test]
    fn a_machine_with_nothing_to_forward_is_refused_rather_than_half_opened() {
        let tunnel = RemoteTunnel::new();
        let error = tunnel.open(&target("h", None, None), vec![]).unwrap_err();
        assert!(error.to_string().contains("No local service ports"));
    }

    #[test]
    fn a_machine_with_no_tunnel_reports_closed_not_failed() {
        let tunnel = RemoteTunnel::new();
        let status = tunnel.status(&target("never-opened", None, None));
        assert_eq!(status.state, TunnelState::Closed);
        assert!(status.detail.is_none());
    }

    #[test]
    fn closing_a_tunnel_that_was_never_open_is_not_an_error() {
        let tunnel = RemoteTunnel::new();
        assert_eq!(
            tunnel.close(&target("never-opened", None, None)).state,
            TunnelState::Closed
        );
        assert_eq!(tunnel.close_all(), 0);
    }

    /// Host and user are compared the way `RemoteTransport` and the project store compare them, so
    /// one machine reached two ways is still one tunnel.
    #[test]
    fn the_same_machine_spelled_differently_is_the_same_tunnel() {
        let a = TunnelKey::from(&target("Devbox-VPS", Some("Root"), Some(22)));
        let b = TunnelKey::from(&target("devbox-vps", Some("root"), Some(22)));
        assert_eq!(a, b);

        let other_port = TunnelKey::from(&target("devbox-vps", Some("root"), Some(2222)));
        assert_ne!(a, other_port);
    }
}
