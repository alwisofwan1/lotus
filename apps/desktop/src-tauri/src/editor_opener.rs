use crate::no_window::NoWindow;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorPreference {
    System,
    VsCode,
    Cursor,
    Antigravity,
    Custom,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorAvailability {
    pub vscode: bool,
    pub cursor: bool,
    pub antigravity: bool,
    pub antigravity_app: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorLaunchSpec {
    pub program: String,
    pub args: Vec<String>,
    pub use_system_open: bool,
}

pub fn preference_from_settings(settings: &serde_json::Value) -> EditorPreference {
    match settings
        .get("editorPreference")
        .and_then(|value| value.as_str())
        .unwrap_or("system")
    {
        "vscode" => EditorPreference::VsCode,
        "cursor" => EditorPreference::Cursor,
        "antigravity" => EditorPreference::Antigravity,
        "custom" => EditorPreference::Custom,
        _ => EditorPreference::System,
    }
}

pub fn resolve_path(cwd: &str, path: &str) -> Result<PathBuf, AppError> {
    let cwd_path = PathBuf::from(cwd);
    let resolved = if let Some(stripped) = path.strip_prefix("~/") {
        dirs::home_dir()
            .map(|home| home.join(stripped))
            .ok_or_else(|| AppError::Other("Home directory unavailable".into()))?
    } else {
        let candidate = PathBuf::from(path);
        if candidate.is_absolute() {
            candidate
        } else {
            cwd_path.join(candidate)
        }
    };

    if !resolved.exists() {
        if let Some(discovered) = resolve_filename_in_workspace(&cwd_path, path) {
            return Ok(discovered);
        }

        return Err(AppError::Other(format!(
            "Path does not exist: {}",
            resolved.display()
        )));
    }

    Ok(resolved)
}

fn resolve_filename_in_workspace(cwd: &Path, path: &str) -> Option<PathBuf> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || path.starts_with("~/")
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::CurDir
                    | Component::ParentDir
                    | Component::RootDir
                    | Component::Prefix(_)
            )
        })
    {
        return None;
    }

    let filename = candidate.file_name()?.to_str()?;
    if candidate
        .parent()
        .is_some_and(|parent| !parent.as_os_str().is_empty())
    {
        return None;
    }

    let mut matches = Vec::new();
    collect_filename_matches(cwd, filename, 0, &mut matches);

    match matches.as_slice() {
        [path] => Some(path.clone()),
        _ => None,
    }
}

fn collect_filename_matches(
    directory: &Path,
    filename: &str,
    depth: usize,
    matches: &mut Vec<PathBuf>,
) {
    const MAX_DEPTH: usize = 5;
    const SKIPPED_DIRS: &[&str] = &[".git", ".next", "node_modules", "out", "target"];

    if depth > MAX_DEPTH || matches.len() > 1 {
        return;
    }

    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = entry.file_name();

        if path.is_file() && file_name == filename {
            matches.push(path);
            if matches.len() > 1 {
                return;
            }
            continue;
        }

        if path.is_dir() {
            let dir_name = file_name.to_string_lossy();
            if SKIPPED_DIRS.contains(&dir_name.as_ref()) {
                continue;
            }

            collect_filename_matches(&path, filename, depth + 1, matches);
            if matches.len() > 1 {
                return;
            }
        }
    }
}

pub fn build_launch_spec(
    preference: EditorPreference,
    resolved_path: &Path,
    line: Option<u32>,
    column: Option<u32>,
    settings: Option<&serde_json::Value>,
) -> EditorLaunchSpec {
    match preference {
        EditorPreference::System => EditorLaunchSpec {
            program: resolved_path.to_string_lossy().into_owned(),
            args: vec![],
            use_system_open: true,
        },
        EditorPreference::VsCode => EditorLaunchSpec {
            program: "code".into(),
            args: vec![
                "--goto".into(),
                path_with_position(resolved_path, line, column),
            ],
            use_system_open: false,
        },
        EditorPreference::Cursor => EditorLaunchSpec {
            program: "cursor".into(),
            args: vec![
                "--goto".into(),
                path_with_position(resolved_path, line, column),
            ],
            use_system_open: false,
        },
        EditorPreference::Antigravity => build_custom_like_spec(
            settings,
            "antigravity",
            vec!["{pathWithPosition}".into()],
            resolved_path,
            line,
            column,
        ),
        EditorPreference::Custom => build_custom_like_spec(
            settings,
            "",
            vec!["{path}".into()],
            resolved_path,
            line,
            column,
        ),
    }
}

