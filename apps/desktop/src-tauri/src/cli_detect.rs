//! Installed-CLI detection — the backend for the CNVS Settings→Agents "Rescan"
//! button. Probes the machine for the agent CLIs CodeCanvas knows how to drive
//! (Claude Code / Codex / Cursor Agent) so the UI can show which are installed.
//!
//! See ADR-0026 (CodeCanvas standalone ADE) and
//! `plans/codecanvas-standalone-ade/PLAN.md` (Fase B.1).
//!
//! The pure decision logic (`detect_clis_with`) is split from the real PATH
//! probe so it can be unit-tested without touching `$PATH` or the filesystem.

use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// One known agent CLI and whether it was found on this machine.
#[derive(serde::Serialize, Clone, PartialEq, Debug)]
pub struct DetectedCli {
    /// Stable identifier (`"claude"`, `"codex"`, `"cursor"`).
    pub id: String,
    /// Human-readable display name.
    pub name: String,
    /// Base command including the default autonomy flags CodeCanvas launches with.
    pub command: String,
    /// Absolute path to the resolved binary, when installed.
    pub path: Option<String>,
    /// Whether the binary was found on `$PATH`.
    pub installed: bool,
    /// The user pointed Lotus at this binary by hand (Settings › Agents › Locate…).
    #[serde(default)]
    pub located: bool,
}

/// The agent CLIs CodeCanvas knows how to drive, from `src/agents.json` (`agent_catalog`).
/// Tuple shape: (id, display name, base command incl. verified default flags, binary name).
///
/// Only verified autonomy flags are in the base command: a guessed flag fails the launch with
/// "unknown option", which reads like a Lotus bug. Users add flags in Canvas Settings → Runners.
/// A `gh copilot` extension is NOT detected: probing `gh` would report Copilot for anyone who
/// merely has the GitHub CLI; the standalone `copilot` binary is.
static KNOWN_CLIS: std::sync::LazyLock<Vec<(&'static str, &'static str, &'static str, &'static str)>> =
    std::sync::LazyLock::new(|| {
        crate::agent_catalog::AGENTS
            .iter()
            .map(|a| (a.id.as_str(), a.product_name.as_str(), a.base_command.as_str(), a.binary()))
            .collect()
    });

/// The binary each known CLI resolves to on PATH.
///
/// Public because the SSH capability probe asks a **remote** machine the same question this module
/// answers locally, and the two lists drifting apart is not a theoretical risk — it is the bug that
/// made `opencode` and `grok` unlaunchable on every remote project: detected here, never asked about
/// there, and therefore filtered out by `clisOnMachine` as "not on that machine". One list, two
/// machines. See `remote_capability::probed_runners`.
pub fn known_cli_binaries() -> Vec<&'static str> {
    KNOWN_CLIS.iter().map(|(_, _, _, bin)| *bin).collect()
}

/// Pure detection: given a `probe` that resolves a binary name to an absolute
/// path (or `None` if not found), return the status of every known CLI.
///
/// Always returns all known CLIs — including ones that are not installed — so
/// the UI can render both found and not-found entries.
pub fn detect_clis_with(probe: impl Fn(&str) -> Option<String>) -> Vec<DetectedCli> {
    KNOWN_CLIS
        .iter()
        .map(|(id, name, command, bin)| {
            let path = probe(bin);
            DetectedCli {
                id: (*id).to_string(),
                name: (*name).to_string(),
                command: (*command).to_string(),
                installed: path.is_some(),
                path,
                located: false,
            }
        })
        .collect()
}

/// Detect which known agent CLIs are installed on this machine, probing the
/// real `$PATH`. Wrapped as a Tauri command in `lib.rs::commands`.
pub fn detect_installed_clis() -> Vec<DetectedCli> {
    let overrides = path_overrides();
    let mut clis = detect_clis_with(probe_path);
    for (cli, (_, _, _, bin)) in clis.iter_mut().zip(KNOWN_CLIS.iter()) {
        if cli.path.is_some() && cli.path.as_ref() == overrides.get(*bin) {
            // A located binary is usually off PATH, so the launch command must name it in full.
            // `set_cli_path` refuses paths with whitespace, so the command still splits cleanly.
            cli.command = cli.command.replacen(bin, cli.path.as_deref().unwrap_or(bin), 1);
            cli.located = true;
        }
    }
    clis
}

