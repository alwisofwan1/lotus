use super::*;

pub(super) fn resolve_session_cwd(cwd: &str) -> String {
    if cwd.trim().is_empty() {
        return paths::home_dir().to_string_lossy().into_owned();
    }
    cwd.to_string()
}

pub(crate) fn resolve_command_executable(executable: &str) -> String {
    if let Some(path) = resolve_explicit_command_path(executable) {
        return path;
    }
    if let Some(path) = resolve_command_from_path(executable) {
        return path;
    }
    if let Some(path) = resolve_command_from_known_locations(executable) {
        return path;
    }
    if let Some(path) = resolve_command_from_login_shell(executable) {
        return path;
    }
    executable.to_string()
}

pub(super) fn resolve_explicit_command_path(executable: &str) -> Option<String> {
    if !looks_like_command_path(executable) {
        return None;
    }
    let path = PathBuf::from(executable);
    if !path.is_file() {
        return None;
    }
    Some(canonicalize_for_command(path))
}

pub(super) fn resolve_command_from_path(executable: &str) -> Option<String> {
    if let Some(path_env) = std::env::var_os("PATH") {
        if let Some(found) = find_command_in_dirs(std::env::split_paths(&path_env), executable) {
            return Some(found);
        }
    }
    // Fallback: search the user's login-shell PATH (covers mise/asdf/nvm
    // shims and `~/.local/share/claude/versions/.../bin`) — important on
    // macOS Finder/launchctl launches where the Tauri parent PATH is just
    // `/usr/bin:/bin` and misses the real `claude` binary.
    #[cfg(unix)]
    {
        if let Some(login_path) = crate::shell_env::user_login_env().get("PATH") {
            return find_command_in_dirs(std::env::split_paths(login_path.as_str()), executable);
        }
    }
    None
}

pub(super) fn resolve_command_from_known_locations(executable: &str) -> Option<String> {
    let home = paths::home_dir();
    let mut dirs = vec![
        home.join(".bun").join("bin"),
        home.join(".local").join("bin"),
        home.join(".cargo").join("bin"),
        home.join("bin"),
    ];

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }

    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/snap/bin"));
    }

    #[cfg(windows)]
    {
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(home.join("scoop").join("shims"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Microsoft").join("WindowsApps"));
        }
    }

    find_command_in_dirs(dirs, executable)
}

pub(super) fn resolve_command_from_login_shell(executable: &str) -> Option<String> {
    #[cfg(windows)]
    {
        let output = Command::new("where.exe").no_window().arg(executable).output().ok()?;
        if !output.status.success() {
            return None;
        }
        return String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .find(|path| path.is_file())
            .map(canonicalize_for_command);
    }

    #[cfg(unix)]
    {
        let mut shells = Vec::new();
        if let Some(shell) = std::env::var_os("SHELL") {
            shells.push(PathBuf::from(shell));
        }
        shells.push(PathBuf::from("/bin/zsh"));
        shells.push(PathBuf::from("/bin/bash"));
        shells.push(PathBuf::from("/bin/sh"));

        for shell in shells {
            if !shell.is_file() {
                continue;
            }
            let output = match Command::new(&shell)
                .no_window()
                .args([
                    "-l",
                    "-c",
                    &format!("command -v {}", shell_escape(executable)),
                ])
                .output()
            {
                Ok(output) => output,
                Err(_) => continue,
            };
            if !output.status.success() {
                continue;
            }
            if let Some(path) = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(PathBuf::from)
                .find(|path| path.is_file())
                .map(canonicalize_for_command)
            {
                return Some(path);
            }
        }
        None
    }
}

pub(super) fn find_command_in_dirs<I>(dirs: I, executable: &str) -> Option<String>
where
    I: IntoIterator<Item = PathBuf>,
{
    if executable.trim().is_empty() || looks_like_command_path(executable) {
        return None;
    }

    for dir in dirs {
        #[cfg(windows)]
        {
            for candidate in windows_command_candidates(executable) {
                let full = dir.join(candidate);
                if full.is_file() {
                    return Some(canonicalize_for_command(full));
                }
            }
        }

        #[cfg(not(windows))]
        {
            let full = dir.join(executable);
            if full.is_file() {
                return Some(canonicalize_for_command(full));
            }
        }
    }
    None
}

pub(super) fn canonicalize_for_command(path: PathBuf) -> String {
    fs::canonicalize(&path)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

pub(super) fn looks_like_command_path(executable: &str) -> bool {
    executable.contains('/') || executable.contains('\\') || Path::new(executable).is_absolute()
}

#[cfg(windows)]
pub(super) fn windows_command_candidates(executable: &str) -> Vec<String> {
    if Path::new(executable).extension().is_some() {
        return vec![executable.to_string()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut out = vec![executable.to_string()];
    out.extend(
        pathext
            .split(';')
            .map(str::trim)
            .filter(|ext| !ext.is_empty())
            .map(|ext| format!("{executable}{ext}")),
    );
    out
}

#[cfg(unix)]
pub(super) fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}
