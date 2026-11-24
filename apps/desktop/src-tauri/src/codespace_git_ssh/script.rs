//! Pure shell-script builders + parsers for SSH-backed git operations.
//!
//! Every builder returns a single shell command string suitable for shipping
//! through `cli_tools::run_ssh_shell_command`. Inputs are escaped via
//! [`quote_shell_arg`] so callers can safely pass paths and commit messages
//! containing whitespace, quotes, or shell meta-characters.

use crate::codespace_git::{
    parse_porcelain_status, CodespaceGitPanelRefresh, CodespaceGitRepoSummary,
};
use crate::error::AppError;

fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Validate a relative path inside a remote repo.
///
/// We only allow forward-slash relative paths without `..`. Absolute paths,
/// `..` segments, and shell meta-characters are rejected before composing
/// the SSH command. This is the SSH equivalent of
/// `codespace_git::resolve_repo_relative_path`.
pub(crate) fn validate_repo_relative_path(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err(AppError::Other("File path is required".to_string()));
    }
    if trimmed.starts_with('/') {
        return Err(AppError::Other(
            "File path must be relative to the repo".to_string(),
        ));
    }
    let mut clean: Vec<&str> = Vec::new();
    for segment in trimmed.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                return Err(AppError::Other(
                    "File path must stay inside the repo".to_string(),
                ));
            }
            other => clean.push(other),
        }
    }
    if clean.is_empty() {
        return Err(AppError::Other("File path is required".to_string()));
    }
    Ok(clean.join("/"))
}

/// A path from the git status of `repo_root`, made relative to it. Status rows carry the
/// remote's absolute path (`/srv/repo/src/a.ts`); the scripts want `src/a.ts`.
pub(crate) fn repo_relative_path(repo_root: &str, file_path: &str) -> Result<String, AppError> {
    let path = file_path.trim().replace('\\', "/");
    if !path.starts_with('/') {
        return validate_repo_relative_path(&path);
    }
    let root = repo_root.trim_end_matches('/');
    match path
        .strip_prefix(root)
        .and_then(|rest| rest.strip_prefix('/'))
    {
        Some(rest) => validate_repo_relative_path(rest),
        None => Err(AppError::Other(
            "File path is outside the repository root".to_string(),
        )),
    }
}

fn cd_repo(repo_root: &str) -> String {
    format!("cd {} && ", quote_shell_arg(repo_root))
}

/// `git status --porcelain=v1 -z --untracked-files=all` inside `repo_root`.
pub(crate) fn build_git_status_script(repo_root: &str) -> String {
    format!(
        "{}git status --porcelain=v1 -z --untracked-files=all",
        cd_repo(repo_root)
    )
}

/// Composite script that emits the four envelopes consumed by
/// [`parse_remote_repo_summary_output`]:
///
/// ```text
/// BRANCH=<short ref or empty>
/// HEAD=<short sha or empty>
/// UPSTREAM=<upstream ref or empty>
/// AHEAD_BEHIND=<ahead>\t<behind>   (omitted when no upstream)
/// ```
pub(crate) fn build_git_repo_summary_script(repo_root: &str) -> String {
    format!(
        concat!(
            "{cd}",
            "BRANCH=$(git branch --show-current 2>/dev/null || true); ",
            "HEAD=$(git rev-parse --short HEAD 2>/dev/null || true); ",
            "UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{{u}}' 2>/dev/null || true); ",
            "printf 'BRANCH=%s\\nHEAD=%s\\nUPSTREAM=%s\\n' \"$BRANCH\" \"$HEAD\" \"$UPSTREAM\"; ",
            "if [ -n \"$UPSTREAM\" ]; then ",
            "AB=$(git rev-list --left-right --count 'HEAD...@{{u}}' 2>/dev/null || true); ",
            "printf 'AHEAD_BEHIND=%s\\n' \"$AB\"; ",
            "fi"
        ),
        cd = cd_repo(repo_root),
    )
}

