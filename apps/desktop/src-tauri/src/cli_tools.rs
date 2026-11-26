use crate::no_window::NoWindow;
use std::collections::HashSet;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::error::{other, AppError};
use crate::remote_transport::RemoteTransport;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CliToolAvailability {
    pub id: String,
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshToolTarget {
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Copy)]
struct CliToolSpec {
    id: &'static str,
    executable: &'static str,
    version_args: &'static [&'static str],
}

const KNOWN_TOOLS: &[CliToolSpec] = &[
    CliToolSpec {
        id: "lazygit",
        executable: "lazygit",
        version_args: &["--version"],
    },
    CliToolSpec {
        id: "lazydocker",
        executable: "lazydocker",
        version_args: &["--version"],
    },
    CliToolSpec {
        id: "yazi",
        executable: "yazi",
        version_args: &["--version"],
    },
    CliToolSpec {
        id: "zoxide",
        executable: "zoxide",
        version_args: &["--version"],
    },
    CliToolSpec {
        id: "delta",
        executable: "delta",
        version_args: &["--version"],
    },
];

pub fn get_cli_tool_availability(tool_ids: Vec<String>) -> Vec<CliToolAvailability> {
    let requested_ids = normalize_requested_ids(tool_ids);

    KNOWN_TOOLS
        .iter()
        .filter(|tool| requested_ids.is_empty() || requested_ids.contains(tool.id))
        .map(|tool| {
            let installed = command_exists(tool.executable);
            CliToolAvailability {
                id: tool.id.to_string(),
                installed,
                version: installed.then(|| read_version(tool)).flatten(),
            }
        })
        .collect()
}

pub fn get_ssh_cli_tool_availability(
    target: SshToolTarget,
    tool_ids: Vec<String>,
) -> Result<Vec<CliToolAvailability>, AppError> {
    let tools = requested_tool_specs(tool_ids);
    if tools.is_empty() {
        return Ok(Vec::new());
    }

    let output = run_ssh_shell_command(
        &target,
        &login_shell_script(&build_remote_tool_probe_script(&tools)),
        SshCommandMode::NoTty,
        None,
    )?;
    if !output.status.success() {
        return Err(other(read_command_error(&output)));
    }

    Ok(parse_remote_tool_probe_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Resolve the remote working directory for an SSH workspace.
///
/// Runs `pwd -P` on the remote (optionally inside `cd <hint>` first) and
/// returns the absolute path of the resulting cwd. When `hint` is missing,
/// empty, or non-absolute (e.g. `"~"`), the command falls back to the user's
/// default shell home — exactly what the user sees after `ssh host`.
///
/// This is used at SSH workspace creation time so the editor receives an
/// absolute `remoteCwd` instead of `"~"` and avoids
/// `validate_remote_cwd`'s "Remote folder must be an absolute path." error.
pub fn ssh_resolve_remote_cwd(
    target: SshToolTarget,
    hint: Option<String>,
) -> Result<String, AppError> {
    let command = build_ssh_resolve_cwd_command(hint.as_deref());
    let output = run_ssh_shell_command(&target, &command, SshCommandMode::NoTty, None)?;
    if !output.status.success() {
        return Err(other(read_command_error(&output)));
    }
    parse_ssh_resolve_cwd_output(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| other("Failed to resolve remote working directory."))
}

fn build_ssh_resolve_cwd_command(hint: Option<&str>) -> String {
    let absolute_hint = hint
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.starts_with('/'));
    match absolute_hint {
        Some(value) => format!("cd {} && pwd -P", quote_shell_arg(value)),
        None => "pwd -P".to_string(),
    }
}

fn parse_ssh_resolve_cwd_output(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && line.starts_with('/'))
        .map(ToOwned::to_owned)
}

