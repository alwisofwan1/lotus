#[test]
fn grok_gets_the_terminal_theme_unless_the_user_chose_one() {
    let mut cmd = CommandBuilder::new("sh");
    apply_terminal_theme_defaults(&mut cmd);
    assert_eq!(cmd.get_env("GROK_THEME"), Some(std::ffi::OsStr::new("terminal")));
    assert_eq!(cmd.get_env("GROK_TERMINAL_THEME"), Some(std::ffi::OsStr::new("1")));

    let mut chosen = CommandBuilder::new("sh");
    chosen.env("GROK_THEME", "tokyonight");
    apply_terminal_theme_defaults(&mut chosen);
    assert_eq!(chosen.get_env("GROK_THEME"), Some(std::ffi::OsStr::new("tokyonight")));
    assert_eq!(chosen.get_env("GROK_TERMINAL_THEME"), None);
}
/// An inherited variable is masked by REMOVING it, never by setting it empty.
///
/// `shell_env::default_agent_env` blanks `CLAUDE_CONFIG_DIR` so a default agent keeps the
/// standard login instead of whatever ccs profile the operator last used. Passing that blank
/// through to the child is a different thing entirely: the variable arrives SET and empty,
/// Claude Code resolves its config directory to "" and calls `mkdir("")`, which fails with
/// `ENOENT: no such file or directory, mkdir` — observed 2026-09-20 on every `claude` start,
/// together with "Remote managed settings failed to load" and a very slow launch.
#[test]
fn empty_login_env_values_are_unset_for_the_child_not_passed_as_empty() {
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.env("CLAUDE_CONFIG_DIR", "/home/test/.ccs/instances/initech");

    apply_env_pairs(&mut cmd, [("CLAUDE_CONFIG_DIR".to_string(), String::new())].iter());

    assert_eq!(
        cmd.get_env("CLAUDE_CONFIG_DIR"),
        None,
        "an empty value means 'do not give the child this variable'",
    );
}

#[test]
fn the_default_account_runs_with_no_config_dir_variable() {
    let mut cmd = CommandBuilder::new("/bin/sh");
    cmd.env("CLAUDE_CONFIG_DIR", "/home/test/.ccs/instances/initech");
    apply_chosen_account(&mut cmd, Some(crate::paths::claude_dir()));
    assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), None);

    apply_chosen_account(&mut cmd, Some("/home/test/.ccs/instances/acme".into()));
    assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR").and_then(|v| v.to_str()), Some("/home/test/.ccs/instances/acme"));
}

#[test]
fn non_empty_login_env_values_still_reach_the_child() {
    let mut cmd = CommandBuilder::new("/bin/sh");
    apply_env_pairs(&mut cmd, [("PATH".to_string(), "/usr/local/bin".to_string())].iter());

    assert_eq!(cmd.get_env("PATH").and_then(|v| v.to_str()), Some("/usr/local/bin"));
}

use super::*;

#[test]
fn silence_is_the_gap_between_session_age_and_last_output() {
    assert_eq!(silence_ms(10_000, 4_000), 6_000);
    assert_eq!(silence_ms(10_000, 10_000), 0);
}

#[test]
fn silence_saturates_when_last_output_reads_ahead_of_session_age() {
    // The two readings are taken a moment apart and share no lock, so the output stamp can
    // legitimately be a hair newer than the age sampled just before it. Wrapping here would
    // report a session that spoke microseconds ago as silent for 584 million years — and a
    // reaper acting on staleness would kill it on the spot.
    assert_eq!(silence_ms(1_000, 1_001), 0);
    assert_eq!(silence_ms(0, u64::MAX), 0);
}

#[test]
fn a_session_that_never_produced_output_is_silent_for_its_whole_life() {
    // last_output_ms starts at 0, so a runner that has said nothing reads as silent since
    // spawn. That is correct, and it is exactly why the reclaim policy also has a minimum
    // age guard: a still-booting runner looks identical to an abandoned one.
    assert_eq!(silence_ms(30_000, 0), 30_000);
}

#[cfg(unix)]
fn unix_process_is_running(pid: i32) -> bool {
    let Ok(output) = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
    else {
        return false;
    };
    output.status.success()
        && output
            .stdout
            .iter()
            .copied()
            .find(|byte| !byte.is_ascii_whitespace())
            .is_some_and(|state| state != b'Z')
}

