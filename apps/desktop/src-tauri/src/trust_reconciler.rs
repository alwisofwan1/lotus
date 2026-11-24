//! Workspace Trust Reconciler (ADR 0032).
//!
//! Each agent CLI gates project access behind its own *workspace trust* check,
//! which is separate from the per-tool approval gate — so `--dangerously-skip-permissions`
//! (Claude) and `--yolo` (Codex) do NOT satisfy it. When CodeCanvas dispatches a CLI
//! headlessly against an untrusted dir, Claude ignores the project's
//! `.claude/settings.local.json` and can block the run; Codex skips the project-scoped
//! `.codex/` layer.
//!
//! This module makes that seamless: when the user opens a project, we write the trust
//! marker into each file-based CLI's *native* config. Trust intent lives in Lotus state
//! (the user picked the folder); enforcement lives in the CLI's own config — Lotus state
//! dirs (`~/.lotus`, `~/.lotus-dev`) are never read by any CLI.
//!
//! Trust stores (verified 2026-06):
//! - Claude → `~/.claude.json` `projects["<abs>"].hasTrustDialogAccepted = true`
//! - Codex  → `~/.codex/config.toml` `[projects."<abs>"] trust_level = "trusted"`

use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{Map, Value};

/// Serializes config read-modify-write so concurrent project opens can't lose-update
/// a shared config file (mirrors the per-store locking used elsewhere in the backend).
static RECONCILE_LOCK: Mutex<()> = Mutex::new(());

/// Pre-trust `abs_root` in every file-based agent CLI's native config so headless
/// dispatch never trips the workspace-trust gate. Fail-open: any write error is logged
/// and ignored — trust is a convenience, never a blocker for opening a project.
///
/// The two spawn substrates resolve config dirs differently — `bridge_chat`/`codechat`
/// inherit the Lotus *process* env (`std::env`), while PTY spawns overlay the captured
/// *login-shell* env (`ccs` injects `CLAUDE_CONFIG_DIR` there). We can't know which file
/// any given dispatch will read, so we write trust to *every* candidate config file. Each
/// write is idempotent and benign, so over-covering costs nothing.
pub fn reconcile_workspace_trust(abs_root: &Path) {
    let abs_root = abs_root.to_string_lossy();
    let home = crate::paths::home_dir();
    let claude_paths = candidate_claude_configs(&home, &env_dirs("CLAUDE_CONFIG_DIR"));
    let codex_paths = candidate_codex_configs(&home, &env_dirs("CODEX_HOME"));
    reconcile_to_paths(&claude_paths, &codex_paths, &abs_root);
}

/// Locked, fail-open reconcile against explicit config-file lists — the testable core of
/// [`reconcile_workspace_trust`].
pub fn reconcile_to_paths(claude_paths: &[PathBuf], codex_paths: &[PathBuf], abs_root: &str) {
    let _guard = RECONCILE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for path in claude_paths {
        if let Err(err) = ensure_claude_trusted(path, abs_root) {
            eprintln!(
                "[trust-reconciler] claude trust write failed for {abs_root} at {path:?}: {err}"
            );
        }
    }
    for path in codex_paths {
        if let Err(err) = ensure_codex_trusted(path, abs_root) {
            eprintln!(
                "[trust-reconciler] codex trust write failed for {abs_root} at {path:?}: {err}"
            );
        }
    }
}

/// Every value of `key` a spawn might inherit: the parent-process env (what
/// `bridge_chat`/`codechat` `Command`s inherit) and the captured login-shell env (what
/// PTY spawns overlay). Both are returned because either substrate may hit the trust gate.
/// Empty values are dropped.
fn env_dirs(key: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(value) = std::env::var(key) {
        if !value.is_empty() {
            dirs.push(PathBuf::from(value));
        }
    }
    if let Some(value) = crate::shell_env::user_login_env().get(key) {
        if !value.is_empty() {
            dirs.push(PathBuf::from(value));
        }
    }
    dirs
}

