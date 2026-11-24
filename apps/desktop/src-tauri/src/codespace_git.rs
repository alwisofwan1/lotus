use crate::no_window::NoWindow;
use crate::shell_env::user_login_env;
use crate::AppError;
use serde::Serialize;
use std::env;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodespaceGitChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    Untracked,
    Unmerged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespaceGitFileStatus {
    pub path: String,
    pub relative_path: String,
    pub staged: Option<CodespaceGitChangeKind>,
    pub unstaged: Option<CodespaceGitChangeKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespaceGitFileDiffContent {
    pub original: String,
    pub modified: String,
    pub original_path: String,
    pub modified_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespaceGitRepoSummary {
    pub branch: String,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

/// Combined status + summary result for the single-round-trip panel refresh.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespaceGitPanelRefresh {
    pub summary: CodespaceGitRepoSummary,
    pub files: Vec<CodespaceGitFileStatus>,
}

pub fn codespace_git_panel_refresh(
    repo_root: String,
) -> Result<CodespaceGitPanelRefresh, AppError> {
    let summary = codespace_git_repo_summary(repo_root.clone())?;
    let files = codespace_git_status(repo_root)?;
    Ok(CodespaceGitPanelRefresh { summary, files })
}

/// Discover git repositories within a workspace root.
/// Returns the root itself (if it's a repo) plus any immediate subdirectories
/// that are separate git repos (not just subdirectories of the parent repo).
pub fn codespace_git_discover_repos(workspace_root: String) -> Vec<String> {
    let root = Path::new(&workspace_root);
    if !root.is_dir() {
        return vec![];
    }

    let mut repos: Vec<String> = Vec::new();

    // Check if the root itself is a git repo
    let root_is_repo = root.join(".git").exists();
    if root_is_repo {
        repos.push(workspace_root.clone());
    }

    // Scan immediate subdirectories for separate git repos
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip hidden dirs (except we already checked .git above), node_modules, etc.
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            if path.join(".git").exists() {
                // This subdirectory has its own .git — it's a separate repo
                // (submodule or nested repo), not just a subfolder of the parent
                repos.push(path.to_string_lossy().to_string());
            }
        }
    }

    repos
}

pub fn codespace_git_status(repo_root: String) -> Result<Vec<CodespaceGitFileStatus>, AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let mut command = git_command();
    command
        .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .current_dir(&repo_root);
    let output = checked_output(command, "git status")?;
    Ok(parse_porcelain_status(
        &repo_root,
        &String::from_utf8_lossy(&output.stdout),
    ))
}