/// Parse the envelope produced by [`build_git_repo_summary_script`].
pub(crate) fn parse_remote_repo_summary_output(
    stdout: &str,
) -> Result<CodespaceGitRepoSummary, AppError> {
    let mut branch = String::new();
    let mut head: Option<String> = None;
    let mut upstream: Option<String> = None;
    let mut ahead_behind: Option<&str> = None;

    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("BRANCH=") {
            branch = value.trim().to_string();
        } else if let Some(value) = line.strip_prefix("HEAD=") {
            let trimmed = value.trim();
            head = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        } else if let Some(value) = line.strip_prefix("UPSTREAM=") {
            let trimmed = value.trim();
            upstream = if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            };
        } else if let Some(value) = line.strip_prefix("AHEAD_BEHIND=") {
            ahead_behind = Some(value);
        }
    }

    let (ahead, behind) = ahead_behind
        .map(crate::codespace_git::parse_ahead_behind)
        .unwrap_or((0, 0));
    let final_branch = if !branch.is_empty() {
        branch
    } else if let Some(short) = head.as_deref() {
        format!("detached:{short}")
    } else {
        "unknown".to_string()
    };

    Ok(CodespaceGitRepoSummary {
        branch: final_branch,
        head,
        upstream,
        ahead,
        behind,
    })
}

pub(crate) fn build_git_stage_file_script(repo_root: &str, relative_path: &str) -> String {
    format!(
        "{}git add -- {}",
        cd_repo(repo_root),
        quote_shell_arg(relative_path)
    )
}

pub(crate) fn build_git_stage_all_script(repo_root: &str) -> String {
    format!("{}git add --all", cd_repo(repo_root))
}

pub(crate) fn build_git_unstage_file_script(repo_root: &str, relative_path: &str) -> String {
    format!(
        "{}git restore --staged -- {}",
        cd_repo(repo_root),
        quote_shell_arg(relative_path)
    )
}

pub(crate) fn build_git_unstage_all_script(repo_root: &str) -> String {
    format!("{}git restore --staged -- .", cd_repo(repo_root))
}

/// Composite script: `restore --worktree -- .` then `clean -fd -- .`.
///
/// Both run inside the same SSH invocation so a partial failure surfaces as a
/// non-zero exit and is mapped to a single error by the caller.
pub(crate) fn build_git_discard_all_script(repo_root: &str) -> String {
    format!(
        "{}git restore --worktree -- . && git clean -fd -- .",
        cd_repo(repo_root)
    )
}

pub(crate) fn build_git_commit_script(repo_root: &str, message: &str) -> String {
    format!(
        "{}git commit -m {}",
        cd_repo(repo_root),
        quote_shell_arg(message)
    )
}

/// `git push` with the `-u <remote> <branch>` fallback when no upstream is
/// configured — same behaviour as the local `codespace_git_push`.
pub(crate) fn build_git_push_script(repo_root: &str) -> String {
    format!(
        concat!(
            "{cd}",
            "if git rev-parse --abbrev-ref --symbolic-full-name '@{{u}}' >/dev/null 2>&1; then ",
            "git push; ",
            "else ",
            "branch=$(git branch --show-current); ",
            "if [ -z \"$branch\" ]; then echo 'Refusing to push detached HEAD' >&2; exit 1; fi; ",
            "remote=$(git remote | head -n1); ",
            "if [ -z \"$remote\" ]; then echo 'No git remote configured' >&2; exit 1; fi; ",
            "git push -u \"$remote\" \"$branch\"; ",
            "fi"
        ),
        cd = cd_repo(repo_root),
    )
}

/// Composite script that emits the repo summary envelope followed by a
/// `STATUS_FOLLOWS\n` sentinel, then the raw NUL-delimited `git status`
/// output — all in a single SSH round-trip.
///
/// The caller splits on `STATUS_FOLLOWS\n` to feed the two halves to
/// [`parse_remote_repo_summary_output`] and [`crate::codespace_git::parse_porcelain_status`].
pub(crate) fn build_git_panel_refresh_script(repo_root: &str) -> String {
    format!(
        concat!(
            "{cd}",
            "BRANCH=$(git branch --show-current 2>/dev/null || true); ",
            "HEAD=$(git rev-parse --short HEAD 2>/dev/null || true); ",
            "UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{{u}}' 2>/dev/null || true); ",
            "printf 'BRANCH=%s\\nHEAD=%s\\nUPSTREAM=%s\\n' \"$BRANCH\" \"$HEAD\" \"$UPSTREAM\"; ",
            "if [ -n \"$UPSTREAM\" ]; then ",
            "AB=$(git rev-list --left-right --count 'HEAD...@{{u}}' 2>/dev/null || true); ",
            "printf 'AHEAD_BEHIND=%s\\n' \"$AB\"; ",
            "fi; ",
            "printf 'STATUS_FOLLOWS\\n'; ",
            "git status --porcelain=v1 -z --untracked-files=all"
        ),
        cd = cd_repo(repo_root),
    )
}

