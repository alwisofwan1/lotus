//! Settings › Worktrees (plans/workspace-cleanup/PLAN.md): every linked worktree of every repo Lotus
//! knows, what removing it would lose, and the removals themselves — by hand or by the auto rule.
//!
//! The main checkout is never listed. Factory worktrees are listed but never removed here (the
//! Factory reaper owns them). A worktree a pane, a chat or a live cell works in is "in use" and never
//! removed. Every removal is logged with the branch and its last commit, so it can be restored with
//! `git branch <name> <sha>`. Only the local branch is deleted, never a remote one.

use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::codespace_git::git_command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Yours,
    Chat,
    Factory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// Its commits are all in the main checkout's branch (by patch, so a rebase or cherry-pick counts).
    Merged,
    /// No commits of its own and no uncommitted files.
    Clean,
    /// Removing it loses something; `reason` says what.
    HasWork,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub sha: Option<String>,
    /// The repo's main checkout.
    pub repo: String,
    pub kind: Kind,
    pub state: State,
    /// What would be lost (Has work).
    pub reason: Option<String>,
    /// Why it cannot be removed at all: in use, Factory's, locked by git.
    pub blocked: Option<String>,
    pub size_bytes: u64,
    /// Newest of its index, HEAD and HEAD log, in ms. 0 when unknown.
    pub last_active_ms: u64,
}

