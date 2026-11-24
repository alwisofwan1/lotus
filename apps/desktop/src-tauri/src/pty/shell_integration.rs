use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::paths;

pub(crate) enum ShellIntegration {
    Zsh {
        zdotdir: PathBuf,
        original_zdotdir: PathBuf,
    },
    Bash {
        rcfile: PathBuf,
    },
    Fish {
        init_script: PathBuf,
    },
}

impl ShellIntegration {
    pub(crate) fn args(&self, default_args: Vec<String>) -> Vec<String> {
        match self {
            // `--rcfile` is ignored by interactive login Bash, so the integration
            // owns forwarding the user's login files instead.
            Self::Bash { rcfile } => vec!["--rcfile".into(), rcfile.to_string_lossy().into_owned()],
            Self::Fish { init_script } => vec![
                "-l".into(),
                "-C".into(),
                format!("source {}", quote_fish_path(init_script)),
            ],
            Self::Zsh { .. } => default_args,
        }
    }

    pub(crate) fn apply_env(&self, cmd: &mut portable_pty::CommandBuilder) {
        cmd.env("LOTUS_SHELL_INTEGRATION", "1");
        if let Self::Zsh {
            zdotdir,
            original_zdotdir,
        } = self
        {
            cmd.env("ZDOTDIR", zdotdir);
            cmd.env("LOTUS_ORIGINAL_ZDOTDIR", original_zdotdir);
        }
    }
}

pub(crate) fn write_shell_integration_script(shell_exe: &str) -> Option<ShellIntegration> {
    let shell_name = Path::new(shell_exe)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_ascii_lowercase)?;

    let root = paths::lotus_state_dir().join("shell-integration");
    if shell_name.contains("zsh") {
        let zdotdir = root.join("zsh");
        let original_zdotdir = resolve_original_zdotdir(&root);
        write_zsh_integration_files(&zdotdir)?;
        return Some(ShellIntegration::Zsh {
            zdotdir,
            original_zdotdir,
        });
    }
    if shell_name.contains("bash") {
        let dir = root.join("bash");
        let rcfile = dir.join("bashrc.bash");
        write_shell_integration_file(&rcfile, include_str!("scripts/bashrc.bash"))?;
        return Some(ShellIntegration::Bash { rcfile });
    }
    if shell_name.contains("fish") {
        let dir = root.join("fish");
        let init_script = dir.join("lotus.fish");
        write_shell_integration_file(&init_script, include_str!("scripts/fish.fish"))?;
        return Some(ShellIntegration::Fish { init_script });
    }

    None
}

fn resolve_original_zdotdir(shell_integration_root: &Path) -> PathBuf {
    let candidate = std::env::var_os("ZDOTDIR")
        .map(PathBuf::from)
        .unwrap_or_else(paths::home_dir);

    if lotus_shell_integration_roots(shell_integration_root)
        .iter()
        .any(|root| path_is_at_or_under(&candidate, root))
    {
        paths::home_dir()
    } else {
        candidate
    }
}

fn lotus_shell_integration_roots(current_root: &Path) -> Vec<PathBuf> {
    let home = paths::home_dir();
    vec![
        current_root.to_path_buf(),
        home.join(".lotus").join("shell-integration"),
        home.join(".lotus-dev").join("shell-integration"),
    ]
}

fn path_is_at_or_under(path: &Path, parent: &Path) -> bool {
    let path = normalize_path(path);
    let parent = normalize_path(parent);
    path == parent || path.starts_with(parent)
}

fn normalize_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical;
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                normalized.push(component.as_os_str());
            }
        }
    }
    normalized
}

fn write_shell_integration_file(path: &Path, contents: &str) -> Option<()> {
    fs::create_dir_all(path.parent()?).ok()?;
    fs::write(path, contents).ok()
}

pub(crate) fn write_zsh_integration_files(zdotdir: &Path) -> Option<()> {
    for name in [".zshenv", ".zprofile", ".zlogin", ".zlogout"] {
        write_shell_integration_file(&zdotdir.join(name), &zsh_forwarding_file(name))?;
    }
    write_shell_integration_file(
        zdotdir.join(".zshrc").as_path(),
        include_str!("scripts/zshrc.zsh"),
    )
}

fn zsh_forwarding_file(name: &str) -> String {
    let sentinel = format!(
        "LOTUS_{}_SOURCED",
        name.trim_start_matches('.').to_ascii_uppercase()
    );
    format!(
        r#"if [[ -z "${{{sentinel}:-}}" ]]; then
  {sentinel}=1
  lotus_original_file="$LOTUS_ORIGINAL_ZDOTDIR/{name}"
  lotus_integration_file="$ZDOTDIR/{name}"
  if [[ -n "${{LOTUS_ORIGINAL_ZDOTDIR:-}}" && -r "$lotus_original_file" ]]; then
    if [[ ! -e "$lotus_integration_file" || ! "$lotus_original_file" -ef "$lotus_integration_file" ]]; then
      source "$lotus_original_file"
    fi
  fi
  unset lotus_original_file lotus_integration_file
fi
"#
    )
}

