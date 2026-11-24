//! SSH-backed git operations.
//!
//! Mirrors the local `codespace_git` API surface but executes against a remote
//! host via the system `ssh` binary. Pure script builders and parsers live in
//! [`script`]; the side-effectful top-level functions are added as siblings to
//! the existing local commands.
//!
//! ### Reusing parsers
//!
//! `parse_porcelain_status` and `parse_ahead_behind` from
//! [`crate::codespace_git`] handle git output identically regardless of where
//! the bytes originated. We re-use them rather than duplicating, so any future
//! parsing fix benefits both code paths.

mod script;

pub(crate) use script::{
    build_git_commit_script, build_git_diff_file_script, build_git_discard_all_script,
    build_git_discard_file_script, build_git_panel_refresh_script, build_git_push_script,
    build_git_repo_summary_script, build_git_show_object_script, build_git_stage_all_script,
    build_git_stage_file_script, build_git_staged_diff_script, build_git_staged_stat_script,
    build_git_status_script, build_git_uncommitted_diff_script, build_git_unstage_all_script,
    build_git_unstage_file_script, build_head_branch_script, build_read_worktree_file_script,
    build_worktree_add_script, build_worktree_list_script, build_worktree_remove_script,
    parse_git_panel_refresh_output, parse_presence_output, parse_remote_repo_summary_output,
    repo_relative_path,
};

use std::path::Path;

use crate::cli_tools::{run_ssh_shell_command, validate_remote_cwd, SshCommandMode, SshToolTarget};
use crate::codespace_git::{
    build_commit_suggest_prompt, diff_file_content_from, is_untracked, parse_diff_target,
    parse_porcelain_status, parse_worktree_porcelain, run_commit_suggest, untracked_file_diff,
    CodespaceGitFileDiffContent, CodespaceGitFileStatus, CodespaceGitPanelRefresh,
    CodespaceGitRepoSummary, GitFileSource, WorktreeEntry,
};
use crate::error::AppError;
use crate::remote_error::map_remote_error_typed;
use crate::remote_transport::RemoteTransport;

fn run_remote_git(
    target: &SshToolTarget,
    script: &str,
    transport: Option<&RemoteTransport>,
) -> Result<std::process::Output, AppError> {
    let output = run_ssh_shell_command(target, script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, 0).into());
    }
    Ok(output)
}

pub fn codespace_git_status_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<Vec<CodespaceGitFileStatus>, AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_status_script(cwd);
    let output = run_remote_git(&target, &script, transport)?;
    Ok(parse_porcelain_status(
        Path::new(cwd),
        &String::from_utf8_lossy(&output.stdout),
    ))
}

pub fn codespace_git_repo_summary_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<CodespaceGitRepoSummary, AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_repo_summary_script(cwd);
    let output = run_remote_git(&target, &script, transport)?;
    parse_remote_repo_summary_output(&String::from_utf8_lossy(&output.stdout))
}

pub fn codespace_git_stage_file_ssh(
    target: SshToolTarget,
    repo_root: String,
    file_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let rel = repo_relative_path(cwd, &file_path)?;
    let script = build_git_stage_file_script(cwd, &rel);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

pub fn codespace_git_stage_all_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_stage_all_script(cwd);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

pub fn codespace_git_unstage_file_ssh(
    target: SshToolTarget,
    repo_root: String,
    file_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let rel = repo_relative_path(cwd, &file_path)?;
    let script = build_git_unstage_file_script(cwd, &rel);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

pub fn codespace_git_unstage_all_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_unstage_all_script(cwd);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

pub fn codespace_git_discard_all_changes_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_discard_all_script(cwd);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

/// SSH twin of [`crate::codespace_git::codespace_git_discard_file`].
pub fn codespace_git_discard_file_ssh(
    target: SshToolTarget,
    repo_root: String,
    file_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let rel = repo_relative_path(cwd, &file_path)?;
    run_remote_git(
        &target,
        &build_git_discard_file_script(cwd, &rel),
        transport,
    )?;
    Ok(())
}

pub fn codespace_git_commit_ssh(
    target: SshToolTarget,
    repo_root: String,
    message: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::Other("Commit message is required".to_string()));
    }
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_commit_script(cwd, trimmed);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

pub fn codespace_git_panel_refresh_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<CodespaceGitPanelRefresh, AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_panel_refresh_script(cwd);
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, 0).into());
    }
    parse_git_panel_refresh_output(cwd, &output.stdout)
}

