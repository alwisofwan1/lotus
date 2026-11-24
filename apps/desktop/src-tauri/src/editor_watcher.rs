//! Watching an Editor pane's folder, so an open file that an agent (or any other program)
//! rewrites does not keep showing the old text — and a later save does not clobber the new one.
//!
//! One watcher per pane, over its whole root: open files are almost always inside it, and the
//! same events keep the tree and the git status fresh. The pane asks for it only while it is on
//! screen (`enabled`), and drops it when it goes off, so a workspace in the background costs
//! nothing.

use std::collections::{BTreeSet, HashMap};
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

/// Short: an agent's single edit should show within a blink. A burst (a formatter over a folder)
/// still arrives as one batch.
pub const EDITOR_DEBOUNCE: Duration = Duration::from_millis(150);

/// More than this in one batch (an `npm install`, a branch switch) and the pane is told to read
/// everything again, instead of being handed thousands of paths.
pub const MAX_BATCH_PATHS: usize = 500;

/// Folders whose churn no editor tab or tree row cares about. `.git` is special: its `index` and
/// `HEAD` say the git status moved, which the pane does care about.
const IGNORED_DIRS: &[&str] = &["node_modules", "target", ".next", ".turbo", "dist"];

/// What changed under a pane's root in one debounced batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorChangeBatch {
    /// Absolute paths, sorted, without duplicates. Empty when `overflow`.
    pub paths: Vec<String>,
    /// The repo's index or HEAD moved: a stage, a commit, a checkout.
    pub git: bool,
    /// Too many to list: read everything that is open or listed again.
    pub overflow: bool,
}

impl EditorChangeBatch {
    fn is_empty(&self) -> bool {
        self.paths.is_empty() && !self.git && !self.overflow
    }
}

/// Sorts a raw batch of changed paths: what a pane shows, whether git moved, and the noise dropped.
///
/// Events arrive under the resolved `root` (`/private/var/…` for `/var/…`, a symlink followed, a
/// `\\?\` prefix on Windows); each kept path is spelled under `shown_root` instead — the root as
/// the pane gave it — so it matches the pane's tabs and tree rows.
pub fn classify_changes<I>(root: &Path, shown_root: &str, changed: I) -> EditorChangeBatch
where
    I: IntoIterator<Item = PathBuf>,
{
    let shown_root = shown_root.replace('\\', "/");
    let shown_root = shown_root.trim_end_matches('/');
    let mut paths = BTreeSet::new();
    let mut git = false;
    for path in changed {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let parts: Vec<&str> = relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(part) => part.to_str(),
                _ => None,
            })
            .collect();
        match parts.as_slice() {
            [".git", "index"] | [".git", "HEAD"] => git = true,
            [".git", ..] => {}
            _ if parts.iter().any(|part| IGNORED_DIRS.contains(part)) => {}
            // Editors' and git's own scratch files, never a file a tab shows.
            [.., last]
                if last.ends_with(".lotus.tmp")
                    || last.contains(".lotus.tmp.")
                    || last.ends_with('~') => {}
            [] => {}
            _ => {
                paths.insert(format!("{shown_root}/{}", parts.join("/")));
            }
        }
    }
    if paths.len() > MAX_BATCH_PATHS {
        return EditorChangeBatch {
            paths: Vec::new(),
            git,
            overflow: true,
        };
    }
    EditorChangeBatch {
        paths: paths.into_iter().collect(),
        git,
        overflow: false,
    }
}

pub trait EditorChangeSink: Send + Sync {
    fn changed(&self, batch: EditorChangeBatch);
}

#[derive(Debug, thiserror::Error)]
pub enum EditorWatcherError {
    #[error("not a folder: {0}")]
    NotADirectory(PathBuf),
    #[error("could not watch {path}: {error}")]
    Watch { path: PathBuf, error: String },
}

/// Dropping this stops the watcher.
pub struct EditorWatcher {
    debouncer: Option<Debouncer<RecommendedWatcher>>,
    worker: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for EditorWatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EditorWatcher")
    }
}

