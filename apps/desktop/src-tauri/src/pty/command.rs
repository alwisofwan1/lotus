use super::*;

pub(super) fn pty_shell_executable_and_args() -> (String, Vec<String>) {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
        (shell, vec!["-l".into()])
    }
    #[cfg(windows)]
    {
        windows_pty_shell_exe_and_args()
    }
}

#[cfg(windows)]
pub(super) fn windows_pty_shell_exe_and_args() -> (String, Vec<String>) {
    let pwsh7 = std::env::var_os("ProgramFiles").map(|root| {
        PathBuf::from(root)
            .join("PowerShell")
            .join("7")
            .join("pwsh.exe")
    });
    if let Some(ref p) = pwsh7 {
        if p.is_file() {
            return (p.to_string_lossy().into_owned(), vec!["-NoLogo".into()]);
        }
    }
    let ps5 = PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
    if ps5.is_file() {
        return (ps5.to_string_lossy().into_owned(), vec!["-NoLogo".into()]);
    }
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    (comspec, Vec::new())
}

/// Canvas environment injected into PTY sessions spawned from a Canvas Terminal Node.
/// Exposes the Canvas Agent API so agents can open browsers, navigate, and pull screenshots.
#[derive(Debug, Clone)]
pub struct CanvasPtyEnv {
    pub terminal_id: String,
    pub api_url: String,
    pub api_key: String,
}

/// portable_pty's `CommandBuilder` calls `env_clear()` on the spawned child, so it inherits NONE of
/// our process env unless we copy it in. Without this the child never sees HOME / CLAUDE_CONFIG_DIR /
/// auth / the real PATH, and `claude` reports "Not logged in · Please run /login" even though the user
/// is authenticated. Copy the parent env, then layer the captured login-shell env on top (covers a
/// Finder/launchd launch whose parent env is the bare `/usr/bin:/bin`). Unix-only — Windows inherits
/// differently. Shared by the shell-session and command-session builders.
#[cfg(unix)]
/// Apply captured environment pairs to a child command.
///
/// An EMPTY value means "the child must not have this variable", not "the child gets an empty
/// one". `shell_env::default_agent_env` blanks `CLAUDE_CONFIG_DIR` to stop a default agent
/// inheriting the operator's last ccs profile — but a blank that is passed through arrives at
/// the child as set-and-empty, and Claude Code then resolves its config directory to "" and
/// calls `mkdir("")`. Measured 2026-09-20: that is the `ENOENT: no such file or directory,
/// mkdir` on every launch, alongside "Remote managed settings failed to load" and a startup slow
/// enough to look like a hang.
pub(super) fn apply_env_pairs<'a, I>(cmd: &mut CommandBuilder, pairs: I)
where
    I: Iterator<Item = &'a (String, String)>,
{
    for (key, value) in pairs {
        if value.is_empty() {
            cmd.env_remove(key);
        } else {
            cmd.env(key, value);
        }
    }
}

#[cfg(unix)]
pub(super) fn apply_inherited_env(cmd: &mut CommandBuilder) {
    for (key, value) in std::env::vars_os() {
        cmd.env(key, value);
    }
    let login_env = crate::shell_env::user_login_env();
    let pairs: Vec<(String, String)> = login_env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    apply_env_pairs(cmd, pairs.iter());
    apply_chosen_account(cmd, crate::usage::chosen_claude_dir());
    // Codex's pick in Settings › Accounts; nothing chosen keeps the shell's `CODEX_HOME`.
    match crate::usage::chosen_codex_account() {
        Some(a) if a.id == crate::accounts::DEFAULT => cmd.env_remove("CODEX_HOME"),
        Some(a) => cmd.env("CODEX_HOME", a.dir),
        None => {}
    }
    // Strip pane-scoped vars picked up from the app's own environment or the
    // login shell — including the ones CommandBuilder::new inherited into its
    // base env. When Lotus itself is launched from inside a canvas terminal
    // (dev workflow) these carry a FOREIGN session's identity and API key;
    // inheriting them would make agents in fresh panes impersonate that
    // session. Panes that own these vars get them re-applied explicitly in
    // `build_pty_shell_command` / `apply_canvas_pty_env`.
    for key in PANE_SCOPED_ENV_VARS {
        cmd.env_remove(key);
    }
    for key in PHYSICAL_TERMINAL_ENV_VARS {
        cmd.env_remove(key);
    }
    for key in PARENT_SESSION_ENV_VARS {
        cmd.env_remove(key);
    }
}