impl Worktree {
    /// Clean up N and the auto rule take only these.
    fn safe(&self) -> bool {
        self.blocked.is_none() && self.state != State::HasWork
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removal {
    pub path: String,
    /// `None`: removed.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at_ms: u64,
    pub path: String,
    pub repo: String,
    pub branch: Option<String>,
    pub sha: Option<String>,
    pub had_work: bool,
    pub auto: bool,
}

/// Where to look and what is in use. Any folder inside a repo is enough to find that repo.
#[derive(Default)]
pub struct Sources {
    pub folders: Vec<PathBuf>,
    pub in_use: Vec<PathBuf>,
}

/// The folders this module owns or recognises under the Lotus state dir.
pub struct Roots {
    pub chat: PathBuf,
    pub factory: PathBuf,
    pub log: PathBuf,
}

impl Roots {
    pub fn from_state_dir(state: &Path) -> Self {
        Roots { chat: state.join("chat-worktrees"), factory: state.join("factory"), log: state.join("worktree-cleanup.jsonl") }
    }

    /// Chat and Factory worktrees are found from their own folders too, not only from a pane.
    fn own_folders(&self) -> Vec<PathBuf> {
        [&self.chat, &self.factory]
            .iter()
            .flat_map(|root| std::fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect()
    }
}

const LOG_DAYS: u64 = 30;
const DAY_MS: u64 = 24 * 60 * 60 * 1000;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// "1 commit", "2 commits".
fn plural(n: usize, noun: &str) -> String {
    format!("{n} {noun}{}", if n == 1 { "" } else { "s" })
}

fn git_out(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git_command().args(args).current_dir(dir).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Runs git; the error is git's own message (a locked file on Windows names the file).
fn git_run(dir: &Path, args: &[&str]) -> Result<(), String> {
    let out = git_command().args(args).current_dir(dir).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() { format!("git {} failed", args.join(" ")) } else { stderr })
}

/// One spelling per folder, so a pane cwd and git's path compare equal: on macOS `/var` is
/// `/private/var`, on Windows git writes `C:/x` where a pane has `C:\x`. A folder that no longer
/// exists is resolved through its nearest existing parent.
fn norm(path: &Path) -> PathBuf {
    let mut rest = Vec::new();
    let mut at = path;
    loop {
        if let Ok(real) = std::fs::canonicalize(at) {
            return rest.iter().rev().fold(real, |p, part| p.join(part));
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                at = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

/// The main checkout of the repo `folder` is in; `None` for a bare repo or no repo.
fn main_checkout(folder: &Path) -> Option<PathBuf> {
    let common = git_out(folder, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let common = Path::new(&common);
    if common.file_name()? != ".git" {
        return None;
    }
    Some(norm(common.parent()?))
}

/// One block of `git worktree list --porcelain`.
#[derive(Debug, Default, PartialEq)]
struct Listed {
    path: String,
    sha: Option<String>,
    branch: Option<String>,
    locked: bool,
    prunable: bool,
}

fn parse_porcelain(text: &str) -> Vec<Listed> {
    let mut out = Vec::new();
    for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
        let mut listed = Listed::default();
        for line in block.lines() {
            let (key, value) = line.split_once(' ').unwrap_or((line, ""));
            match key {
                "worktree" => listed.path = value.to_string(),
                "HEAD" => listed.sha = Some(value.to_string()),
                "branch" => listed.branch = Some(value.trim_start_matches("refs/heads/").to_string()),
                "locked" => listed.locked = true,
                "prunable" => listed.prunable = true,
                _ => {}
            }
        }
        if !listed.path.is_empty() {
            out.push(listed);
        }
    }
    out
}

/// Merged, Clean or Has work, with what would be lost. Same rule as the chat reaper
/// (`chat_runtime::changes::worktree_state`): uncommitted files, or a commit whose patch the main
/// checkout's branch lacks (`git cherry`).
fn classify(main: &Path, path: &Path, branch: Option<&str>) -> (State, Option<String>) {
    let has_work = |why: String| (State::HasWork, Some(why));
    let Some(status) = git_out(path, &["--no-optional-locks", "status", "--porcelain"]) else {
        return has_work("git could not read it".into());
    };
    if !status.is_empty() {
        return has_work(plural(status.lines().count(), "uncommitted file"));
    }
    let Some(branch) = branch else { return has_work("Not on a branch".into()) };
    let Some(into) = git_out(main, &["branch", "--show-current"]).filter(|b| !b.is_empty()) else {
        return has_work("The main checkout is not on a branch".into());
    };
    let Some(cherry) = git_out(main, &["cherry", &into, branch]) else {
        return has_work("git could not compare it".into());
    };
    let unmerged = cherry.lines().filter(|l| l.starts_with('+')).count();
    if unmerged > 0 {
        return if squash_merged(main, &into, branch) {
            (State::Merged, None)
        } else {
            has_work(format!("{} not in {into}", plural(unmerged, "commit")))
        };
    }
    if !cherry.is_empty() {
        return (State::Merged, None);
    }
    // Nothing ahead of `into`: either never committed on, or merged by a real merge. Its reflog
    // tells them apart (the first entry is the branch's creation).
    let moved = git_out(main, &["reflog", "show", "--format=%H", &format!("refs/heads/{branch}")])
        .is_some_and(|log| log.lines().count() > 1);
    (if moved { State::Merged } else { State::Clean }, None)
}

/// A squash merge (GitHub's "Squash and merge") lands the branch as one new commit, so `git cherry`
/// matches none of the branch's own commits. Folding the branch into one commit on its merge base
/// and asking `git cherry` about that matches it. Only as fresh as the local `into` (pull first).
/// The folded commit is never referenced; `git gc` prunes it.
fn squash_merged(main: &Path, into: &str, branch: &str) -> bool {
    let folded = git_out(main, &["merge-base", into, branch]).and_then(|base| {
        let tree = format!("{branch}^{{tree}}");
        git_out(main, &["commit-tree", &tree, "-p", &base, "-m", "lotus squash check"])
    });
    folded
        .and_then(|commit| git_out(main, &["cherry", into, &commit]))
        .is_some_and(|out| out.starts_with('-'))
}

/// The worktree's admin dir from its `.git` file (`gitdir: …`).
fn admin_dir(path: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(path.join(".git")).ok()?;
    let dir = PathBuf::from(text.strip_prefix("gitdir:")?.trim());
    Some(if dir.is_absolute() { dir } else { path.join(dir) })
}

fn last_active_ms(path: &Path) -> u64 {
    let Some(admin) = admin_dir(path) else { return 0 };
    ["index", "HEAD", "logs/HEAD"]
        .iter()
        .filter_map(|f| std::fs::metadata(admin.join(f)).and_then(|m| m.modified()).ok())
        .filter_map(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .max()
        .unwrap_or(0)
}

/// Every linked worktree of the repos `sources` reaches. `sizes`: also measure each folder, which
/// reads every file in it (slow on a big `node_modules`).
pub fn scan(sources: &Sources, roots: &Roots, sizes: bool) -> Vec<Worktree> {
    let mut seen_folders = HashSet::new();
    let mut repos = BTreeMap::new();
    for folder in sources.folders.iter().cloned().chain(roots.own_folders()) {
        if !folder.is_dir() || !seen_folders.insert(norm(&folder)) {
            continue;
        }
        if let Some(main) = main_checkout(&folder) {
            repos.entry(main).or_insert(());
        }
    }
    let in_use: Vec<PathBuf> = sources.in_use.iter().map(|p| norm(p)).collect();
    let chat_root = norm(&roots.chat);
    let factory_root = norm(&roots.factory);

    let mut rows = Vec::new();
    let mut seen_worktrees = HashSet::new();
    for main in repos.keys() {
        let Some(text) = git_out(main, &["worktree", "list", "--porcelain"]) else { continue };
        // The first block is the main checkout.
        for listed in parse_porcelain(&text).into_iter().skip(1) {
            let path = norm(Path::new(&listed.path));
            if listed.prunable || !path.is_dir() || &path == main || !seen_worktrees.insert(path.clone()) {
                continue;
            }
            let kind = if path.starts_with(&factory_root) {
                Kind::Factory
            } else if path.starts_with(&chat_root) {
                Kind::Chat
            } else {
                Kind::Yours
            };
            let (state, reason) = classify(main, &path, listed.branch.as_deref());
            let blocked = if kind == Kind::Factory {
                Some("Factory cleans this up".to_string())
            } else if in_use.iter().any(|u| u.starts_with(&path)) {
                Some("In use".to_string())
            } else if listed.locked {
                Some("Locked by git".to_string())
            } else {
                None
            };
            rows.push(Worktree {
                path: listed.path.clone(),
                branch: listed.branch,
                sha: listed.sha,
                repo: main.to_string_lossy().into_owned(),
                kind,
                state,
                reason,
                blocked,
                size_bytes: if sizes { crate::chat_runtime::changes::dir_size(&path) } else { 0 },
                last_active_ms: last_active_ms(&path),
            });
        }
    }
    rows.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then_with(|| a.path.cmp(&b.path)));
    rows
}

/// Removes `paths`, re-checked from a fresh scan so the caller's view is never trusted. A Has work
/// row needs `discard`. One failure (a file locked by another app on Windows) fails only its row.
pub fn remove(sources: &Sources, roots: &Roots, paths: &[String], discard: bool, auto: bool) -> Vec<Removal> {
    let rows = scan(sources, roots, false);
    paths
        .iter()
        .map(|asked| {
            let wanted = norm(Path::new(asked));
            let row = rows.iter().find(|r| norm(Path::new(&r.path)) == wanted);
            let error = match row {
                None => Some("Not a worktree Lotus can remove".to_string()),
                Some(row) => remove_one(row, discard, auto, &roots.log).err(),
            };
            Removal { path: asked.clone(), error }
        })
        .collect()
}

fn remove_one(row: &Worktree, discard: bool, auto: bool, log: &Path) -> Result<(), String> {
    if let Some(why) = &row.blocked {
        return Err(why.clone());
    }
    let had_work = row.state == State::HasWork;
    if had_work && !discard {
        return Err(format!("It has work: {}", row.reason.as_deref().unwrap_or("unknown")));
    }
    let main = Path::new(&row.repo);
    let mut args = vec!["worktree", "remove"];
    if had_work {
        args.push("--force");
    }
    args.push(&row.path);
    git_run(main, &args).map_err(|e| format!("Could not remove: {e}. The worktree was kept."))?;
    // The folder is gone from here on, so the log entry is written even if the branch stays.
    append_log(log, &LogEntry {
        at_ms: now_ms(),
        path: row.path.clone(),
        repo: row.repo.clone(),
        branch: row.branch.clone(),
        sha: row.sha.clone(),
        had_work,
        auto,
    });
    if let Some(branch) = &row.branch {
        git_run(main, &["branch", "-D", branch]).map_err(|e| format!("Folder removed, branch kept: {e}"))?;
    }
    Ok(())
}

/// The auto rule: Merged or Clean, not blocked, untouched for `days`.
pub fn auto(sources: &Sources, roots: &Roots, days: u32) -> Vec<Removal> {
    let cutoff = now_ms().saturating_sub(u64::from(days.max(1)) * DAY_MS);
    let due: Vec<String> = scan(sources, roots, false)
        .into_iter()
        .filter(|r| r.safe() && r.last_active_ms > 0 && r.last_active_ms < cutoff)
        .map(|r| r.path)
        .collect();
    if due.is_empty() {
        return Vec::new();
    }
    remove(sources, roots, &due, false, true)
}

fn append_log(log: &Path, entry: &LogEntry) {
    let line = match serde_json::to_string(entry) {
        Ok(line) => line,
        Err(e) => return eprintln!("[worktree-cleanup] log entry not written: {e}"),
    };
    let written = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .and_then(|mut f| writeln!(f, "{line}"));
    if let Err(e) = written {
        eprintln!("[worktree-cleanup] log entry not written: {e}");
    }
}

/// Removals of the last 30 days, newest first.
// shortcut: the log is never trimmed (one short line per removal); rewrite it on read if it ever grows.
pub fn read_log(log: &Path) -> Vec<LogEntry> {
    let since = now_ms().saturating_sub(LOG_DAYS * DAY_MS);
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let mut entries: Vec<LogEntry> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
        .filter(|e| e.at_ms >= since)
        .collect();
    entries.reverse();
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    // `git_command`, not a bare "git": other tests change PATH while this one runs.
    fn sh(dir: &Path, args: &[&str]) {
        let ok = git_command().args(args).current_dir(dir).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    fn repo(root: &Path) -> PathBuf {
        let main = root.join("repo");
        std::fs::create_dir_all(&main).unwrap();
        sh(&main, &["init", "-q", "-b", "main"]);
        sh(&main, &["config", "user.email", "t@t"]);
        sh(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("a.txt"), "a").unwrap();
        sh(&main, &["add", "."]);
        sh(&main, &["commit", "-qm", "a"]);
        main
    }

    fn roots(root: &Path) -> Roots {
        Roots::from_state_dir(&root.join("state"))
    }

    #[test]
    fn porcelain_blocks_parse_branch_detached_locked_and_prunable() {
        let text = "worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r-x\nHEAD 2\ndetached\nlocked why\n\nworktree /gone\nHEAD 3\nbranch refs/heads/g\nprunable gitdir file points to non-existent location\n";
        let listed = parse_porcelain(text);
        assert_eq!(listed.len(), 3);
        assert_eq!(listed[0].branch.as_deref(), Some("main"));
        assert_eq!(listed[1].branch, None);
        assert!(listed[1].locked);
        assert!(listed[2].prunable);
    }

    #[test]
    fn rows_are_classified_and_only_safe_unused_ones_are_removed_and_logged() {
        let tmp = tempfile::tempdir().unwrap();
        let main = repo(tmp.path());
        let roots = roots(tmp.path());
        std::fs::create_dir_all(roots.log.parent().unwrap()).unwrap();
        let wt = |name: &str| tmp.path().join(name);
        sh(&main, &["worktree", "add", "-q", "-b", "clean", wt("clean").to_str().unwrap()]);
        sh(&main, &["worktree", "add", "-q", "-b", "merged", wt("merged").to_str().unwrap()]);
        std::fs::write(wt("merged").join("m.txt"), "m").unwrap();
        sh(&wt("merged"), &["add", "."]);
        sh(&wt("merged"), &["commit", "-qm", "m"]);
        sh(&main, &["merge", "-q", "merged"]);
        sh(&main, &["worktree", "add", "-q", "-b", "squashed", wt("squashed").to_str().unwrap()]);
        for n in ["s1", "s2"] {
            std::fs::write(wt("squashed").join(n), n).unwrap();
            sh(&wt("squashed"), &["add", "."]);
            sh(&wt("squashed"), &["commit", "-qm", n]);
        }
        sh(&main, &["merge", "-q", "--squash", "squashed"]);
        sh(&main, &["commit", "-qm", "squash"]);
        sh(&main, &["worktree", "add", "-q", "-b", "dirty", wt("dirty").to_str().unwrap()]);
        std::fs::write(wt("dirty").join("d.txt"), "d").unwrap();
        sh(&main, &["worktree", "add", "-q", "-b", "used", wt("used").to_str().unwrap()]);

        let sources = Sources { folders: vec![main.clone()], in_use: vec![wt("used").join("sub")] };
        let rows = scan(&sources, &roots, true);
        let state = |name: &str| {
            let row = rows.iter().find(|r| r.branch.as_deref() == Some(name)).unwrap();
            (row.state, row.blocked.clone())
        };
        assert_eq!(rows.len(), 5, "the main checkout is never listed");
        assert_eq!(state("squashed"), (State::Merged, None));
        assert_eq!(state("clean"), (State::Clean, None));
        assert_eq!(state("merged"), (State::Merged, None));
        assert_eq!(state("dirty").0, State::HasWork);
        assert_eq!(state("used"), (State::Clean, Some("In use".into())));

        let path = |name: &str| wt(name).to_string_lossy().into_owned();
        let out = remove(&sources, &roots, &[path("clean"), path("dirty"), path("used")], false, false);
        assert_eq!(out[0].error, None);
        assert!(out[1].error.as_deref().unwrap().starts_with("It has work"));
        assert_eq!(out[2].error.as_deref(), Some("In use"));
        assert!(!wt("clean").exists() && wt("dirty").exists() && wt("used").exists());
        assert!(git_out(&main, &["rev-parse", "--verify", "-q", "refs/heads/clean"]).is_none(), "branch deleted");

        let out = remove(&sources, &roots, &[path("dirty")], true, false);
        assert_eq!(out[0].error, None);
        let log = read_log(&roots.log);
        assert_eq!(log.iter().map(|e| e.branch.as_deref().unwrap()).collect::<Vec<_>>(), ["dirty", "clean"]);
        assert!(log[0].had_work && log[0].sha.is_some());
    }

    #[test]
    fn auto_takes_only_safe_rows_older_than_the_cutoff() {
        let tmp = tempfile::tempdir().unwrap();
        let main = repo(tmp.path());
        let roots = roots(tmp.path());
        std::fs::create_dir_all(roots.log.parent().unwrap()).unwrap();
        let fresh = tmp.path().join("fresh");
        sh(&main, &["worktree", "add", "-q", "-b", "fresh", fresh.to_str().unwrap()]);
        let sources = Sources { folders: vec![main], in_use: vec![] };
        assert!(auto(&sources, &roots, 7).is_empty(), "touched just now");
        assert!(fresh.exists());
    }
}