#[cfg(unix)]
#[test]
fn unix_pty_defaults_to_bash_login_shell() {
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous = std::env::var_os("SHELL");
    std::env::remove_var("SHELL");
    let (exe, args) = pty_shell_executable_and_args();
    assert_eq!(exe, "/bin/bash");
    assert_eq!(args, vec!["-l".to_string()]);
    match &previous {
        Some(v) => std::env::set_var("SHELL", v),
        None => std::env::remove_var("SHELL"),
    }
}

#[cfg(unix)]
#[test]
fn unix_pty_respects_shell_env() {
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous = std::env::var_os("SHELL");
    std::env::set_var("SHELL", "/bin/zsh");
    let (exe, args) = pty_shell_executable_and_args();
    assert_eq!(exe, "/bin/zsh");
    assert_eq!(args, vec!["-l".to_string()]);
    match &previous {
        Some(v) => std::env::set_var("SHELL", v),
        None => std::env::remove_var("SHELL"),
    }
}

#[cfg(windows)]
#[test]
fn windows_pty_shell_path_is_a_known_host_shell() {
    let (exe, _) = pty_shell_executable_and_args();
    let lower = exe.to_lowercase();
    assert!(
        lower.ends_with("pwsh.exe")
            || lower.ends_with("powershell.exe")
            || lower.ends_with("cmd.exe"),
        "unexpected shell: {exe}"
    );
}

#[test]
fn build_direct_command_uses_first_token_as_executable() {
    let cmd = build_pty_command(
        &[
            "claude".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ],
        "/tmp",
        None,
        None,
    )
    .expect("build direct pty command");
    let debug = format!("{cmd:?}");
    assert!(debug.contains("claude"));
    assert!(debug.contains("--dangerously-skip-permissions"));
    assert!(debug.contains("/tmp"));
}

#[test]
fn default_claude_pty_uses_standard_login_without_a_config_dir_override() {
    // The intent is unchanged — a default agent must not inherit the operator's last ccs
    // profile — but the way to express it is ABSENCE, not an empty string.
    //
    // Measured 2026-09-20 with `claude doctor`, same machine, same binary (2.1.278):
    //   CLAUDE_CONFIG_DIR=""  → "Last update attempt: none recorded"
    //   variable unset        → "Last update attempt: success → 2.1.193 (2026-06-26)"
    // The empty value sends the CLI to a config home it cannot use; the binary itself
    // carries the string "the configuration home (CLAUDE_CONFIG_DIR) is not an absolute
    // path". In a pane that surfaced as "Remote managed settings failed to load", an
    // "ENOENT: no such file or directory, mkdir" on the first prompt, and a launch slow
    // enough to look like a hang.
    let cmd = build_pty_command(&["claude".into()], "/tmp", None, None).unwrap();
    assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), None);
}

#[test]
fn a_pane_on_its_own_account_overrides_the_chosen_one() {
    let account = |id: &str, dir: &str| crate::accounts::Account {
        id: id.into(),
        source: crate::accounts::Source::Lotus,
        dir: dir.into(),
        config_file: format!("{dir}/.claude.json").into(),
    };
    let mut cmd = build_pty_command(&["claude".into()], "/tmp", None, None).unwrap();
    apply_account(&mut cmd, &account("hss", "/h/.ccs/instances/hss"));
    assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), Some(std::ffi::OsStr::new("/h/.ccs/instances/hss")));
    // `default` is the absence of the variable, never `~/.claude`.
    apply_account(&mut cmd, &account(crate::accounts::DEFAULT, "/h/.claude"));
    assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), None);
}

#[test]
fn a_ccs_account_command_runs_claude_on_that_account() {
    let argv = |s: &str| s.split(' ').map(String::from).collect::<Vec<_>>();
    let is_account = |id: &str| id == "initech";
    assert_eq!(
        legacy_ccs(argv("ccs initech --dangerously-skip-permissions"), None, is_account),
        (argv("claude --dangerously-skip-permissions"), Some("initech".into()))
    );
    // A ccs API profile, a ccs subcommand flag and an explicit account are left as they are.
    assert_eq!(legacy_ccs(argv("ccs glm"), None, is_account), (argv("ccs glm"), None));
    assert_eq!(legacy_ccs(argv("ccs --version"), None, is_account), (argv("ccs --version"), None));
    assert_eq!(legacy_ccs(argv("ccs initech"), Some("work".into()), is_account), (argv("ccs initech"), Some("work".into())));
}