/// The account picked with "Use" in the usage popover. A `ccs <name>` runner still sets its own.
/// The `default` account is the absence of the variable, never `CLAUDE_CONFIG_DIR=~/.claude`.
#[cfg(unix)]
pub(super) fn apply_chosen_account(cmd: &mut CommandBuilder, chosen: Option<std::path::PathBuf>) {
    match chosen {
        Some(dir) if crate::accounts::is_default(&dir) => cmd.env_remove("CLAUDE_CONFIG_DIR"),
        Some(dir) => cmd.env("CLAUDE_CONFIG_DIR", dir),
        None => {}
    }
}

/// "Claude on account X" (issues/07): a pane's own account, over the one chosen globally.
pub(super) fn apply_account(cmd: &mut CommandBuilder, account: &crate::accounts::Account) {
    if account.id == crate::accounts::DEFAULT {
        cmd.env_remove("CLAUDE_CONFIG_DIR");
    } else {
        cmd.env("CLAUDE_CONFIG_DIR", &account.dir);
    }
}

/// `ccs <name> …` runs as `claude …` on account `<name>` when there is one (issues/08): a saved runner
/// or canvas node keeps working once ccs is uninstalled. A ccs API profile is no account, so it stays ccs.
pub(crate) fn legacy_ccs(command: Vec<String>, account: Option<String>, is_account: impl Fn(&str) -> bool) -> (Vec<String>, Option<String>) {
    let is_ccs = command.first().is_some_and(|c| Path::new(c).file_name().is_some_and(|n| n == "ccs"));
    match command.get(1) {
        Some(name) if is_ccs && account.is_none() && !name.starts_with('-') && is_account(name) => {
            let name = name.clone();
            let argv = std::iter::once("claude".to_string()).chain(command.into_iter().skip(2)).collect();
            (argv, Some(name))
        }
        _ => (command, account),
    }
}

/// An unknown id fails the spawn: running it on the global account instead would bill the wrong one.
pub(super) fn with_account(cmd: &mut CommandBuilder, claude_account: Option<&str>) -> Result<(), AppError> {
    if let Some(id) = claude_account {
        let account = crate::accounts::find(id).ok_or_else(|| crate::error::other(format!("no Claude account named {id}")))?;
        apply_account(cmd, &account);
    }
    Ok(())
}

/// Grok's default theme paints every cell `rgb(20,20,20)`, so on a light canvas it sits as a black
/// slab inside the node. Its `terminal` theme paints no background and takes our palette instead
/// (measured: 36 background sequences → 0). A value the user exported themselves wins.
pub(super) fn apply_terminal_theme_defaults(cmd: &mut CommandBuilder) {
    if cmd.get_env("GROK_THEME").is_none() {
        cmd.env("GROK_THEME", "terminal");
        // The theme is still behind a rollout flag; without this it falls back to the default.
        cmd.env("GROK_TERMINAL_THEME", "1");
    }
    // Our xterm renders OSC 8, but with TERM_PROGRAM stripped, supports-hyperlinks says no. Claude
    // Code then prints URLs as text, which Ink hard-wraps, so a click opened only the first row's half.
    if cmd.get_env("FORCE_HYPERLINK").is_none() {
        cmd.env("FORCE_HYPERLINK", "1");
    }
    // OSC 7501 program status (read by `McpIpcState::program_status_sink`) without the support
    // query: under sessiond its reply would have to come from the daemon, before the DA reply.
    // grok has no env switch; it gets its status from the Claude hooks it reads.
    if cmd.get_env("PI_PROGRAM_STATUS").is_none() {
        cmd.env("PI_PROGRAM_STATUS", "1");
    }
    if cmd.get_env("AGY_CLI_OSC7501").is_none() {
        cmd.env("AGY_CLI_OSC7501", "on");
    }
}

