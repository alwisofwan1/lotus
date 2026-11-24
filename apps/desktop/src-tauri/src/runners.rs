use crate::cli_detect::detect_installed_clis;
use crate::error::AppError;
use crate::json::{read_json, write_json};
use crate::paths::lotus_state_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Default for `resume_on_reopen` so configs saved before the field existed (and the unconfigured
/// case) keep the prior always-on behaviour (ADR-0027 Phase 5).
fn default_true() -> bool {
    true
}

/// Per-runner configuration stored in ~/.lotus/runners.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerConfig {
    pub id: String,
    pub skip_permissions: bool,
    pub extra_flags: String,
    /// Whether a reopened live agent resumes its prior session (ADR-0027 Phase 5). Default true.
    #[serde(default = "default_true")]
    pub resume_on_reopen: bool,
    pub resume_session_id: Option<String>,
    /// User-defined custom runner (not an auto-detected CLI). When true, `name` + `command` below are
    /// authoritative and the entry is surfaced even though `detect_installed_clis` never yields it.
    #[serde(default)]
    pub custom: bool,
    /// Display name for a custom runner (e.g. "acme"). None/ignored for detected CLIs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Full base command for a custom runner (e.g. "ccs acme --dangerously-skip-permissions").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// A custom runner that is actually Claude Code (a different account/profile wrapper). When true it
    /// receives full claude-family treatment at spawn: --append-system-prompt (identity + peer
    /// messaging), --model, and session pinning — so a 2nd-account Claude can collaborate like a
    /// built-in claude runner. Ignored for non-custom detected CLIs.
    #[serde(default)]
    pub claude_family: bool,
    /// How this custom runner is told to continue a conversation, as a template containing `{id}`
    /// (Session Widget, Slice 06).
    ///
    /// `resume_on_reopen` above is a permission; this is the *method*, and without it the permission
    /// had nothing to act on. Two real examples from CLIs installed here:
    /// `--resume {id}` (grok) and `--session {id}` (opencode). Empty/absent = this runner cannot
    /// continue a conversation, and Lotus offers "start with context" instead of a resume it cannot
    /// deliver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_template: Option<String>,
    /// How this runner is told to START a conversation under an id we choose, same `{id}` template.
    ///
    /// Only grok can do this (`--session-id {id}`), and it is worth a field of its own because it
    /// removes the capture race entirely: there is nothing to discover afterwards when we named the
    /// session ourselves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_session_template: Option<String>,
}

/// Combined view: detected CLI + loaded config (or defaults)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub path: Option<String>,
    pub command: String,
    pub skip_permissions: bool,
    pub extra_flags: String,
    pub resume_on_reopen: bool,
    pub resume_session_id: Option<String>,
    /// The user located this binary by hand (Settings › Agents › Locate…).
    #[serde(default)]
    pub located: bool,
    /// True for user-defined custom runners (vs auto-detected CLIs) — lets the UI show edit/delete.
    #[serde(default)]
    pub custom: bool,
    /// A custom runner that is actually Claude Code — surfaced so the UI can show the toggle and the
    /// spawn path can grant claude-family treatment.
    #[serde(default)]
    pub claude_family: bool,
    /// `{id}` template for continuing a conversation, e.g. `--resume {id}` (Session Widget, Slice 06).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_template: Option<String>,
    /// `{id}` template for starting one under an id we choose, e.g. `--session-id {id}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_session_template: Option<String>,
}

/// Registry of all runner configs, merged with CLI detection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerRegistry {
    pub runners: Vec<RunnerInfo>,
}

fn runners_file() -> PathBuf {
    lotus_state_dir().join("runners.json")
}

/// Load all runner configs from disk, or empty if file missing
fn load_registry() -> Result<HashMap<String, RunnerConfig>, AppError> {
    load_registry_from(&runners_file())
}

/// Load runner configs from a specific path (seam for tests — avoids depending on real home state).
fn load_registry_from(path: &Path) -> Result<HashMap<String, RunnerConfig>, AppError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    Ok(read_json::<HashMap<String, RunnerConfig>>(&path.to_path_buf()).unwrap_or_default())
}

