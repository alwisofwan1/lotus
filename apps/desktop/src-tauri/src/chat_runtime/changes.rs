//! The Workbench Changes drawer (#281, mockup `lotus-chat.fig` page "05a Changes", board B).
//!
//! Git cannot tell whose edit is whose, so the chat keeps two things beside it: which files the
//! agent changed (its `fileChange` items, from any provider) and snapshots of the folder. A
//! snapshot is a tree object written through a throwaway index, so neither the user's index nor
//! the stash moves. One is taken when a message starts a new turn (before the agent can act) and
//! one when a turn completes.
//!
//! - Undo puts a file back as it was in the last snapshot before the agent first edited it, so the
//!   user's earlier work in that file survives; a file absent there was created by the agent and
//!   is deleted.
//! - "Also yours": the file already differed from HEAD before the agent's first edit, or it
//!   changed after the turn that last edited it ended. Undo would lose the second kind.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::store::{event_type, Envelope};
use crate::codespace_git::{
    checked_output, codespace_git_status, git_command, git_relative_path, resolve_repo_relative_path,
    resolve_repo_root, untracked_file_diff, CodespaceGitChangeKind,
};

/// Git's empty tree, to diff against in a repository that has no commit yet.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Taken when a message starts a new turn.
    Before,
    /// Taken when a turn completes.
    After,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Before => "before",
            Phase::After => "after",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    /// The last event seq when it was taken.
    pub seq: u64,
    pub phase: Phase,
    pub tree: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relative to the repository root, with `/`.
    pub path: String,
    /// "added", "modified" or "deleted", against HEAD.
    pub status: &'static str,
    /// None for a binary file.
    pub added: Option<u32>,
    pub removed: Option<u32>,
    /// The chat's agent changed it.
    pub agent: bool,
    /// It already differed from HEAD before the agent's first edit.
    pub yours_before: bool,
    /// It changed after the turn that last edited it ended; undo would lose that.
    pub yours_after: bool,
    /// A snapshot from before the agent's first edit exists, so undo knows what to put back.
    pub undoable: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    /// None when the folder is not in a git repository.
    pub branch: Option<String>,
    /// The chat's folder inside the repository, "" or ending in "/"; `files` paths start with it.
    pub prefix: String,
    pub files: Vec<ChangedFile>,
    /// Set for a delegated chat working in its own worktree: what its branch would bring to the lead.
    pub delegated: Option<Delegated>,
}

