//! Tells an open Git graph that a branch, a tag or HEAD moved — an agent committing in its own
//! worktree included, which no Editor pane's watcher sees (its refs live in the main repo's git
//! directory, not under the pane's folder).
//!
//! Watches only the git directories, never the working tree: `<common>/refs` (recursive),
//! `<common>` and this worktree's own git dir (not recursive, for `HEAD` and `packed-refs`).
//! The graph asks for it while it is on screen and drops it after.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::Duration;

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use serde::Serialize;

use crate::codespace_git::{git_command, resolve_repo_root};
use crate::AppError;

/// A commit moves a ref, the reflog and often `packed-refs`: one batch, one reload.
pub const REFS_DEBOUNCE: Duration = Duration::from_millis(500);

/// Does a change at `path` move what the graph shows? `dirs` are the git directories watched.
pub fn moves_refs(path: &Path, dirs: &[PathBuf]) -> bool {
    dirs.iter().any(|dir| {
        let Ok(relative) = path.strip_prefix(dir) else { return false };
        let parts: Vec<&str> = relative
            .components()
            .filter_map(|c| match c {
                Component::Normal(part) => part.to_str(),
                _ => None,
            })
            .collect();
        // Lock files come and go around every update; the rename that follows is the change.
        if parts.last().is_some_and(|last| last.ends_with(".lock")) {
            return false;
        }
        matches!(parts.as_slice(), ["HEAD"] | ["packed-refs"] | ["refs", _, ..])
    })
}

pub trait RefsSink: Send + Sync {
    fn moved(&self);
}