/// List all installed runners with their configs (detected + loaded)
pub fn list_runners() -> Result<RunnerRegistry, AppError> {
    let configs = load_registry()?;
    let installed = detect_installed_clis();

    let runners: Vec<RunnerInfo> = installed
        .into_iter()
        .map(|cli| {
            let config = configs.get(&cli.id).cloned();
            RunnerInfo {
                id: cli.id.clone(),
                name: cli.name,
                installed: cli.installed,
                located: cli.located,
                path: cli.path,
                command: cli.command,
                // Default YOLO: CodeCanvas runner-first agents launch with skip-permissions on
                // (ADR-0027), so an unconfigured runner honestly reports skip_permissions = true.
                // A saved config overrides it (the user can turn YOLO off per runner).
                skip_permissions: config.as_ref().map_or(true, |c| c.skip_permissions),
                extra_flags: config
                    .as_ref()
                    .map_or_else(String::new, |c| c.extra_flags.clone()),
                // Resume-on-reopen defaults on (prior behaviour); a saved config can turn it off per runner.
                resume_on_reopen: config.as_ref().map_or(true, |c| c.resume_on_reopen),
                resume_session_id: config.as_ref().and_then(|c| c.resume_session_id.clone()),
                custom: false,
                // Detected CLIs are classified by their own id (claude/codex/cursor); the flag is only
                // meaningful for custom runners, but honour a saved value if one exists.
                claude_family: config.as_ref().map_or(false, |c| c.claude_family),
                resume_template: config.as_ref().and_then(|c| c.resume_template.clone()),
                new_session_template: config.as_ref().and_then(|c| c.new_session_template.clone()),
            }
        })
        .collect();

    // Custom runners (`custom: true` entries) are no longer listed (2026-11-19): each one was a
    // known CLI (now built-in), a duplicate, or a Claude account (now in Accounts). Their entries
    // stay in runners.json untouched, as a backup.
    Ok(RunnerRegistry { runners })
}

/// Get a single runner info by ID
pub fn get_runner(id: String) -> Result<Option<RunnerInfo>, AppError> {
    let registry = list_runners()?;
    Ok(registry.runners.into_iter().find(|r| r.id == id))
}

/// Save runner configuration (skip_permissions, extra_flags, etc.)
pub fn save_runner_config(id: String, config: RunnerConfig) -> Result<(), AppError> {
    if id != config.id {
        return Err(crate::error::other("runner id mismatch"));
    }
    // A custom runner is only useful with a base command to launch (e.g. "ccs acme …").
    if config.custom
        && config
            .command
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return Err(crate::error::other("custom runner requires a command"));
    }

    let path = runners_file();
    let mut registry = load_registry()?;
    registry.insert(id, config);

    // Ensure parent dir exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::Io)?;
    }

    write_json(&path, &registry)
}