/// Binaries the user located by hand, keyed by binary name (`agy` → `/opt/agy/bin/agy`).
fn overrides_file() -> PathBuf {
    crate::paths::lotus_state_dir().join("cli-paths.json")
}

fn path_overrides() -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(overrides_file())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Point a known CLI at a binary Lotus did not find by itself, or forget that (`None`).
pub fn set_cli_path(id: &str, path: Option<String>) -> Result<(), String> {
    let (_, _, _, bin) = KNOWN_CLIS
        .iter()
        .find(|(known, ..)| *known == id)
        .ok_or_else(|| format!("Unknown CLI: {id}"))?;
    let mut overrides = path_overrides();
    match path {
        Some(path) => {
            validate_located_path(&path)?;
            overrides.insert((*bin).to_string(), path);
        }
        None => {
            overrides.remove(*bin);
        }
    }
    let text = serde_json::to_string_pretty(&overrides).map_err(|e| e.to_string())?;
    std::fs::write(overrides_file(), text).map_err(|e| e.to_string())
}

/// The path ends up inside a launch command that is split on whitespace, so it must be one token.
fn validate_located_path(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() || path.chars().any(char::is_whitespace) {
        return Err("Pick a file whose full path has no spaces.".into());
    }
    if !is_executable_file(p) {
        return Err("That file is not a program Lotus can run.".into());
    }
    Ok(())
}

/// Real `$PATH` probe. GUI apps on macOS inherit a minimal process `$PATH`
/// (Finder/dock launches don't source the shell rc), so `claude` & friends —
/// which live in homebrew / nvm / `~/.claude/local` / `~/.local/bin` — are
/// invisible there. We therefore search the captured login-shell PATH as well
/// (the same source Bridge uses to spawn CLIs). Returns the first executable
/// file named `bin`; on Windows, `PATHEXT` extensions are also tried.
fn probe_path(bin: &str) -> Option<String> {
    if let Some(located) = path_overrides().get(bin) {
        if is_executable_file(Path::new(located)) {
            return Some(located.clone());
        }
    }
    let proc_path = env::var_os("PATH");
    let login_path = crate::shell_env::user_login_env()
        .get("PATH")
        .map(OsString::from);
    let mut dirs = candidate_dirs(proc_path.as_deref(), login_path.as_deref());
    // Belt-and-suspenders: GUI launches can have a minimal PATH *and* a flaky login-shell
    // capture, so also probe the well-known install dirs directly (where claude/codex/cursor
    // actually live). This makes detection robust regardless of how the app was launched.
    for dir in well_known_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    resolve_in_paths(bin, &dirs)
}

/// The first executable named `bin` on the user's PATH (login shell included) or in the usual
/// install folders, as an absolute path.
pub fn find_executable(bin: &str) -> Option<String> {
    probe_path(bin)
}

/// Common install locations for agent CLIs, independent of `$PATH`. `$HOME`-relative dirs are
/// expanded; the rest are standard system/package-manager bins. Pure given `$HOME`.
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(home) = env::var_os("HOME") {
        let home = PathBuf::from(home);
        for rel in [
            ".local/bin",
            "bin",
            ".cargo/bin",
            // Where grok installs itself; no other entry covers it, and a dock launch has a
            // minimal PATH.
            ".grok/bin",
            ".bun/bin",
            ".npm-global/bin",
        ] {
            dirs.push(home.join(rel));
        }
    }
    for abs in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/run/current-system/sw/bin",
    ] {
        dirs.push(PathBuf::from(abs));
    }
    dirs
}

/// Ordered, de-duplicated search directories: the process PATH first, then the
/// login-shell PATH (the real source of truth for GUI launches). Pure over its
/// inputs so it can be unit-tested without touching `$PATH` or a login shell.
fn candidate_dirs(proc_path: Option<&OsStr>, login_path: Option<&OsStr>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for src in [proc_path, login_path].into_iter().flatten() {
        for dir in env::split_paths(src) {
            if seen.insert(dir.clone()) {
                dirs.push(dir);
            }
        }
    }
    dirs
}