pub fn codespace_git_repo_summary(repo_root: String) -> Result<CodespaceGitRepoSummary, AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let branch = git_output_lossy(&repo_root, ["branch", "--show-current"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let head = git_output_lossy(&repo_root, ["rev-parse", "--short", "HEAD"])
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let upstream = git_output_lossy(
        &repo_root,
        [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());
    let (ahead, behind) = if upstream.is_some() {
        parse_ahead_behind(
            &git_output_lossy(
                &repo_root,
                ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )
            .unwrap_or_default(),
        )
    } else {
        (0, 0)
    };

    Ok(CodespaceGitRepoSummary {
        branch: if branch.is_empty() {
            head.clone()
                .map(|short| format!("detached:{short}"))
                .unwrap_or_else(|| "unknown".to_string())
        } else {
            branch
        },
        head,
        upstream,
        ahead,
        behind,
    })
}

pub fn codespace_git_stage_file(repo_root: String, file_path: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let relative_path = resolve_repo_relative_path(&repo_root, &file_path)?;

    let mut command = git_command();
    command
        .arg("add")
        .arg("--")
        .arg(relative_path)
        .current_dir(repo_root);
    checked_output(command, "git add")?;
    Ok(())
}

pub fn codespace_git_stage_all(repo_root: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let mut command = git_command();
    command.args(["add", "--all"]).current_dir(repo_root);
    checked_output(command, "git add --all")?;
    Ok(())
}

pub fn codespace_git_unstage_file(repo_root: String, file_path: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let relative_path = resolve_repo_relative_path(&repo_root, &file_path)?;

    let mut command = git_command();
    command
        .args(["restore", "--staged", "--"])
        .arg(relative_path)
        .current_dir(repo_root);
    checked_output(command, "git restore --staged")?;
    Ok(())
}

pub fn codespace_git_unstage_all(repo_root: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let mut command = git_command();
    command
        .args(["restore", "--staged", "--", "."])
        .current_dir(repo_root);
    checked_output(command, "git restore --staged")?;
    Ok(())
}

pub fn codespace_git_discard_all_changes(repo_root: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;

    let mut restore = git_command();
    restore
        .args(["restore", "--worktree", "--", "."])
        .current_dir(&repo_root);
    checked_output(restore, "git restore --worktree")?;

    let mut clean = git_command();
    clean
        .args(["clean", "-fd", "--", "."])
        .current_dir(repo_root);
    checked_output(clean, "git clean")?;
    Ok(())
}

/// Throws away one file's working-tree changes; what is staged stays. A file git does not track
/// is deleted, as that is its only change.
pub fn codespace_git_discard_file(repo_root: String, file_path: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let relative_path = resolve_repo_relative_path(&repo_root, &file_path)?;

    let tracked = git_command()
        .args(["ls-files", "--error-unmatch", "--"])
        .arg(&relative_path)
        .current_dir(&repo_root)
        .output()
        .map_err(|err| AppError::Other(format!("git ls-files failed: {err}")))?
        .status
        .success();

    let mut command = git_command();
    if tracked {
        command.args(["restore", "--worktree", "--"]);
    } else {
        command.args(["clean", "-f", "--"]);
    }
    command.arg(relative_path).current_dir(repo_root);
    checked_output(
        command,
        if tracked {
            "git restore --worktree"
        } else {
            "git clean"
        },
    )?;
    Ok(())
}

pub fn codespace_git_commit(repo_root: String, message: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let message = message.trim();
    if message.is_empty() {
        return Err(AppError::Other("Commit message is required".to_string()));
    }

    let mut command = git_command();
    command
        .arg("commit")
        .arg("-m")
        .arg(message)
        .current_dir(repo_root);
    checked_output(command, "git commit")?;
    Ok(())
}

/// Hard cap on staged-diff bytes we forward to the Claude CLI. Roughly
/// 6K tokens of code/diff. Beyond this we send only the `--stat` summary
/// plus a head-of-file slice to keep cost predictable.
const MAX_DIFF_CHARS_FOR_AI: usize = 21_000;

const COMMIT_SUGGEST_SYSTEM_PROMPT: &str = "You are a Git commit message writer. Given a staged diff, output exactly ONE Conventional Commit message and nothing else.\n\nRules:\n- Format: <type>[optional scope]: <description>\n- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert\n- Header at most 72 characters, imperative mood, no trailing period, lowercase first word after the colon\n- Optionally add a body: blank line after the header, then 1-3 short lines explaining WHY (not WHAT), wrapped at 72 chars\n- Do NOT wrap the answer in code fences, do not prefix with explanations, do not include any text outside the commit message itself";

pub fn codespace_git_ai_suggest_commit(repo_root: String) -> Result<String, AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let stat = git_output_lossy(&repo_root, ["diff", "--staged", "--stat", "--no-color"])
        .unwrap_or_default();
    let raw_diff =
        git_output_lossy(&repo_root, ["diff", "--staged", "--no-color"]).unwrap_or_default();
    let prompt = build_commit_suggest_prompt(&stat, &raw_diff)?;
    run_commit_suggest(&prompt, &repo_root)
}

/// The prompt for the staged change set, or an error when nothing is staged. Shared with SSH,
/// where the stat and diff come from the remote host.
pub(crate) fn build_commit_suggest_prompt(stat: &str, raw_diff: &str) -> Result<String, AppError> {
    let stat = stat.trim();
    if stat.is_empty() {
        return Err(AppError::Other(
            "No staged changes — stage files before requesting an AI suggestion.".to_string(),
        ));
    }

    let (diff_payload, truncated) = if raw_diff.len() > MAX_DIFF_CHARS_FOR_AI {
        let mut end = MAX_DIFF_CHARS_FOR_AI;
        while !raw_diff.is_char_boundary(end) {
            end -= 1;
        }
        let mut slice = raw_diff[..end].to_string();
        // Cut at the last newline so we don't dangle inside a hunk header.
        if let Some(last_newline) = slice.rfind('\n') {
            slice.truncate(last_newline);
        }
        (slice, true)
    } else {
        (raw_diff.to_string(), false)
    };

    let truncation_note = if truncated {
        "\n\n[diff truncated for length — header should reflect the full change set in the stat above]"
    } else {
        ""
    };
    Ok(format!(
        "Staged stat:\n{stat}\n\nStaged diff:\n{diff_payload}{truncation_note}"
    ))
}

/// Runs the local Claude CLI on `prompt`. `cwd` is where it runs: the repo for a local
/// workspace, a temp folder for SSH (the repo is not on this machine).
pub(crate) fn run_commit_suggest(prompt: &str, cwd: &Path) -> Result<String, AppError> {
    let mut command = Command::new("claude").no_window();
    command
        .arg("--print")
        .arg("--output-format")
        .arg("text")
        .arg("--model")
        .arg("haiku")
        .arg("--append-system-prompt")
        .arg(COMMIT_SUGGEST_SYSTEM_PROMPT)
        .current_dir(cwd)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // After `env_clear`, and via the helper rather than `.envs()`: an empty captured value means
    // "unset in the child". `.envs()` cannot express that, and a blank `CLAUDE_CONFIG_DIR` makes
    // `claude` write its config home into `current_dir` — here, the operator's repo root.
    crate::shell_env::apply_login_env_pairs(&mut command, user_login_env());

    let mut child = command.spawn().map_err(|err| {
        AppError::Other(format!(
            "Failed to spawn `claude`: {err}. Make sure the Claude CLI is installed and on PATH."
        ))
    })?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .map_err(|err| AppError::Other(format!("Failed to write prompt to claude: {err}")))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|err| AppError::Other(format!("Failed to read claude output: {err}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("claude exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(AppError::Other(format!("AI suggest failed: {detail}")));
    }

    let suggestion = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if suggestion.is_empty() {
        return Err(AppError::Other(
            "Claude returned an empty suggestion".to_string(),
        ));
    }
    Ok(suggestion)
}

pub fn codespace_git_push(repo_root: String) -> Result<(), AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;

    // If the current branch has no upstream yet, push with -u to the default
    // remote so the next push works without manual `git push -u origin …`.
    let upstream = git_output_lossy(
        &repo_root,
        [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    )
    .ok()
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty());

    let mut command = git_command();
    command.current_dir(&repo_root).arg("push");
    if upstream.is_none() {
        let branch = git_output_lossy(&repo_root, ["branch", "--show-current"])
            .unwrap_or_default()
            .trim()
            .to_string();
        if branch.is_empty() {
            return Err(AppError::Other(
                "Cannot push from a detached HEAD".to_string(),
            ));
        }
        command.arg("--set-upstream").arg("origin").arg(branch);
    }
    checked_output(command, "git push")?;
    Ok(())
}

pub fn codespace_git_diff_file(
    repo_root: String,
    file_path: String,
    target: String,
) -> Result<String, AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let relative_path = resolve_repo_relative_path(&repo_root, &file_path)?;
    let relative_path_string = git_relative_path(&relative_path);
    let target = parse_diff_target(&target)?;

    let statuses = codespace_git_status(repo_root.to_string_lossy().to_string())?;
    let current_status = statuses
        .iter()
        .find(|status| status.relative_path == relative_path_string);

    if target == "unstaged" && is_untracked(current_status) {
        let content = std::fs::read_to_string(repo_root.join(&relative_path))
            .map_err(|err| AppError::Other(format!("Unable to read untracked file: {err}")))?;
        return Ok(untracked_file_diff(&relative_path_string, &content));
    }

    let mut command = git_command();
    command.arg("diff");
    if target == "staged" {
        command.arg("--cached");
    }
    command.arg("--").arg(relative_path).current_dir(repo_root);
    let output = checked_output(command, "git diff")?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn codespace_git_diff_file_content(
    repo_root: String,
    file_path: String,
    target: String,
) -> Result<CodespaceGitFileDiffContent, AppError> {
    let repo_root = resolve_repo_root(&repo_root)?;
    let relative_path = resolve_repo_relative_path(&repo_root, &file_path)?;
    let relative_path_string = git_relative_path(&relative_path);
    let target = parse_diff_target(&target)?;

    let statuses = codespace_git_status(repo_root.to_string_lossy().to_string())?;
    let current_status = statuses
        .iter()
        .find(|status| status.relative_path == relative_path_string);

    diff_file_content_from(
        &LocalGitFiles {
            repo_root: &repo_root,
        },
        &relative_path_string,
        current_status,
        target,
    )
}

/// Where a diff's two texts are read from: this machine, or a repo over SSH.
pub(crate) trait GitFileSource {
    /// `git show <spec>`; `None` when there is no such object (a file new in the index).
    fn object(&self, spec: &str) -> Result<Option<String>, AppError>;
    /// The working-tree file; empty when it is gone.
    fn worktree_file(&self, relative_path: &str) -> Result<String, AppError>;
}

struct LocalGitFiles<'a> {
    repo_root: &'a Path,
}