#[test]
fn ccs_profile_selection_survives_direct_spawn_and_resume() {
    let cmd = build_pty_command(
        &["ccs".into(), "initech".into(), "--resume".into(), "session-a".into()],
        "/tmp", None, None,
    ).unwrap();
    let args = cmd.get_argv();
    assert_eq!(args[1..], ["initech", "--resume", "session-a"]);
    // `ccs` picks its own profile from its arguments, so the child must arrive with no
    // inherited override at all — see the note on the test above for why empty is not that.
    assert_eq!(cmd.get_env("CLAUDE_CONFIG_DIR"), None);
}

#[cfg(unix)]
#[test]
fn build_direct_command_skips_login_shell_wrapper_on_unix() {
    // Bridge spawns the executable directly so rc-file banners
    // (P10k, nvm, motd) can't pollute the stream-json stdout the
    // composer parses. Auth env comes from `shell_env::user_login_env()`
    // captured once at startup.
    let cmd = build_pty_command(
        &[
            "claude".to_string(),
            "--print".to_string(),
            "hello world".to_string(),
        ],
        "/tmp",
        None,
        None,
    )
    .expect("build direct pty command");
    let debug = format!("{cmd:?}");
    assert!(debug.contains("claude"));
    assert!(!debug.contains("lotus-pty-command"));
    assert!(!debug.contains("exec \\\"$@\\\""));
    assert!(debug.contains("--print"));
    assert!(debug.contains("hello world"));
}