pub fn get_ssh_git_repo_root(
    target: SshToolTarget,
    remote_cwd: Option<String>,
) -> Result<Option<String>, AppError> {
    let command = match remote_cwd
        .as_deref()
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
    {
        Some(cwd) => format!(
            "cd {} && git rev-parse --show-toplevel 2>/dev/null",
            quote_shell_arg(validate_remote_cwd(cwd)?),
        ),
        None => "git rev-parse --show-toplevel 2>/dev/null".to_string(),
    };
    let output = run_ssh_shell_command(&target, &command, SshCommandMode::NoTty, None)?;
    if !output.status.success() {
        return Ok(None);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let repo_root = stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    Ok(repo_root.map(ToOwned::to_owned))
}

fn requested_tool_specs(tool_ids: Vec<String>) -> Vec<CliToolSpec> {
    let requested_ids = normalize_requested_ids(tool_ids);
    KNOWN_TOOLS
        .iter()
        .filter(|tool| requested_ids.is_empty() || requested_ids.contains(tool.id))
        .copied()
        .collect()
}

fn normalize_requested_ids(tool_ids: Vec<String>) -> HashSet<String> {
    tool_ids
        .into_iter()
        .map(|id| id.trim().to_ascii_lowercase())
        .filter(|id| !id.is_empty())
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum SshCommandMode {
    NoTty,
}

pub(crate) fn run_ssh_shell_command(
    target: &SshToolTarget,
    command: &str,
    mode: SshCommandMode,
    transport: Option<&RemoteTransport>,
) -> Result<std::process::Output, AppError> {
    let mut ssh = build_ssh_command(target, command, mode, transport)?;
    ssh.output().map_err(AppError::Io)
}

/// Run a remote shell command and feed `stdin_bytes` to its stdin.
///
/// Used by SSH editor write paths that send file content as a base64 stream.
/// Returns the same `Output` shape as [`run_ssh_shell_command`].
pub(crate) fn run_ssh_shell_command_with_stdin(
    target: &SshToolTarget,
    command: &str,
    mode: SshCommandMode,
    stdin_bytes: &[u8],
    transport: Option<&RemoteTransport>,
) -> Result<std::process::Output, AppError> {
    use std::io::Write;
    use std::process::Stdio;

    let mut ssh = build_ssh_command(target, command, mode, transport)?;
    ssh.stdin(Stdio::piped());
    ssh.stdout(Stdio::piped());
    ssh.stderr(Stdio::piped());

    let mut child = ssh.spawn().map_err(AppError::Io)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(stdin_bytes).map_err(AppError::Io)?;
    }
    child.wait_with_output().map_err(AppError::Io)
}

pub(crate) fn build_ssh_command(
    target: &SshToolTarget,
    command: &str,
    mode: SshCommandMode,
    transport: Option<&RemoteTransport>,
) -> Result<Command, AppError> {
    let mut ssh = Command::new("ssh").no_window();
    match mode {
        SshCommandMode::NoTty => {
            ssh.arg("-T");
        }
    }
    ssh.args([
        "-o",
        "BatchMode=yes",
        // Slow VPSes need slack here. The first call after opening an SSH
        // workspace pays the full TCP+banner+kex+auth cost; loaded sshd
        // sometimes takes 10-20 s just to send the banner. 30 s is
        // generous enough to never spuriously fail on a real link.
        "-o",
        "ConnectTimeout=30",
        // Retry once on transient connection failure (TCP RST, single
        // dropped SYN). Cheaper than surfacing the error to the user only
        // for them to manually retry.
        "-o",
        "ConnectionAttempts=2",
    ]);

    if let Some(t) = transport {
        // Slave into the RemoteTransport master — skip TCP+KEX+auth (~30 ms vs ~500 ms).
        let socket = t.acquire(target)?;
        ssh.args([
            "-o",
            "ControlMaster=no",
            "-o",
            &format!("ControlPath={}", socket.display()),
        ]);
    }
    // transport = None: fresh TCP+KEX+auth per call. Used by one-shot probes
    // (cwd resolve, tool check, git-repo-root) and unit tests.

    if let Some(port) = target.port {
        ssh.arg("-p").arg(port.to_string());
    }
    ssh.arg(format_ssh_target(target)?)
        .arg(build_remote_login_shell_command(command));
    Ok(ssh)
}

/// Run `command` only through the master already listening on `socket`. `ProxyCommand=false`
/// makes the fallback connection ssh would otherwise open (master gone since we looked) fail at
/// once, instead of starting a handshake or an SSO prompt.
pub(crate) fn run_ssh_over_master(
    target: &SshToolTarget,
    command: &str,
    socket: &std::path::Path,
) -> Result<std::process::Output, AppError> {
    let mut ssh = Command::new("ssh").no_window();
    ssh.args(["-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ProxyCommand=false"]);
    ssh.args(["-o", &format!("ControlPath={}", socket.display())]);
    if let Some(port) = target.port {
        ssh.arg("-p").arg(port.to_string());
    }
    ssh.arg(format_ssh_target(target)?).arg(build_remote_login_shell_command(command));
    ssh.output().map_err(AppError::Io)
}

fn build_remote_login_shell_command(command: &str) -> String {
    // `-lc` (login, non-interactive) sources `.zprofile`/`.profile` so
    // user-customized PATH is available, but skips `.zshrc`/`.bashrc` —
    // which often contain interactive-only completion setups (e.g.
    // `command -v fd` lookups) that error noisily and run for hundreds of
    // milliseconds on every SSH call.
    format!("exec ${{SHELL:-bash}} -lc {}", quote_shell_arg(command))
}

pub(crate) fn format_ssh_target(target: &SshToolTarget) -> Result<String, AppError> {
    let host = target.host.trim();
    if !is_valid_ssh_host(host) {
        return Err(other("SSH host must be a config alias or hostname."));
    }

    if let Some(user) = target
        .user
        .as_deref()
        .map(str::trim)
        .filter(|user| !user.is_empty())
    {
        if !is_valid_ssh_user(user) {
            return Err(other("SSH user contains unsupported characters."));
        }
        return Ok(format!("{user}@{host}"));
    }

    Ok(host.to_string())
}

fn is_valid_ssh_host(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_valid_ssh_user(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub(crate) fn validate_remote_cwd(value: &str) -> Result<&str, AppError> {
    let trimmed = value.trim();
    if !trimmed.starts_with('/') {
        return Err(other("Remote folder must be an absolute path."));
    }
    if trimmed
        .bytes()
        .any(|byte| byte.is_ascii_control() || matches!(byte, b';' | b'&' | b'|' | b'`'))
        || trimmed.contains("$(")
    {
        return Err(other(
            "Remote folder contains unsupported shell characters.",
        ));
    }
    Ok(trimmed)
}

fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Run a probe through the operator's own login+interactive shell.
///
/// **Measured against `devbox-vps` on 2026-09-15, asking for `claude` three ways:** a plain
/// `ssh host 'claude'` (non-login) said `command not found`; `${SHELL:-bash} -lc` said the same,
/// because zsh reads `.zprofile` when it is a login shell; only `-lic` found it, at
/// `/home/alwi/.local/bin/claude`.
///
/// Every CLI installed by its own installer lands on a PATH that only the operator's `.zshrc` sets,
/// so a probe that does not do this reports present tools as missing — and a picker built on that
/// answer offers nothing, or worse, offers something that then fails at spawn. Parsers downstream
/// must stay tolerant of extra lines: an interactive shell may greet.
/// A PATH that tests may rely on, because the process one is not theirs to rely on.
///
/// `std::env::set_var` mutates the **whole process**, and `pty.rs`'s tests legitimately set `PATH`
/// to a temp directory and to `""` to prove how a spawn behaves without one. `cargo test` runs the
/// binary's tests in parallel, so any other test that reads the ambient `PATH` to build a child's
/// environment can pick up that empty value mid-flight.
///
/// The symptom is nothing like the cause: a shell script under test fails with
/// `mkdir: No such file or directory`, in a test that has nothing to do with spawning. Seen for
/// real on 2026-09-17 — ten tests failed together in a full run and every one of them passed in
/// isolation.
///
/// So a test that runs a shell script pins this instead of inheriting.
#[cfg(test)]
pub(crate) const TEST_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Make a script's globs behave the way it was written to expect, whatever shell runs it.
///
/// **ssh runs a command through the operator's login shell**, and on a zsh machine that shell has
/// `nomatch` on by default: a pattern matching nothing is a **fatal error**, where sh and bash leave
/// it as a literal for a `[ -d ]` guard to drop. Every script here was written for the second
/// behaviour, so on a zsh host they abort instead of returning nothing.
///
/// Found live on devbox-vps, 2026-09-17 — its shell is `/usr/bin/zsh`:
///
/// ```text
/// zsh   for d in */   (empty dir)  →  zsh:1: no matches found: */   ← whole script dies
/// bash  for d in */   (empty dir)  →  [*/]  and the guard drops it
/// sh    for d in */   (empty dir)  →  [*/]  and the guard drops it
/// ```
///
/// That cost two things silently: browsing an **empty directory** while picking a project failed
/// instead of showing nothing, and listing remote sessions died on every machine without
/// `~/.ccs/instances` — which is most of them.
///
/// `setopt` is a zsh builtin; in bash and dash it is simply not a command, so the redirect and
/// `|| true` make the line a no-op there. Measured in all three.
pub(crate) const SH_GLOB_PRELUDE: &str = "setopt nonomatch 2>/dev/null || true\n";

pub(crate) fn login_shell_script(script: &str) -> String {
    format!("exec ${{SHELL:-bash}} -lic {}", quote_shell_arg(script))
}

fn build_remote_tool_probe_script(tools: &[CliToolSpec]) -> String {
    tools
        .iter()
        .map(|tool| {
            format!(
                "if command -v {exe} >/dev/null 2>&1; then version=\"$({exe} {version_args} 2>&1 | sed -n '1p')\"; printf '%s\\t1\\t%s\\n' {id} \"$version\"; else printf '%s\\t0\\t\\n' {id}; fi",
                exe = quote_shell_arg(tool.executable),
                version_args = tool.version_args.join(" "),
                id = quote_shell_arg(tool.id),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_remote_tool_probe_output(output: &str) -> Vec<CliToolAvailability> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let id = parts.next()?.trim();
            let installed = parts.next()? == "1";
            let version = parts
                .next()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned);
            Some(CliToolAvailability {
                id: id.to_string(),
                installed,
                version,
            })
        })
        .collect()
}

pub(crate) fn read_command_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let message = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if message.is_empty() {
        "SSH command failed.".to_string()
    } else {
        message.lines().next().unwrap_or(message).trim().to_string()
    }
}

fn command_exists(executable: &str) -> bool {
    env::var_os("PATH")
        .map(|paths| command_exists_in_paths(executable, env::split_paths(&paths).collect()))
        .unwrap_or(false)
}

fn command_exists_in_paths(executable: &str, paths: Vec<PathBuf>) -> bool {
    if executable.contains(std::path::MAIN_SEPARATOR) {
        return is_executable_candidate(Path::new(executable));
    }

    for path in paths {
        let candidate = path.join(executable);
        if is_executable_candidate(&candidate) {
            return true;
        }

        #[cfg(windows)]
        {
            let extensions = env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".into());
            for extension in extensions
                .split(';')
                .filter(|extension| !extension.is_empty())
            {
                if is_executable_candidate(&path.join(format!("{executable}{extension}"))) {
                    return true;
                }
            }
        }
    }

    false
}

fn is_executable_candidate(path: &Path) -> bool {
    path.is_file()
}

fn read_version(tool: &CliToolSpec) -> Option<String> {
    let output = Command::new(tool.executable)
        .no_window()
        .args(tool.version_args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let value = if stdout.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };

    if value.is_empty() {
        None
    } else {
        Some(value.lines().next().unwrap_or(value).trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn command_lookup_finds_executable_in_supplied_paths() {
        let root = env::temp_dir().join(format!("lotus-cli-tools-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create temp dir");
        let executable = root.join("lazygit");
        fs::write(&executable, "").expect("write executable candidate");

        assert!(command_exists_in_paths("lazygit", vec![root.clone()]));
        assert!(!command_exists_in_paths("yazi", vec![root.clone()]));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn empty_request_returns_all_known_tools() {
        let result = get_cli_tool_availability(Vec::new());

        assert_eq!(
            result
                .iter()
                .map(|tool| tool.id.as_str())
                .collect::<Vec<_>>(),
            vec!["lazygit", "lazydocker", "yazi", "zoxide", "delta"],
        );
    }

    #[test]
    fn requested_ids_are_normalized_and_filtered() {
        let result = get_cli_tool_availability(vec![" Delta ".into(), "missing".into()]);

        assert_eq!(
            result
                .iter()
                .map(|tool| tool.id.as_str())
                .collect::<Vec<_>>(),
            vec!["delta"],
        );
    }

    #[test]
    fn formats_validated_ssh_targets() {
        assert_eq!(
            format_ssh_target(&SshToolTarget {
                host: "devbox-vps".into(),
                user: Some("alwi".into()),
                port: Some(2222),
            })
            .expect("valid target"),
            "alwi@devbox-vps",
        );
        assert!(format_ssh_target(&SshToolTarget {
            host: "bad host".into(),
            user: None,
            port: None,
        })
        .is_err());
    }

    #[test]
    fn parses_remote_tool_probe_output() {
        let result =
            parse_remote_tool_probe_output("lazygit\t1\tlazygit version 0.44.1\nyazi\t0\t\n");

        assert_eq!(
            result,
            vec![
                CliToolAvailability {
                    id: "lazygit".into(),
                    installed: true,
                    version: Some("lazygit version 0.44.1".into()),
                },
                CliToolAvailability {
                    id: "yazi".into(),
                    installed: false,
                    version: None,
                },
            ],
        );
    }

    #[test]
    fn builds_remote_probe_commands_for_the_remote_login_shell() {
        // -lc (non-interactive) loads PATH from .zprofile/.profile but skips
        // .zshrc/.bashrc, keeping SSH calls fast and silent.
        assert_eq!(
            build_remote_login_shell_command("command -v lazydocker"),
            "exec ${SHELL:-bash} -lc 'command -v lazydocker'",
        );
    }

    #[test]
    fn rejects_unsafe_remote_cwd() {
        assert_eq!(
            validate_remote_cwd("/home/alwi/project").unwrap(),
            "/home/alwi/project"
        );
        assert!(validate_remote_cwd("relative").is_err());
        assert!(validate_remote_cwd("/tmp/project; rm -rf /").is_err());
    }

    #[test]
    fn resolve_cwd_command_falls_back_to_pwd_when_hint_is_missing_or_relative() {
        assert_eq!(build_ssh_resolve_cwd_command(None), "pwd -P");
        assert_eq!(build_ssh_resolve_cwd_command(Some("")), "pwd -P");
        assert_eq!(build_ssh_resolve_cwd_command(Some("   ")), "pwd -P");
        assert_eq!(build_ssh_resolve_cwd_command(Some("~")), "pwd -P");
        assert_eq!(build_ssh_resolve_cwd_command(Some("~/projects")), "pwd -P");
        assert_eq!(
            build_ssh_resolve_cwd_command(Some("relative/path")),
            "pwd -P"
        );
    }

    #[test]
    fn resolve_cwd_command_uses_cd_for_absolute_hint() {
        assert_eq!(
            build_ssh_resolve_cwd_command(Some("/home/alwi/acme-main")),
            "cd '/home/alwi/acme-main' && pwd -P",
        );
        // Single quote is escaped so command stays single argument.
        assert_eq!(
            build_ssh_resolve_cwd_command(Some("/tmp/it's-fine")),
            "cd '/tmp/it'\\''s-fine' && pwd -P",
        );
    }

    #[test]
    fn resolve_cwd_parser_picks_first_absolute_line_after_shell_noise() {
        assert_eq!(
            parse_ssh_resolve_cwd_output("/home/alwi\n").as_deref(),
            Some("/home/alwi"),
        );
        assert_eq!(
            parse_ssh_resolve_cwd_output("Welcome banner\n\n  /var/www  \nextra\n").as_deref(),
            Some("/var/www"),
        );
        assert!(parse_ssh_resolve_cwd_output("").is_none());
        assert!(parse_ssh_resolve_cwd_output("relative-path\n").is_none());
    }
}