impl GitFileSource for LocalGitFiles<'_> {
    fn object(&self, spec: &str) -> Result<Option<String>, AppError> {
        read_git_object(self.repo_root, spec)
    }

    fn worktree_file(&self, relative_path: &str) -> Result<String, AppError> {
        read_worktree_file(&self.repo_root.join(relative_path))
    }
}

pub(crate) fn parse_diff_target(target: &str) -> Result<&'static str, AppError> {
    match target.trim() {
        "staged" => Ok("staged"),
        "unstaged" => Ok("unstaged"),
        _ => Err(AppError::Other(
            "Diff target must be staged or unstaged".to_string(),
        )),
    }
}

pub(crate) fn is_untracked(status: Option<&CodespaceGitFileStatus>) -> bool {
    status.and_then(|status| status.unstaged) == Some(CodespaceGitChangeKind::Untracked)
}

/// Staged: HEAD against the index. Unstaged: the index (else HEAD) against the working tree.
pub(crate) fn diff_file_content_from(
    source: &dyn GitFileSource,
    relative_path: &str,
    status: Option<&CodespaceGitFileStatus>,
    target: &str,
) -> Result<CodespaceGitFileDiffContent, AppError> {
    let (original, modified) = if target == "staged" {
        let staged = status.and_then(|status| status.staged);
        let original = if staged == Some(CodespaceGitChangeKind::Added) {
            String::new()
        } else {
            source
                .object(&format!("HEAD:{relative_path}"))?
                .unwrap_or_default()
        };
        let modified = if staged == Some(CodespaceGitChangeKind::Deleted) {
            String::new()
        } else {
            source
                .object(&format!(":{relative_path}"))?
                .unwrap_or_default()
        };
        (original, modified)
    } else {
        let unstaged = status.and_then(|status| status.unstaged);
        let original = if unstaged == Some(CodespaceGitChangeKind::Untracked) {
            String::new()
        } else {
            match source.object(&format!(":{relative_path}"))? {
                Some(text) => text,
                None => source
                    .object(&format!("HEAD:{relative_path}"))?
                    .unwrap_or_default(),
            }
        };
        let modified = if unstaged == Some(CodespaceGitChangeKind::Deleted) {
            String::new()
        } else {
            source.worktree_file(relative_path)?
        };
        (original, modified)
    };

    Ok(CodespaceGitFileDiffContent {
        original,
        modified,
        original_path: format!("original://{relative_path}"),
        modified_path: format!("modified://{relative_path}"),
    })
}