pub fn codespace_git_push_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_push_script(cwd);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

// ── One file's diff, and the AI commit message ───────────────────────────────

fn remote_file_status(
    target: &SshToolTarget,
    cwd: &str,
    relative_path: &str,
    transport: Option<&RemoteTransport>,
) -> Result<Option<CodespaceGitFileStatus>, AppError> {
    let output = run_remote_git(target, &build_git_status_script(cwd), transport)?;
    Ok(
        parse_porcelain_status(Path::new(cwd), &String::from_utf8_lossy(&output.stdout))
            .into_iter()
            .find(|status| status.relative_path == relative_path),
    )
}

/// SSH twin of [`crate::codespace_git::codespace_git_diff_file`].
pub fn codespace_git_diff_file_ssh(
    target: SshToolTarget,
    repo_root: String,
    file_path: String,
    diff_target: String,
    transport: Option<&RemoteTransport>,
) -> Result<String, AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let rel = repo_relative_path(cwd, &file_path)?;
    let diff_target = parse_diff_target(&diff_target)?;
    let status = remote_file_status(&target, cwd, &rel, transport)?;

    if diff_target == "unstaged" && is_untracked(status.as_ref()) {
        let files = SshGitFiles {
            target: &target,
            cwd,
            transport,
        };
        return Ok(untracked_file_diff(&rel, &files.worktree_file(&rel)?));
    }
    let script = build_git_diff_file_script(cwd, &rel, diff_target == "staged");
    let output = run_remote_git(&target, &script, transport)?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// SSH twin of [`crate::codespace_git::codespace_git_diff_file_content`]: the same rules, with
/// each text read over SSH.
pub fn codespace_git_diff_file_content_ssh(
    target: SshToolTarget,
    repo_root: String,
    file_path: String,
    diff_target: String,
    transport: Option<&RemoteTransport>,
) -> Result<CodespaceGitFileDiffContent, AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let rel = repo_relative_path(cwd, &file_path)?;
    let diff_target = parse_diff_target(&diff_target)?;
    let status = remote_file_status(&target, cwd, &rel, transport)?;
    let files = SshGitFiles {
        target: &target,
        cwd,
        transport,
    };
    diff_file_content_from(&files, &rel, status.as_ref(), diff_target)
}

struct SshGitFiles<'a> {
    target: &'a SshToolTarget,
    cwd: &'a str,
    transport: Option<&'a RemoteTransport>,
}

impl GitFileSource for SshGitFiles<'_> {
    fn object(&self, spec: &str) -> Result<Option<String>, AppError> {
        let output = run_remote_git(
            self.target,
            &build_git_show_object_script(self.cwd, spec),
            self.transport,
        )?;
        Ok(parse_presence_output(&output.stdout))
    }

    fn worktree_file(&self, relative_path: &str) -> Result<String, AppError> {
        let output = run_remote_git(
            self.target,
            &build_read_worktree_file_script(self.cwd, relative_path),
            self.transport,
        )?;
        Ok(parse_presence_output(&output.stdout).unwrap_or_default())
    }
}

/// The staged diff is read over SSH; the Claude CLI runs here, in a temp folder, since the repo
/// is on the other machine.
pub fn codespace_git_ai_suggest_commit_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<String, AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let stat = run_remote_git(&target, &build_git_staged_stat_script(cwd), transport)?;
    let diff = run_remote_git(&target, &build_git_staged_diff_script(cwd), transport)?;
    let prompt = build_commit_suggest_prompt(
        &String::from_utf8_lossy(&stat.stdout),
        &String::from_utf8_lossy(&diff.stdout),
    )?;
    run_commit_suggest(&prompt, &std::env::temp_dir())
}

// ── Worktrees and the agent diff ──────────────────────────────────────────────