/// A remote chat's changes (plans/chat-remote-host): no repository here, so the list is the
/// agent's own edit steps with the host's line counts. Paths are made relative to `cwd`.
pub fn remote(cwd: &str, events: &[Envelope]) -> Changes {
    let root = format!("{}/", cwd.trim_end_matches('/'));
    let mut files: Vec<ChangedFile> = Vec::new();
    for envelope in events {
        let item = &envelope.event["item"];
        if event_type(&envelope.event) != "item/completed" || item["kind"] != "fileChange" {
            continue;
        }
        let Some(path) = item["path"].as_str() else { continue };
        let path = path.strip_prefix(&root).unwrap_or(path).to_string();
        let count = |key: &str| item[key].as_u64().map(|n| n as u32);
        let add = |a: Option<u32>, b: Option<u32>| match (a, b) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        match files.iter_mut().find(|f| f.path == path) {
            Some(file) => {
                file.added = add(file.added, count("added"));
                file.removed = add(file.removed, count("removed"));
            }
            None => files.push(ChangedFile {
                status: if item["change"] == "create" { "added" } else { "modified" },
                path,
                added: count("added"),
                removed: count("removed"),
                agent: true,
                yours_before: false,
                yours_after: false,
                undoable: false,
            }),
        }
    }
    Changes { branch: None, prefix: String::new(), files, delegated: None }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Delegated {
    /// The child's worktree branch.
    pub branch: String,
    /// The lead's current branch, which a merge goes into.
    pub into: String,
    /// "<short sha> <subject>" for each commit on `branch` that `into` lacks, newest first.
    pub commits: Vec<String>,
    /// Files changed in the child's worktree but not committed; a merge would leave them behind.
    pub uncommitted: usize,
}

fn git(repo: &Path, args: &[&str], label: &str) -> Result<Vec<u8>, String> {
    let mut command = git_command();
    command.args(args).current_dir(repo);
    checked_output(command, label)
        .map(|o| o.stdout)
        .map_err(|e| e.to_string())
}

fn git_text(repo: &Path, args: &[&str]) -> Option<String> {
    let mut command = git_command();
    command.args(args).current_dir(repo);
    let out = command.output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub fn repo_root(cwd: &str) -> Option<PathBuf> {
    resolve_repo_root(cwd).ok()
}

/// The whole working tree (tracked and untracked, minus ignored files) as a tree object.
// shortcut: the tree and its blobs are unreferenced, so `git gc` prunes them after its grace
// period (two weeks by default) and undo then refuses (see `exists`); keep a ref per thread if
// undo must reach further back.
pub fn snapshot(repo: &Path) -> Result<String, String> {
    let index = PathBuf::from(
        git_text(repo, &["rev-parse", "--path-format=absolute", "--git-path", "index"])
            .ok_or("not a git repository")?,
    );
    let temp = std::env::temp_dir().join(format!("lotus-chat-index-{}", uuid::Uuid::new_v4()));
    // Starting from the real index keeps `add` to what changed instead of hashing every file.
    if index.is_file() {
        std::fs::copy(&index, &temp).map_err(|e| format!("copy the index: {e}"))?;
    }
    let run = |args: &[&str]| -> Result<Vec<u8>, String> {
        let mut command = git_command();
        command.args(args).env("GIT_INDEX_FILE", &temp).current_dir(repo);
        checked_output(command, "git snapshot")
            .map(|o| o.stdout)
            .map_err(|e| e.to_string())
    };
    let tree = run(&["add", "-A"]).and_then(|_| run(&["write-tree"]));
    let _ = std::fs::remove_file(&temp);
    Ok(String::from_utf8_lossy(&tree?).trim().to_string())
}

/// One file the agent changed.
#[derive(Clone, Copy)]
struct AgentEdit {
    /// The seqs of its first and of its last edit.
    first: u64,
    last: u64,
    /// The agent named it in a `fileChange` item; false when only a command turn's snapshots show
    /// it changed, which may be the user's own edit made meanwhile, so undo refuses it.
    named: bool,
}

/// The files the agent changed, by repo-relative path.
///
/// Its `fileChange` items name their files. A command can write files too (Codex often creates one
/// with `printf … > f`, #286), so a turn that ran one also claims every file in the chat's folder
/// that differs between its Before and After snapshots. Git cannot tell those from the user's own
/// edits made while the turn ran, so they are shown as the agent's but never undone.
fn agent_edits(repo: &Path, cwd: &str, events: &[Envelope], snapshots: &[Snapshot]) -> HashMap<String, AgentEdit> {
    let mut edits: HashMap<String, AgentEdit> = HashMap::new();
    let mut claim = |path: String, first: u64, last: u64, named: bool| {
        edits
            .entry(path)
            .and_modify(|e| {
                e.first = e.first.min(first);
                e.last = e.last.max(last);
                e.named |= named;
            })
            .or_insert(AgentEdit { first, last, named });
    };
    let prefix = git_text(Path::new(cwd), &["rev-parse", "--show-prefix"]).unwrap_or_default();
    for end in snapshots.iter().filter(|s| s.phase == Phase::After) {
        let Some(start) = before(repo, snapshots, end.seq) else { continue };
        let ran_command = events
            .iter()
            .any(|e| e.seq > start.seq && e.seq <= end.seq && e.event["item"]["kind"] == "command");
        if !ran_command || !exists(repo, end) {
            continue;
        }
        let mut args = vec!["diff", "--name-only", "--no-renames", "-z", &start.tree, &end.tree, "--"];
        if !prefix.is_empty() {
            args.push(&prefix);
        }
        let Ok(out) = git(repo, &args, "git diff") else {
            continue;
        };
        for path in out.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            // `before(.., first)` must find `start` again, and `after(.., last)` must find `end`.
            claim(String::from_utf8_lossy(path).into_owned(), start.seq + 1, end.seq, false);
        }
    }
    for envelope in events {
        if !matches!(event_type(&envelope.event), "item/started" | "item/completed") {
            continue;
        }
        let item = &envelope.event["item"];
        if item["kind"] != "fileChange" {
            continue;
        }
        let Some(path) = item["path"].as_str() else { continue };
        let Some(relative) = relative_path(repo, cwd, path) else { continue };
        claim(relative, envelope.seq, envelope.seq, true);
    }
    edits
}

/// A path the agent reported (absolute, or relative to the chat's folder), relative to the repo.
fn relative_path(repo: &Path, cwd: &str, path: &str) -> Option<String> {
    let absolute = if Path::new(path).is_absolute() {
        PathBuf::from(path)
    } else {
        Path::new(cwd).join(path)
    };
    // A deleted file cannot be canonicalized, so its folder stands in for it.
    let resolved = match absolute.canonicalize() {
        Ok(p) => p,
        Err(_) => absolute.parent()?.canonicalize().ok()?.join(absolute.file_name()?),
    };
    resolve_repo_relative_path(repo, &resolved.to_string_lossy())
        .ok()
        .map(|p| git_relative_path(&p))
}

/// The blob id of `path` in `tree`, or None when the tree does not have it.
fn blob(repo: &Path, tree: &str, path: &str) -> Option<String> {
    git_text(repo, &["rev-parse", "--verify", "--quiet", &format!("{tree}:{path}")])
}

fn worktree_blob(repo: &Path, path: &str) -> Option<String> {
    repo.join(path)
        .is_file()
        .then(|| git_text(repo, &["hash-object", "--", path]))
        .flatten()
}

fn head(repo: &Path) -> String {
    git_text(repo, &["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]).unwrap_or_else(|| EMPTY_TREE.into())
}

/// `git gc` prunes an unreferenced tree after its grace period. A missing one must never read as
/// "the file did not exist then": undo would delete the file instead of restoring it.
fn exists(repo: &Path, snapshot: &Snapshot) -> bool {
    git_text(repo, &["cat-file", "-e", &format!("{}^{{tree}}", snapshot.tree)]).is_some()
}

/// The last `Before` snapshot taken before `seq`, if git still has it.
fn before<'a>(repo: &Path, snapshots: &'a [Snapshot], seq: u64) -> Option<&'a Snapshot> {
    snapshots
        .iter()
        .filter(|s| s.phase == Phase::Before && s.seq < seq)
        .max_by_key(|s| s.seq)
        .filter(|s| exists(repo, s))
}

/// The first `After` snapshot taken at or after `seq`, if git still has it.
fn after<'a>(repo: &Path, snapshots: &'a [Snapshot], seq: u64) -> Option<&'a Snapshot> {
    snapshots
        .iter()
        .filter(|s| s.phase == Phase::After && s.seq >= seq)
        .min_by_key(|s| s.seq)
        .filter(|s| exists(repo, s))
}