pub(crate) fn resolve_repo_root(repo_root: &str) -> Result<PathBuf, AppError> {
    let repo_root = Path::new(repo_root)
        .canonicalize()
        .map_err(|err| AppError::Other(format!("Unable to resolve repository root: {err}")))?;
    if !repo_root.is_dir() {
        return Err(AppError::Other(
            "Repository root is not a directory".to_string(),
        ));
    }

    let output = git_command()
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&repo_root)
        .output()
        .map_err(|err| AppError::Other(format!("git rev-parse failed: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Other(if stderr.is_empty() {
            "Not a Git repository".to_string()
        } else {
            stderr
        }));
    }

    let top_level = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if top_level.is_empty() {
        return Err(AppError::Other("Git repository root is empty".to_string()));
    }
    Path::new(&top_level)
        .canonicalize()
        .map_err(|err| AppError::Other(format!("Unable to resolve Git repository root: {err}")))
}

pub(crate) fn git_command() -> Command {
    Command::new(resolve_git_executable()).no_window()
}

fn resolve_git_executable() -> PathBuf {
    let executable = if cfg!(windows) { "git.exe" } else { "git" };
    if let Some(path) = env::var_os("PATH") {
        for dir in env::split_paths(&path) {
            let candidate = dir.join(executable);
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    for fallback in [
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/git",
        "/bin/git",
    ] {
        let candidate = PathBuf::from(fallback);
        if candidate.is_file() {
            return candidate;
        }
    }

    PathBuf::from(executable)
}

pub(crate) fn resolve_repo_relative_path(repo_root: &Path, file_path: &str) -> Result<PathBuf, AppError> {
    let input = Path::new(file_path);
    if !input.is_absolute() {
        return Err(AppError::Other("File path must be absolute".to_string()));
    }

    let normalized = if input.exists() {
        input
            .canonicalize()
            .map_err(|err| AppError::Other(format!("Unable to resolve file path: {err}")))?
    } else {
        normalize_path(input)
    };

    if !normalized.starts_with(repo_root) {
        return Err(AppError::Other(
            "File path is outside the repository root".to_string(),
        ));
    }

    normalized
        .strip_prefix(repo_root)
        .map(Path::to_path_buf)
        .map_err(|_| AppError::Other("Unable to resolve repository-relative path".to_string()))
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                output.pop();
            }
            other => output.push(other.as_os_str()),
        }
    }
    output
}

pub(crate) fn git_relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub(crate) fn checked_output(mut command: Command, label: &str) -> Result<Output, AppError> {
    let output = command
        .output()
        .map_err(|err| AppError::Other(format!("{label} failed: {err}")))?;
    if output.status.success() {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Other(if stderr.is_empty() {
        format!("{label} failed with status {}.", output.status)
    } else {
        stderr
    }))
}

