use crate::no_window::NoWindow;
use super::paths::{relative_to_root, resolve_project_child, resolve_project_root};
use super::MAX_DIFF_BYTES;
use serde::{Deserialize, Serialize};
use std::process::{Command, Output};

/// Who last changed one line (the editor's inline blame).
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBlameEntry {
    pub line_number: u32,
    /// The first 8 characters of the commit.
    pub commit: String,
    pub author: String,
    /// Unix seconds.
    pub timestamp: i64,
    /// The commit message's first line.
    pub summary: String,
    /// False for a line changed on disk but not committed (git's all-zero commit).
    pub committed: bool,
    /// The author's email is this repo's `user.email`.
    pub you: bool,
}

/// Git blame for a file.
pub fn git_blame_file(
    project_path: String,
    file_path: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<Vec<GitBlameEntry>, String> {
    let root = resolve_project_root(&project_path)?;
    let full_path = resolve_project_child(&project_path, &file_path)?;
    let relative_path = relative_to_root(&root, &full_path);

    let mut cmd = Command::new("git").no_window();
    cmd.args(["blame", "--line-porcelain"]);

    if let Some(range) = blame_range(start_line, end_line) {
        cmd.args(["-L", &range]);
    }

    cmd.arg("--").arg(&relative_path).current_dir(&root);
    let output = checked_output(cmd, "git blame")?;
    let mut email = Command::new("git").no_window();
    email.args(["config", "user.email"]).current_dir(&root);
    // No user.email set: nothing is "You", which is not an error.
    let me = checked_output(email, "git config")
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default();
    Ok(parse_blame_porcelain(&String::from_utf8_lossy(&output.stdout), &me))
}

/// Git diff.
pub fn git_diff(project_path: String, target: Option<String>) -> Result<String, String> {
    let root = resolve_project_root(&project_path)?;
    let mut cmd = Command::new("git").no_window();
    cmd.arg("diff");

    match target
        .as_deref()
        .map(str::trim)
        .filter(|target| !target.is_empty())
    {
        Some("staged") => {
            cmd.arg("--cached");
        }
        Some(ref_name) if ref_name.starts_with('-') => {
            return Err("Git diff target cannot start with '-'.".to_string());
        }
        Some(ref_name) => {
            cmd.arg(ref_name);
        }
        None => {
            cmd.arg("HEAD");
        }
    }

    cmd.current_dir(&root);
    let output = checked_output(cmd, "git diff")?;
    Ok(truncate_utf8_output(&output.stdout, MAX_DIFF_BYTES))
}

pub fn git_repo_status(project_path: String) -> Result<crate::models::GitRepoStatus, String> {
    let project_root = resolve_project_root(&project_path)?;

    let mut repo_root_cmd = Command::new("git").no_window();
    repo_root_cmd
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&project_root);
    let repo_root_output = checked_output(repo_root_cmd, "git rev-parse")
        .map_err(|_| "Not a git repository".to_string())?;

    let repo_root = String::from_utf8_lossy(&repo_root_output.stdout)
        .trim()
        .to_string();

    let mut branch_cmd = Command::new("git").no_window();
    branch_cmd
        .args(["branch", "--show-current"])
        .current_dir(&repo_root);
    let branch_output = checked_output(branch_cmd, "git branch")?;

    let branch = String::from_utf8_lossy(&branch_output.stdout)
        .trim()
        .to_string();
    let branch = if branch.is_empty() {
        "detached".to_string()
    } else {
        branch
    };

    let mut status_cmd = Command::new("git").no_window();
    status_cmd
        .args(["status", "--short"])
        .current_dir(&repo_root);
    let status_output = checked_output(status_cmd, "git status")?;

    let (staged_count, unstaged_count, untracked_count) =
        parse_git_status_counts(&String::from_utf8_lossy(&status_output.stdout));

    Ok(crate::models::GitRepoStatus {
        repo_root,
        branch,
        has_changes: staged_count > 0 || unstaged_count > 0 || untracked_count > 0,
        staged_count,
        unstaged_count,
        untracked_count,
    })
}

fn checked_output(mut cmd: Command, label: &str) -> Result<Output, String> {
    let output = cmd
        .output()
        .map_err(|error| format!("{label} failed: {error}"))?;
    if output.status.success() {
        return Ok(output);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("{label} failed with status {}.", output.status)
    } else {
        stderr
    })
}