/// Parse the combined output produced by [`build_git_panel_refresh_script`].
pub(crate) fn parse_git_panel_refresh_output(
    repo_root: &str,
    stdout: &[u8],
) -> Result<CodespaceGitPanelRefresh, AppError> {
    const SEPARATOR: &[u8] = b"STATUS_FOLLOWS\n";
    let sep_pos = stdout.windows(SEPARATOR.len()).position(|w| w == SEPARATOR);
    let (summary_bytes, status_bytes) = match sep_pos {
        Some(pos) => (&stdout[..pos], &stdout[pos + SEPARATOR.len()..]),
        None => (stdout, [].as_slice()),
    };
    let summary = parse_remote_repo_summary_output(&String::from_utf8_lossy(summary_bytes))?;
    let files = parse_porcelain_status(
        std::path::Path::new(repo_root),
        &String::from_utf8_lossy(status_bytes),
    );
    Ok(CodespaceGitPanelRefresh { summary, files })
}

// ── Worktrees and the agent diff ──────────────────────────────────────────────

/// `git diff HEAD` — every uncommitted tracked change, which is what the agent diff panel shows.
///
/// No `--` and no pathspec: the panel's question is "what has this agent changed", and the answer
/// is the whole worktree it was given.
pub(crate) fn build_git_uncommitted_diff_script(repo_root: &str) -> String {
    format!("{}git diff HEAD", cd_repo(repo_root))
}

/// One file's working-tree changes thrown away: `restore` when git tracks it, else `clean`
/// (an untracked file's only change is that it exists).
pub(crate) fn build_git_discard_file_script(repo_root: &str, relative_path: &str) -> String {
    let path = quote_shell_arg(relative_path);
    format!(
        "{}if git ls-files --error-unmatch -- {path} >/dev/null 2>&1; then git restore --worktree -- {path}; else git clean -f -- {path}; fi",
        cd_repo(repo_root),
    )
}

pub(crate) fn build_git_diff_file_script(
    repo_root: &str,
    relative_path: &str,
    staged: bool,
) -> String {
    format!(
        "{}git diff --no-color{} -- {}",
        cd_repo(repo_root),
        if staged { " --cached" } else { "" },
        quote_shell_arg(relative_path)
    )
}

/// `Y` + the object's bytes, or `N` when it does not exist. The marker keeps "no such object"
/// apart from a failed connection, which exits non-zero.
pub(crate) fn build_git_show_object_script(repo_root: &str, spec: &str) -> String {
    let spec = quote_shell_arg(spec);
    format!(
        "{}if git cat-file -e {spec} 2>/dev/null; then printf Y; git show {spec}; else printf N; fi",
        cd_repo(repo_root),
    )
}

/// `Y` + the file's bytes, or `N` when it is not there.
pub(crate) fn build_read_worktree_file_script(repo_root: &str, relative_path: &str) -> String {
    let path = quote_shell_arg(relative_path);
    format!(
        "{}if [ -f {path} ]; then printf Y; cat -- {path}; else printf N; fi",
        cd_repo(repo_root),
    )
}

/// Reads the output of [`build_git_show_object_script`] or [`build_read_worktree_file_script`].
pub(crate) fn parse_presence_output(stdout: &[u8]) -> Option<String> {
    match stdout.split_first() {
        Some((b'Y', rest)) => Some(String::from_utf8_lossy(rest).to_string()),
        _ => None,
    }
}

pub(crate) fn build_git_staged_stat_script(repo_root: &str) -> String {
    format!("{}git diff --staged --stat --no-color", cd_repo(repo_root))
}

