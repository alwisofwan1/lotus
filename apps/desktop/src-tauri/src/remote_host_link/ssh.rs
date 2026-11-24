//! `MachineAccess` over the real SSH master: `-O forward -L` for the link, `ssh … curl` as fallback.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{Endpoint, MachineAccess};
use crate::cli_tools::{format_ssh_target, run_ssh_over_master, run_ssh_shell_command, SshCommandMode, SshToolTarget};
use crate::error::{other, AppError};
use crate::no_window::NoWindow;
use crate::remote_lotus_host::{call_host, discovery_prelude, parse_host_answer, REPORT_BEGIN, REPORT_END};
use crate::remote_transport::RemoteTransport;

/// Prints the host's port and secret between the report markers. The secret crosses SSH, once.
pub(crate) fn discovery_script() -> String {
    format!(
        "{}printf '%s\\n' '{REPORT_BEGIN}' \"$_lh_port\" \"$_lh_secret\" '{REPORT_END}'\n",
        discovery_prelude()
    )
}

/// `(port, secret)`, or `None` when the machine runs no host.
pub(crate) fn parse_discovery(stdout: &str) -> Result<Option<(u16, String)>, AppError> {
    let Some((body, _)) = parse_host_answer(stdout)? else {
        return Ok(None);
    };
    let mut lines = body.lines().map(str::trim);
    match (lines.next().and_then(|p| p.parse::<u16>().ok()), lines.next()) {
        (Some(port), Some(secret)) if !secret.is_empty() => Ok(Some((port, secret.to_string()))),
        _ => Err(other("The machine's Lotus Host discovery file could not be read.")),
    }
}

/// A port nothing listens on now. shortcut: another process can take it before ssh binds; the
/// caller retries with a new one, which is enough on a desktop.
fn free_local_port() -> Result<u16, AppError> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

fn mux(target: &SshToolTarget, socket: &Path, op: &str, spec: &str) -> Result<(), AppError> {
    let mut ssh = Command::new("ssh").no_window();
    ssh.args(["-o", "BatchMode=yes", "-o", &format!("ControlPath={}", socket.display()), "-O", op, "-L", spec]);
    if let Some(port) = target.port {
        ssh.arg("-p").arg(port.to_string());
    }
    let out = ssh.arg(format_ssh_target(target)?).output()?;
    if out.status.success() {
        return Ok(());
    }
    Err(other(format!("ssh -O {op} -L {spec}: {}", String::from_utf8_lossy(&out.stderr).trim())))
}

pub struct SshAccess {
    app: AppHandle,
    /// The forward each machine holds now, cancelled before a reopen so ports do not pile up.
    forwards: Mutex<HashMap<String, (PathBuf, String)>>,
}

impl SshAccess {
    pub fn new(app: AppHandle) -> Self {
        SshAccess { app, forwards: Mutex::new(HashMap::new()) }
    }
}

impl MachineAccess for SshAccess {
    fn open(&self, target: &SshToolTarget) -> Result<Endpoint, AppError> {
        let socket = self.app.state::<RemoteTransport>().acquire(target)?;
        let out = run_ssh_over_master(target, &discovery_script(), &socket)?;
        let (remote_port, secret) = parse_discovery(&String::from_utf8_lossy(&out.stdout))?
            .ok_or_else(|| other(format!("{} does not run a Lotus Host.", target.host)))?;

        let key = super::key(target);
        if let Some((old_socket, old_spec)) = self.forwards.lock().unwrap_or_else(|e| e.into_inner()).remove(&key) {
            // Best effort: a master that died took its forwards with it.
            let _ = mux(target, &old_socket, "cancel", &old_spec);
        }
        let mut last_error = None;
        for _ in 0..3 {
            let local = free_local_port()?;
            let spec = format!("127.0.0.1:{local}:127.0.0.1:{remote_port}");
            match mux(target, &socket, "forward", &spec) {
                Ok(()) => {
                    self.forwards.lock().unwrap_or_else(|e| e.into_inner()).insert(key, (socket, spec));
                    return Ok(Endpoint { base: format!("http://127.0.0.1:{local}"), secret });
                }
                Err(e) => last_error = Some(e),
            }
        }
        Err(last_error.unwrap_or_else(|| other("could not open a forward")))
    }

    fn curl(&self, target: &SshToolTarget, path: &str, body: &Value) -> Result<(u16, Value), AppError> {
        let transport = self.app.state::<RemoteTransport>();
        let out = run_ssh_shell_command(target, &call_host(path, body), SshCommandMode::NoTty, Some(transport.inner()))?;
        let (payload, status) = parse_host_answer(&String::from_utf8_lossy(&out.stdout))?
            .ok_or_else(|| other(format!("{} does not run a Lotus Host.", target.host)))?;
        Ok((status, serde_json::from_str(&payload).unwrap_or(Value::String(payload))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_script_reads_port_and_secret_from_the_host_file() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join(".lotus")).unwrap();
        std::fs::write(
            home.path().join(".lotus/lotus-mcp-ipc.json"),
            "{\n  \"port\": 45477,\n  \"secret\": \"s3cr$t\"\n}",
        )
        .unwrap();
        let out = Command::new("/bin/sh").arg("-c").arg(discovery_script()).env("HOME", home.path()).output().unwrap();
        let got = parse_discovery(&String::from_utf8_lossy(&out.stdout)).unwrap();
        assert_eq!(got, Some((45477, "s3cr$t".to_string())));

        let empty = tempfile::tempdir().unwrap();
        let out = Command::new("/bin/sh").arg("-c").arg(discovery_script()).env("HOME", empty.path()).output().unwrap();
        assert_eq!(parse_discovery(&String::from_utf8_lossy(&out.stdout)).unwrap(), None);
    }
}