fn git_output_lossy<const N: usize>(repo_root: &Path, args: [&str; N]) -> Result<String, AppError> {
    let mut command = git_command();
    command.args(args).current_dir(repo_root);
    let output = checked_output(command, "git")?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// ── Canvas worktree API ───────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct WorktreeEntry {
    pub path: String,
    pub branch: Option<String>, // None when HEAD is detached
    pub is_main: bool,
}

/// List all git worktrees for the repository that contains `repo_path`.
/// Returns the main worktree first, then linked worktrees in the order
/// `git worktree list --porcelain` produces them.
pub fn list_git_worktrees(repo_path: String) -> Result<Vec<WorktreeEntry>, AppError> {
    let repo = resolve_repo_root(&repo_path)?;
    let raw = git_output_lossy(&repo, ["worktree", "list", "--porcelain"])?;
    Ok(parse_worktree_porcelain(&raw))
}

/// Resolve the current branch of the repo containing `repo_path` — the base
/// branch new isolated-agent worktrees are cut from and merged back into
/// (ADR 0015). Errors on detached HEAD: isolation needs a named base.
pub fn resolve_repo_head_branch(repo_path: String) -> Result<String, AppError> {
    let repo = resolve_repo_root(&repo_path)?;
    let branch = git_output_lossy(&repo, ["branch", "--show-current"])?
        .trim()
        .to_string();
    if branch.is_empty() {
        return Err(AppError::Other(
            "repository is in detached HEAD state; cannot isolate agents without a base branch"
                .to_string(),
        ));
    }
    Ok(branch)
}

pub(crate) fn parse_worktree_porcelain(output: &str) -> Vec<WorktreeEntry> {
    let mut entries: Vec<WorktreeEntry> = Vec::new();
    // (path, branch) accumulated while reading a stanza
    let mut cur_path: Option<String> = None;
    let mut cur_branch: Option<String> = None;

    let flush = |entries: &mut Vec<WorktreeEntry>, path: Option<String>, branch: Option<String>| {
        if let Some(p) = path {
            let is_main = entries.is_empty();
            entries.push(WorktreeEntry {
                path: p,
                branch,
                is_main,
            });
        }
    };

    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut entries, cur_path.take(), cur_branch.take());
            cur_path = Some(path.to_string());
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            cur_branch = Some(branch.to_string());
        }
    }
    flush(&mut entries, cur_path, cur_branch);
    entries
}

/// Creates a linked worktree at `worktree_path` for `branch`.
/// If `branch` doesn't exist, creates it at HEAD via `-b`.
pub fn create_git_worktree(
    repo_path: String,
    branch: String,
    worktree_path: String,
) -> Result<WorktreeEntry, AppError> {
    let repo = resolve_repo_root(&repo_path)?;
    let first = git_command()
        .arg("worktree")
        .arg("add")
        .arg(&worktree_path)
        .arg(&branch)
        .current_dir(&repo)
        .output()
        .map_err(|e| AppError::Other(format!("git worktree add failed: {e}")))?;
    if !first.status.success() {
        let out = git_command()
            .arg("worktree")
            .arg("add")
            .arg("-b")
            .arg(&branch)
            .arg(&worktree_path)
            .current_dir(&repo)
            .output()
            .map_err(|e| AppError::Other(format!("git worktree add -b failed: {e}")))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(AppError::Other(if stderr.is_empty() {
                format!("git worktree add exited with {}", out.status)
            } else {
                stderr
            }));
        }
    }
    let raw = git_output_lossy(&repo, ["worktree", "list", "--porcelain"])?;
    parse_worktree_porcelain(&raw)
        .into_iter()
        .find(|e| e.branch.as_deref() == Some(branch.as_str()))
        .ok_or_else(|| AppError::Other(format!("worktree for '{branch}' not found after creation")))
}

/// Removes the linked worktree at `worktree_path`.
pub fn remove_git_worktree(repo_path: String, worktree_path: String) -> Result<(), AppError> {
    let repo = resolve_repo_root(&repo_path)?;
    let out = git_command()
        .arg("worktree")
        .arg("remove")
        .arg(&worktree_path)
        .current_dir(&repo)
        .output()
        .map_err(|e| AppError::Other(format!("git worktree remove failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(AppError::Other(if stderr.is_empty() {
            format!("git worktree remove exited with {}", out.status)
        } else {
            stderr
        }));
    }
    Ok(())
}

/// Returns the subset of `branches` that correspond to a live worktree.
pub fn validate_worktree_branches(
    repo_path: String,
    branches: Vec<String>,
) -> Result<Vec<String>, AppError> {
    use std::collections::HashSet;
    let entries = list_git_worktrees(repo_path)?;
    let live: HashSet<&str> = entries.iter().filter_map(|e| e.branch.as_deref()).collect();
    Ok(branches
        .into_iter()
        .filter(|b| live.contains(b.as_str()))
        .collect())
}