#[cfg(not(unix))]
pub(super) fn apply_inherited_env(cmd: &mut CommandBuilder) {
    // Windows PTYs inherit the process env via CommandBuilder's base env —
    // still strip pane-scoped identity vars (see the unix variant for why).
    for key in PANE_SCOPED_ENV_VARS {
        cmd.env_remove(key);
    }
    for key in PHYSICAL_TERMINAL_ENV_VARS {
        cmd.env_remove(key);
    }
    for key in PARENT_SESSION_ENV_VARS {
        cmd.env_remove(key);
    }
}

/// Env keys Lotus injects per-pane. Never inherited into a new PTY: each pane
/// either owns fresh values (re-applied below) or must not see them at all.
/// Markers naming the Claude session that launched **Lotus itself**.
///
/// Observed live 2026-09-12: a canvas agent cell printed *"Transcript saving is off — inherited
/// CLAUDE_CODE_CHILD_SESSION marker"*. A cell that believes it is nested writes no transcript, so
/// no session id can be captured, so nothing can be resumed later — the feature simply has nothing
/// to point at. `packages/host` has stripped these since 2026-09-07 (`core/agent-env.ts`); the
/// desktop's own PTY spawn inherited them all along.
///
/// Two of them are worse than noisy: `CLAUDE_CODE_MESSAGING_SOCKET` and `_TOKEN` address the
/// launching session's channel, so a cell that inherits them holds another session's credential.
///
/// **A deny-list, not the `CLAUDE_CODE_` prefix**, and that is load-bearing:
/// `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is a flag Lotus sets on purpose — sweeping the prefix
/// would turn off the feature this app is a front end for. `CLAUDE_CONFIG_DIR` stays too: it is the
/// profile a cell was asked to run as.
pub(super) const PARENT_SESSION_ENV_VARS: [&str; 6] = [
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
];

pub(super) const PANE_SCOPED_ENV_VARS: [&str; 7] = [
    "LOTUS_PANE_ID",
    "LOTUS_PROFILE_KEY",
    "AGENT_CANVAS_TERMINAL_ID",
    "AGENT_CANVAS_API",
    "AGENT_CANVAS_API_KEY",
    "LOTUS_BROWSER_HELPER",
    "LOTUS_BROWSER_STATE_DIR",
];

/// Identity and capability hints for the terminal that launched Lotus itself.
///
/// A child PTY renders through Lotus's xterm surfaces, not through that outer terminal.
/// Forwarding these hints makes CLIs enable protocols the actual renderer does not
/// implement — notably Codex emitting PNG terminal pets through Kitty graphics when
/// Lotus was launched from Ghostty. `TERM` is set explicitly by each command builder.
pub(super) const PHYSICAL_TERMINAL_ENV_VARS: [&str; 10] = [
    "TERM_PROGRAM",
    "TERM_PROGRAM_VERSION",
    "KITTY_WINDOW_ID",
    "WEZTERM_EXECUTABLE",
    "WEZTERM_VERSION",
    "ITERM_SESSION_ID",
    "LC_TERMINAL",
    "LC_TERMINAL_VERSION",
    "GHOSTTY_RESOURCES_DIR",
    "GHOSTTY_BIN_DIR",
];

pub(super) fn build_pty_shell_command(
    cwd: &str,
    pane_id: Option<&str>,
    canvas_env: Option<&CanvasPtyEnv>,
) -> CommandBuilder {
    let (exe, default_args) = pty_shell_executable_and_args();
    let integration = shell_integration::write_shell_integration_script(&exe);
    let args = integration
        .as_ref()
        .map(|integration| integration.args(default_args.clone()))
        .unwrap_or(default_args);
    let mut cmd = CommandBuilder::new(&exe);
    for a in args {
        cmd.arg(a);
    }
    // Inherit the user's real env (HOME, CLAUDE_CONFIG_DIR, auth, login PATH) FIRST so agents/`claude`
    // launched in this shell are logged in. Canvas-specific vars below override as needed.
    apply_inherited_env(&mut cmd);
    if let Some(integration) = integration.as_ref() {
        integration.apply_env(&mut cmd);
    }
    cmd.env("TERM", "xterm-256color");
    apply_terminal_theme_defaults(&mut cmd);
    // Phase 7.3 profile invariant: tell any agent/CLI launched in this PTY which Lotus instance
    // spawned it ("lotus" | "lotus-dev"), so its MCP sidecar refuses to serve the OTHER instance's
    // fleet (both registrations coexist in ~/.claude.json when dev + release run side by side).
    cmd.env("LOTUS_PROFILE_KEY", crate::mcp_config::mcp_server_key());
    // Lets the next Lotus recognise this tree's orphans if we die without a clean exit.
    #[cfg(unix)]
    cmd.env(orphan_reaper::OWNER_PID_ENV, std::process::id().to_string());
    if let Some(pid) = pane_id {
        cmd.env("LOTUS_PANE_ID", pid);
    }
    if let Some(env) = canvas_env {
        apply_canvas_pty_env(&mut cmd, env);
    }
    cmd.cwd(cwd);
    cmd
}