pub(crate) fn quote_fish_path(path: &Path) -> String {
    let escaped = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$");
    format!("\"{escaped}\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use uuid::Uuid;

    #[test]
    fn normalizes_trailing_current_dir_before_path_comparison() {
        let root = PathBuf::from("/tmp/lotus/shell-integration");
        let path = PathBuf::from("/tmp/lotus/shell-integration/zsh/.");

        assert!(path_is_at_or_under(&path, &root));
    }

    #[test]
    fn zsh_forwarding_file_uses_sentinel_and_same_file_guard() {
        let contents = zsh_forwarding_file(".zshenv");

        assert!(contents.contains("LOTUS_ZSHENV_SOURCED"));
        assert!(contents.contains("-ef"));
        assert!(!contents.contains("!= \"$ZDOTDIR/.zshenv\""));
    }

    #[test]
    fn write_zsh_files_uses_same_file_guard() {
        let temp_home = std::env::temp_dir().join(format!("lotus_shell_home_{}", Uuid::new_v4()));
        let zdotdir = temp_home
            .join(".lotus")
            .join("shell-integration")
            .join("zsh");

        write_zsh_integration_files(&zdotdir).expect("write zsh integration files");

        let zshenv = fs::read_to_string(zdotdir.join(".zshenv")).expect("read generated zshenv");
        assert!(zshenv.contains("LOTUS_ZSHENV_SOURCED"));
        assert!(zshenv.contains("-ef"));

        let _ = fs::remove_dir_all(temp_home);
    }

    #[test]
    fn zshrc_osc7_path_is_percent_encoded() {
        let zshrc = include_str!("scripts/zshrc.zsh");

        assert!(zshrc.contains("__lotus_percent_encode_path"));
        assert!(zshrc.contains("$(__lotus_percent_encode_path \"$PWD\")"));
        assert!(!zshrc.contains("file://%s%s\\007' \"${HOST:-localhost}\" \"$PWD\""));
    }

    #[test]
    fn zsh_percent_encoder_runs_without_modifier_errors() {
        let zshrc_path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/pty/scripts/zshrc.zsh");
        let script = format!(
            r#"source {zshrc_path}
__lotus_percent_encode_path "/tmp/a b#c?d%"
"#
        );
        let output = Command::new("zsh")
            .arg("-f")
            .arg("-c")
            .arg(script)
            .env("LOTUS_SHELL_INTEGRATION", "1")
            .env("LOTUS_ORIGINAL_ZDOTDIR", "/tmp/lotus-missing-zdotdir")
            .env("ZDOTDIR", "/tmp/lotus-missing-zdotdir")
            .output()
            .expect("run zsh percent encoder");

        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            String::from_utf8_lossy(&output.stdout).ends_with("/tmp/a%20b%23c%3Fd%25"),
            "stdout: {}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    /// Runs `codex <args>` through a Lotus shell script with a fake `codex` that prints its
    /// arguments, and returns what the real CLI would have been given.
    fn codex_args_via(shell: &str, script: &str, args: &str) -> String {
        let dir = std::env::temp_dir().join(format!("lotus-codex-wrap-{}-{shell}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("codex");
        std::fs::write(&fake, "#!/bin/sh\necho \"$*\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap_or_default());
        let script_path = format!("{}/src/pty/scripts/{script}", env!("CARGO_MANIFEST_DIR"));
        let mut cmd = Command::new(shell);
        match shell {
            "zsh" => cmd.arg("-f").arg("-c").arg(format!("source {script_path}\ncodex {args}")),
            "bash" => cmd.arg("--norc").arg("-c").arg(format!("HOME=/nonexistent; source {script_path}\ncodex {args}")),
            _ => cmd.arg("--no-config").arg("-c").arg(format!("source {script_path}; codex {args}")),
        };
        let output = cmd
            .env("PATH", path)
            .env("LOTUS_SHELL_INTEGRATION", "1")
            .env("LOTUS_BASH_USER_STARTUP_SOURCED", "1")
            .env("LOTUS_ORIGINAL_ZDOTDIR", "/tmp/lotus-missing-zdotdir")
            .env("ZDOTDIR", "/tmp/lotus-missing-zdotdir")
            .output()
            .expect("run shell");
        std::fs::remove_dir_all(&dir).ok();
        // The scripts print OSC cwd markers first; they end in BEL.
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        stdout.rsplit('\u{7}').next().unwrap_or("").trim().to_string()
    }

    /*
      2026-10-10: Codex 0.162 runs turns, and therefore hooks, in one shared background server
      that carries the env of whichever pane started it, so every Codex pane's hook reports
      named one stale pane. `--no-daemon` keeps the server inside the pane's own process.
      Verified live by the user the same day: the pane's transcript was found with it.
    */
    #[test]
    fn codex_in_a_lotus_shell_runs_without_the_shared_server() {
        for (shell, script) in [("zsh", "zshrc.zsh"), ("bash", "bashrc.bash"), ("fish", "fish.fish")] {
            if Command::new(shell).arg("-c").arg("true").output().is_err() {
                continue; // fish is not installed everywhere
            }
            assert_eq!(
                codex_args_via(shell, script, "--dangerously-bypass-approvals-and-sandbox"),
                "--no-daemon --dangerously-bypass-approvals-and-sandbox",
                "{shell}"
            );
            assert_eq!(codex_args_via(shell, script, ""), "--no-daemon", "{shell}");
            assert_eq!(codex_args_via(shell, script, "resume --last"), "--no-daemon resume --last", "{shell}");
            // Subcommands that are not the interactive screen are left alone.
            assert_eq!(codex_args_via(shell, script, "exec --json hi"), "exec --json hi", "{shell}");
            assert_eq!(codex_args_via(shell, script, "agents"), "agents", "{shell}");
            // Already asked for, or a remote server: not added twice, not combined.
            assert_eq!(codex_args_via(shell, script, "--no-daemon"), "--no-daemon", "{shell}");
            assert_eq!(codex_args_via(shell, script, "--remote ws://x"), "--remote ws://x", "{shell}");
        }
    }
}
