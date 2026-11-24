use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

/// Captured environment from the user's interactive login shell.
///
/// Bridge spawns CLIs (`claude`, `ccs hss`, …) directly via PTY without
/// wrapping in `$SHELL -l -c`, so `.zshrc`/`.bashrc` are never sourced
/// at runtime. We instead run the shell **once** in interactive+login
/// mode at app start, snapshot its environment, and inject those vars
/// into every Bridge spawn. This matches what users see in a normal
/// terminal (where `ANTHROPIC_API_KEY`, nvm/asdf PATH, etc. live in rc
/// files) and avoids polluting Bridge's stream-json stdout with rc-file
/// banners (P10k instant prompt, nvm logs, motd, …).
///
/// Cached in a `OnceLock` so the cost is paid once per app process.
static LOGIN_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
/// The same capture before `default_agent_env` blanks `CLAUDE_CONFIG_DIR`.
static RAW_LOGIN_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

/// The login-shell environment with Claude's default account selected explicitly.
///
/// An empty override means the CLI's standard login (not an explicit `~/.claude`, which uses
/// a different macOS Keychain identity). Keeping the empty entry also masks a CCS profile inherited
/// by non-PTY subprocesses using `Command::envs`. Named runners such as `ccs initech` set their
/// own profile inside that child process; neither CCS recency nor the parent chooses this default.
/// On Windows only this account policy is applied; no login shell is captured.
pub fn user_login_env() -> &'static HashMap<String, String> {
    LOGIN_ENV.get_or_init(|| {
        let raw = capture_login_env();
        let _ = RAW_LOGIN_ENV.set(raw.clone());
        default_agent_env(raw)
    })
}

/// What the user's login shell really exports for `key`, for account discovery. Agents must keep
/// inheriting [`user_login_env`], never this.
pub fn raw_login_var(key: &str) -> Option<String> {
    user_login_env();
    RAW_LOGIN_ENV.get()?.get(key).cloned()
}

fn default_agent_env(mut env: HashMap<String, String>) -> HashMap<String, String> {
    env.insert("CLAUDE_CONFIG_DIR".to_string(), String::new());
    env
}

#[cfg(unix)]
fn capture_login_env() -> HashMap<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());

    // `env -0` prints `KEY=VALUE\0` records — robust against newlines in values.
    // `-l` for login mode, `-i` for interactive (so zsh sources `.zshrc`).
    // Redirect stderr to /dev/null so any rc-file warnings don't break parsing.
    // </dev/null on stdin so the shell doesn't try to read a prompt.
    let output = match std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", "env -0"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            // Best-effort 5s timeout. portable_pty / std lacks a built-in wait_timeout,
            // so we poll. If the shell hangs (broken rc), we give up and fall back.
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(std::io::Error::new(
                                std::io::ErrorKind::TimedOut,
                                "login shell env capture timed out",
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(e) => return Err(e),
                }
            }
            child.wait_with_output()
        }) {
        Ok(out) if out.status.success() => out.stdout,
        _ => return HashMap::new(),
    };

    let mut env = HashMap::new();
    for record in output.split(|b| *b == 0) {
        if record.is_empty() {
            continue;
        }
        let s = match std::str::from_utf8(record) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let Some((key, value)) = s.split_once('=') else {
            continue;
        };
        if key.is_empty() || should_skip(key) {
            continue;
        }
        env.insert(key.to_string(), value.to_string());
    }
    env
}

#[cfg(windows)]
fn capture_login_env() -> HashMap<String, String> {
    // Windows: PTY child inherits parent process env directly; no rc-file
    // sourcing problem. Returning empty leaves the existing behavior intact.
    HashMap::new()
}

/// Layer captured env pairs onto a `std::process::Command`.
///
/// An EMPTY value means "the child must **not** have this variable", never "the child gets an
/// empty one" — `default_agent_env` blanks `CLAUDE_CONFIG_DIR` as a mask, and a mask that is
/// passed through arrives set-and-empty. Claude Code reads `CLAUDE_CONFIG_DIR` with a nullish
/// fallback (`?? ~/.claude`), so `""` is *not* nullish: it resolves the config home to a relative
/// `""` and writes the whole home — `projects/` transcripts, `skills/synced/`, `plugins/`,
/// `backups/.claude.json.backup.*`, `policy-limits.json` — into the child's **cwd**.
///
/// Measured 2026-09-21 in an empty directory:
///
/// ```text
/// env CLAUDE_CONFIG_DIR= claude mcp list  → policy-limits.json, remote-settings.json, … in cwd
/// env -u CLAUDE_CONFIG_DIR claude mcp list → cwd stays empty
/// ```
///
/// That is how 9.6 MB of config home landed in `apps/desktop/src-tauri/` (the cwd of a CodeChat
/// spawn). `env_remove` is required rather than merely skipping the key, because
/// `std::process::Command` inherits the parent env: Lotus launched from a `ccs` shell carries the
/// operator's profile, and skipping would leak it into a default agent — the very thing the mask
/// exists to prevent. The PTY layer has its own copy of this rule in `pty::apply_env_pairs`,
/// against `portable_pty`'s `CommandBuilder`, which is a different type.
pub fn apply_login_env_pairs(cmd: &mut std::process::Command, pairs: &HashMap<String, String>) {
    for (key, value) in pairs {
        if value.is_empty() {
            cmd.env_remove(key);
        } else {
            cmd.env(key, value);
        }
    }
}