#[cfg(unix)]
#[test]
fn build_direct_command_resolves_first_token_from_path() {
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let temp_dir = std::env::temp_dir().join(format!("lotus_pty_path_test_{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).expect("create temp command dir");
    let fake_claude = temp_dir.join("claude");
    fs::write(&fake_claude, "#!/bin/sh\nexit 0\n").expect("write fake command");

    let previous_path = std::env::var_os("PATH");
    std::env::set_var("PATH", temp_dir.to_string_lossy().as_ref());

    let cmd = build_pty_command(
        &["claude".to_string(), "--print".to_string()],
        "/tmp",
        None,
        None,
    )
    .expect("build direct pty command");
    let debug = format!("{cmd:?}");
    assert!(debug.contains(fake_claude.to_string_lossy().as_ref()));

    match previous_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
    let _ = fs::remove_file(fake_claude);
    let _ = fs::remove_dir(temp_dir);
}

#[cfg(unix)]
#[test]
fn unresolved_direct_command_keeps_original_token() {
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous_path = std::env::var_os("PATH");
    std::env::set_var("PATH", "");

    let cmd = build_pty_command(
        &["definitely-missing-lotus-command".to_string()],
        "/tmp",
        None,
        None,
    )
    .expect("build direct pty command");
    let debug = format!("{cmd:?}");
    assert!(debug.contains("definitely-missing-lotus-command"));

    match previous_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
}

#[test]
fn build_direct_command_rejects_empty_commands() {
    let error =
        build_pty_command(&[], "/tmp", None, None).expect_err("empty commands must fail");
    assert!(error.to_string().contains("command is empty"));
}

#[cfg(unix)]
#[test]
fn zsh_shell_command_enables_lotus_shell_integration() {
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous = std::env::var_os("SHELL");
    std::env::set_var("SHELL", "/bin/zsh");

    let cmd = build_pty_shell_command("/tmp", None, None);

    assert_eq!(cmd.get_env("LOTUS_SHELL_INTEGRATION").and_then(|v| v.to_str()), Some("1"));
    assert!(cmd.get_env("ZDOTDIR").is_some());
    assert!(cmd.get_env("LOTUS_ORIGINAL_ZDOTDIR").is_some());

    match previous {
        Some(v) => std::env::set_var("SHELL", v),
        None => std::env::remove_var("SHELL"),
    }
}

#[test]
fn shell_command_injects_lotus_pane_id_env_when_provided() {
    let cmd = build_pty_shell_command("/tmp", Some("pane-uuid-abc"), None);
    assert_eq!(
        cmd.get_env("LOTUS_PANE_ID")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("pane-uuid-abc".to_string()),
    );
}

#[test]
fn shell_command_omits_lotus_pane_id_env_when_absent() {
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous = std::env::var_os("LOTUS_PANE_ID");
    std::env::remove_var("LOTUS_PANE_ID");
    let cmd = build_pty_shell_command("/tmp", None, None);
    assert!(cmd.get_env("LOTUS_PANE_ID").is_none());
    match previous {
        Some(v) => std::env::set_var("LOTUS_PANE_ID", v),
        None => std::env::remove_var("LOTUS_PANE_ID"),
    }
}

#[test]
fn pty_commands_do_not_claim_the_parent_physical_terminals_capabilities() {
    const PHYSICAL_TERMINAL_KEYS: [&str; 10] = [
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

    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous: Vec<_> = PHYSICAL_TERMINAL_KEYS
        .iter()
        .map(|key| std::env::var_os(key))
        .collect();
    for key in PHYSICAL_TERMINAL_KEYS {
        std::env::set_var(key, "outer-terminal-capability");
    }

    let shell = build_pty_shell_command("/tmp", None, None);
    let direct = build_pty_command(&["codex".to_string()], "/tmp", None, None)
        .expect("build direct pty command");

    for (key, value) in PHYSICAL_TERMINAL_KEYS.iter().zip(previous) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    for key in PHYSICAL_TERMINAL_KEYS {
        assert!(shell.get_env(key).is_none(), "shell inherited {key}");
        assert!(
            direct.get_env(key).is_none(),
            "direct command inherited {key}"
        );
    }
    assert_eq!(
        shell.get_env("TERM").and_then(|v| v.to_str()),
        Some("xterm-256color")
    );
    assert_eq!(
        direct.get_env("TERM").and_then(|v| v.to_str()),
        Some("xterm-256color")
    );
    // Stripping TERM_PROGRAM must not cost OSC 8 links: our xterm renders them.
    for cmd in [&shell, &direct] {
        assert_eq!(cmd.get_env("FORCE_HYPERLINK").and_then(|v| v.to_str()), Some("1"));
    }
}

#[test]
fn direct_command_injects_lotus_pane_id_env_when_provided() {
    let cmd = build_pty_command(
        &["claude".to_string(), "--print".to_string()],
        "/tmp",
        Some("pane-xyz"),
        None,
    )
    .expect("build direct pty command");
    assert_eq!(
        cmd.get_env("LOTUS_PANE_ID")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("pane-xyz".to_string()),
    );
}

#[test]
fn direct_command_injects_canvas_env_vars_when_canvas_env_provided() {
    let env = CanvasPtyEnv {
        terminal_id: "agent-node-abc".to_string(),
        api_url: "http://127.0.0.1:9877".to_string(),
        api_key: "secret-key-xyz".to_string(),
    };
    let cmd = build_pty_command(
        &["claude".to_string(), "--print".to_string()],
        "/tmp",
        Some("pane-xyz"),
        Some(&env),
    )
    .expect("build direct pty command");
    assert_eq!(
        cmd.get_env("AGENT_CANVAS_TERMINAL_ID")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("agent-node-abc".to_string()),
    );
    assert_eq!(
        cmd.get_env("AGENT_CANVAS_API")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("http://127.0.0.1:9877".to_string()),
    );
    assert_eq!(
        cmd.get_env("AGENT_CANVAS_API_KEY")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("secret-key-xyz".to_string()),
    );
    assert!(cmd.get_env("LOTUS_BROWSER_HELPER").is_some());
}

#[test]
fn empty_cwd_falls_back_to_home_dir() {
    assert_eq!(resolve_session_cwd(""), paths::home_dir().to_string_lossy());
}

#[test]
fn shell_command_injects_canvas_env_vars_when_canvas_env_provided() {
    let env = CanvasPtyEnv {
        terminal_id: "node-term-abc".to_string(),
        api_url: "http://127.0.0.1:9877".to_string(),
        api_key: "secret-key-xyz".to_string(),
    };
    let cmd = build_pty_shell_command("/tmp", None, Some(&env));
    assert_eq!(
        cmd.get_env("AGENT_CANVAS_TERMINAL_ID")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("node-term-abc".to_string()),
    );
    assert_eq!(
        cmd.get_env("AGENT_CANVAS_API")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("http://127.0.0.1:9877".to_string()),
    );
    assert_eq!(
        cmd.get_env("AGENT_CANVAS_API_KEY")
            .and_then(|v| v.to_str())
            .map(str::to_string),
        Some("secret-key-xyz".to_string()),
    );
}

#[test]
fn shell_command_exposes_lotus_browser_helper_for_canvas_terminal() {
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous_home = std::env::var_os("HOME");
    let previous_path = std::env::var_os("PATH");
    let home = std::env::temp_dir().join("lotus_browser_helper_pty_home");
    std::env::set_var("HOME", &home);
    std::env::set_var("PATH", "/usr/bin");

    let env = CanvasPtyEnv {
        terminal_id: "node-term-abc".to_string(),
        api_url: "http://127.0.0.1:9877".to_string(),
        api_key: "secret-key-xyz".to_string(),
    };
    let cmd = build_pty_shell_command("/tmp", None, Some(&env));
    let helper = cmd
        .get_env("LOTUS_BROWSER_HELPER")
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let state_dir = cmd
        .get_env("LOTUS_BROWSER_STATE_DIR")
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let path = cmd.get_env("PATH").expect("PATH should be set");
    let first_path = std::env::split_paths(path).next().expect("helper bin path");

    assert!(helper.ends_with("lotus-browser.mjs"));
    assert!(state_dir.ends_with("browser-helper"));
    assert_eq!(first_path, paths::lotus_state_dir().join("bin"));

    match previous_home {
        Some(v) => std::env::set_var("HOME", v),
        None => std::env::remove_var("HOME"),
    }
    match previous_path {
        Some(v) => std::env::set_var("PATH", v),
        None => std::env::remove_var("PATH"),
    }
}

#[test]
fn shell_command_omits_canvas_env_vars_when_canvas_env_absent() {
    // Simulate Lotus itself being launched from inside a canvas terminal
    // (the dev workflow): the app process carries a FOREIGN session's
    // pane-scoped vars. A fresh pane without its own canvas env must not
    // inherit that identity — agents would impersonate the other session.
    let _g = crate::paths::TEST_ENV_LOCK
        .lock()
        .expect("lock pty env tests");
    let previous: Vec<Option<String>> = PANE_SCOPED_ENV_VARS
        .iter()
        .map(|k| std::env::var(k).ok())
        .collect();
    for key in PANE_SCOPED_ENV_VARS {
        std::env::set_var(key, "foreign-session-value");
    }

    let cmd = build_pty_shell_command("/tmp", None, None);

    for (key, value) in PANE_SCOPED_ENV_VARS.iter().zip(previous) {
        match value {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }

    for key in PANE_SCOPED_ENV_VARS {
        if key == "LOTUS_PROFILE_KEY" {
            // Instance-level, not foreign session identity: a bare pane must NOT inherit the
            // foreign value, but MUST carry THIS instance's key (Phase 7.3 profile invariant).
            assert_eq!(
                cmd.get_env(key).and_then(|v| v.to_str()),
                Some(crate::mcp_config::mcp_server_key()),
                "LOTUS_PROFILE_KEY must be reset to this instance's key, not inherited",
            );
        } else {
            assert!(cmd.get_env(key).is_none(), "{key} should be absent");
        }
    }
}

/// `session_child_pid` powers nested-agent stop attribution in
/// `mcp_ipc::hook_stop`; an unknown session must yield `None` (the caller
/// then fails open) rather than erroring.
#[test]
fn session_child_pid_returns_none_for_unknown_session() {
    let state: PtyState = Arc::new(Mutex::new(PtyStore::default()));
    assert_eq!(session_child_pid("no-such-session", &state), None);
}

/// Closing a PTY session is an ownership boundary: commands launched by the
/// pane must not survive after the pane itself is gone, even when they ignore
/// terminal hangup/TERM and run in a descendant shell.
#[cfg(unix)]
#[test]
fn kill_session_terminates_descendant_processes() {
    let _serial = crate::pty::PROCESS_KILL_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state: PtyState = Arc::new(Mutex::new(PtyStore::default()));
    let temp = tempfile::tempdir().expect("tempdir");
    let pid_file = temp.path().join("descendant.pid");
    let script = format!(
        "nohup /bin/sh -c 'trap \"\" TERM HUP; while :; do /bin/sleep 1; done' </dev/null >/dev/null 2>&1 & echo $! > {} ; wait",
        shell_escape(pid_file.to_string_lossy().as_ref()),
    );
    let builder = build_pty_command(
        &["/bin/sh".to_string(), "-c".to_string(), script],
        "/tmp",
        None,
        None,
    )
    .expect("builder");
    let session_id = spawn_session(
        "/tmp".to_string(),
        "process-tree-test".to_string(),
        80,
        24,
        None,
        &state,
        builder,
        None,
    )
    .expect("spawn session");
    let root_pid = session_child_pid(&session_id, &state).expect("root pid");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !pid_file.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let descendant_pid: i32 = fs::read_to_string(&pid_file)
        .expect("descendant pid file")
        .trim()
        .parse()
        .expect("descendant pid");
    let start_deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !unix_process_is_running(descendant_pid) && std::time::Instant::now() < start_deadline
    {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if !unix_process_is_running(descendant_pid) {
        kill_session(session_id, &state).expect("cleanup unstarted descendant session");
        panic!("descendant {descendant_pid} did not reach running state");
    }

    kill_session(session_id, &state).expect("kill session");
    // A successful command is the shutdown boundary used by the frontend:
    // once it resolves the window may close immediately, so cleanup cannot
    // still be pending on a detached native thread.
    let stopped = !unix_process_is_running(descendant_pid);

    // Always clean up on RED so the regression test itself cannot leak the
    // exact runaway process it is designed to catch.
    if !stopped {
        process_tree::terminate_process_tree(root_pid, std::time::Duration::ZERO);
        unsafe { libc::kill(descendant_pid, libc::SIGKILL) };
    }
    assert!(
        stopped,
        "descendant {descendant_pid} survived session close"
    );
}

/// Multi-window regression: closing one window's sessions must NOT touch
/// sessions owned by another window. Before the fix, `close_all_sessions`
/// drained the whole global store, so opening CodeSpace killed CodeCanvas's
/// live agent PTYs (cross-window freeze).
#[cfg(unix)]
#[test]
fn close_sessions_for_window_only_reaps_matching_window() {
    let state: PtyState = Arc::new(Mutex::new(PtyStore::default()));

    // `cat` blocks on stdin → the child stays alive without emitting output.
    let builder_a =
        build_pty_command(&["/bin/cat".to_string()], "/tmp", None, None).expect("builder a");
    let id_a = spawn_session(
        "/tmp".to_string(),
        "window-a".to_string(),
        80,
        24,
        None,
        &state,
        builder_a,
        None,
    )
    .expect("spawn a");

    let builder_b =
        build_pty_command(&["/bin/cat".to_string()], "/tmp", None, None).expect("builder b");
    let id_b = spawn_session(
        "/tmp".to_string(),
        "window-b".to_string(),
        80,
        24,
        None,
        &state,
        builder_b,
        None,
    )
    .expect("spawn b");

    assert_eq!(state.lock().unwrap().0.len(), 2, "both sessions live");

    let reaped = close_sessions_for_window("window-a", &state).expect("close window-a");
    assert_eq!(reaped, 1, "only window-a's session is reaped");

    {
        let store = state.lock().unwrap();
        assert!(!store.0.contains_key(&id_a), "window-a session removed");
        assert!(store.0.contains_key(&id_b), "window-b session survives");
    }

    // Clean up the surviving child so the test leaves no stray process.
    let _ = close_sessions_for_window("window-b", &state);
}

#[test]
fn session_capacity_allows_within_both_caps() {
    assert_eq!(session_capacity_error(0, 0), None);
    assert_eq!(
        session_capacity_error(MAX_SESSIONS_TOTAL - 1, MAX_SESSIONS_PER_WINDOW - 1),
        None
    );
}

#[test]
fn session_capacity_enforces_per_window_cap_independent_of_other_windows() {
    // This window is full, but the global total is nowhere near its cap —
    // the old global-only check would have allowed this (and, conversely,
    // let a busy OTHER window block an idle window). Now it is refused with
    // a window-scoped message.
    let err = session_capacity_error(MAX_SESSIONS_PER_WINDOW, MAX_SESSIONS_PER_WINDOW)
        .expect("per-window cap should trip");
    assert!(err.contains("this window"), "got: {err}");
}

#[test]
fn session_capacity_global_backstop_wins_when_both_exceeded() {
    let err = session_capacity_error(MAX_SESSIONS_TOTAL, MAX_SESSIONS_PER_WINDOW)
        .expect("global cap should trip");
    assert!(err.contains("all windows"), "got: {err}");
}
/// A TUI's screen, proven through the real PTY path rather than a fixture.
///
/// The shell writes the shapes claude actually writes — absolute cursor positioning for rows
/// and **column jumps in place of spaces** — so the raw stream carries no layout at all. That
/// is the bug `issues/18` was opened for: `read_output_tail` handed the permission parser
/// `Doyouwanttocreategate17.txt?`, one line, words fused.
#[test]
fn a_tui_screen_is_readable_where_the_raw_stream_is_not() {
    let state: PtyState = Arc::new(Mutex::new(PtyStore::default()));
    // \033[r;cH places each row; \033[NG jumps to a column instead of printing spaces.
    let draw = "printf '\\033[2J\\033[5;2HDo\\033[5;5Hyou\\033[5;9Hwant\\033[5;14Hto\
\\033[5;17Hcreate\\033[5;24Hgate.txt?\
\\033[6;2H\\342\\235\\257 1. Yes\
\\033[7;4H2. Yes, and switch to accept edits (auto-approve file edits and common file\
\\033[8;7Hcommands) for this session (shift+tab)\
\\033[9;4H3. No'; sleep 30";
    let builder = build_pty_command(
        &["/bin/sh".to_string(), "-c".to_string(), draw.to_string()],
        "/tmp",
        None,
        None,
    )
    .expect("builder");
    let session_id = spawn_session(
        "/tmp".to_string(),
        "screen-test".to_string(),
        80,
        24,
        None,
        &state,
        builder,
        None,
    )
    .expect("spawn session");

    // The flusher coalesces on a 4 ms window; wait for the drawing to land.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let mut screen = String::new();
    while std::time::Instant::now() < deadline {
        screen = read_pane_screen(&session_id, &state).unwrap_or_default();
        if screen.contains("3. No") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let raw = read_output_tail(&session_id, 64 * 1024, &state);
    kill_session(session_id, &state).expect("kill session");

    // The words are only spaced because something drew them into a grid.
    assert!(
        screen.contains(" Do you want to create gate.txt?"),
        "rendered screen was:\n{screen}"
    );

    let prompt = crate::permission_prompt::parse_permission_prompt(&screen, Some(80))
        .expect("a rendered screen parses");
    assert_eq!(prompt.question, "Do you want to create gate.txt?");
    assert_eq!(
        prompt.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(),
        vec![
            "Yes",
            "Yes, and switch to accept edits (auto-approve file edits and common file \
commands) for this session (shift+tab)",
            "No",
        ]
    );

    // And the same bytes, undrawn, offer nothing — which is why the handler must never fall
    // back to them.
    assert!(
        crate::permission_prompt::parse_permission_prompt(&raw, Some(80)).is_none(),
        "the raw stream must not look parseable"
    );
}

/// Observed live 2026-09-12 in a canvas agent cell: the pane printed
/// *"Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker"*, so no transcript
/// was written, so no session id could ever be captured — and a session that was never written
/// cannot be resumed later. Lotus launched from inside a Claude session hands its own markers to
/// every cell it spawns. `packages/host` has scrubbed these since 2026-09-07
/// (`core/agent-env.ts`); the desktop's own PTY spawn never did.
#[test]
fn parent_session_markers_are_stripped_from_a_new_pty() {
    for key in [
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
    ] {
        assert!(
            PARENT_SESSION_ENV_VARS.contains(&key),
            "{key} names the launching session and must not reach a cell"
        );
    }
}

/// A deny-list, never the `CLAUDE_CODE_` prefix: this flag is one Lotus sets on purpose, and
/// sweeping the prefix would turn the feature this app fronts for off.
#[test]
fn the_agent_teams_flag_survives() {
    assert!(!PARENT_SESSION_ENV_VARS.contains(&"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"));
}

/// The same path, driven by a real `claude`, because `issues/18` says so: a fixture proves the
/// renderer and nothing about the agent still drawing prompts the way it drew them the day
/// they were captured.
///
/// `#[ignore]` because it needs `claude` on PATH, a working login and roughly a minute. Run
/// it deliberately: `cargo test --lib live_claude -- --ignored --nocapture`.
#[test]
#[ignore]
fn live_claude_permission_prompt_is_readable_from_the_screen() {
    let state: PtyState = Arc::new(Mutex::new(PtyStore::default()));
    let temp = tempfile::tempdir().expect("tempdir");
    let cwd = temp.path().to_string_lossy().to_string();

    let builder = build_pty_command(
        &[
            "claude".to_string(),
            "--permission-mode".to_string(),
            "manual".to_string(),
        ],
        &cwd,
        None,
        None,
    )
    .expect("builder");
    let session_id = spawn_session(
        cwd.clone(),
        "live-claude-test".to_string(),
        80,
        24,
        None,
        &state,
        builder,
        None,
    )
    .expect("spawn claude");

    let screen_now =
        |id: &str| read_pane_screen(id, &state).unwrap_or_default();
    let wait_for = |needle: &str, secs: u64| -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if screen_now(&session_id).contains(needle) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        false
    };
    let send = |data: &str| {
        write_to_session(session_id.clone(), data.to_string(), &state).expect("write")
    };

    // A fresh directory is untrusted, and the trust dialog is itself read off the screen we
    // are here to test.
    //
    // The keypress is confirmed rather than assumed: claude ignores input for a moment after
    // drawing, and a Down that never landed leaves `❯ No, exit` selected — which Enter then
    // obediently chooses, ending the session and blaming the wrong thing.
    if wait_for("Yes, I trust this folder", 60) {
        let mut moved = false;
        for _ in 0..10 {
            send("\x1b[B");
            std::thread::sleep(std::time::Duration::from_millis(400));
            if screen_now(&session_id).contains("❯ Yes, I trust this folder") {
                moved = true;
                break;
            }
        }
        if !moved {
            let screen = screen_now(&session_id);
            kill_session(session_id, &state).ok();
            panic!("could not select the trusted option. Screen:\n{screen}");
        }
        send("\r");
    }

    // The posture line, not the shortcut hint: the footer's contents move between releases
    // and at 80 columns it truncates.
    if !wait_for("manual mode on", 60) {
        let screen = screen_now(&session_id);
        kill_session(session_id, &state).ok();
        panic!("claude never reached its prompt. Screen:\n{screen}");
    }

    send("buat berkas live-probe.txt berisi kata halo");
    std::thread::sleep(std::time::Duration::from_millis(400));
    send("\r");

    let reached = wait_for("Do you want to", 120);
    let screen = screen_now(&session_id);
    let raw = read_output_tail(&session_id, 64 * 1024, &state);
    kill_session(session_id, &state).ok();

    assert!(reached, "no permission prompt appeared. Screen:\n{screen}");

    let prompt = crate::permission_prompt::parse_permission_prompt(&screen, Some(80))
        .unwrap_or_else(|| panic!("the rendered screen did not parse. Screen:\n{screen}"));

    println!("question: {}", prompt.question);
    for option in &prompt.options {
        println!("  {}. {}", option.key, option.label);
    }

    assert!(prompt.options.len() >= 2);
    assert_eq!(prompt.options[0].key, "1");
    assert!(prompt.question.ends_with('?'));
    // Every label whole: no option may end mid-sentence because its row wrapped.
    assert!(
        prompt.options.iter().all(|o| !o.label.is_empty()),
        "an option lost its label"
    );
    // And the proof it was the drawing that made the difference.
    assert!(
        crate::permission_prompt::parse_permission_prompt(&raw, Some(80)).is_none(),
        "the raw stream must not look parseable"
    );
}
