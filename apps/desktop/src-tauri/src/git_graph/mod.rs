//! The Git graph (GLOSSARY "Source control"): a read-only view of one repository's history.
//!
//! Every call starts the `git` program (`codespace_git::git_command`, which never opens a console
//! window on Windows) and reads its output through the pure parsers in `parse.rs`. Nothing here
//! writes to the repository. Revisions go to `git log` on stdin, not the command line: "All" in a
//! repo with hundreds of agent branches would pass Windows' 32 K command-line limit.

mod parse;
pub mod watch;

use std::io::Write;
use std::path::Path;
use std::process::Stdio;

use serde::Serialize;

use crate::codespace_git::{checked_output, git_command, resolve_repo_root};
use crate::AppError;

/// Most rows one page may ask for.
const MAX_PAGE: u32 = 1000;
/// Most `↑`/`↓` marks worth computing: past this the branch is far apart anyway.
const MAX_SYNC_MARKS: u32 = 1000;
/// Most changed files listed for one commit (a vendored folder can be tens of thousands).
const MAX_COMMIT_FILES: usize = 3000;
/// A side of a diff past this is not read unless asked (`allow_large`).
const MAX_DIFF_BYTES: u64 = 1024 * 1024;
/// How far into a blob git's own binary check looks.
const BINARY_SNIFF_BYTES: usize = 8000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub author_email: String,
    /// Author time, Unix seconds.
    pub time: i64,
    pub subject: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphRefKind {
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    /// `main`, `origin/main`, `v1.0`.
    pub name: String,
    /// `refs/heads/main`: what is handed back to `git_graph_log`.
    pub full_name: String,
    pub kind: GraphRefKind,
    /// The commit it points at (an annotated tag is peeled).
    pub target: String,
    /// A local branch's upstream, short (`origin/main`).
    pub upstream: Option<String>,
    /// Checked out in this working tree.
    pub is_head: bool,
    /// The working tree that has this branch checked out (this one or another).
    pub worktree: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRefs {
    /// `None` in a repository with no commit yet.
    pub head: Option<String>,
    pub detached: bool,
    pub shallow: bool,
    /// `main`/`master`, or what `origin/HEAD` names; short.
    pub default_branch: Option<String>,
    pub refs: Vec<GraphRef>,
    /// On HEAD, not on its upstream (not pushed).
    pub outgoing: Vec<String>,
    /// On the upstream, not on HEAD (not pulled).
    pub incoming: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// `A`, `M`, `D`, `R`, `C` or `T`.
    pub status: String,
    /// Repo-relative, `/`-separated, as git spells it.
    pub path: String,
    /// The path before a rename or copy.
    pub old_path: Option<String>,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    #[serde(flatten)]
    pub commit: GraphCommit,
    pub message: String,
    /// Against the first parent; a root commit against the empty tree.
    pub files: Vec<CommitFile>,
    pub files_truncated: bool,
    /// `origin` on GitHub, as a web page: `#N` in the message links there.
    pub github_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFilePair {
    /// `None` when the file did not exist on that side.
    pub original: Option<String>,
    pub modified: Option<String>,
    pub binary: bool,
    /// A side is over 1 MB and `allow_large` was not set: neither side was read.
    pub too_large: bool,
}

fn run(repo: &Path, args: &[&str], label: &str) -> Result<Vec<u8>, AppError> {
    let mut command = git_command();
    command.args(args).current_dir(repo);
    Ok(checked_output(command, label)?.stdout)
}

fn run_text(repo: &Path, args: &[&str], label: &str) -> Result<String, AppError> {
    run(repo, args, label).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Like `run_text`, but a failure is an answer (`None`), not an error: "no HEAD yet", "no upstream".
fn try_text(repo: &Path, args: &[&str]) -> Option<String> {
    let output = git_command().args(args).current_dir(repo).output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn check_sha(sha: &str) -> Result<(), AppError> {
    if parse::is_hash_query(sha) {
        Ok(())
    } else {
        Err(AppError::Other(format!("Not a commit hash: {sha}")))
    }
}

fn check_revs(revs: &[String]) -> Result<(), AppError> {
    match revs.iter().find(|rev| !parse::is_safe_rev(rev)) {
        Some(rev) => Err(AppError::Other(format!("Not a revision: {rev}"))),
        None => Ok(()),
    }
}

pub fn git_graph_refs(repo_root: String) -> Result<GraphRefs, AppError> {
    let repo = resolve_repo_root(&repo_root)?;
    let raw = run_text(
        &repo,
        &["for-each-ref", parse::REFS_FORMAT, "refs/heads", "refs/remotes", "refs/tags"],
        "git for-each-ref",
    )?;
    let (refs, remote_default) = parse::parse_refs(&raw);
    let head = try_text(&repo, &["rev-parse", "--verify", "--quiet", "HEAD"]).map(|out| out.trim().to_string());
    let head_branch = refs.iter().find(|r| r.is_head);
    let detached = head.is_some() && head_branch.is_none();
    let shallow = try_text(&repo, &["rev-parse", "--is-shallow-repository"]).is_some_and(|out| out.trim() == "true");

    let local = |name: &str| refs.iter().any(|r| r.kind == GraphRefKind::Local && r.name == name);
    let default_branch = remote_default
        .map(|remote| {
            // `origin/main` → the local `main` when there is one: that is the branch people mean.
            let short = remote.split_once('/').map_or(remote.as_str(), |(_, name)| name);
            if local(short) { short.to_string() } else { remote }
        })
        .or_else(|| ["main", "master"].into_iter().find(|name| local(name)).map(str::to_string));

    let (outgoing, incoming) = match head_branch.and_then(|r| r.upstream.as_ref()) {
        Some(_) => {
            let max = format!("--max-count={MAX_SYNC_MARKS}");
            try_text(&repo, &["rev-list", "--left-right", &max, "HEAD...@{upstream}"])
                .map(|out| parse::parse_left_right(&out))
                .unwrap_or_default()
        }
        None => Default::default(),
    };

    Ok(GraphRefs { head, detached, shallow, default_branch, refs, outgoing, incoming })
}

/// `revs` (full ref names, `HEAD` or hashes) in topo order: a child is always above its parent.
///
/// shortcut: paging is `--skip`, so each page re-walks the pages before it; git's commit-graph
/// makes that cheap well past 10 k commits. Move to a cursor if a huge repo shows it.
pub fn git_graph_log(repo_root: String, revs: Vec<String>, skip: u32, limit: u32) -> Result<Vec<GraphCommit>, AppError> {
    if revs.is_empty() {
        return Ok(Vec::new());
    }
    check_revs(&revs)?;
    let repo = resolve_repo_root(&repo_root)?;
    let skip = format!("--skip={skip}");
    let limit = format!("--max-count={}", limit.clamp(1, MAX_PAGE));
    let raw = log_with_stdin(&repo, &["--topo-order", &skip, &limit], &revs)?;
    Ok(parse::parse_log(&raw))
}

fn log_with_stdin(repo: &Path, extra: &[&str], revs: &[String]) -> Result<String, AppError> {
    let mut command = git_command();
    command
        .arg("log")
        .arg(parse::LOG_FORMAT)
        .args(extra)
        .arg("--stdin")
        .current_dir(repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|err| AppError::Other(format!("git log failed: {err}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        // Dropped at the end of this block: git reads to EOF before it starts walking.
        stdin
            .write_all(revs.join("\n").as_bytes())
            .and_then(|()| stdin.write_all(b"\n"))
            .map_err(|err| AppError::Other(format!("git log failed: {err}")))?;
    }
    let output = child.wait_with_output().map_err(|err| AppError::Other(format!("git log failed: {err}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::Other(if stderr.is_empty() { "git log failed".to_string() } else { stderr }));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The whole history of `revs`, matched by message or author (case-insensitive, plain text), and
/// by hash. Newest first; a hash match leads.
pub fn git_graph_search(repo_root: String, revs: Vec<String>, query: String, limit: u32) -> Result<Vec<GraphCommit>, AppError> {
    let query = query.trim().to_string();
    if query.is_empty() || revs.is_empty() {
        return Ok(Vec::new());
    }
    check_revs(&revs)?;
    let repo = resolve_repo_root(&repo_root)?;
    let limit = limit.clamp(1, MAX_PAGE) as usize;
    let max = format!("--max-count={limit}");

    let mut found = Vec::new();
    if parse::is_hash_query(&query) {
        let spec = format!("{query}^{{commit}}");
        if let Some(sha) = try_text(&repo, &["rev-parse", "--verify", "--quiet", &spec]) {
            let raw = run_text(&repo, &["log", "-1", parse::LOG_FORMAT, sha.trim()], "git log")?;
            found.extend(parse::parse_log(&raw));
        }
    }
    // `--grep` and `--author` together would mean both; each is its own pass, then merged.
    let grep = format!("--grep={query}");
    let author = format!("--author={query}");
    for pattern in [&grep, &author] {
        let raw = log_with_stdin(&repo, &["-i", "--fixed-strings", pattern, &max], &revs)?;
        found.extend(parse::parse_log(&raw));
    }
    let lead = usize::from(found.first().is_some_and(|c| c.sha.starts_with(&query)));
    found[lead..].sort_by(|a, b| b.time.cmp(&a.time));
    let mut seen = std::collections::HashSet::new();
    found.retain(|commit| seen.insert(commit.sha.clone()));
    found.truncate(limit);
    Ok(found)
}

pub fn git_graph_commit(repo_root: String, sha: String) -> Result<CommitDetail, AppError> {
    check_sha(&sha)?;
    let repo = resolve_repo_root(&repo_root)?;
    let raw = run_text(&repo, &["show", "-s", parse::DETAIL_FORMAT, &sha, "--"], "git show")?;
    let (commit, message) = parse::parse_detail(&raw).ok_or_else(|| AppError::Other(format!("No such commit: {sha}")))?;

    let tree_diff = |mode: &str| -> Result<String, AppError> {
        let sha = commit.sha.as_str();
        let mut args = vec!["diff-tree", "-r", "-M", "-z", mode];
        match commit.parents.first() {
            Some(parent) => args.extend([parent.as_str(), sha]),
            None => args.extend(["--root", sha]),
        }
        run_text(&repo, &args, "git diff-tree")
    };
    let names = tree_diff("--name-status")?;
    let mut files = parse::parse_name_status_z(strip_root_sha(&names, &commit.sha));
    let counts = tree_diff("--numstat")?;
    parse::merge_numstat(&mut files, &parse::parse_numstat_z(strip_root_sha(&counts, &commit.sha)));

    let files_truncated = files.len() > MAX_COMMIT_FILES;
    files.truncate(MAX_COMMIT_FILES);
    Ok(CommitDetail { commit, message, files, files_truncated, github_url: github_url(&repo) })
}

fn github_url(repo: &Path) -> Option<String> {
    try_text(repo, &["remote", "get-url", "origin"]).and_then(|url| parse::github_web_url(&url))
}

/// `diff-tree --root <sha>` prints the commit's own hash first; two trees do not.
fn strip_root_sha<'a>(raw: &'a str, sha: &str) -> &'a str {
    raw.strip_prefix(sha).map_or(raw, |rest| rest.trim_start_matches(['\0', '\n']))
}

/// Both sides of one file in a commit, for the diff view. `parent` is the commit's first parent
/// (`None` for a root commit); `old_path` is the path before a rename.
pub fn git_graph_file_pair(
    repo_root: String,
    sha: String,
    parent: Option<String>,
    path: String,
    old_path: Option<String>,
    status: String,
    allow_large: bool,
) -> Result<CommitFilePair, AppError> {
    check_sha(&sha)?;
    if let Some(parent) = &parent {
        check_sha(parent)?;
    }
    let repo = resolve_repo_root(&repo_root)?;
    let original_spec = match (&parent, status.as_str()) {
        (Some(parent), status) if status != "A" => Some(format!("{parent}:{}", old_path.as_deref().unwrap_or(&path))),
        _ => None,
    };
    let modified_spec = (status != "D").then(|| format!("{sha}:{path}"));
    let specs = [original_spec.as_deref(), modified_spec.as_deref()];

    if !allow_large {
        for spec in specs.into_iter().flatten() {
            let size = try_text(&repo, &["cat-file", "-s", spec]).and_then(|out| out.trim().parse::<u64>().ok());
            if size.is_some_and(|size| size > MAX_DIFF_BYTES) {
                return Ok(CommitFilePair { original: None, modified: None, binary: false, too_large: true });
            }
        }
    }
    let mut binary = false;
    let mut read = |spec: Option<&str>| -> Result<Option<String>, AppError> {
        let Some(spec) = spec else { return Ok(None) };
        let bytes = run(&repo, &["cat-file", "blob", spec], "git cat-file")?;
        binary |= bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0);
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    };
    let original = read(specs[0])?;
    let modified = read(specs[1])?;
    if binary {
        return Ok(CommitFilePair { original: None, modified: None, binary: true, too_large: false });
    }
    Ok(CommitFilePair { original, modified, binary, too_large: false })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// A throwaway repository with a branch, a merge, a rename, a binary file and a tag.
    fn fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let status = git_command()
                .args(["-c", "user.name=T", "-c", "user.email=t@x", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"])
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(status.status.success(), "{args:?}: {}", String::from_utf8_lossy(&status.stderr));
        };
        git(&["init", "-q"]);
        std::fs::write(root.join("a.txt"), "one\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "first"]);
        git(&["checkout", "-qb", "feature"]);
        std::fs::rename(root.join("a.txt"), root.join("b.txt")).unwrap();
        std::fs::write(root.join("img.bin"), [0u8, 1, 2, 0, 3]).unwrap();
        git(&["add", "-A"]);
        git(&["commit", "-qm", "rename and image"]);
        git(&["checkout", "-q", "main"]);
        std::fs::write(root.join("c.txt"), "three\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "Fix the parser"]);
        git(&["merge", "-q", "--no-ff", "-m", "Merge feature", "feature"]);
        git(&["tag", "-a", "v1", "-m", "v1"]);
        let path = root.to_string_lossy().into_owned();
        (dir, path)
    }

    fn has_git() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    #[test]
    fn reads_refs_log_search_and_a_commit_from_a_real_repository() {
        if !has_git() {
            return;
        }
        let (_dir, repo) = fixture();

        let refs = git_graph_refs(repo.clone()).unwrap();
        assert!(!refs.detached);
        assert_eq!(refs.default_branch.as_deref(), Some("main"));
        let main = refs.refs.iter().find(|r| r.name == "main").unwrap();
        assert!(main.is_head);
        let tag = refs.refs.iter().find(|r| r.name == "v1").unwrap();
        assert_eq!(tag.target, main.target, "the annotated tag is peeled to the merge");

        let log = git_graph_log(repo.clone(), vec!["refs/heads/main".into()], 0, 50).unwrap();
        assert_eq!(log.len(), 4);
        assert_eq!(log[0].subject, "Merge feature");
        assert_eq!(log[0].parents.len(), 2);
        let page2 = git_graph_log(repo.clone(), vec!["refs/heads/main".into()], 2, 50).unwrap();
        assert_eq!(page2.len(), 2);

        let hits = git_graph_search(repo.clone(), vec!["refs/heads/main".into()], "parser".into(), 50).unwrap();
        assert_eq!(hits.len(), 1);
        let by_hash = git_graph_search(repo.clone(), vec!["refs/heads/main".into()], log[3].sha[..8].into(), 50).unwrap();
        assert_eq!(by_hash[0].sha, log[3].sha);

        let renamed = log.iter().find(|c| c.subject == "rename and image").unwrap();
        let detail = git_graph_commit(repo.clone(), renamed.sha.clone()).unwrap();
        let rename = detail.files.iter().find(|f| f.status == "R").unwrap();
        assert_eq!(rename.old_path.as_deref(), Some("a.txt"));
        assert!(detail.files.iter().any(|f| f.path == "img.bin" && f.binary));

        let pair = git_graph_file_pair(
            repo.clone(),
            renamed.sha.clone(),
            renamed.parents.first().cloned(),
            "b.txt".into(),
            Some("a.txt".into()),
            "R".into(),
            false,
        )
        .unwrap();
        assert_eq!(pair.original.as_deref(), Some("one\n"));
        assert_eq!(pair.modified.as_deref(), Some("one\n"));

        let image = git_graph_file_pair(repo.clone(), renamed.sha.clone(), renamed.parents.first().cloned(), "img.bin".into(), None, "A".into(), false).unwrap();
        assert!(image.binary);

        let root = log.last().unwrap();
        let first = git_graph_commit(repo, root.sha.clone()).unwrap();
        assert_eq!(first.files.len(), 1, "a root commit lists its files against the empty tree");
        assert_eq!(first.files[0].path, "a.txt");
    }

    #[test]
    fn refuses_revisions_that_git_would_read_as_options() {
        let err = git_graph_log(".".into(), vec!["--output=/tmp/x".into()], 0, 10).unwrap_err();
        assert!(err.to_string().contains("Not a revision"));
        assert!(git_graph_commit(".".into(), "HEAD; rm".into()).is_err());
    }
}