fn blame_range(start_line: Option<u32>, end_line: Option<u32>) -> Option<String> {
    let start = start_line?;
    let end = end_line?;
    let start = start.max(1);
    let end = end.max(start);
    Some(format!("{start},{end}"))
}

fn parse_blame_porcelain(stdout: &str, me: &str) -> Vec<GitBlameEntry> {
    let mut entries = Vec::new();
    let (mut commit, mut author, mut mail, mut summary) = (String::new(), String::new(), String::new(), String::new());
    let mut timestamp: i64 = 0;
    let mut line_number: u32 = 0;

    for line in stdout.lines() {
        if line.starts_with('\t') {
            entries.push(GitBlameEntry {
                line_number,
                commit: commit.chars().take(8).collect(),
                author: author.clone(),
                timestamp,
                summary: summary.clone(),
                committed: commit.chars().any(|c| c != '0'),
                you: !me.is_empty() && mail.eq_ignore_ascii_case(me),
            });
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 3 && parts[0].len() == 40 && parts[0].chars().all(|c| c.is_ascii_hexdigit()) {
            commit = parts[0].to_string();
            line_number = parts[2].parse().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("author-mail ") {
            mail = value.trim_start_matches('<').trim_end_matches('>').to_string();
        } else if let Some(value) = line.strip_prefix("author-time ") {
            timestamp = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("author ") {
            author = value.to_string();
        } else if let Some(value) = line.strip_prefix("summary ") {
            summary = value.to_string();
        }
    }

    entries
}

fn parse_git_status_counts(stdout: &str) -> (u32, u32, u32) {
    let mut staged_count = 0_u32;
    let mut unstaged_count = 0_u32;
    let mut untracked_count = 0_u32;

    for line in stdout.lines() {
        if line.starts_with("??") {
            untracked_count += 1;
            continue;
        }

        let mut chars = line.chars();
        let index_status = chars.next().unwrap_or(' ');
        let worktree_status = chars.next().unwrap_or(' ');

        if index_status != ' ' {
            staged_count += 1;
        }
        if worktree_status != ' ' {
            unstaged_count += 1;
        }
    }

    (staged_count, unstaged_count, untracked_count)
}

fn truncate_utf8_output(bytes: &[u8], max_bytes: usize) -> String {
    if bytes.len() <= max_bytes {
        return String::from_utf8_lossy(bytes).to_string();
    }

    let mut end = max_bytes;
    while end > 0 && std::str::from_utf8(&bytes[..end]).is_err() {
        end -= 1;
    }

    let mut output = String::from_utf8_lossy(&bytes[..end]).to_string();
    output.push_str(&format!(
        "\n\n[CodeChat diff truncated at {max_bytes} bytes from {} bytes total]",
        bytes.len()
    ));
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_git_status_counts_splits_staged_unstaged_untracked() {
        let counts = parse_git_status_counts(" M file-a\nM  file-b\nMM file-c\n?? file-d\n");

        assert_eq!(counts, (2, 2, 1));
    }

    #[test]
    fn truncate_utf8_output_adds_clear_marker() {
        let output = truncate_utf8_output("abcdef".as_bytes(), 3);

        assert!(output.starts_with("abc"));
        assert!(output.contains("truncated at 3 bytes"));
    }

    #[test]
    fn blame_porcelain_reads_message_you_and_uncommitted_lines() {
        let me = "alwi@example.com";
        let stdout = "\
23855d8312345678901234567890123456789012 1 1 1
author Alwi Sofwan
author-mail <Alwi@Example.com>
author-time 1763700000
summary fix(chat): keep a review note
filename a.ts
\tconst a = 1;
0000000000000000000000000000000000000000 2 2 1
author Not Committed Yet
author-mail <not.committed.yet>
author-time 1763700100
summary Version of a.ts from a.ts
filename a.ts
\tconst b = 2;
";
        let entries = parse_blame_porcelain(stdout, me);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].commit, "23855d83");
        assert_eq!(entries[0].summary, "fix(chat): keep a review note");
        assert_eq!(entries[0].timestamp, 1763700000);
        assert!(entries[0].committed && entries[0].you);
        assert_eq!(entries[1].line_number, 2);
        assert!(!entries[1].committed && !entries[1].you);
    }
}