/// Search `dirs` (in order) for an executable file matching `bin`, returning the
/// first match as a display string. Pure over its inputs (no `$PATH` access).
fn resolve_in_paths(bin: &str, dirs: &[PathBuf]) -> Option<String> {
    for dir in dirs {
        // Bare candidate (Unix, and Windows binaries that already carry an ext).
        let candidate = dir.join(bin);
        if is_executable_file(&candidate) {
            return Some(candidate.display().to_string());
        }

        // Windows: try each PATHEXT extension.
        if cfg!(windows) {
            let extensions =
                env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string());
            for ext in extensions.split(';').filter(|e| !e.is_empty()) {
                let ext = ext.trim_start_matches('.');
                let candidate = dir.join(format!("{bin}.{ext}"));
                if is_executable_file(&candidate) {
                    return Some(candidate.display().to_string());
                }
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_all_known_clis() {
        let result = detect_clis_with(|_| None);
        let ids: Vec<&str> = result.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            // src/agents.json order, which is also the New workspace chip order.
            vec![
                "claude",
                "codex",
                "gemini",
                "opencode",
                "cursor",
                "droid",
                "copilot",
                "antigravity",
                "grok",
                "kimi",
                "pi"
            ]
        );
    }

    #[test]
    fn detects_the_clis_actually_installed_on_a_dev_machine() {
        // Measured with `command -v` on 2026-09-10: claude, codex, cursor-agent, opencode and grok
        // were all present, yet Lotus only knew the first three — so opencode and grok could only
        // be used by hand-typing a command as a custom runner.
        let installed = ["claude", "codex", "cursor-agent", "opencode", "grok"];
        let result = detect_clis_with(|bin| {
            installed
                .contains(&bin)
                .then(|| format!("/usr/local/bin/{bin}"))
        });

        for id in ["claude", "codex", "cursor", "opencode", "grok"] {
            let entry = result.iter().find(|c| c.id == id).unwrap();
            assert!(entry.installed, "{id} should be detected");
        }
        for id in ["gemini", "droid", "copilot", "antigravity", "kimi", "pi"] {
            let entry = result.iter().find(|c| c.id == id).unwrap();
            assert!(!entry.installed, "{id} should not be detected");
            assert_eq!(entry.path, None);
        }
    }

    #[test]
    fn invents_no_autonomy_flag_for_a_cli_whose_flags_are_unverified() {
        let result = detect_clis_with(|_| None);

        // A wrong flag fails the launch with a message that reads like a Lotus bug ("unknown
        // option --yolo"), so an unverified CLI gets the bare binary and the user adds flags in
        // Canvas Settings → Runners (`extra_flags`), which exists for exactly this.
        for id in ["opencode", "grok", "gemini", "droid", "copilot", "kimi", "pi"] {
            let entry = result.iter().find(|c| c.id == id).unwrap();
            assert!(
                !entry.command.contains("--"),
                "{id} must not carry a guessed flag, got {:?}",
                entry.command
            );
        }
    }

    #[test]
    fn located_path_must_be_one_absolute_executable_token() {
        assert!(validate_located_path("relative/agy").is_err());
        assert!(validate_located_path("/Applications/My App/agy").is_err());
        assert!(validate_located_path("/definitely/missing/agy").is_err());
        assert!(validate_located_path("/bin/sh").is_ok());
        // A plain file without the execute bit is not a program.
        let file = std::env::temp_dir().join(format!("lotus-not-exec-{}", std::process::id()));
        std::fs::write(&file, "x").unwrap();
        assert!(validate_located_path(file.to_str().unwrap()).is_err());
        let _ = std::fs::remove_file(file);
    }

    #[test]
    fn detects_antigravity_by_its_agy_binary() {
        let result = detect_clis_with(|bin| (bin == "agy").then(|| "/Users/u/.local/bin/agy".to_string()));
        let agy = result.iter().find(|c| c.id == "antigravity").unwrap();
        assert!(agy.installed);
        assert_eq!(agy.command, "agy --dangerously-skip-permissions");
    }

    #[test]
    fn keeps_the_ids_that_already_have_saved_config() {
        // `runners.json` is keyed by id: renaming one silently drops the user's saved
        // skip-permissions / extra-flags / claude-family settings for that runner.
        let result = detect_clis_with(|_| None);
        let claude = result.iter().find(|c| c.id == "claude").unwrap();
        assert_eq!(claude.command, "claude --dangerously-skip-permissions");
        let cursor = result.iter().find(|c| c.id == "cursor").unwrap();
        assert_eq!(cursor.command, "cursor-agent --yolo");
    }

    #[test]
    fn searches_the_dir_grok_installs_into() {
        // `~/.grok/bin/grok` on this machine, which no other well-known dir covers. A GUI launch
        // has a minimal PATH, so without this entry grok is invisible when Lotus starts from the
        // dock rather than a shell.
        let dirs = well_known_dirs();
        assert!(
            dirs.iter().any(|d| d.ends_with(".grok/bin")),
            "well-known dirs should include ~/.grok/bin, got {dirs:?}"
        );
    }

    #[test]
    fn marks_only_resolved_cli_as_installed() {
        // Fake probe: only "claude" resolves.
        let result = detect_clis_with(|bin| {
            if bin == "claude" {
                Some("/usr/local/bin/claude".to_string())
            } else {
                None
            }
        });

        let claude = result.iter().find(|c| c.id == "claude").unwrap();
        assert!(claude.installed);
        assert_eq!(claude.path.as_deref(), Some("/usr/local/bin/claude"));
        assert_eq!(claude.name, "Claude Code");
        assert_eq!(claude.command, "claude --dangerously-skip-permissions");

        let codex = result.iter().find(|c| c.id == "codex").unwrap();
        assert!(!codex.installed);
        assert_eq!(codex.path, None);
        assert_eq!(codex.name, "Codex");
        assert_eq!(
            codex.command,
            "codex --dangerously-bypass-approvals-and-sandbox"
        );

        let cursor = result.iter().find(|c| c.id == "cursor").unwrap();
        assert!(!cursor.installed);
        assert_eq!(cursor.path, None);
        assert_eq!(cursor.name, "Cursor Agent");
        assert_eq!(cursor.command, "cursor-agent --yolo");
    }

    #[test]
    fn none_installed_when_probe_finds_nothing() {
        let result = detect_clis_with(|_| None);
        assert!(result.iter().all(|c| !c.installed && c.path.is_none()));
    }

    #[test]
    fn candidate_dirs_merges_process_then_login_path_deduped() {
        let proc = OsString::from("/usr/bin:/bin");
        let login = OsString::from("/opt/homebrew/bin:/usr/bin:/Users/me/.claude/local");
        let dirs = candidate_dirs(Some(proc.as_os_str()), Some(login.as_os_str()));
        let shown: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
        // process PATH first, then login-only dirs appended, /usr/bin not duplicated.
        assert_eq!(
            shown,
            vec![
                "/usr/bin",
                "/bin",
                "/opt/homebrew/bin",
                "/Users/me/.claude/local"
            ],
        );
    }

    #[test]
    fn well_known_dirs_include_home_local_bin_and_system_bins() {
        if std::env::var_os("HOME").is_some() {
            assert!(well_known_dirs().iter().any(|d| d.ends_with(".local/bin")));
        }
        assert!(well_known_dirs()
            .iter()
            .any(|d| d == &PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn candidate_dirs_tolerates_a_missing_source() {
        let login = OsString::from("/opt/homebrew/bin");
        let only_login = candidate_dirs(None, Some(login.as_os_str()));
        assert_eq!(only_login.len(), 1);
        assert!(candidate_dirs(None, None).is_empty());
    }

    #[test]
    fn all_installed_when_probe_resolves_everything() {
        let result = detect_clis_with(|bin| Some(format!("/opt/bin/{bin}")));
        assert!(result.iter().all(|c| c.installed));
        let cursor = result.iter().find(|c| c.id == "cursor").unwrap();
        // Probe is keyed on the *binary* name, not the id.
        assert_eq!(cursor.path.as_deref(), Some("/opt/bin/cursor-agent"));
    }

    #[test]
    fn detect_on_actual_system() {
        // Real-world test: check what's actually on this machine.
        let result = detect_installed_clis();
        eprintln!("=== CLI Detection on actual system ===");
        for cli in &result {
            eprintln!(
                "  {}: installed={}, path={:?}",
                cli.id, cli.installed, cli.path
            );
        }
        // Every known CLI is reported, installed or not — the count follows the table rather
        // than a literal, so adding a CLI does not require editing this test.
        assert_eq!(result.len(), KNOWN_CLIS.len());
    }
}