/// Every uncommitted tracked change in `repo_root`, as a unified diff.
///
/// An empty string is the honest answer for a clean worktree, and for a path that is not a repo the
/// error carries through — the panel can tell those apart, where a silent `""` could not.
pub fn codespace_git_uncommitted_diff_ssh(
    target: SshToolTarget,
    repo_root: String,
    transport: Option<&RemoteTransport>,
) -> Result<String, AppError> {
    let cwd = validate_remote_cwd(&repo_root)?;
    let script = build_git_uncommitted_diff_script(cwd);
    let output = run_remote_git(&target, &script, transport)?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// The worktrees of the repo containing `repo_path`, main one first.
pub fn list_git_worktrees_ssh(
    target: SshToolTarget,
    repo_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<Vec<WorktreeEntry>, AppError> {
    let cwd = validate_remote_cwd(&repo_path)?;
    let script = build_worktree_list_script(cwd);
    let output = run_remote_git(&target, &script, transport)?;
    Ok(parse_worktree_porcelain(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// The repo's current branch, refusing a detached HEAD for the same reason the local twin does:
/// isolation needs a named base to cut from and merge back into.
pub fn resolve_repo_head_branch_ssh(
    target: SshToolTarget,
    repo_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<String, AppError> {
    let cwd = validate_remote_cwd(&repo_path)?;
    let script = build_head_branch_script(cwd);
    let output = run_remote_git(&target, &script, transport)?;
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() {
        return Err(AppError::Other(
            "repository is in detached HEAD state; cannot isolate agents without a base branch"
                .to_string(),
        ));
    }
    Ok(branch)
}

/// Create a linked worktree for `branch` at `worktree_path`, creating the branch if needed.
///
/// The entry is read back from `git worktree list` rather than assembled from the arguments: git
/// normalises the path (symlinks, a trailing slash, a relative path), and an entry that disagrees
/// with what is actually on disk is how a node ends up pointing at a directory that is not there.
pub fn create_git_worktree_ssh(
    target: SshToolTarget,
    repo_path: String,
    branch: String,
    worktree_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<WorktreeEntry, AppError> {
    let cwd = validate_remote_cwd(&repo_path)?;
    let path = validate_remote_cwd(&worktree_path)?;
    let script = build_worktree_add_script(cwd, &branch, path);
    run_remote_git(&target, &script, transport)?;

    list_git_worktrees_ssh(target, repo_path, transport)?
        .into_iter()
        .find(|entry| entry.branch.as_deref() == Some(branch.as_str()))
        .ok_or_else(|| AppError::Other(format!("worktree for '{branch}' not found after creation")))
}

/// Remove the linked worktree at `worktree_path`.
pub fn remove_git_worktree_ssh(
    target: SshToolTarget,
    repo_path: String,
    worktree_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let cwd = validate_remote_cwd(&repo_path)?;
    let path = validate_remote_cwd(&worktree_path)?;
    let script = build_worktree_remove_script(cwd, path);
    run_remote_git(&target, &script, transport)?;
    Ok(())
}

/// Which of `branches` still have a live worktree.
///
/// Derived from the list rather than asked for separately — one round trip, and one definition of
/// "live" shared with the local twin.
pub fn validate_worktree_branches_ssh(
    target: SshToolTarget,
    repo_path: String,
    branches: Vec<String>,
    transport: Option<&RemoteTransport>,
) -> Result<Vec<String>, AppError> {
    use std::collections::HashSet;
    let entries = list_git_worktrees_ssh(target, repo_path, transport)?;
    let live: HashSet<&str> = entries
        .iter()
        .filter_map(|entry| entry.branch.as_deref())
        .collect();
    Ok(branches
        .into_iter()
        .filter(|branch| live.contains(branch.as_str()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_tools::SshToolTarget;

    fn target() -> SshToolTarget {
        SshToolTarget {
            host: "host".into(),
            user: None,
            port: None,
        }
    }

    #[test]
    fn commit_rejects_empty_message_before_ssh() {
        let result = codespace_git_commit_ssh(target(), "/srv/repo".into(), "  \n".into(), None);
        let err = result.expect_err("blank message must be rejected");
        let AppError::Other(msg) = err else {
            panic!("expected Other");
        };
        assert!(msg.contains("Commit message"));
    }

    #[test]
    fn stage_file_rejects_invalid_relative_path_before_ssh() {
        let result =
            codespace_git_stage_file_ssh(target(), "/srv/repo".into(), "../escape".into(), None);
        assert!(result.is_err());
    }

    #[test]
    fn unstage_file_rejects_absolute_path_before_ssh() {
        let result = codespace_git_unstage_file_ssh(
            target(),
            "/srv/repo".into(),
            "/etc/passwd".into(),
            None,
        );
        assert!(result.is_err());
    }

    #[test]
    fn status_rejects_relative_repo_root_before_ssh() {
        let result = codespace_git_status_ssh(target(), "relative".into(), None);
        assert!(result.is_err());
    }
}