fn numstat(repo: &Path, base: &str) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let text = git_text(repo, &["diff", base, "--numstat", "--no-renames", "--no-color"]).unwrap_or_default();
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let added = parts.next()?.parse().ok();
            let removed = parts.next()?.parse().ok();
            Some((parts.next()?.to_string(), (added, removed)))
        })
        .collect()
}

pub fn list(cwd: &str, events: &[Envelope], snapshots: &[Snapshot]) -> Result<Changes, String> {
    let Some(repo) = repo_root(cwd) else {
        return Ok(Changes { branch: None, prefix: String::new(), files: Vec::new(), delegated: None });
    };
    let branch = git_text(&repo, &["branch", "--show-current"])
        .filter(|b| !b.is_empty())
        .or_else(|| git_text(&repo, &["rev-parse", "--short", "HEAD"]))
        .unwrap_or_else(|| "no commits".into());
    let base = head(&repo);
    let stats = numstat(&repo, &base);
    let edits = agent_edits(&repo, cwd, events, snapshots);
    let statuses = codespace_git_status(repo.to_string_lossy().into_owned()).map_err(|e| e.to_string())?;

    let mut files: Vec<ChangedFile> = statuses
        .into_iter()
        .map(|s| {
            let untracked = s.unstaged == Some(CodespaceGitChangeKind::Untracked);
            let deleted = [s.staged, s.unstaged].contains(&Some(CodespaceGitChangeKind::Deleted));
            let (added, removed) = if untracked {
                let lines = std::fs::read(repo.join(&s.relative_path))
                    .ok()
                    .filter(|bytes| !bytes.contains(&0))
                    .map(|bytes| bytes.iter().filter(|b| **b == b'\n').count() as u32);
                (lines, lines.map(|_| 0))
            } else {
                stats.get(&s.relative_path).copied().unwrap_or((None, None))
            };
            let in_head = blob(&repo, &base, &s.relative_path).is_some();
            let mut file = ChangedFile {
                status: if deleted {
                    "deleted"
                } else if !in_head {
                    "added"
                } else {
                    "modified"
                },
                path: s.relative_path,
                added,
                removed,
                agent: false,
                yours_before: false,
                yours_after: false,
                undoable: false,
            };
            if let Some(&AgentEdit { first, last, named }) = edits.get(&file.path) {
                file.agent = true;
                if let Some(snap) = before(&repo, snapshots, first) {
                    file.undoable = named;
                    file.yours_before = blob(&repo, &snap.tree, &file.path) != blob(&repo, &base, &file.path);
                }
                if let Some(snap) = after(&repo, snapshots, last) {
                    file.yours_after = worktree_blob(&repo, &file.path) != blob(&repo, &snap.tree, &file.path);
                }
            }
            file
        })
        .collect();
    files.sort_by(|a, b| b.agent.cmp(&a.agent).then_with(|| a.path.cmp(&b.path)));
    let prefix = git_text(Path::new(cwd), &["rev-parse", "--show-prefix"]).unwrap_or_default();
    Ok(Changes { branch: Some(branch), prefix, files, delegated: None })
}