/// Every Claude config file Lotus should keep in sync (default `~/.claude.json`, each
/// `CLAUDE_CONFIG_DIR` profile a `ccs`/wrapper injects, and every account in `accounts.rs`).
/// Shared by the trust reconciler AND the MCP keeper so a 2nd-account/profile Claude gets both
/// trust and the lotus MCP tools. Empty if no home.
pub fn all_claude_config_paths() -> Vec<PathBuf> {
    match dirs::home_dir() {
        Some(home) => with_account_configs(
            candidate_claude_configs(&home, &env_dirs("CLAUDE_CONFIG_DIR")),
            &crate::accounts::claude_accounts(),
        ),
        None => Vec::new(),
    }
}

fn with_account_configs(mut paths: Vec<PathBuf>, accounts: &[crate::accounts::Account]) -> Vec<PathBuf> {
    paths.extend(accounts.iter().map(|a| a.config_file.clone()));
    dedupe(paths)
}

/// Codex counterpart of [`all_claude_config_paths`]: default `~/.codex/config.toml` + `CODEX_HOME` profiles.
pub fn all_codex_config_paths() -> Vec<PathBuf> {
    match dirs::home_dir() {
        Some(home) => with_account_configs(candidate_codex_configs(&home, &env_dirs("CODEX_HOME")), &crate::accounts::codex_accounts()),
        None => Vec::new(),
    }
}

/// Every Claude config file a spawn could read for `abs_root`: always `<home>/.claude.json`
/// (the no-`CLAUDE_CONFIG_DIR` case) plus `<dir>/.claude.json` for each candidate dir. Deduped.
pub fn candidate_claude_configs(home: &Path, env_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = vec![claude_config_path(None, home)];
    for dir in env_dirs {
        paths.push(claude_config_path(Some(dir), home));
    }
    dedupe(paths)
}

/// Codex counterpart of [`candidate_claude_configs`] — always `<home>/.codex/config.toml`
/// plus `<CODEX_HOME>/config.toml` for each candidate dir. Deduped.
pub fn candidate_codex_configs(home: &Path, env_dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut paths = vec![codex_config_path(None, home)];
    for dir in env_dirs {
        paths.push(codex_config_path(Some(dir), home));
    }
    dedupe(paths)
}

fn dedupe(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        if seen.insert(path.clone()) {
            out.push(path);
        }
    }
    out
}

/// Ensure Claude CLI trusts `abs_root` by setting
/// `projects["<abs_root>"].hasTrustDialogAccepted = true` in `config_path`.
///
/// Merge-safe: every other key (credentials, `mcpServers`, other projects) is preserved.
/// Idempotent: returns `Ok(true)` when a write happened, `Ok(false)` when the flag was
/// already set so no rewrite was needed.
pub fn ensure_claude_trusted(config_path: &Path, abs_root: &str) -> std::io::Result<bool> {
    let mut root = read_json_object(config_path)?;

    let projects = root
        .entry("projects")
        .or_insert_with(|| Value::Object(Map::new()));
    if !projects.is_object() {
        *projects = Value::Object(Map::new());
    }
    let projects = projects.as_object_mut().expect("projects is object");

    let project = projects
        .entry(abs_root.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !project.is_object() {
        *project = Value::Object(Map::new());
    }
    let project = project.as_object_mut().expect("project is object");

    if project.get("hasTrustDialogAccepted") == Some(&Value::Bool(true)) {
        return Ok(false);
    }
    project.insert("hasTrustDialogAccepted".to_string(), Value::Bool(true));

    let body = serde_json::to_vec_pretty(&Value::Object(root))?;
    crate::mcp_config::atomic_write(config_path, &body)?;
    Ok(true)
}

/// Resolve the Claude config file the spawned CLI will actually read. Mirrors the
/// spawn env: when `CLAUDE_CONFIG_DIR` is set (e.g. by `ccs`, see `shell_env`), Claude
/// reads `<dir>/.claude.json`; otherwise `<home>/.claude.json`. Writing to the wrong
/// file would trust a config the CLI never loads.
pub fn claude_config_path(config_dir_override: Option<&Path>, home: &Path) -> std::path::PathBuf {
    config_dir_override.unwrap_or(home).join(".claude.json")
}

/// Resolve the Codex config file. `CODEX_HOME` (default `~/.codex`) holds `config.toml`.
pub fn codex_config_path(codex_home_override: Option<&Path>, home: &Path) -> std::path::PathBuf {
    match codex_home_override {
        Some(dir) => dir.join("config.toml"),
        None => home.join(".codex").join("config.toml"),
    }
}

/// Ensure Codex CLI trusts `abs_root` by writing a `[projects."<abs_root>"]`
/// table with `trust_level = "trusted"` into `config_path` (`~/.codex/config.toml`).
///
/// Follows the codebase convention of editing `config.toml` as text (see
/// `mcp_config`), appending the table so all existing content/comments survive.
/// Idempotent: returns `Ok(false)` when the project table already exists.
pub fn ensure_codex_trusted(config_path: &Path, abs_root: &str) -> std::io::Result<bool> {
    let existing = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(err) => return Err(err),
    };

    let header = format!("[projects.\"{}\"]", toml_escape(abs_root));
    if existing.lines().any(|line| line.trim() == header) {
        return Ok(false);
    }

    let mut next = existing;
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    if !next.is_empty() {
        next.push('\n');
    }
    next.push_str(&header);
    next.push_str("\ntrust_level = \"trusted\"\n");

    crate::mcp_config::atomic_write(config_path, next.as_bytes())?;
    Ok(true)
}

