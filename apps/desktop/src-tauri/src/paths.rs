use std::path::PathBuf;

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Resolves the user home directory: `HOME` wins when set (macOS/Linux shells, WSL, CI),
/// otherwise `dirs::home_dir()`, with a last-resort OS temp path.
pub fn home_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home);
    }
    dirs::home_dir().unwrap_or_else(|| {
        #[cfg(unix)]
        {
            PathBuf::from("/tmp")
        }
        #[cfg(not(unix))]
        {
            std::env::temp_dir()
        }
    })
}

pub fn claude_dir() -> PathBuf {
    home_dir().join(".claude")
}

pub fn codex_dir() -> PathBuf {
    home_dir().join(".codex")
}

pub fn gemini_dir() -> PathBuf {
    home_dir().join(".gemini")
}

pub fn cursor_dir() -> PathBuf {
    home_dir().join(".cursor")
}

/// True for cargo debug builds (`tauri dev`, `cargo run`), false for release.
/// Drives the dev/release profile split: dev uses `~/.lotus-dev/` and skips
/// the single-instance plugin so it can run alongside the bundled release.
pub fn is_dev_profile() -> bool {
    cfg!(debug_assertions)
}

/// Lotus's own state root. Release: `~/.lotus/`. Dev: `~/.lotus-dev/`.
/// Holds teams/, tasks/, logs, procs, MCP discovery file, codex notify
/// scripts, codechat images. Distinct from `claude_dir()` which is owned
/// by the Claude CLI itself (settings.json, projects/, skills/).
pub fn lotus_state_dir() -> PathBuf {
    if is_dev_profile() {
        home_dir().join(".lotus-dev")
    } else {
        home_dir().join(".lotus")
    }
}

pub fn teams_dir() -> PathBuf {
    lotus_state_dir().join("teams")
}

pub fn canvas_templates_dir() -> PathBuf {
    lotus_state_dir().join("canvas-templates")
}

/// User/agent-authored CodeCanvas themes (ADR-0023, Phase 3). Each theme is a
/// `<id>/theme.json` token bag plus optional media assets in the same folder.
pub fn canvas_themes_dir() -> PathBuf {
    lotus_state_dir().join("canvas-themes")
}

pub fn tasks_dir() -> PathBuf {
    lotus_state_dir().join("tasks")
}

pub fn logs_dir() -> PathBuf {
    lotus_state_dir().join("agent-teams-logs")
}

pub fn procs_file() -> PathBuf {
    lotus_state_dir().join("agent-teams-procs.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_prefers_home_env_when_set() {
        let _g = TEST_ENV_LOCK.lock().expect("lock paths env tests");
        let previous = std::env::var_os("HOME");
        let custom = std::env::temp_dir().join("lotus_paths_test_home");
        std::env::set_var("HOME", &custom);
        assert_eq!(home_dir(), custom);
        match previous {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn home_without_home_env_matches_dirs_home() {
        let _g = TEST_ENV_LOCK.lock().expect("lock paths env tests");
        let previous = std::env::var_os("HOME");
        std::env::remove_var("HOME");
        let resolved = home_dir();
        match previous {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }

        #[cfg(unix)]
        {
            assert_eq!(
                resolved,
                dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
            );
            if dirs::home_dir().is_some() {
                assert_ne!(
                    resolved,
                    PathBuf::from("/tmp"),
                    "real user home should not fall back to /tmp when dirs resolves"
                );
            }
        }
        #[cfg(windows)]
        {
            assert_eq!(
                resolved,
                dirs::home_dir().unwrap_or_else(|| std::env::temp_dir())
            );
        }
    }

    #[test]
    fn claude_dir_joins_dot_claude() {
        let _g = TEST_ENV_LOCK.lock().expect("lock paths env tests");
        let previous = std::env::var_os("HOME");
        let custom = std::env::temp_dir().join("lotus_paths_test_claude");
        std::env::set_var("HOME", &custom);
        assert_eq!(claude_dir(), custom.join(".claude"));
        match previous {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn lotus_state_dir_branches_on_profile() {
        let _g = TEST_ENV_LOCK.lock().expect("lock paths env tests");
        let previous = std::env::var_os("HOME");
        let custom = std::env::temp_dir().join("lotus_paths_test_state");
        std::env::set_var("HOME", &custom);
        let expected_leaf = if is_dev_profile() {
            ".lotus-dev"
        } else {
            ".lotus"
        };
        assert_eq!(lotus_state_dir(), custom.join(expected_leaf));
        // teams/tasks/logs/procs all flow through lotus_state_dir.
        assert_eq!(teams_dir(), custom.join(expected_leaf).join("teams"));
        assert_eq!(tasks_dir(), custom.join(expected_leaf).join("tasks"));
        assert_eq!(
            logs_dir(),
            custom.join(expected_leaf).join("agent-teams-logs")
        );
        assert_eq!(
            procs_file(),
            custom.join(expected_leaf).join("agent-teams-procs.json")
        );
        match previous {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