/// A path from the webview: relative and inside the repository.
fn checked(path: &str) -> Result<&str, String> {
    let inside = Path::new(path)
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    if path.is_empty() || !inside {
        return Err(format!("{path} is not a path inside the repository"));
    }
    Ok(path)
}

/// The file's diff against HEAD, as `git diff` prints it; `ignore_whitespace` adds `-w`.
pub fn diff(cwd: &str, path: &str, ignore_whitespace: bool) -> Result<String, String> {
    let repo = repo_root(cwd).ok_or("not a git repository")?;
    let path = checked(path)?;
    let file = repo.join(path);
    let tracked = git_text(&repo, &["ls-files", "--error-unmatch", "--", path]).is_some();
    if !tracked && file.is_file() {
        let content = std::fs::read_to_string(&file).map_err(|e| format!("read {path}: {e}"))?;
        return Ok(untracked_file_diff(path, &content));
    }
    let base = head(&repo);
    let mut args = vec!["diff", base.as_str(), "--no-color", "--no-renames"];
    if ignore_whitespace {
        args.push("-w");
    }
    args.extend(["--", path]);
    let out = git(&repo, &args, "git diff")?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// Commits exactly `paths`, as they are in the folder; whatever else is staged stays staged.
pub fn commit(cwd: &str, paths: &[String], message: &str) -> Result<String, String> {
    let repo = repo_root(cwd).ok_or("not a git repository")?;
    let message = message.trim();
    if message.is_empty() {
        return Err("write a commit message".into());
    }
    if paths.is_empty() {
        return Err("no files picked".into());
    }
    for path in paths {
        checked(path)?;
    }
    let mut add = vec!["add", "-A", "--"];
    add.extend(paths.iter().map(String::as_str));
    git(&repo, &add, "git add")?;
    let mut commit = vec!["commit", "-m", message, "--"];
    commit.extend(paths.iter().map(String::as_str));
    git(&repo, &commit, "git commit")?;
    git_text(&repo, &["rev-parse", "--short", "HEAD"]).ok_or_else(|| "committed, but HEAD is unreadable".into())
}

/// Puts each of `paths` back as it was before the agent's first edit. Refuses the whole call if
/// one of them has no snapshot to go back to or was not changed by the agent.
pub fn undo(cwd: &str, paths: &[String], events: &[Envelope], snapshots: &[Snapshot]) -> Result<(), String> {
    let repo = repo_root(cwd).ok_or("not a git repository")?;
    let edits = agent_edits(&repo, cwd, events, snapshots);
    let mut plan = Vec::new();
    for path in paths {
        let edit = edits.get(path).ok_or_else(|| format!("{path} was not changed in this chat"))?;
        if !edit.named {
            return Err(format!("{path} changed during a command, maybe by you too; Lotus does not undo it"));
        }
        let first = edit.first;
        let snap = before(&repo, snapshots, first).ok_or_else(|| format!("Lotus has no copy of {path} from before the edit"))?;
        plan.push((path, blob(&repo, &snap.tree, path)));
    }
    for (path, blob) in plan {
        let file = repo.join(path);
        match blob {
            Some(id) => {
                let bytes = git(&repo, &["cat-file", "blob", &id], "git cat-file")?;
                if let Some(dir) = file.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| format!("{path}: {e}"))?;
                }
                std::fs::write(&file, bytes).map_err(|e| format!("{path}: {e}"))?;
            }
            None if file.exists() => std::fs::remove_file(&file).map_err(|e| format!("{path}: {e}"))?,
            None => {}
        }
    }
    Ok(())
}

/// A new worktree at `path` on a new `branch` from HEAD, its files set to `tree` (a snapshot) and
/// left uncommitted, so the agent and the user see what differs from HEAD. Ignored files
/// (node_modules, builds) are not in a snapshot and so not in the worktree.
pub fn worktree_at(repo: &Path, tree: &str, branch: &str, path: &Path) -> Result<(), String> {
    if git_text(repo, &["cat-file", "-e", &format!("{tree}^{{tree}}")]).is_none() {
        return Err("git no longer has that turn's files (unreferenced snapshots are pruned after about two weeks)".into());
    }
    let at = path.to_string_lossy();
    git(repo, &["worktree", "add", "-q", "-b", branch, &at, "HEAD"], "git worktree add")?;
    git(path, &["read-tree", "-u", "--reset", tree], "git read-tree")?;
    git(path, &["reset", "-q"], "git reset")?;
    Ok(())
}