pub(crate) fn parse_ahead_behind(stdout: &str) -> (u32, u32) {
    let mut parts = stdout.split_whitespace();
    let ahead = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let behind = parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    (ahead, behind)
}

fn read_git_object(repo_root: &Path, spec: &str) -> Result<Option<String>, AppError> {
    let output = git_command()
        .arg("show")
        .arg(spec)
        .current_dir(repo_root)
        .output()
        .map_err(|err| AppError::Other(format!("git show failed: {err}")))?;

    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()))
}

fn read_worktree_file(path: &Path) -> Result<String, AppError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(err) => Err(AppError::Other(format!(
            "Unable to read working tree file: {err}"
        ))),
    }
}

/// Git prints nothing for a file it does not track; show it as all added.
pub(crate) fn untracked_file_diff(relative_path: &str, content: &str) -> String {
    let line_count = content.lines().count().max(1);
    let mut output = format!(
        "diff --git a/{relative_path} b/{relative_path}\nnew file mode 100644\n--- /dev/null\n+++ b/{relative_path}\n@@ -0,0 +1,{line_count} @@\n",
    );

    for line in content.lines() {
        output.push('+');
        output.push_str(line);
        output.push('\n');
    }
    if !content.ends_with('\n') {
        output.push_str("\\ No newline at end of file\n");
    }
    output
}

pub(crate) fn parse_porcelain_status(
    repo_root: &Path,
    stdout: &str,
) -> Vec<CodespaceGitFileStatus> {
    let mut output = Vec::new();
    let mut parts = stdout
        .split('\0')
        .filter(|part| !part.is_empty())
        .peekable();

    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }

        let mut chars = entry.chars();
        let index_status = chars.next().unwrap_or(' ');
        let worktree_status = chars.next().unwrap_or(' ');
        let _space = chars.next();
        let relative_path = chars.as_str().to_string();
        if relative_path.is_empty() {
            continue;
        }

        if matches!(index_status, 'R' | 'C') {
            let _old_path = parts.next();
        }

        let staged = staged_kind(index_status);
        let unstaged = if index_status == '?' && worktree_status == '?' {
            Some(CodespaceGitChangeKind::Untracked)
        } else {
            unstaged_kind(worktree_status)
        };

        output.push(CodespaceGitFileStatus {
            path: repo_root.join(&relative_path).to_string_lossy().to_string(),
            relative_path,
            staged,
            unstaged,
        });
    }

    output
}

fn staged_kind(status: char) -> Option<CodespaceGitChangeKind> {
    match status {
        'A' => Some(CodespaceGitChangeKind::Added),
        'M' => Some(CodespaceGitChangeKind::Modified),
        'D' => Some(CodespaceGitChangeKind::Deleted),
        'R' => Some(CodespaceGitChangeKind::Renamed),
        'C' => Some(CodespaceGitChangeKind::Copied),
        'U' => Some(CodespaceGitChangeKind::Unmerged),
        '?' | ' ' => None,
        _ => None,
    }
}