/// The login env as a plain map for a child started with `env_clear()`: empty values mean "unset"
/// and are left out. Passed on as "", CLAUDE_CONFIG_DIR makes the CLI write its config into its cwd.
pub fn login_env_without_unset() -> HashMap<String, String> {
    user_login_env().iter().filter(|(_, v)| !v.is_empty()).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Keys we don't want to copy from the login shell — the PTY layer or the
/// child process owns these.
fn should_skip(key: &str) -> bool {
    matches!(
        key,
        "_" | "SHLVL"
            | "OLDPWD"
            | "PWD"
            | "TERM"
            | "LOTUS_PANE_ID"
            | "COLUMNS"
            | "LINES"
            | "TERM_PROGRAM"
            | "TERM_SESSION_ID"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cleared_child_gets_no_empty_claude_config_dir() {
        assert!(!login_env_without_unset().contains_key("CLAUDE_CONFIG_DIR"));
    }

    #[test]
    fn default_agents_use_standard_claude_login_not_the_last_ccs_account() {
        assert_eq!(
            user_login_env().get("CLAUDE_CONFIG_DIR"),
            Some(&String::new()),
            "CCS runners select their own account; the default must keep its own login"
        );
    }

    #[test]
    fn skip_list_filters_runtime_keys() {
        assert!(should_skip("PWD"));
        assert!(should_skip("TERM"));
        assert!(should_skip("SHLVL"));
        assert!(!should_skip("ANTHROPIC_API_KEY"));
        assert!(!should_skip("PATH"));
        assert!(!should_skip("HOME"));
    }

    #[cfg(unix)]
    #[test]
    fn capture_returns_some_env_on_unix() {
        // Smoke: should return either a populated map or empty (timeout/no-shell).
        // We only assert no panic.
        let env = user_login_env();
        let _ = env.len();
    }

    #[test]
    fn default_account_masks_an_inherited_profile_without_changing_other_settings() {
        let inherited = HashMap::from([
            ("CLAUDE_CONFIG_DIR".into(), "/home/test/.ccs/instances/initech".into()),
            ("PATH".into(), "/bin".into()),
        ]);
        let env = default_agent_env(inherited);
        assert_eq!(env.get("CLAUDE_CONFIG_DIR").map(String::as_str), Some(""));
        assert_eq!(env.get("PATH").map(String::as_str), Some("/bin"));
    }

    /// The mask is a *removal* instruction, not a value. Passing it through as a value is what
    /// wrote a Claude config home into `apps/desktop/src-tauri/` on 2026-09-20: `""` survives
    /// Claude's `?? ~/.claude` fallback and resolves the home to a relative path, i.e. the cwd.
    #[test]
    fn an_empty_value_unsets_the_variable_in_the_child_instead_of_blanking_it() {
        let pairs = HashMap::from([
            ("CLAUDE_CONFIG_DIR".to_string(), String::new()),
            ("PATH".to_string(), "/bin".to_string()),
        ]);
        let mut cmd = std::process::Command::new("true");
        apply_login_env_pairs(&mut cmd, &pairs);

        let entry = cmd
            .get_envs()
            .find(|(key, _)| *key == std::ffi::OsStr::new("CLAUDE_CONFIG_DIR"));
        assert_eq!(
            entry.map(|(_, value)| value),
            Some(None),
            "an empty mask must arrive as a removal, never as a set-and-empty variable"
        );
        assert_eq!(
            cmd.get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("PATH"))
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new("/bin")),
            "every other captured var still reaches the child unchanged"
        );
    }

    #[test]
    fn first_login_does_not_require_any_existing_profile() {
        assert_eq!(
            default_agent_env(HashMap::new()).get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some("")
        );
    }
}