/// Dropping this stops the watcher.
pub struct RefsWatcher {
    debouncer: Option<Debouncer<RecommendedWatcher>>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for RefsWatcher {
    fn drop(&mut self) {
        // Debouncer first: it owns the sender, and closing the channel ends the worker.
        drop(self.debouncer.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// This worktree's git dir and the shared one (the same dir outside a linked worktree), absolute
/// and resolved the way the watcher reports paths (`/private/var` for `/var`, `\\?\` on Windows).
pub fn git_dirs(repo: &Path) -> Result<Vec<PathBuf>, AppError> {
    let output = git_command()
        .args(["rev-parse", "--git-dir", "--git-common-dir"])
        .current_dir(repo)
        .output()
        .map_err(|err| AppError::Other(format!("git rev-parse failed: {err}")))?;
    if !output.status.success() {
        return Err(AppError::Other("Not a Git repository".to_string()));
    }
    let mut dirs: Vec<PathBuf> = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let dir = repo.join(line).canonicalize().map_err(|err| AppError::Other(format!("Unable to resolve {line}: {err}")))?;
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    Ok(dirs)
}

pub fn start_refs_watcher<S: RefsSink + 'static>(repo: &Path, sink: Arc<S>, debounce: Duration) -> Result<RefsWatcher, AppError> {
    let dirs = git_dirs(repo)?;
    let watch_err = |path: &Path, error: String| AppError::Other(format!("could not watch {}: {error}", path.display()));
    let (tx, rx) = mpsc::channel();
    let mut debouncer = new_debouncer(debounce, tx).map_err(|error| watch_err(repo, error.to_string()))?;
    for dir in &dirs {
        debouncer
            .watcher()
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(|error| watch_err(dir, error.to_string()))?;
    }
    // The common dir is last (`--git-common-dir` prints after `--git-dir`). A repo whose refs are
    // all packed may have no `refs/` folder: `HEAD` and `packed-refs` still cover it.
    let refs = dirs.last().map(|common| common.join("refs")).filter(|refs| refs.is_dir());
    if let Some(refs) = &refs {
        debouncer
            .watcher()
            .watch(refs, RecursiveMode::Recursive)
            .map_err(|error| watch_err(refs, error.to_string()))?;
    }
    let worker = std::thread::Builder::new()
        .name("lotus-git-graph-watcher".into())
        .spawn(move || {
            while let Ok(batch) = rx.recv() {
                let batch: DebounceEventResult = batch;
                match batch {
                    Ok(events) if events.iter().any(|event| moves_refs(&event.path, &dirs)) => sink.moved(),
                    Ok(_) => {}
                    Err(error) => eprintln!("[git-graph-watcher] notify error: {error}"),
                }
            }
        })
        .map_err(|error| watch_err(repo, error.to_string()))?;
    Ok(RefsWatcher { debouncer: Some(debouncer), worker: Some(worker) })
}

fn registry() -> &'static Mutex<HashMap<String, RefsWatcher>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, RefsWatcher>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefsMoved {
    watch_id: String,
}

/// Emits `git-graph://refs-moved` with the watch id, so each graph takes only its own.
struct TauriSink {
    app: tauri::AppHandle,
    watch_id: String,
}

impl RefsSink for TauriSink {
    fn moved(&self) {
        let payload = RefsMoved { watch_id: self.watch_id.clone() };
        if let Err(error) = tauri::Emitter::emit(&self.app, "git-graph://refs-moved", payload) {
            eprintln!("[git-graph-watcher] emit failed: {error}");
        }
    }
}

/// One watcher per watch id; a new id per start, so a late stop only ends its own watch.
pub fn watch(app: tauri::AppHandle, watch_id: &str, repo_root: &str) -> Result<(), AppError> {
    let repo = resolve_repo_root(repo_root)?;
    let sink = Arc::new(TauriSink { app, watch_id: watch_id.to_string() });
    let watcher = start_refs_watcher(&repo, sink, REFS_DEBOUNCE)?;
    let replaced = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(watch_id.to_string(), watcher);
    // Joined outside the lock.
    drop(replaced);
    Ok(())
}

pub fn unwatch(watch_id: &str) {
    let removed = registry().lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(watch_id);
    drop(removed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    #[test]
    fn only_refs_head_and_packed_refs_move_the_graph() {
        let dirs = vec![PathBuf::from("/r/.git/worktrees/wt"), PathBuf::from("/r/.git")];
        let moved = |p: &str| moves_refs(Path::new(p), &dirs);
        assert!(moved("/r/.git/refs/heads/agent/nia"));
        assert!(moved("/r/.git/packed-refs"));
        assert!(moved("/r/.git/HEAD"));
        assert!(moved("/r/.git/worktrees/wt/HEAD"));
        assert!(!moved("/r/.git/refs/heads/main.lock"));
        assert!(!moved("/r/.git/index"));
        assert!(!moved("/r/.git/objects/ab/cdef"));
        assert!(!moved("/r/.git/logs/HEAD"));
        assert!(!moved("/r/src/main.rs"));
    }

    #[derive(Default)]
    struct Count(AtomicUsize);
    impl RefsSink for Count {
        fn moved(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn a_commit_in_the_repository_reaches_the_sink() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let git = |args: &[&str]| {
            let out = git_command()
                .args(["-c", "user.name=T", "-c", "user.email=t@x", "-c", "commit.gpgsign=false"])
                .args(args)
                .current_dir(root)
                .output()
                .unwrap();
            assert!(out.status.success(), "{args:?}");
        };
        git(&["init", "-q"]);
        git(&["commit", "-q", "--allow-empty", "-m", "one"]);
        let sink = Arc::new(Count::default());
        let watcher = start_refs_watcher(root, sink.clone(), Duration::from_millis(50)).unwrap();
        // FSEvents may deliver the setup's own writes late; count only from a settled start.
        std::thread::sleep(Duration::from_millis(300));
        sink.0.store(0, Ordering::SeqCst);
        git(&["commit", "-q", "--allow-empty", "-m", "two"]);
        let deadline = Instant::now() + Duration::from_secs(5);
        while sink.0.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(sink.0.load(Ordering::SeqCst) > 0, "the commit moved a ref");
        drop(watcher);
    }
}