fn unstaged_kind(status: char) -> Option<CodespaceGitChangeKind> {
    match status {
        'M' => Some(CodespaceGitChangeKind::Modified),
        'D' => Some(CodespaceGitChangeKind::Deleted),
        'U' => Some(CodespaceGitChangeKind::Unmerged),
        '?' => Some(CodespaceGitChangeKind::Untracked),
        ' ' => None,
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo_with_commit(tag: &str, branch: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("lotus-git-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        git_command()
            .args(["init"])
            .current_dir(&root)
            .output()
            .expect("git init");
        std::fs::write(root.join("README.md"), "x\n").expect("write initial file");
        git_command()
            .args(["add", "."])
            .current_dir(&root)
            .output()
            .expect("git add");
        git_command()
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "init",
            ])
            .current_dir(&root)
            .output()
            .expect("git commit");
        git_command()
            .args(["checkout", "-B", branch])
            .current_dir(&root)
            .output()
            .expect("git checkout -B");
        root
    }

    #[test]
    fn resolve_repo_head_branch_returns_current_branch() {
        let root = init_repo_with_commit("headbranch", "trunk");
        let branch = resolve_repo_head_branch(root.to_string_lossy().to_string())
            .expect("resolve head branch");
        assert_eq!(branch, "trunk");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_repo_head_branch_errors_on_detached_head() {
        let root = init_repo_with_commit("nohead", "trunk");
        let sha = git_command()
            .args(["rev-parse", "HEAD"])
            .current_dir(&root)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .expect("rev-parse");
        git_command()
            .args(["checkout", &sha])
            .current_dir(&root)
            .output()
            .expect("detach");
        let err = resolve_repo_head_branch(root.to_string_lossy().to_string())
            .expect_err("detached HEAD should error");
        assert!(format!("{err:?}").to_lowercase().contains("detached"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_porcelain_status_maps_staged_unstaged_and_untracked() {
        let root = Path::new("/repo");
        let statuses =
            parse_porcelain_status(root, " M src/a.ts\0M  src/b.ts\0MM src/c.ts\0?? src/d.ts\0");

        assert_eq!(statuses.len(), 4);
        assert_eq!(statuses[0].relative_path, "src/a.ts");
        assert_eq!(statuses[0].staged, None);
        assert_eq!(statuses[0].unstaged, Some(CodespaceGitChangeKind::Modified));
        assert_eq!(statuses[1].staged, Some(CodespaceGitChangeKind::Modified));
        assert_eq!(statuses[1].unstaged, None);
        assert_eq!(statuses[2].staged, Some(CodespaceGitChangeKind::Modified));
        assert_eq!(statuses[2].unstaged, Some(CodespaceGitChangeKind::Modified));
        assert_eq!(statuses[3].staged, None);
        assert_eq!(
            statuses[3].unstaged,
            Some(CodespaceGitChangeKind::Untracked)
        );
    }

    #[test]
    fn parse_porcelain_status_skips_rename_old_path_payload() {
        let root = Path::new("/repo");
        let statuses = parse_porcelain_status(root, "R  src/new.ts\0src/old.ts\0");

        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].relative_path, "src/new.ts");
        assert_eq!(statuses[0].staged, Some(CodespaceGitChangeKind::Renamed));
    }

    #[test]
    fn normalize_path_removes_parent_segments() {
        let normalized = normalize_path(Path::new("/repo/src/../README.md"));

        assert_eq!(normalized, PathBuf::from("/repo/README.md"));
    }

    #[test]
    fn parse_ahead_behind_handles_rev_list_counts() {
        assert_eq!(parse_ahead_behind("2\t3\n"), (2, 3));
        assert_eq!(parse_ahead_behind(""), (0, 0));
    }

    #[test]
    fn codespace_git_commit_rejects_blank_message() {
        let root =
            std::env::temp_dir().join(format!("lotus-git-commit-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        git_command()
            .args(["init"])
            .current_dir(&root)
            .output()
            .expect("git init");

        let error = codespace_git_commit(root.to_string_lossy().to_string(), "   ".to_string())
            .expect_err("blank commit message should fail");

        assert!(format!("{error:?}").contains("Commit message is required"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codespace_git_discard_all_changes_restores_tracked_and_removes_untracked() {
        let root =
            std::env::temp_dir().join(format!("lotus-git-discard-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        git_command()
            .args(["init"])
            .current_dir(&root)
            .output()
            .expect("git init");
        std::fs::write(root.join("README.md"), "before\n").expect("write initial file");
        git_command()
            .args(["add", "README.md"])
            .current_dir(&root)
            .output()
            .expect("git add");
        std::fs::write(root.join("README.md"), "after\n").expect("modify tracked file");
        std::fs::write(root.join("scratch.txt"), "temp\n").expect("write untracked file");

        codespace_git_discard_all_changes(root.to_string_lossy().to_string())
            .expect("discard changes");

        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).expect("read tracked file"),
            "before\n",
        );
        assert!(!root.join("scratch.txt").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn untracked_file_diff_formats_added_lines() {
        let diff = untracked_file_diff("src/new.ts", "one\ntwo");

        assert!(diff.contains("new file mode 100644"));
        assert!(diff.contains("+++ b/src/new.ts"));
        assert!(diff.contains("+one\n+two\n"));
        assert!(diff.ends_with("\\ No newline at end of file\n"));
    }

    struct FakeFiles;

    impl GitFileSource for FakeFiles {
        fn object(&self, spec: &str) -> Result<Option<String>, AppError> {
            Ok(match spec {
                "HEAD:a.ts" => Some("head".to_string()),
                ":a.ts" => Some("index".to_string()),
                _ => None,
            })
        }

        fn worktree_file(&self, _relative_path: &str) -> Result<String, AppError> {
            Ok("worktree".to_string())
        }
    }

    fn status(
        staged: Option<CodespaceGitChangeKind>,
        unstaged: Option<CodespaceGitChangeKind>,
    ) -> CodespaceGitFileStatus {
        CodespaceGitFileStatus {
            path: "/r/a.ts".to_string(),
            relative_path: "a.ts".to_string(),
            staged,
            unstaged,
        }
    }

    #[test]
    fn diff_file_content_from_reads_the_right_sides() {
        let modified = status(
            Some(CodespaceGitChangeKind::Modified),
            Some(CodespaceGitChangeKind::Modified),
        );
        let staged = diff_file_content_from(&FakeFiles, "a.ts", Some(&modified), "staged").unwrap();
        assert_eq!(
            (staged.original.as_str(), staged.modified.as_str()),
            ("head", "index")
        );
        let unstaged =
            diff_file_content_from(&FakeFiles, "a.ts", Some(&modified), "unstaged").unwrap();
        assert_eq!(
            (unstaged.original.as_str(), unstaged.modified.as_str()),
            ("index", "worktree")
        );

        let untracked = status(None, Some(CodespaceGitChangeKind::Untracked));
        let new_file =
            diff_file_content_from(&FakeFiles, "a.ts", Some(&untracked), "unstaged").unwrap();
        assert_eq!(
            (new_file.original.as_str(), new_file.modified.as_str()),
            ("", "worktree")
        );
    }

    #[test]
    fn build_commit_suggest_prompt_refuses_an_empty_stage_and_cuts_on_a_char_boundary() {
        assert!(build_commit_suggest_prompt("  \n", "").is_err());
        let long = format!("{}\n", "é".repeat(MAX_DIFF_CHARS_FOR_AI));
        let prompt = build_commit_suggest_prompt(" 1 file changed", &long).unwrap();
        assert!(prompt.starts_with("Staged stat:\n1 file changed"));
        assert!(prompt.contains("[diff truncated for length"));
    }

    #[test]
    fn codespace_git_discard_file_reverts_one_tracked_file_and_keeps_the_rest() {
        let root = init_repo_with_commit("discard-one", "trunk");
        std::fs::write(root.join("other.md"), "o\n").unwrap();
        git_command()
            .args(["add", "other.md"])
            .current_dir(&root)
            .output()
            .unwrap();
        git_command()
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-m",
                "two",
            ])
            .current_dir(&root)
            .output()
            .unwrap();
        std::fs::write(root.join("README.md"), "changed\n").unwrap();
        std::fs::write(root.join("other.md"), "changed too\n").unwrap();
        let repo = root.to_string_lossy().to_string();

        codespace_git_discard_file(repo, root.join("README.md").to_string_lossy().to_string())
            .expect("discard one file");

        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "x\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("other.md")).unwrap(),
            "changed too\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codespace_git_discard_file_deletes_an_untracked_file() {
        let root = init_repo_with_commit("discard-new", "trunk");
        std::fs::write(root.join("new.md"), "n\n").unwrap();
        let repo = root.to_string_lossy().to_string();

        codespace_git_discard_file(repo, root.join("new.md").to_string_lossy().to_string())
            .expect("discard untracked file");

        assert!(!root.join("new.md").exists());
        assert!(root.join("README.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codespace_git_diff_file_returns_unstaged_diff_from_git() {
        let root = std::env::temp_dir().join(format!("lotus-git-diff-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        git_command()
            .args(["init"])
            .current_dir(&root)
            .output()
            .expect("git init");
        std::fs::write(root.join("README.md"), "before\n").expect("write initial file");
        git_command()
            .args(["add", "README.md"])
            .current_dir(&root)
            .output()
            .expect("git add");
        std::fs::write(root.join("README.md"), "after\n").expect("modify file");

        let diff = codespace_git_diff_file(
            root.to_string_lossy().to_string(),
            root.join("README.md").to_string_lossy().to_string(),
            "unstaged".to_string(),
        )
        .expect("read unstaged diff");

        assert!(diff.contains("--- a/README.md"));
        assert!(diff.contains("+++ b/README.md"));
        assert!(diff.contains("-before"));
        assert!(diff.contains("+after"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codespace_git_diff_file_content_returns_original_and_modified() {
        let root = std::env::temp_dir().join(format!(
            "lotus-git-content-diff-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp repo dir");
        git_command()
            .args(["init"])
            .current_dir(&root)
            .output()
            .expect("git init");
        std::fs::write(root.join("README.md"), "before\n").expect("write initial file");
        git_command()
            .args(["add", "README.md"])
            .current_dir(&root)
            .output()
            .expect("git add");
        std::fs::write(root.join("README.md"), "after\n").expect("modify file");

        let diff = codespace_git_diff_file_content(
            root.to_string_lossy().to_string(),
            root.join("README.md").to_string_lossy().to_string(),
            "unstaged".to_string(),
        )
        .expect("read content diff");

        assert_eq!(diff.original, "before\n");
        assert_eq!(diff.modified, "after\n");
        assert_eq!(diff.original_path, "original://README.md");
        assert_eq!(diff.modified_path, "modified://README.md");

        let _ = std::fs::remove_dir_all(&root);
    }
}