fn build_custom_like_spec(
    settings: Option<&serde_json::Value>,
    default_command: &str,
    default_args: Vec<String>,
    resolved_path: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> EditorLaunchSpec {
    let command = settings
        .and_then(|value| value.get("editorCommand"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_command.to_string());

    let args = settings
        .and_then(|value| value.get("editorArgs"))
        .and_then(|value| value.as_array())
        .map(|value| {
            value
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| apply_template(item, resolved_path, line, column))
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            default_args
                .into_iter()
                .map(|item| apply_template(&item, resolved_path, line, column))
                .filter(|item| !item.is_empty())
                .collect()
        });

    EditorLaunchSpec {
        program: command,
        args,
        use_system_open: false,
    }
}

fn apply_template(
    template: &str,
    resolved_path: &Path,
    line: Option<u32>,
    column: Option<u32>,
) -> String {
    template
        .replace(
            "{pathWithPosition}",
            &path_with_position(resolved_path, line, column),
        )
        .replace("{path}", &resolved_path.display().to_string())
        .replace(
            "{line}",
            &line.map(|value| value.to_string()).unwrap_or_default(),
        )
        .replace(
            "{column}",
            &column.map(|value| value.to_string()).unwrap_or_default(),
        )
        .trim()
        .to_string()
}

fn path_with_position(path: &Path, line: Option<u32>, column: Option<u32>) -> String {
    match (line, column) {
        (Some(line), Some(column)) => format!("{}:{line}:{column}", path.display()),
        (Some(line), None) => format!("{}:{line}", path.display()),
        _ => path.display().to_string(),
    }
}

pub fn open_in_editor(spec: &EditorLaunchSpec) -> Result<(), AppError> {
    if spec.use_system_open {
        return Err(AppError::Other("system-open".into()));
    }

    if spec.program.trim().is_empty() {
        return Err(AppError::Other("Editor command is empty".into()));
    }

    // A Dock launch has PATH=/usr/bin:/bin:/usr/sbin:/sbin, so `code`/`cursor` must be resolved.
    let program = crate::cli_detect::find_executable(&spec.program).unwrap_or_else(|| spec.program.clone());
    let status = Command::new(program)
        .no_window()
        .args(&spec.args)
        .status()
        .map_err(AppError::Io)?;

    if !status.success() {
        return Err(AppError::Other(format!(
            "Editor command failed: {} {}",
            spec.program,
            spec.args.join(" ")
        )));
    }

    Ok(())
}

pub fn available_editors() -> EditorAvailability {
    EditorAvailability {
        vscode: command_exists("code"),
        cursor: command_exists("cursor"),
        antigravity: command_exists("antigravity"),
        antigravity_app: antigravity_app_exists(),
    }
}

fn antigravity_app_exists() -> bool {
    #[cfg(target_os = "macos")]
    {
        Path::new("/Applications/Antigravity.app").exists()
            || dirs::home_dir()
                .map(|home| home.join("Applications/Antigravity.app").exists())
                .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

fn command_exists(program: &str) -> bool {
    crate::cli_detect::find_executable(program).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_editor_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("orchids-editor-opener-{name}-{nonce}"))
    }

    #[test]
    fn builds_vscode_launch_spec_with_goto() {
        let spec = build_launch_spec(
            EditorPreference::VsCode,
            Path::new("/tmp/demo.ts"),
            Some(12),
            Some(4),
            None,
        );

        assert_eq!(spec.program, "code");
        assert_eq!(spec.args, vec!["--goto", "/tmp/demo.ts:12:4"]);
        assert!(!spec.use_system_open);
    }

    #[test]
    fn builds_cursor_launch_spec() {
        let spec = build_launch_spec(
            EditorPreference::Cursor,
            Path::new("/tmp/demo.ts"),
            Some(12),
            None,
            None,
        );

        assert_eq!(spec.program, "cursor");
        assert_eq!(spec.args, vec!["--goto", "/tmp/demo.ts:12"]);
    }

    #[test]
    fn builds_system_launch_spec() {
        let spec = build_launch_spec(
            EditorPreference::System,
            Path::new("/tmp/demo.ts"),
            None,
            None,
            None,
        );

        assert!(spec.use_system_open);
        assert_eq!(spec.program, "/tmp/demo.ts");
        assert!(spec.args.is_empty());
    }

    #[test]
    fn reads_preference_from_settings_json() {
        let settings = serde_json::json!({ "editorPreference": "cursor" });
        assert_eq!(
            preference_from_settings(&settings),
            EditorPreference::Cursor
        );
    }

    #[test]
    fn builds_antigravity_spec_with_default_template() {
        let spec = build_launch_spec(
            EditorPreference::Antigravity,
            Path::new("/tmp/demo.ts"),
            Some(7),
            Some(2),
            Some(&serde_json::json!({})),
        );

        assert_eq!(spec.program, "antigravity");
        assert_eq!(spec.args, vec!["/tmp/demo.ts:7:2"]);
    }

    #[test]
    fn builds_custom_spec_from_templated_args() {
        let spec = build_launch_spec(
            EditorPreference::Custom,
            Path::new("/tmp/demo.ts"),
            Some(7),
            Some(2),
            Some(&serde_json::json!({
                "editorCommand": "zed",
                "editorArgs": ["{path}", "--line", "{line}", "--column", "{column}"]
            })),
        );

        assert_eq!(spec.program, "zed");
        assert_eq!(
            spec.args,
            vec!["/tmp/demo.ts", "--line", "7", "--column", "2"]
        );
    }

    #[test]
    fn resolves_unique_workspace_filename_reference() {
        let root = temp_editor_root("unique");
        let plan_dir = root.join("plans").join("codespace");
        std::fs::create_dir_all(&plan_dir).expect("creates plan directory");
        std::fs::write(plan_dir.join("cli-tools-workspace-tools-plan.md"), "# Plan")
            .expect("writes plan file");

        let resolved = resolve_path(
            root.to_string_lossy().as_ref(),
            "cli-tools-workspace-tools-plan.md",
        )
        .expect("resolves unique filename");

        assert_eq!(resolved, plan_dir.join("cli-tools-workspace-tools-plan.md"));
        std::fs::remove_dir_all(root).expect("cleans temp root");
    }

    #[test]
    fn rejects_ambiguous_workspace_filename_reference() {
        let root = temp_editor_root("ambiguous");
        std::fs::create_dir_all(root.join("plans")).expect("creates plans directory");
        std::fs::create_dir_all(root.join("docs")).expect("creates docs directory");
        std::fs::write(root.join("plans").join("notes.md"), "# Plan").expect("writes first file");
        std::fs::write(root.join("docs").join("notes.md"), "# Docs").expect("writes second file");

        let error = resolve_path(root.to_string_lossy().as_ref(), "notes.md")
            .expect_err("ambiguous filename should not resolve");

        assert!(error.to_string().contains("Path does not exist"));
        std::fs::remove_dir_all(root).expect("cleans temp root");
    }
}