pub(crate) fn build_git_staged_diff_script(repo_root: &str) -> String {
    format!("{}git diff --staged --no-color", cd_repo(repo_root))
}

/// `git worktree list --porcelain`, parsed by the same function the local path uses.
pub(crate) fn build_worktree_list_script(repo_root: &str) -> String {
    format!("{}git worktree list --porcelain", cd_repo(repo_root))
}

/// The repo's current branch — the base an isolated agent's branch is cut from (ADR 0015).
pub(crate) fn build_head_branch_script(repo_root: &str) -> String {
    format!("{}git branch --show-current", cd_repo(repo_root))
}

/// Add a worktree for `branch` at `worktree_path`, creating the branch only if it is not there.
///
/// **It asks first rather than trying and falling back**, and the difference is the error message.
/// The local twin runs `add <path> <branch>`, discards its output, and retries with `-b`; when the
/// branch exists *and another worktree already holds it*, what the operator is shown is the second
/// attempt's complaint — "a branch named 'x' already exists" — which is both true and useless. The
/// real reason, "already used by worktree …", was in the output that got thrown away.
///
/// On this machine that costs a glance at `git worktree list`. On a machine the operator cannot see
/// it costs the whole diagnosis, so each arm here runs only when it is the right one and reports
/// its own failure.
///
/// **No `--force`, on purpose.** Git refuses to check out a branch another worktree already holds,
/// and that refusal is the only thing standing between two agents and the same branch.
pub(crate) fn build_worktree_add_script(
    repo_root: &str,
    branch: &str,
    worktree_path: &str,
) -> String {
    format!(
        concat!(
            "{cd}",
            "if git show-ref --verify --quiet refs/heads/{raw_branch}; then ",
            "git worktree add {path} {branch}; ",
            "else ",
            "git worktree add -b {branch} {path}; ",
            "fi"
        ),
        cd = cd_repo(repo_root),
        // `show-ref --verify` takes the ref as one argument, so the quoting is the same; spelling it
        // separately keeps the two uses from drifting if one ever needs a prefix.
        raw_branch = quote_shell_arg(branch),
        path = quote_shell_arg(worktree_path),
        branch = quote_shell_arg(branch),
    )
}