/// A Lotus-made worktree as git sees it: its branch, the repository's main worktree, and what
/// removing it would lose (`None`: nothing).
pub struct WorktreeState {
    pub branch: String,
    pub main: PathBuf,
    pub loses: Option<String>,
}

/// Never a worktree on the main worktree's own branch: removing that branch is not Lotus's call.
/// Loss is checked by patch (`git cherry`), so work that reached the main branch by cherry-pick or
/// rebase counts as kept.
pub fn worktree_state(path: &Path) -> Result<WorktreeState, String> {
    let branch = current_branch(path).ok_or("not on a branch")?;
    let status = git_text(path, &["status", "--porcelain"]).ok_or("git status failed")?;
    let common = git_text(path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).ok_or("no git dir")?;
    let main = Path::new(&common).parent().ok_or("no main worktree")?.to_path_buf();
    let into = current_branch(&main).ok_or("the main worktree is not on a branch")?;
    if into == branch {
        return Err(format!("it is on {into}, the main worktree's branch"));
    }
    let loses = if !status.is_empty() {
        Some(format!("{} uncommitted files", status.lines().count()))
    } else {
        let cherry = git_text(&main, &["cherry", &into, &branch]).ok_or("git cherry failed")?;
        let unmerged = cherry.lines().filter(|l| l.starts_with('+')).count();
        (unmerged > 0).then(|| format!("{unmerged} commits not in {into}"))
    };
    Ok(WorktreeState { branch, main, loses })
}

fn remove_worktree(path: &Path, state: &WorktreeState, force: bool) -> Result<(), String> {
    let path = path.to_string_lossy();
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&path);
    git(&state.main, &args, "git worktree remove")?;
    git(&state.main, &["branch", "-D", &state.branch], "git branch -D")?;
    Ok(())
}

/// Removes a Lotus-made worktree and its branch, but only when that loses nothing
/// (`worktree_state`). `Err` says why it was kept.
pub fn reap_worktree(path: &Path) -> Result<(), String> {
    let state = worktree_state(path)?;
    if let Some(why) = &state.loses {
        return Err(why.clone());
    }
    remove_worktree(path, &state, false)
}

/// Removes a Lotus-made worktree and its branch even though work is lost: the user chose Discard.
/// Only a `lotus/…` branch, so a worktree someone else made is never deleted. Returns the branch.
pub fn discard_worktree(path: &Path) -> Result<String, String> {
    let state = worktree_state(path)?;
    if !state.branch.starts_with("lotus/") {
        return Err(format!("{} is not a branch Lotus made", state.branch));
    }
    remove_worktree(path, &state, true)?;
    Ok(state.branch)
}

/// Bytes under `path`, not following links. Best effort: what cannot be read counts as nothing.
pub fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path).into_iter().flatten().flatten().map(|e| dir_size(&e.path())).sum()
}

fn current_branch(repo: &Path) -> Option<String> {
    git_text(repo, &["branch", "--show-current"]).filter(|b| !b.is_empty())
}