impl Drop for EditorWatcher {
    fn drop(&mut self) {
        // Debouncer first: it owns the sender, and closing the channel is what ends the worker.
        drop(self.debouncer.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn start_editor_watcher<S>(
    root: &Path,
    sink: Arc<S>,
    debounce: Duration,
) -> Result<EditorWatcher, EditorWatcherError>
where
    S: EditorChangeSink + 'static,
{
    if !root.is_dir() {
        return Err(EditorWatcherError::NotADirectory(root.to_path_buf()));
    }
    let shown_root = root.to_string_lossy().to_string();
    // Events come back with the resolved path (`/private/var/…` for `/var/…` on macOS); matching
    // them against the root needs the same spelling.
    let root = root
        .canonicalize()
        .map_err(|error| EditorWatcherError::Watch {
            path: root.to_path_buf(),
            error: error.to_string(),
        })?;

    let (tx, rx) = mpsc::channel();
    let mut debouncer = new_debouncer(debounce, tx).map_err(|error| EditorWatcherError::Watch {
        path: root.clone(),
        error: error.to_string(),
    })?;
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|error| EditorWatcherError::Watch {
            path: root.clone(),
            error: error.to_string(),
        })?;

    let loop_root = root.clone();
    let worker = std::thread::Builder::new()
        .name("lotus-editor-watcher".into())
        .spawn(move || run_loop(rx, &loop_root, &shown_root, sink))
        .map_err(|error| EditorWatcherError::Watch {
            path: root,
            error: error.to_string(),
        })?;

    Ok(EditorWatcher {
        debouncer: Some(debouncer),
        worker: Some(worker),
    })
}

fn run_loop<S>(rx: mpsc::Receiver<DebounceEventResult>, root: &Path, shown_root: &str, sink: Arc<S>)
where
    S: EditorChangeSink + 'static,
{
    while let Ok(batch) = rx.recv() {
        match batch {
            Ok(events) => {
                let batch =
                    classify_changes(root, shown_root, events.into_iter().map(|event| event.path));
                if !batch.is_empty() {
                    sink.changed(batch);
                }
            }
            Err(error) => eprintln!("[editor-watcher] notify error: {error}"),
        }
    }
}

/// One watcher per watch id. The pane makes a new id each time it starts watching, so a stop
/// that arrives late (commands are not ordered) can only stop the watch it belongs to.
fn registry() -> &'static Mutex<HashMap<String, EditorWatcher>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, EditorWatcher>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorFsChanged {
    watch_id: String,
    #[serde(flatten)]
    batch: EditorChangeBatch,
}

/// Emits `editor://fs-changed` with the watch id, so each pane takes only its own.
struct TauriSink {
    app: tauri::AppHandle,
    watch_id: String,
}

impl EditorChangeSink for TauriSink {
    fn changed(&self, batch: EditorChangeBatch) {
        let payload = EditorFsChanged {
            watch_id: self.watch_id.clone(),
            batch,
        };
        if let Err(error) = tauri::Emitter::emit(&self.app, "editor://fs-changed", payload) {
            eprintln!("[editor-watcher] emit failed: {error}");
        }
    }
}

pub fn watch_root(
    app: tauri::AppHandle,
    watch_id: &str,
    root: &str,
) -> Result<(), EditorWatcherError> {
    // Started outside the lock: a recursive watch walks the tree (inotify), and other panes'
    // calls must not wait on it.
    let sink = Arc::new(TauriSink {
        app,
        watch_id: watch_id.to_string(),
    });
    let watcher = start_editor_watcher(Path::new(root), sink, EDITOR_DEBOUNCE)?;
    let replaced = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(watch_id.to_string(), watcher);
    // Joined outside the lock too.
    drop(replaced);
    Ok(())
}

pub fn unwatch(watch_id: &str) {
    let removed = registry()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(watch_id);
    // Joined outside the lock: another pane's call must not wait on this thread's exit.
    drop(removed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct Recording(StdMutex<Vec<EditorChangeBatch>>);

    impl EditorChangeSink for Recording {
        fn changed(&self, batch: EditorChangeBatch) {
            self.0.lock().unwrap().push(batch);
        }
    }

    impl Recording {
        fn paths(&self) -> Vec<String> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .flat_map(|batch| batch.paths.clone())
                .collect()
        }
    }

    fn wait_for(sink: &Recording, found: impl Fn(&Recording) -> bool) -> bool {
        for _ in 0..40 {
            if found(sink) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn classify_keeps_files_drops_noise_and_flags_git() {
        let root = Path::new("/r");
        let batch = classify_changes(
            root,
            "/r",
            [
                "/r/src/a.ts",
                "/r/src/a.ts",
                "/r/.git/index",
                "/r/.git/objects/ab/cd",
                "/r/node_modules/x/index.js",
                "/r/apps/desktop/target/debug/lotus",
                "/r/src/a.ts.lotus.tmp.123",
                "/elsewhere/b.ts",
            ]
            .map(PathBuf::from),
        );
        assert_eq!(
            batch,
            EditorChangeBatch {
                paths: vec!["/r/src/a.ts".into()],
                git: true,
                overflow: false
            }
        );
    }

    /// `/var/…` on macOS resolves to `/private/var/…`; the pane's tabs use the spelling it gave.
    #[test]
    fn classify_spells_paths_under_the_root_the_pane_gave() {
        let batch = classify_changes(
            Path::new("/private/var/repo"),
            "/var/repo/",
            [PathBuf::from("/private/var/repo/src/a.ts")],
        );
        assert_eq!(batch.paths, vec!["/var/repo/src/a.ts".to_string()]);
    }

    /// What the frontend's `EditorFsChange` reads: camelCase, flat, with the watch id.
    #[test]
    fn the_event_payload_has_the_shape_the_pane_reads() {
        let payload = EditorFsChanged {
            watch_id: "pane-1:3".into(),
            batch: EditorChangeBatch {
                paths: vec!["/r/a.ts".into()],
                git: true,
                overflow: false,
            },
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({ "watchId": "pane-1:3", "paths": ["/r/a.ts"], "git": true, "overflow": false })
        );
    }

    #[test]
    fn classify_overflows_a_huge_batch() {
        let root = Path::new("/r");
        let batch = classify_changes(
            root,
            "/r",
            (0..=MAX_BATCH_PATHS).map(|n| PathBuf::from(format!("/r/f{n}.ts"))),
        );
        assert!(batch.overflow);
        assert!(batch.paths.is_empty());
    }

    /// The ticket's first check: a change to an open file reaches the pane.
    #[test]
    fn a_write_under_the_root_reaches_the_sink_with_its_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        let file = dir.path().join("src/a.ts");
        std::fs::write(&file, "one").unwrap();
        let sink = Arc::new(Recording::default());
        let _watcher =
            start_editor_watcher(dir.path(), Arc::clone(&sink), Duration::from_millis(60))
                .expect("watchable");
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(&file, "two").unwrap();

        // Spelled under the root as given (a temp dir is `/var/…`, resolved `/private/var/…`).
        let expected = format!(
            "{}/src/a.ts",
            dir.path().to_string_lossy().replace('\\', "/")
        );
        assert!(
            wait_for(&sink, |sink| sink.paths().contains(&expected)),
            "expected {expected} in {:?}",
            sink.paths()
        );
    }

    #[test]
    fn dropping_the_watcher_stops_the_events() {
        let dir = tempfile::tempdir().expect("tempdir");
        let sink = Arc::new(Recording::default());
        let watcher =
            start_editor_watcher(dir.path(), Arc::clone(&sink), Duration::from_millis(60))
                .expect("watchable");
        drop(watcher);

        std::fs::write(dir.path().join("late.ts"), "x").unwrap();
        std::thread::sleep(Duration::from_millis(300));

        assert!(sink.paths().is_empty());
    }

    #[test]
    fn a_missing_root_is_refused() {
        let error = start_editor_watcher(
            Path::new("/definitely/not/here"),
            Arc::new(Recording::default()),
            EDITOR_DEBOUNCE,
        )
        .expect_err("nothing to watch");
        assert!(matches!(error, EditorWatcherError::NotADirectory(_)));
    }
}
