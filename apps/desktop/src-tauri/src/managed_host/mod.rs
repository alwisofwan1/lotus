//! Managed Host: the Standalone Host that Lotus installs on an SSH machine and keeps at its version.
//!
//! Every step is one SSH call over the workspace's master connection, so the UI can show each step
//! as it finishes. The steps themselves live in `remote.sh`; this side only picks one, checks its
//! inputs, and falls back to sending the binary from the Mac when the machine cannot download it.

use serde::Serialize;

use crate::cli_tools::{
    run_ssh_shell_command, run_ssh_shell_command_with_stdin, SshCommandMode, SshToolTarget,
};
use crate::error::{other, AppError};
use crate::no_window::NoWindow;
use crate::remote_transport::RemoteTransport;

const SCRIPT: &str = include_str!("remote.sh");
const RELEASES: &str = "https://github.com/alwisofwan1/lotus-releases/releases/download";
/// `remote.sh download` exits with this when the machine has no way to reach the release.
const NO_DOWNLOAD: i32 = 3;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedHostStatus {
    pub os: String,
    /// `x64` or `arm64`; `None` on any machine we have no host for.
    pub arch: Option<String>,
    /// `none`, `managed` (installed by Lotus) or `manual` (installed with install.sh).
    pub kind: String,
    pub version: Option<String>,
    pub running: bool,
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn command(step: &str, arg: &str) -> String {
    format!("sh -c {} lotus-host {} {}", quote(SCRIPT), step, quote(arg))
}

fn valid_version(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

pub(crate) fn parse_status(stdout: &str) -> ManagedHostStatus {
    let mut status = ManagedHostStatus::default();
    for line in stdout.lines() {
        let Some((key, value)) = line.trim().split_once('=') else {
            continue;
        };
        let value = value.trim().to_string();
        match key {
            "os" => status.os = value,
            "arch" if !value.is_empty() => status.arch = Some(value),
            "kind" => status.kind = value,
            "version" if !value.is_empty() => status.version = Some(value),
            "running" => status.running = value == "1",
            _ => {}
        }
    }
    status
}

fn failure(target: &SshToolTarget, output: &std::process::Output) -> AppError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = stderr.trim();
    if text.is_empty() {
        other(format!("{} stopped without saying why.", target.host))
    } else {
        other(text.to_string())
    }
}

pub fn status(
    target: SshToolTarget,
    transport: Option<&RemoteTransport>,
) -> Result<ManagedHostStatus, AppError> {
    let output = run_ssh_shell_command(&target, &command("status", ""), SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(failure(&target, &output));
    }
    Ok(parse_status(&String::from_utf8_lossy(&output.stdout)))
}

/// One install/update step. `version` is the app's version: the release to fetch and the build the
/// health check must see.
pub fn step(
    target: SshToolTarget,
    step: String,
    version: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let known = ["download", "check", "install", "start", "health", "restore", "remove"];
    if !known.contains(&step.as_str()) {
        return Err(other(format!("Unknown host step {step}.")));
    }
    if !valid_version(&version) {
        return Err(other(format!("{version} is not a release version.")));
    }
    let output = run_ssh_shell_command(&target, &command(&step, &version), SshCommandMode::NoTty, transport)?;
    if output.status.success() {
        return Ok(());
    }
    if step == "download" && output.status.code() == Some(NO_DOWNLOAD) {
        return send_from_here(&target, &version, transport);
    }
    Err(failure(&target, &output))
}

/// The machine cannot reach GitHub: fetch the release here and stream it over SSH.
fn send_from_here(
    target: &SshToolTarget,
    version: &str,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let arch = status(target.clone(), transport)?
        .arch
        .ok_or_else(|| other("This machine is not Linux x64 or arm64."))?;
    let url = format!("{RELEASES}/v{version}/lotus-host-linux-{arch}");
    let dir = std::env::temp_dir().join(format!("lotus-host-{version}-{arch}"));
    std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
    let sent = send_files(target, &dir, &url, transport);
    let _ = std::fs::remove_dir_all(&dir);
    sent
}

fn send_files(
    target: &SshToolTarget,
    dir: &std::path::Path,
    url: &str,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    for (remote, url) in [("new.sha256", format!("{url}.sha256")), ("new", url.to_string())] {
        let local = dir.join(remote);
        let fetched = std::process::Command::new("curl")
            .no_window()
            .args(["-fsSL", "--max-time", "600", "-o"])
            .arg(&local)
            .arg(&url)
            .status()
            .map_err(AppError::Io)?;
        if !fetched.success() {
            return Err(other(format!(
                "Neither {} nor this Mac could download {url}.",
                target.host
            )));
        }
        let bytes = std::fs::read(&local).map_err(AppError::Io)?;
        let output = run_ssh_shell_command_with_stdin(
            target,
            &command("receive", remote),
            SshCommandMode::NoTty,
            &bytes,
            transport,
        )?;
        if !output.status.success() {
            return Err(failure(target, &output));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_status_lines_and_ignores_a_greeting() {
        let status = parse_status("Welcome to Ubuntu\nos=Linux\narch=arm64\nkind=managed\nversion=0.16.0\nrunning=1\n");
        assert_eq!(
            status,
            ManagedHostStatus {
                os: "Linux".into(),
                arch: Some("arm64".into()),
                kind: "managed".into(),
                version: Some("0.16.0".into()),
                running: true,
            }
        );
        let none = parse_status("os=Darwin\narch=\nkind=none\n");
        assert_eq!(none.arch, None);
        assert!(!none.running);
    }

    #[test]
    fn only_a_release_version_reaches_the_shell() {
        assert!(valid_version("0.16.0"));
        assert!(!valid_version("0.16"));
        assert!(!valid_version("0.16.0; rm -rf ~"));
        assert!(!valid_version("dev"));
    }

    #[test]
    fn the_script_is_one_quoted_argument() {
        let cmd = command("status", "");
        assert!(cmd.starts_with("sh -c '"));
        assert!(cmd.ends_with(" lotus-host status ''"));
    }
}