/// Escape a string for use inside a TOML basic (double-quoted) string. Filesystem
/// paths almost never contain `"` or `\`, but we escape them so an exotic path
/// can't produce malformed TOML.
fn toml_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Read `path` as a JSON object. A missing file yields an empty object; content we cannot
/// parse is an error, so the caller never rewrites (and so destroys) a file it did not understand.
fn read_json_object(path: &Path) -> std::io::Result<Map<String, Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(err) => return Err(err),
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{} is not a JSON object; leaving it untouched", path.display()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_trust_refuses_to_overwrite_unparseable_config() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cfg = dir.path().join(".claude.json");
        std::fs::write(&cfg, b"{ \"oauthAccount\": {").expect("seed corrupt config");

        assert!(ensure_claude_trusted(&cfg, "/tmp/demo").is_err());
        assert_eq!(
            std::fs::read(&cfg).expect("read config"),
            b"{ \"oauthAccount\": {",
            "a config we cannot parse must be left byte-for-byte alone"
        );
    }

    #[test]
    fn claude_trust_created_in_fresh_config() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cfg = dir.path().join(".claude.json");

        let changed = ensure_claude_trusted(&cfg, "/tmp/demo").expect("ensure trusted");

        assert!(
            changed,
            "writing trust into a fresh config should report a change"
        );
        let value: Value =
            serde_json::from_slice(&std::fs::read(&cfg).expect("read config")).expect("parse json");
        assert_eq!(
            value["projects"]["/tmp/demo"]["hasTrustDialogAccepted"],
            Value::Bool(true)
        );
    }

    #[test]
    fn claude_trust_preserves_credentials_mcp_and_other_projects() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cfg = dir.path().join(".claude.json");
        std::fs::write(
            &cfg,
            serde_json::to_vec_pretty(&serde_json::json!({
                "oauthAccount": { "accessToken": "secret-token" },
                "mcpServers": { "lotus": { "command": "node" } },
                "projects": {
                    "/other/repo": { "hasTrustDialogAccepted": true, "lastCost": 1.23 }
                }
            }))
            .unwrap(),
        )
        .unwrap();

        ensure_claude_trusted(&cfg, "/tmp/demo").expect("ensure trusted");

        let value: Value =
            serde_json::from_slice(&std::fs::read(&cfg).unwrap()).expect("parse json");
        // New trust added.
        assert_eq!(
            value["projects"]["/tmp/demo"]["hasTrustDialogAccepted"],
            Value::Bool(true)
        );
        // Nothing else clobbered.
        assert_eq!(value["oauthAccount"]["accessToken"], "secret-token");
        assert_eq!(value["mcpServers"]["lotus"]["command"], "node");
        assert_eq!(
            value["projects"]["/other/repo"]["hasTrustDialogAccepted"],
            Value::Bool(true)
        );
        assert_eq!(value["projects"]["/other/repo"]["lastCost"], 1.23);
    }

    #[test]
    fn claude_trust_is_idempotent_no_rewrite_when_already_true() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cfg = dir.path().join(".claude.json");

        assert!(ensure_claude_trusted(&cfg, "/tmp/demo").unwrap());
        // Second call: already trusted → no change reported.
        assert!(!ensure_claude_trusted(&cfg, "/tmp/demo").unwrap());
    }

    #[test]
    fn codex_trust_appended_to_fresh_config() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cfg = dir.path().join("config.toml");

        let changed = ensure_codex_trusted(&cfg, "/tmp/demo").expect("ensure trusted");

        assert!(changed);
        let text = std::fs::read_to_string(&cfg).expect("read config");
        assert!(text.contains("[projects.\"/tmp/demo\"]"), "got: {text}");
        assert!(text.contains("trust_level = \"trusted\""), "got: {text}");
    }

    #[test]
    fn codex_trust_preserves_existing_config_and_other_projects() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cfg = dir.path().join("config.toml");
        let prior = "model = \"gpt-5\"\n\
                     notify = [\"/Users/x/.lotus/codex-notify.sh\"]\n\n\
                     [projects.\"/other/repo\"]\n\
                     trust_level = \"trusted\"\n";
        std::fs::write(&cfg, prior).unwrap();

        ensure_codex_trusted(&cfg, "/tmp/demo").expect("ensure trusted");

        let text = std::fs::read_to_string(&cfg).unwrap();
        assert!(
            text.contains("model = \"gpt-5\""),
            "model preserved: {text}"
        );
        assert!(text.contains("notify = ["), "notify preserved: {text}");
        assert!(
            text.contains("[projects.\"/other/repo\"]"),
            "other project preserved"
        );
        assert!(
            text.contains("[projects.\"/tmp/demo\"]"),
            "new project added"
        );
        // The file remains parseable as a sequence of distinct top-level tables:
        // exactly two project tables, no duplicated headers.
        assert_eq!(
            text.matches("[projects.").count(),
            2,
            "no duplicate tables: {text}"
        );
    }

    #[test]
    fn codex_trust_is_idempotent() {
        let dir = tempfile::tempdir().expect("temp dir");
        let cfg = dir.path().join("config.toml");

        assert!(ensure_codex_trusted(&cfg, "/tmp/demo").unwrap());
        assert!(!ensure_codex_trusted(&cfg, "/tmp/demo").unwrap());
    }

    #[test]
    fn trust_already_granted_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".claude.json");
        // Compact: a rewrite would pretty-print it.
        let text = r#"{"projects":{"/r":{"hasTrustDialogAccepted":true}}}"#;
        std::fs::write(&file, text).unwrap();
        assert!(!ensure_claude_trusted(&file, "/r").unwrap());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    }

    #[test]
    fn every_account_config_file_is_kept_in_sync() {
        let home = tempfile::tempdir().unwrap();
        let state = home.path().join("state");
        for dir in [home.path().join(".ccs/instances/acme"), state.join("accounts/claude/work")] {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(".claude.json"), "{}").unwrap();
        }
        let accounts = crate::accounts::claude_accounts_in(home.path(), &state, &[]);
        let paths = with_account_configs(candidate_claude_configs(home.path(), &[]), &accounts);
        assert_eq!(
            paths,
            [
                home.path().join(".claude.json"),
                home.path().join(".ccs/instances/acme/.claude.json"),
                state.join("accounts/claude/work/.claude.json"),
            ]
        );
    }

    #[test]
    fn claude_config_path_honors_override_then_home() {
        let home = Path::new("/home/u");
        assert_eq!(
            claude_config_path(None, home),
            Path::new("/home/u/.claude.json")
        );
        assert_eq!(
            claude_config_path(Some(Path::new("/cfg/claude")), home),
            Path::new("/cfg/claude/.claude.json")
        );
    }

    #[test]
    fn codex_config_path_honors_codex_home_then_default() {
        let home = Path::new("/home/u");
        assert_eq!(
            codex_config_path(None, home),
            Path::new("/home/u/.codex/config.toml")
        );
        assert_eq!(
            codex_config_path(Some(Path::new("/cfg/codex")), home),
            Path::new("/cfg/codex/config.toml")
        );
    }

    #[test]
    fn concurrent_reconcile_does_not_lose_updates() {
        let dir = tempfile::tempdir().expect("temp dir");
        let claude = dir.path().join(".claude.json");
        let codex = dir.path().join("config.toml");

        std::thread::scope(|scope| {
            for i in 0..12 {
                let claude = claude.clone();
                let codex = codex.clone();
                scope.spawn(move || {
                    reconcile_to_paths(
                        std::slice::from_ref(&claude),
                        std::slice::from_ref(&codex),
                        &format!("/repo/{i}"),
                    );
                });
            }
        });

        let value: Value =
            serde_json::from_slice(&std::fs::read(&claude).unwrap()).expect("parse json");
        let codex_text = std::fs::read_to_string(&codex).unwrap();
        for i in 0..12 {
            assert_eq!(
                value["projects"][format!("/repo/{i}")]["hasTrustDialogAccepted"],
                Value::Bool(true),
                "claude trust for /repo/{i} lost"
            );
            assert!(
                codex_text.contains(&format!("[projects.\"/repo/{i}\"]")),
                "codex trust for /repo/{i} lost"
            );
        }
    }

    #[test]
    fn reconcile_is_fail_open_and_isolates_adapter_failures() {
        let dir = tempfile::tempdir().expect("temp dir");
        // Claude path is unwritable: its parent is a regular file, so create_dir_all fails.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, b"x").unwrap();
        let claude = blocker.join("nested").join(".claude.json");
        let codex = dir.path().join("config.toml");

        // Must not panic despite the Claude write failing…
        reconcile_to_paths(
            std::slice::from_ref(&claude),
            std::slice::from_ref(&codex),
            "/repo/demo",
        );

        // …and the Codex adapter still ran.
        let codex_text = std::fs::read_to_string(&codex).expect("codex written");
        assert!(codex_text.contains("[projects.\"/repo/demo\"]"));
    }

    #[test]
    fn candidate_configs_cover_home_and_every_env_dir_deduped() {
        let home = Path::new("/home/u");
        let env_dirs = vec![
            PathBuf::from("/home/u"), // duplicates the home case
            PathBuf::from("/cfg/a"),
            PathBuf::from("/cfg/a"), // duplicate
            PathBuf::from("/cfg/b"),
        ];

        let claude = candidate_claude_configs(home, &env_dirs);
        assert_eq!(
            claude,
            vec![
                PathBuf::from("/home/u/.claude.json"),
                PathBuf::from("/cfg/a/.claude.json"),
                PathBuf::from("/cfg/b/.claude.json"),
            ]
        );

        let codex = candidate_codex_configs(home, &env_dirs);
        assert_eq!(
            codex,
            vec![
                // Default CODEX_HOME is `<home>/.codex`; a literal CODEX_HOME=/home/u
                // means `/home/u/config.toml` — a distinct, legitimate file, not a dup.
                PathBuf::from("/home/u/.codex/config.toml"),
                PathBuf::from("/home/u/config.toml"),
                PathBuf::from("/cfg/a/config.toml"),
                PathBuf::from("/cfg/b/config.toml"),
            ]
        );
    }

    #[test]
    fn reconcile_writes_trust_to_all_candidate_files() {
        let dir = tempfile::tempdir().expect("temp dir");
        let home_claude = dir.path().join("home").join(".claude.json");
        let alt_claude = dir.path().join("ccs").join(".claude.json");
        let home_codex = dir.path().join("home").join(".codex").join("config.toml");

        reconcile_to_paths(
            &[home_claude.clone(), alt_claude.clone()],
            &[home_codex.clone()],
            "/repo/demo",
        );

        for path in [&home_claude, &alt_claude] {
            let value: Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).expect("parse");
            assert_eq!(
                value["projects"]["/repo/demo"]["hasTrustDialogAccepted"],
                Value::Bool(true),
                "trust missing in {path:?}"
            );
        }
    }
}