/// Remove a worktree.
///
/// **No `--force` here either**, and this one is load-bearing: without it git refuses to remove a
/// worktree with uncommitted changes in it. On a remote machine the operator cannot glance at that
/// directory, so git's refusal is the only warning that an agent's unsaved work is about to go.
pub(crate) fn build_worktree_remove_script(repo_root: &str, worktree_path: &str) -> String {
    format!(
        "{}git worktree remove {}",
        cd_repo(repo_root),
        quote_shell_arg(worktree_path)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_relative_path_accepts_an_absolute_path_inside_the_repo() {
        assert_eq!(
            repo_relative_path("/srv/repo", "/srv/repo/src/a.ts").unwrap(),
            "src/a.ts"
        );
        assert_eq!(
            repo_relative_path("/srv/repo/", "/srv/repo/a.ts").unwrap(),
            "a.ts"
        );
        assert_eq!(
            repo_relative_path("/srv/repo", "src/a.ts").unwrap(),
            "src/a.ts"
        );
    }

    #[test]
    fn repo_relative_path_rejects_a_path_outside_the_repo() {
        assert!(repo_relative_path("/srv/repo", "/srv/repo2/a.ts").is_err());
        assert!(repo_relative_path("/srv/repo", "/etc/passwd").is_err());
        assert!(repo_relative_path("/srv/repo", "/srv/repo").is_err());
        assert!(repo_relative_path("/srv/repo", "/srv/repo/../x").is_err());
    }

    #[test]
    fn discard_file_script_restores_a_tracked_file_and_cleans_an_untracked_one() {
        let script = build_git_discard_file_script("/srv/repo", "it's.ts");
        assert!(script.starts_with("cd '/srv/repo' && "));
        assert!(script
            .contains(r"if git ls-files --error-unmatch -- 'it'\''s.ts' >/dev/null 2>&1; then"));
        assert!(script.contains(
            r"git restore --worktree -- 'it'\''s.ts'; else git clean -f -- 'it'\''s.ts'; fi"
        ));
    }

    #[test]
    fn diff_file_script_adds_cached_only_for_staged() {
        assert!(build_git_diff_file_script("/srv/repo", "a.ts", true)
            .ends_with("git diff --no-color --cached -- 'a.ts'"));
        assert!(build_git_diff_file_script("/srv/repo", "a.ts", false)
            .ends_with("git diff --no-color -- 'a.ts'"));
    }

    #[test]
    fn show_object_and_read_file_scripts_mark_presence_before_the_bytes() {
        let show = build_git_show_object_script("/srv/repo", "HEAD:a b.ts");
        assert!(show.contains("if git cat-file -e 'HEAD:a b.ts' 2>/dev/null; then printf Y; git show 'HEAD:a b.ts'; else printf N; fi"));
        let read = build_read_worktree_file_script("/srv/repo", "a.ts");
        assert!(read.contains("if [ -f 'a.ts' ]; then printf Y; cat -- 'a.ts'; else printf N; fi"));
    }

    #[test]
    fn parse_presence_output_splits_the_marker_from_the_text() {
        assert_eq!(
            parse_presence_output(b"Yhello\n"),
            Some("hello\n".to_string())
        );
        assert_eq!(parse_presence_output(b"Y"), Some(String::new()));
        assert_eq!(parse_presence_output(b"N"), None);
        assert_eq!(parse_presence_output(b""), None);
    }

    #[test]
    fn staged_diff_scripts_ask_for_stat_and_patch() {
        assert!(build_git_staged_stat_script("/srv/repo")
            .ends_with("git diff --staged --stat --no-color"));
        assert!(build_git_staged_diff_script("/srv/repo").ends_with("git diff --staged --no-color"));
    }

    #[test]
    fn validates_repo_relative_path_happy() {
        assert_eq!(
            validate_repo_relative_path("src/main.rs").expect("ok"),
            "src/main.rs"
        );
        assert_eq!(
            validate_repo_relative_path("src\\foo\\bar.txt").expect("ok"),
            "src/foo/bar.txt"
        );
    }

    #[test]
    fn validates_repo_relative_path_rejects_bad_inputs() {
        assert!(validate_repo_relative_path("").is_err());
        assert!(validate_repo_relative_path("/etc/passwd").is_err());
        assert!(validate_repo_relative_path("..").is_err());
        assert!(validate_repo_relative_path("src/../../etc").is_err());
        assert!(validate_repo_relative_path("./").is_err());
    }

    #[test]
    fn status_script_uses_porcelain_v1_z_untracked_all() {
        let script = build_git_status_script("/srv/repo");
        assert!(script.starts_with("cd '/srv/repo' && "));
        assert!(script.contains("git status --porcelain=v1 -z --untracked-files=all"));
    }

    #[test]
    fn repo_summary_script_emits_required_envelope_keys() {
        let script = build_git_repo_summary_script("/srv/repo");
        for key in ["BRANCH=%s", "HEAD=%s", "UPSTREAM=%s", "AHEAD_BEHIND=%s"] {
            assert!(script.contains(key), "missing {key} in: {script}");
        }
        // Branch / head / upstream lookups must come from git itself.
        assert!(script.contains("git branch --show-current"));
        assert!(script.contains("git rev-parse --short HEAD"));
        assert!(script.contains("git rev-list --left-right --count"));
    }

    #[test]
    fn parses_repo_summary_with_upstream_and_ahead_behind() {
        let stdout = "BRANCH=feat/x\nHEAD=abc1234\nUPSTREAM=origin/feat/x\nAHEAD_BEHIND=2\t3\n";
        let summary = parse_remote_repo_summary_output(stdout).expect("ok");
        assert_eq!(summary.branch, "feat/x");
        assert_eq!(summary.head.as_deref(), Some("abc1234"));
        assert_eq!(summary.upstream.as_deref(), Some("origin/feat/x"));
        assert_eq!(summary.ahead, 2);
        assert_eq!(summary.behind, 3);
    }

    #[test]
    fn parses_repo_summary_falls_back_when_branch_missing() {
        let stdout = "BRANCH=\nHEAD=def5678\nUPSTREAM=\n";
        let summary = parse_remote_repo_summary_output(stdout).expect("ok");
        assert_eq!(summary.branch, "detached:def5678");
        assert_eq!(summary.head.as_deref(), Some("def5678"));
        assert!(summary.upstream.is_none());
        assert_eq!(summary.ahead, 0);
        assert_eq!(summary.behind, 0);
    }

    #[test]
    fn parses_repo_summary_handles_empty_repo() {
        let stdout = "BRANCH=\nHEAD=\nUPSTREAM=\n";
        let summary = parse_remote_repo_summary_output(stdout).expect("ok");
        assert_eq!(summary.branch, "unknown");
        assert!(summary.head.is_none());
    }

    #[test]
    fn stage_file_script_quotes_path_and_uses_double_dash() {
        let script = build_git_stage_file_script("/srv/repo", "src/main.rs");
        assert!(script.contains("git add -- 'src/main.rs'"));
    }

    #[test]
    fn unstage_all_script_uses_dot_target() {
        let script = build_git_unstage_all_script("/srv/repo");
        assert!(script.ends_with("git restore --staged -- ."));
    }

    #[test]
    fn discard_all_script_runs_restore_then_clean_chained_with_and() {
        let script = build_git_discard_all_script("/srv/repo");
        assert!(script.contains("git restore --worktree -- . && git clean -fd -- ."));
    }

    #[test]
    fn commit_script_escapes_message_with_quotes_and_apostrophes() {
        let script = build_git_commit_script("/srv/repo", "fix: alwi's bug");
        assert!(script.contains(r"git commit -m 'fix: alwi'\''s bug'"));
    }

    #[test]
    fn push_script_falls_back_to_set_upstream_when_no_upstream() {
        let script = build_git_push_script("/srv/repo");
        assert!(script.contains("git rev-parse --abbrev-ref --symbolic-full-name '@{u}'"));
        assert!(script.contains("git push;"));
        assert!(script.contains("git push -u \"$remote\" \"$branch\""));
        assert!(script.contains("Refusing to push detached HEAD"));
        assert!(script.contains("No git remote configured"));
    }

    #[test]
    fn quote_shell_arg_escapes_apostrophes() {
        assert_eq!(quote_shell_arg("it's"), r"'it'\''s'");
    }

    // ── batch refresh ─────────────────────────────────────────────────────────

    #[test]
    fn panel_refresh_script_contains_summary_keys_and_status_sentinel() {
        let script = build_git_panel_refresh_script("/srv/repo");
        assert!(script.starts_with("cd '/srv/repo' && "));
        for key in ["BRANCH=%s", "HEAD=%s", "UPSTREAM=%s"] {
            assert!(script.contains(key), "missing {key}");
        }
        assert!(script.contains("STATUS_FOLLOWS"));
        assert!(script.contains("git status --porcelain=v1 -z --untracked-files=all"));
    }

    #[test]
    fn parse_panel_refresh_splits_summary_and_status() {
        let stdout = b"BRANCH=main\nHEAD=abc1234\nUPSTREAM=origin/main\nAHEAD_BEHIND=1\t2\nSTATUS_FOLLOWS\n M src/main.rs\0?? new.txt\0";
        let result = parse_git_panel_refresh_output("/srv/repo", stdout).expect("ok");
        assert_eq!(result.summary.branch, "main");
        assert_eq!(result.summary.head.as_deref(), Some("abc1234"));
        assert_eq!(result.summary.ahead, 1);
        assert_eq!(result.summary.behind, 2);
        assert_eq!(result.files.len(), 2);
    }

    #[test]
    fn parse_panel_refresh_handles_missing_separator_gracefully() {
        let stdout = b"BRANCH=main\nHEAD=abc1234\nUPSTREAM=\n";
        let result = parse_git_panel_refresh_output("/srv/repo", stdout).expect("ok");
        assert_eq!(result.summary.branch, "main");
        assert!(result.files.is_empty());
    }

    #[test]
    fn parse_panel_refresh_handles_empty_status_section() {
        let stdout = b"BRANCH=feat/x\nHEAD=def5678\nUPSTREAM=\nSTATUS_FOLLOWS\n";
        let result = parse_git_panel_refresh_output("/srv/repo", stdout).expect("ok");
        assert_eq!(result.summary.branch, "feat/x");
        assert!(result.files.is_empty());
    }

    // ── Worktrees and the agent diff, run against a real repo ─────────────────
    //
    // These scripts are the ones that create and destroy directories on a machine the operator
    // cannot look at. Asserting on their text would pass just as happily with the `||` arms the
    // wrong way round, or with a `--force` that quietly discards someone's work. So each one is
    // executed against a throwaway git repo, and the filesystem is what answers.

    fn sh(script: &str, dir: &std::path::Path) -> std::process::Output {
        std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .current_dir(dir)
            .env("PATH", git_path())
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "Lotus Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Lotus Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .expect("run script")
    }

    /// Where `git` is, resolved once and pinned — never read from the ambient `PATH`.
    ///
    /// See `cli_tools::TEST_PATH`: another test in this binary sets the process `PATH` to `""`, and
    /// a `git` that vanishes mid-run reads as this test's own failure.
    fn git_path() -> String {
        let extra = std::process::Command::new("/usr/bin/which")
            .arg("git")
            .env("PATH", crate::cli_tools::TEST_PATH)
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .rsplit_once('/')
                    .map(|(dir, _)| dir.to_string())
            });
        match extra {
            Some(dir) => format!("{dir}:{}", crate::cli_tools::TEST_PATH),
            None => crate::cli_tools::TEST_PATH.to_string(),
        }
    }

    /// A repo with one commit on `main`, at a real path.
    fn temp_repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        // macOS hands out /var/... which is a symlink to /private/var; git reports the resolved
        // form in `worktree list`, and a test comparing the two would fail for the wrong reason.
        let root = std::fs::canonicalize(dir.path()).expect("canonicalize");
        let setup = sh(
            "git init -q -b main . && echo hello > a.txt && git add a.txt && git commit -q -m first",
            &root,
        );
        assert!(
            setup.status.success(),
            "{}",
            String::from_utf8_lossy(&setup.stderr)
        );
        let path = root.to_string_lossy().to_string();
        (dir, path)
    }

    #[test]
    fn adding_a_worktree_creates_the_branch_when_it_does_not_exist_yet() {
        let (dir, repo) = temp_repo();
        let tree = format!("{repo}/wt-new");
        let out = sh(
            &build_worktree_add_script(&repo, "lotus/team/rowan", &tree),
            dir.path(),
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let listed = sh(&build_worktree_list_script(&repo), dir.path());
        let entries = crate::codespace_git::parse_worktree_porcelain(&String::from_utf8_lossy(
            &listed.stdout,
        ));
        assert!(entries[0].is_main, "the main worktree is listed first");
        let made = entries
            .iter()
            .find(|entry| entry.branch.as_deref() == Some("lotus/team/rowan"))
            .expect("the new worktree is listed");
        assert_eq!(made.path, tree);
        assert!(!made.is_main);
        assert!(std::path::Path::new(&tree).join("a.txt").exists());
    }

    /// Re-attaching an agent to a branch it already has must work. The arms of the `||` being the
    /// wrong way round would break exactly this and nothing else, which is why it has its own test.
    #[test]
    fn adding_a_worktree_reuses_a_branch_that_already_exists() {
        let (dir, repo) = temp_repo();
        assert!(sh("git branch lotus/team/rowan", dir.path())
            .status
            .success());

        let tree = format!("{repo}/wt-existing");
        let out = sh(
            &build_worktree_add_script(&repo, "lotus/team/rowan", &tree),
            dir.path(),
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let listed = sh(&build_worktree_list_script(&repo), dir.path());
        let entries = crate::codespace_git::parse_worktree_porcelain(&String::from_utf8_lossy(
            &listed.stdout,
        ));
        assert_eq!(
            entries
                .iter()
                .filter(|e| e.branch.as_deref() == Some("lotus/team/rowan"))
                .count(),
            1,
            "reusing a branch must not produce a second one"
        );
    }

    /// The project's own rule, on a machine nobody can look at: two agents must never end up on the
    /// same branch. Git refuses this by itself — as long as we never pass `--force`, which is the
    /// thing this test is really guarding.
    #[test]
    fn a_branch_another_worktree_already_holds_is_refused() {
        let (dir, repo) = temp_repo();
        let first = format!("{repo}/wt-a");
        assert!(sh(
            &build_worktree_add_script(&repo, "shared", &first),
            dir.path()
        )
        .status
        .success());

        let second = format!("{repo}/wt-b");
        let out = sh(
            &build_worktree_add_script(&repo, "shared", &second),
            dir.path(),
        );
        assert!(
            !out.status.success(),
            "git must refuse a branch that is already checked out somewhere else"
        );
        assert!(
            !std::path::Path::new(&second).exists(),
            "a refused add must not leave a directory behind"
        );
        let message = String::from_utf8_lossy(&out.stderr);
        assert!(
            message.contains("already used by worktree") || message.contains("already checked out"),
            "the operator has to be able to read why: {message}"
        );
    }

    /// The one that would cost someone real work. `git worktree remove` refuses a worktree with
    /// uncommitted changes, and on a remote machine that refusal is the only warning there is.
    #[test]
    fn removing_a_worktree_with_unsaved_work_is_refused() {
        let (dir, repo) = temp_repo();
        let tree = format!("{repo}/wt-dirty");
        assert!(
            sh(&build_worktree_add_script(&repo, "busy", &tree), dir.path())
                .status
                .success()
        );
        std::fs::write(format!("{tree}/a.txt"), "an agent was working here").expect("dirty it");

        let out = sh(&build_worktree_remove_script(&repo, &tree), dir.path());
        assert!(
            !out.status.success(),
            "a dirty worktree must not be removed silently"
        );
        assert!(
            std::path::Path::new(&tree).join("a.txt").exists(),
            "the agent's work is still there"
        );
    }

    #[test]
    fn removing_a_clean_worktree_works() {
        let (dir, repo) = temp_repo();
        let tree = format!("{repo}/wt-clean");
        assert!(
            sh(&build_worktree_add_script(&repo, "done", &tree), dir.path())
                .status
                .success()
        );

        let out = sh(&build_worktree_remove_script(&repo, &tree), dir.path());
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!std::path::Path::new(&tree).exists());
    }

    #[test]
    fn the_head_branch_is_the_one_an_agent_is_cut_from() {
        let (dir, repo) = temp_repo();
        let out = sh(&build_head_branch_script(&repo), dir.path());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "main");
    }

    /// A detached HEAD prints nothing rather than failing, which is why the caller — not the script
    /// — is the one that turns the empty answer into an error.
    #[test]
    fn a_detached_head_answers_with_nothing() {
        let (dir, repo) = temp_repo();
        assert!(sh("git checkout -q --detach HEAD", dir.path())
            .status
            .success());
        let out = sh(&build_head_branch_script(&repo), dir.path());
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).trim().is_empty());
    }

    #[test]
    fn the_agent_diff_shows_what_changed_and_nothing_when_nothing_did() {
        let (dir, repo) = temp_repo();
        let clean = sh(&build_git_uncommitted_diff_script(&repo), dir.path());
        assert!(clean.status.success());
        assert!(String::from_utf8_lossy(&clean.stdout).trim().is_empty());

        std::fs::write(format!("{repo}/a.txt"), "goodbye\n").expect("change it");
        let dirty = sh(&build_git_uncommitted_diff_script(&repo), dir.path());
        let diff = String::from_utf8_lossy(&dirty.stdout);
        assert!(diff.contains("-hello"), "{diff}");
        assert!(diff.contains("+goodbye"), "{diff}");
    }

    /// A path with a space is the ordinary case on a machine that is not yours.
    #[test]
    fn a_path_with_a_space_survives_the_quoting() {
        let (dir, repo) = temp_repo();
        let tree = format!("{repo}/my worktree");
        let out = sh(
            &build_worktree_add_script(&repo, "spaced", &tree),
            dir.path(),
        );
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(std::path::Path::new(&tree).join("a.txt").exists());
    }
}