/// What a child chat did on its own worktree branch, against the lead's branch. None unless the
/// child works in another worktree of the lead's repository and both are on a branch.
pub fn delegated(child_cwd: &str, lead_cwd: &str) -> Option<Delegated> {
    let (child, lead) = (repo_root(child_cwd)?, repo_root(lead_cwd)?);
    let common = |repo: &Path| git_text(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if child == lead || common(&child)? != common(&lead)? {
        return None;
    }
    let (branch, into) = (current_branch(&child)?, current_branch(&lead)?);
    let log = git_text(&lead, &["log", "--format=%h %s", &format!("{into}..{branch}")])?;
    let status = git_text(&child, &["status", "--porcelain"])?;
    Some(Delegated {
        branch,
        into,
        commits: log.lines().map(str::to_string).collect(),
        uncommitted: status.lines().count(),
    })
}

/// Merges the child's committed work into the lead's branch (`--no-ff`, so it can be reverted as
/// one commit). A conflict is aborted, never left half-merged in the lead's folder.
pub fn merge(child_cwd: &str, lead_cwd: &str) -> Result<String, String> {
    let d = delegated(child_cwd, lead_cwd).ok_or("this chat does not work on its own branch of the lead's repository")?;
    if d.uncommitted > 0 {
        return Err(format!("{} has {} uncommitted files; commit them first", d.branch, d.uncommitted));
    }
    if d.commits.is_empty() {
        return Err(format!("nothing to merge: {} has no commits that {} lacks", d.branch, d.into));
    }
    let lead = repo_root(lead_cwd).ok_or("not a git repository")?;
    let message = format!("Merge {} into {}", d.branch, d.into);
    if let Err(error) = git(&lead, &["merge", "--no-ff", "--no-edit", "-m", &message, &d.branch], "git merge") {
        if git_text(&lead, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_none() {
            return Err(error); // refused before starting, e.g. the lead's own edits are in the way
        }
        let conflicts = git_text(&lead, &["diff", "--name-only", "--diff-filter=U"]).unwrap_or_default();
        git(&lead, &["merge", "--abort"], "git merge --abort")?;
        return Err(format!(
            "{} conflicts with {} in: {}. Nothing was merged; ask the agent to rebase onto {}",
            d.branch,
            d.into,
            conflicts.lines().collect::<Vec<_>>().join(", "),
            d.into
        ));
    }
    git_text(&lead, &["rev-parse", "--short", "HEAD"]).ok_or_else(|| "merged, but HEAD is unreadable".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sh(repo: &Path, args: &[&str]) {
        git(repo, args, "test git").unwrap();
    }

    fn edit(seq: u64, path: &Path) -> Envelope {
        Envelope {
            thread_id: "t".into(),
            seq,
            at: 0,
            event: json!({ "type": "item/completed", "turnId": "u", "item": {
                "id": format!("i{seq}"), "status": "completed", "kind": "fileChange",
                "path": path.to_string_lossy(), "change": "edit", "patch": null } }),
        }
    }

    #[test]
    fn undo_keeps_the_users_earlier_work_and_commit_takes_only_the_picked_files() {
        let dir = std::env::temp_dir().join(format!("lotus-changes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.canonicalize().unwrap();
        sh(&repo, &["init", "-q"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("f"), "a\n").unwrap();
        sh(&repo, &["add", "f"]);
        sh(&repo, &["commit", "-qm", "init"]);
        let cwd = repo.to_string_lossy().into_owned();

        // The user's edit, then a turn: the agent edits f and creates n.
        std::fs::write(repo.join("f"), "a\nuser\n").unwrap();
        let mut snaps = vec![Snapshot { seq: 0, phase: Phase::Before, tree: snapshot(&repo).unwrap() }];
        std::fs::write(repo.join("f"), "a\nuser\nagent\n").unwrap();
        std::fs::write(repo.join("n"), "new\n").unwrap();
        let events = vec![edit(1, &repo.join("f")), edit(2, &repo.join("n"))];
        snaps.push(Snapshot { seq: 3, phase: Phase::After, tree: snapshot(&repo).unwrap() });
        // After the turn: the user edits f again and writes a file of their own.
        std::fs::write(repo.join("f"), "a\nuser\nagent\nlater\n").unwrap();
        std::fs::write(repo.join("o"), "mine\n").unwrap();

        let files = list(&cwd, &events, &snaps).unwrap().files;
        let f = files.iter().find(|x| x.path == "f").unwrap();
        assert!(f.agent && f.undoable && f.yours_before && f.yours_after);
        assert_eq!((f.added, f.removed), (Some(3), Some(0)));
        let n = files.iter().find(|x| x.path == "n").unwrap();
        assert!(n.agent && n.status == "added" && !n.yours_before && !n.yours_after);
        assert!(!files.iter().find(|x| x.path == "o").unwrap().agent);

        // A pruned snapshot refuses instead of deleting.
        let gone = vec![Snapshot { seq: 0, phase: Phase::Before, tree: "1".repeat(40) }];
        assert!(undo(&cwd, &["f".into()], &events, &gone).is_err());
        assert!(repo.join("f").exists());

        undo(&cwd, &["f".into(), "n".into()], &events, &snaps).unwrap();
        assert_eq!(std::fs::read_to_string(repo.join("f")).unwrap(), "a\nuser\n");
        assert!(!repo.join("n").exists());
        assert!(undo(&cwd, &["o".into()], &events, &snaps).is_err(), "never the user's own files");

        commit(&cwd, &["o".into()], "add o").unwrap();
        let left = list(&cwd, &events, &snaps).unwrap().files;
        assert_eq!(left.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["f"]);
        assert!(diff(&cwd, "../etc/passwd", false).is_err());

        // Whitespace-only edits leave the -w diff empty.
        commit(&cwd, &["f".into()], "take f").unwrap();
        std::fs::write(repo.join("f"), "a\n   user\n").unwrap();
        assert!(diff(&cwd, "f", false).unwrap().contains("+   user"));
        assert!(!diff(&cwd, "f", true).unwrap().contains("+   user"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn command(seq: u64) -> Envelope {
        Envelope {
            thread_id: "t".into(),
            seq,
            at: 0,
            event: json!({ "type": "item/completed", "turnId": "u", "item": {
                "id": format!("c{seq}"), "status": "completed", "kind": "command",
                "command": "printf hi > s", "description": null, "output": "" } }),
        }
    }

    #[test]
    fn a_file_written_by_a_command_is_shown_as_the_agents_but_never_undone() {
        let dir = std::env::temp_dir().join(format!("lotus-changes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.canonicalize().unwrap();
        sh(&repo, &["init", "-q"]);
        std::fs::write(repo.join("keep"), "k\n").unwrap();
        let cwd = repo.to_string_lossy().into_owned();
        let mut snaps = Vec::new();
        let mut take = |seq, phase| snaps.push(Snapshot { seq, phase, tree: snapshot(&repo).unwrap() });

        // Turn 1 runs a command that writes s.
        take(0, Phase::Before);
        std::fs::write(repo.join("s"), "hi").unwrap();
        take(2, Phase::After);
        // Turn 2 only edits e through a fileChange, while the user writes u.
        take(2, Phase::Before);
        std::fs::write(repo.join("e"), "e\n").unwrap();
        std::fs::write(repo.join("u"), "mine\n").unwrap();
        take(4, Phase::After);
        let events = vec![command(1), edit(3, &repo.join("e"))];

        let files = list(&cwd, &events, &snaps).unwrap().files;
        let agent = |p: &str| files.iter().find(|x| x.path == p).unwrap().agent;
        assert!(agent("s") && agent("e"));
        assert!(!agent("u") && !agent("keep"));
        // s may be the user's own edit made during the command turn, so it is never undone.
        assert!(!files.iter().find(|x| x.path == "s").unwrap().undoable);
        assert!(undo(&cwd, &["s".into()], &events, &snaps).is_err());
        assert!(repo.join("s").exists());

        // A chat in a subfolder does not claim s, which is outside it.
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        let sub = repo.join("sub").to_string_lossy().into_owned();
        assert!(!list(&sub, &events, &snaps).unwrap().files.iter().find(|x| x.path == "s").unwrap().agent);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_worktree_at_a_snapshot_has_that_turns_files_uncommitted_on_a_branch_from_head() {
        let dir = std::env::temp_dir().join(format!("lotus-fork-wt-{}", uuid::Uuid::new_v4()));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.canonicalize().unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@t"]);
        sh(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("a"), "1\n").unwrap();
        std::fs::write(repo.join("gone"), "x\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "base"]);
        // Turn N left: a edited, gone deleted, new created.
        std::fs::write(repo.join("a"), "2\n").unwrap();
        std::fs::remove_file(repo.join("gone")).unwrap();
        std::fs::write(repo.join("new"), "n\n").unwrap();
        let tree = snapshot(&repo).unwrap();
        // Later the folder moved on.
        std::fs::write(repo.join("a"), "3\n").unwrap();

        let wt = dir.join("wt");
        worktree_at(&repo, &tree, "lotus/f-test", &wt).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join("a")).unwrap(), "2\n");
        assert!(!wt.join("gone").exists());
        assert_eq!(std::fs::read_to_string(wt.join("new")).unwrap(), "n\n");
        assert_eq!(git_text(&wt, &["rev-parse", "--abbrev-ref", "HEAD"]).as_deref(), Some("lotus/f-test"));
        // Uncommitted against HEAD, so the merge card counts them; the original is untouched.
        let status = git_text(&wt, &["status", "--porcelain"]).unwrap();
        assert_eq!(status.lines().count(), 3, "{status}");
        assert_eq!(std::fs::read_to_string(repo.join("a")).unwrap(), "3\n");
        assert!(worktree_at(&repo, "0000000000000000000000000000000000000000", "lotus/f-x", &dir.join("x")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_removes_a_lotus_worktree_with_its_work_and_nothing_else() {
        let dir = std::env::temp_dir().join(format!("lotus-discard-{}", uuid::Uuid::new_v4()));
        let main = dir.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let main = main.canonicalize().unwrap();
        sh(&main, &["init", "-q", "-b", "main"]);
        sh(&main, &["config", "user.email", "t@t"]);
        sh(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("f"), "a\n").unwrap();
        sh(&main, &["add", "f"]);
        sh(&main, &["commit", "-qm", "init"]);
        let (wt, mine) = (dir.join("wt"), dir.join("mine"));
        sh(&main, &["worktree", "add", "-q", "-b", "lotus/d-x", &wt.to_string_lossy()]);
        sh(&main, &["worktree", "add", "-q", "-b", "feature", &mine.to_string_lossy()]);
        std::fs::write(wt.join("g"), "child\n").unwrap();
        sh(&wt, &["add", "g"]);
        sh(&wt, &["commit", "-qm", "add g"]);
        std::fs::write(wt.join("h"), "uncommitted\n").unwrap();

        assert_eq!(worktree_state(&wt).unwrap().loses.as_deref(), Some("1 uncommitted files"));
        assert!(discard_worktree(&mine).unwrap_err().contains("not a branch Lotus made"));
        assert!(discard_worktree(&main).is_err(), "the main worktree is never discarded");
        assert_eq!(discard_worktree(&wt).unwrap(), "lotus/d-x");
        assert!(!wt.exists() && mine.exists());
        assert!(git_text(&main, &["rev-parse", "-q", "--verify", "refs/heads/lotus/d-x"]).is_none());
        assert_eq!(std::fs::read_to_string(main.join("f")).unwrap(), "a\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_worktree_is_reaped_only_when_nothing_is_lost() {
        let dir = std::env::temp_dir().join(format!("lotus-reap-{}", uuid::Uuid::new_v4()));
        let main = dir.join("main");
        std::fs::create_dir_all(&main).unwrap();
        let main = main.canonicalize().unwrap();
        sh(&main, &["init", "-q", "-b", "main"]);
        sh(&main, &["config", "user.email", "t@t"]);
        sh(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("f"), "a\n").unwrap();
        sh(&main, &["add", "f"]);
        sh(&main, &["commit", "-qm", "init"]);
        let wt = dir.join("wt");
        sh(&main, &["worktree", "add", "-q", "-b", "lotus/d-x", &wt.to_string_lossy()]);
        let branch_exists = || git_text(&main, &["rev-parse", "-q", "--verify", "refs/heads/lotus/d-x"]).is_some();

        std::fs::write(wt.join("g"), "child\n").unwrap();
        assert!(reap_worktree(&wt).unwrap_err().contains("uncommitted"), "untracked file kept");
        sh(&wt, &["add", "g"]);
        sh(&wt, &["commit", "-qm", "add g"]);
        assert!(reap_worktree(&wt).unwrap_err().contains("not in main"), "unmerged commit kept");
        assert!(wt.exists() && branch_exists());

        // The commit reaches main by cherry-pick: a new hash, the same patch.
        let sha = git_text(&wt, &["rev-parse", "HEAD"]).unwrap();
        sh(&main, &["cherry-pick", &sha]);
        reap_worktree(&wt).unwrap();
        assert!(!wt.exists() && !branch_exists());
        assert_eq!(std::fs::read_to_string(main.join("g")).unwrap(), "child\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_childs_branch_merges_into_the_lead_and_a_conflict_is_aborted() {
        let dir = std::env::temp_dir().join(format!("lotus-merge-{}", uuid::Uuid::new_v4()));
        let lead = dir.join("lead");
        std::fs::create_dir_all(&lead).unwrap();
        let lead = lead.canonicalize().unwrap();
        sh(&lead, &["init", "-q", "-b", "main"]);
        sh(&lead, &["config", "user.email", "t@t"]);
        sh(&lead, &["config", "user.name", "t"]);
        std::fs::write(lead.join("f"), "a\n").unwrap();
        sh(&lead, &["add", "f"]);
        sh(&lead, &["commit", "-qm", "init"]);
        let child = dir.join("child");
        sh(&lead, &["worktree", "add", "-q", "-b", "lotus/d-x", &child.to_string_lossy()]);
        let (lead_cwd, child_cwd) = (lead.to_string_lossy().into_owned(), child.to_string_lossy().into_owned());

        assert!(delegated(&lead_cwd, &lead_cwd).is_none(), "the lead is not its own child");
        assert!(merge(&child_cwd, &lead_cwd).unwrap_err().starts_with("nothing to merge"));
        std::fs::write(child.join("g"), "child\n").unwrap();
        assert!(merge(&child_cwd, &lead_cwd).unwrap_err().contains("uncommitted"));
        sh(&child, &["add", "g"]);
        sh(&child, &["commit", "-qm", "add g"]);
        let d = delegated(&child_cwd, &lead_cwd).unwrap();
        assert_eq!((d.branch.as_str(), d.into.as_str(), d.uncommitted), ("lotus/d-x", "main", 0));
        assert!(d.commits.len() == 1 && d.commits[0].ends_with(" add g"));
        merge(&child_cwd, &lead_cwd).unwrap();
        assert_eq!(std::fs::read_to_string(lead.join("g")).unwrap(), "child\n");

        // Both edit f: the merge is refused and the lead is left as it was.
        std::fs::write(child.join("f"), "child\n").unwrap();
        sh(&child, &["commit", "-qam", "child f"]);
        std::fs::write(lead.join("f"), "lead\n").unwrap();
        sh(&lead, &["commit", "-qam", "lead f"]);
        let error = merge(&child_cwd, &lead_cwd).unwrap_err();
        assert!(error.contains("conflicts") && error.contains(": f."), "{error}");
        assert!(git_text(&lead, &["rev-parse", "-q", "--verify", "MERGE_HEAD"]).is_none());
        assert_eq!(std::fs::read_to_string(lead.join("f")).unwrap(), "lead\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