/// Delete a runner configuration
pub fn delete_runner_config(id: String) -> Result<(), AppError> {
    let path = runners_file();
    let mut registry = load_registry()?;
    registry.remove(&id);
    write_json(&path, &registry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_detect::DetectedCli;

    #[test]
    fn load_registry_returns_empty_for_missing_file() {
        // Point at a guaranteed-missing path so the test never depends on the real ~/.lotus[-dev] state.
        let missing = std::env::temp_dir().join("lotus_runners_registry_absent_test.json");
        let _ = std::fs::remove_file(&missing);
        let result = load_registry_from(&missing);
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[test]
    fn skip_permissions_defaults_to_yolo_when_unconfigured() {
        // Mirrors the merge in list_runners: no saved config → YOLO (true); a saved config wins.
        let none: Option<RunnerConfig> = None;
        assert!(
            none.as_ref().map_or(true, |c| c.skip_permissions),
            "unconfigured runner is YOLO"
        );

        let off = Some(RunnerConfig {
            id: "claude".to_string(),
            skip_permissions: false,
            extra_flags: String::new(),
            resume_on_reopen: true,
            resume_session_id: None,
            custom: false,
            name: None,
            command: None,
            claude_family: false,
            resume_template: None,
            new_session_template: None,
        });
        assert!(
            !off.as_ref().map_or(true, |c| c.skip_permissions),
            "saved skip=false is respected"
        );
    }

    #[test]
    fn resume_on_reopen_defaults_true_for_old_configs() {
        // A config saved before the field existed must deserialize with resume_on_reopen = true.
        let legacy =
            r#"{"id":"claude","skip_permissions":true,"extra_flags":"","resume_session_id":null}"#;
        let cfg: RunnerConfig = serde_json::from_str(legacy).unwrap();
        assert!(cfg.resume_on_reopen, "legacy config defaults to resume on");

        // And it round-trips when explicitly off.
        let off = r#"{"id":"claude","skip_permissions":true,"extra_flags":"","resume_on_reopen":false,"resume_session_id":null}"#;
        let cfg: RunnerConfig = serde_json::from_str(off).unwrap();
        assert!(
            !cfg.resume_on_reopen,
            "explicit resume_on_reopen=false is respected"
        );
    }

    #[test]
    fn runner_config_serializes() {
        let config = RunnerConfig {
            id: "claude".to_string(),
            skip_permissions: true,
            extra_flags: "--model opus".to_string(),
            resume_on_reopen: true,
            resume_session_id: Some("abc123".to_string()),
            custom: false,
            name: None,
            command: None,
            claude_family: false,
            resume_template: None,
            new_session_template: None,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("claude"));
        assert!(json.contains("true"));
    }

    #[test]
    fn claude_family_defaults_false_and_round_trips() {
        // Legacy config (field absent) → false.
        let legacy = r#"{"id":"acme","skip_permissions":true,"extra_flags":"","resume_on_reopen":true,"resume_session_id":null,"custom":true,"command":"ccs acme"}"#;
        let cfg: RunnerConfig = serde_json::from_str(legacy).unwrap();
        assert!(!cfg.claude_family, "absent claude_family defaults to false");

        // Explicit true round-trips.
        let on = r#"{"id":"acme","skip_permissions":true,"extra_flags":"","resume_on_reopen":true,"resume_session_id":null,"custom":true,"command":"ccs acme","claude_family":true}"#;
        let cfg: RunnerConfig = serde_json::from_str(on).unwrap();
        assert!(
            cfg.claude_family,
            "explicit claude_family=true is respected"
        );
    }

    #[test]
    fn runner_info_merges_detected_with_config() {
        let cli = DetectedCli {
            id: "claude".to_string(),
            name: "Claude Code".to_string(),
            command: "claude --dangerously-skip-permissions".to_string(),
            path: Some("/usr/local/bin/claude".to_string()),
            installed: true,
            located: false,
        };

        let config = RunnerConfig {
            id: "claude".to_string(),
            skip_permissions: true,
            extra_flags: "--model sonnet".to_string(),
            resume_on_reopen: false,
            resume_session_id: None,
            custom: false,
            name: None,
            command: None,
            claude_family: false,
            resume_template: None,
            new_session_template: None,
        };

        let info = RunnerInfo {
            id: cli.id.clone(),
            name: cli.name,
            installed: cli.installed,
            located: cli.located,
            path: cli.path,
            command: cli.command,
            skip_permissions: config.skip_permissions,
            extra_flags: config.extra_flags.clone(),
            resume_on_reopen: config.resume_on_reopen,
            resume_session_id: config.resume_session_id,
            custom: false,
            claude_family: false,
            resume_template: config.resume_template,
            new_session_template: config.new_session_template,
        };

        assert_eq!(info.id, "claude");
        assert!(info.skip_permissions);
        assert!(!info.resume_on_reopen);
        assert_eq!(info.extra_flags, "--model sonnet");
    }

    #[test]
    fn custom_config_defaults_false_for_legacy_and_round_trips() {
        // A config saved before `custom`/`name`/`command` existed deserializes as a detected-CLI config.
        let legacy =
            r#"{"id":"claude","skip_permissions":true,"extra_flags":"","resume_session_id":null}"#;
        let cfg: RunnerConfig = serde_json::from_str(legacy).unwrap();
        assert!(!cfg.custom);
        assert!(cfg.command.is_none());

        let custom = r#"{"id":"custom-acme","skip_permissions":true,"extra_flags":"","resume_session_id":null,"custom":true,"name":"acme","command":"ccs acme --dangerously-skip-permissions"}"#;
        let cfg: RunnerConfig = serde_json::from_str(custom).unwrap();
        assert!(cfg.custom);
        assert_eq!(cfg.name.as_deref(), Some("acme"));
        assert_eq!(
            cfg.command.as_deref(),
            Some("ccs acme --dangerously-skip-permissions")
        );
    }
}