pub(super) fn apply_canvas_pty_env(cmd: &mut CommandBuilder, env: &CanvasPtyEnv) {
    cmd.env("AGENT_CANVAS_TERMINAL_ID", &env.terminal_id);
    cmd.env("AGENT_CANVAS_API", &env.api_url);
    cmd.env("AGENT_CANVAS_API_KEY", &env.api_key);
    let helper = crate::browser_helper::terminal_env();
    cmd.env("LOTUS_BROWSER_HELPER", helper.script_path);
    cmd.env("LOTUS_BROWSER_STATE_DIR", helper.state_dir);
    // Prepend the helper bin to the INHERITED login PATH (not the bare parent PATH), so both the
    // browser helper and `claude` / toolchain shims resolve.
    #[cfg(unix)]
    let base_path = crate::shell_env::user_login_env()
        .get("PATH")
        .map(|p| std::ffi::OsString::from(p.as_str()))
        .or_else(|| std::env::var_os("PATH"));
    #[cfg(not(unix))]
    let base_path = std::env::var_os("PATH");
    cmd.env(
        "PATH",
        crate::browser_helper::prepend_helper_bin_to_path(base_path),
    );
}

pub(super) fn build_pty_command(
    command: &[String],
    cwd: &str,
    pane_id: Option<&str>,
    canvas_env: Option<&CanvasPtyEnv>,
) -> Result<CommandBuilder, AppError> {
    let executable = command
        .first()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| other("command is empty"))?;

    let resolved_executable = resolve_command_executable(executable);

    let mut cmd = CommandBuilder::new(&resolved_executable);

    for arg in command.iter().skip(1) {
        cmd.arg(arg);
    }

    // Copy the parent env + captured login-shell env so `claude` sees HOME / CLAUDE_CONFIG_DIR /
    // auth / real PATH (portable_pty env_clear()s the child). Shared with the shell-session builder.
    apply_inherited_env(&mut cmd);
    // One-shot diagnostic on stderr (LOTUS_BRIDGE_LOG=1) so users can verify auth env reached `claude`.
    #[cfg(unix)]
    if std::env::var_os("LOTUS_BRIDGE_LOG").is_some() {
        let login_env = crate::shell_env::user_login_env();
        eprintln!(
            "[bridge-pty] exec={} parent_CLAUDE_CONFIG_DIR={:?} login_CLAUDE_CONFIG_DIR={:?} login_env_keys={} cwd={}",
            resolved_executable,
            std::env::var("CLAUDE_CONFIG_DIR").ok(),
            login_env.get("CLAUDE_CONFIG_DIR"),
            login_env.len(),
            cwd,
        );
    }

    cmd.env("TERM", "xterm-256color");
    apply_terminal_theme_defaults(&mut cmd);
    // Phase 7.3 profile invariant: tell any agent/CLI launched in this PTY which Lotus instance
    // spawned it ("lotus" | "lotus-dev"), so its MCP sidecar refuses to serve the OTHER instance's
    // fleet (both registrations coexist in ~/.claude.json when dev + release run side by side).
    cmd.env("LOTUS_PROFILE_KEY", crate::mcp_config::mcp_server_key());
    // Lets the next Lotus recognise this tree's orphans if we die without a clean exit.
    #[cfg(unix)]
    cmd.env(orphan_reaper::OWNER_PID_ENV, std::process::id().to_string());
    if let Some(pid) = pane_id {
        cmd.env("LOTUS_PANE_ID", pid);
    }
    if let Some(env) = canvas_env {
        apply_canvas_pty_env(&mut cmd, env);
    }
    cmd.cwd(cwd);
    Ok(cmd)
}
