//! Watching a vault's `tickets/` directory, so the tracker is never showing a status that has
//! already changed.
//!
//! This is not a convenience. `obsidian-git` in a real vault pulls on boot and pushes every ten
//! minutes, so ticket files change with nobody at the keyboard — and a landing pull changes many
//! at once. A list that only refreshes when somebody presses a button would quietly be wrong, with
//! nothing on screen to say so.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};

/// Longer than the agent-hooks watcher's 100 ms, on purpose: a `git pull` rewrites dozens of
/// tickets in one breath, and what is wanted from that is a single re-read, not dozens.
pub const VAULT_DEBOUNCE: Duration = Duration::from_millis(500);

/// Told that something under `tickets/` changed. Deliberately carries NO path: the answer is
/// always the same — read the folder again — and naming one file would invite a caller to believe
/// it was the only one.
pub trait VaultChangeSink: Send + Sync {
    fn vault_changed(&self);
}

#[derive(Debug, thiserror::Error)]
pub enum VaultWatcherError {
    #[error("vault has no tickets directory: {0}")]
    NoTicketsDir(PathBuf),
    #[error("could not watch {path}: {error}")]
    Watch { path: PathBuf, error: String },
}

/// Dropping this stops the watcher.
pub struct VaultWatcher {
    debouncer: Option<Debouncer<RecommendedWatcher>>,
    worker: Option<JoinHandle<()>>,
}

impl std::fmt::Debug for VaultWatcher {
    // The debouncer is not `Debug`, and the only thing worth saying about a running watcher is
    // that it is running.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VaultWatcher")
    }
}

impl Drop for VaultWatcher {
    fn drop(&mut self) {
        // Debouncer first: it owns the sender, and dropping it closes the channel so the worker's
        // `recv()` returns and the loop exits. Joining before that would wait forever.
        drop(self.debouncer.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn start_vault_watcher<S>(
    vault: &Path,
    sink: Arc<S>,
    debounce: Duration,
) -> Result<VaultWatcher, VaultWatcherError>
where
    S: VaultChangeSink + 'static,
{
    let dir = vault.join("tickets");
    if !dir.is_dir() {
        return Err(VaultWatcherError::NoTicketsDir(dir));
    }

    let (tx, rx) = mpsc::channel();
    let mut debouncer = new_debouncer(debounce, tx).map_err(|error| VaultWatcherError::Watch {
        path: dir.clone(),
        error: error.to_string(),
    })?;
    debouncer
        .watcher()
        // Tickets are flat; `tickets/` has no subdirectories. Watching recursively would pick up
        // whatever somebody nests there later and re-read the vault for it.
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|error| VaultWatcherError::Watch {
            path: dir.clone(),
            error: error.to_string(),
        })?;

    let worker = std::thread::Builder::new()
        .name("lotus-vault-watcher".into())
        .spawn(move || run_loop(rx, sink))
        .map_err(|error| VaultWatcherError::Watch {
            path: dir,
            error: error.to_string(),
        })?;

    Ok(VaultWatcher {
        debouncer: Some(debouncer),
        worker: Some(worker),
    })
}

/// One notification per debounced batch, whatever the batch holds.
///
/// This is where twenty files become one re-read. The batch's paths are deliberately discarded:
/// the answer to any of them is the same — read the folder again — and passing one along would
/// invite a caller to believe it was the only thing that moved.
fn run_loop<S>(rx: mpsc::Receiver<DebounceEventResult>, sink: Arc<S>)
where
    S: VaultChangeSink + 'static,
{
    while let Ok(batch) = rx.recv() {
        match batch {
            Ok(events) if !events.is_empty() => sink.vault_changed(),
            Ok(_) => {}
            Err(error) => eprintln!("[vault-watcher] notify error: {error}"),
        }
    }
}

/// The one watcher this app runs, so that changing the vault path replaces it rather than adding
/// a second one reporting about a folder nobody is looking at.
fn current() -> &'static std::sync::Mutex<Option<VaultWatcher>> {
    static CURRENT: std::sync::OnceLock<std::sync::Mutex<Option<VaultWatcher>>> =
        std::sync::OnceLock::new();
    CURRENT.get_or_init(|| std::sync::Mutex::new(None))
}

/// Emits `vault://changed`. Carries no payload: the answer is always to read the folder again.
struct TauriSink(tauri::AppHandle);

impl VaultChangeSink for TauriSink {
    fn vault_changed(&self) {
        if let Err(error) = tauri::Emitter::emit(&self.0, "vault://changed", ()) {
            eprintln!("[vault-watcher] emit failed: {error}");
        }
    }
}

/// Watch `vault`, or stop watching when it is empty.
///
/// Replacing the handle drops the old one, which stops it: a stale watcher on a folder nobody is
/// looking at would make the board re-read for a vault that is no longer connected.
pub fn set_watched_vault(app: tauri::AppHandle, vault: &str) -> Result<(), VaultWatcherError> {
    let mut slot = current()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // Dropped BEFORE the new one starts, so two watchers never overlap on a path change.
    *slot = None;

    if vault.trim().is_empty() {
        return Ok(());
    }

    *slot = Some(start_vault_watcher(
        Path::new(vault.trim()),
        Arc::new(TauriSink(app)),
        VAULT_DEBOUNCE,
    )?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counting(AtomicUsize);

    impl VaultChangeSink for Counting {
        fn vault_changed(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn vault_with_tickets() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("tickets")).expect("tickets dir");
        dir
    }

    /// The `git pull` case, which is the reason the debounce is 500 ms and not 100.
    ///
    /// The assertion is a RANGE, not `== 1`, and that is the honest shape: how many batches the
    /// OS coalesces twenty writes into is not something it promises — measured here, the same
    /// twenty arrived as two. What the debouncer does promise is that a burst collapses, and that
    /// is what breaks loudly (twenty notifications) if somebody removes it.
    #[test]
    fn a_burst_of_writes_collapses_into_a_handful() {
        let dir = vault_with_tickets();
        let sink = Arc::new(Counting(AtomicUsize::new(0)));
        let _watcher = start_vault_watcher(dir.path(), Arc::clone(&sink), Duration::from_millis(120))
            .expect("a vault with a tickets directory can be watched");

        for n in 0..20 {
            std::fs::write(
                dir.path().join("tickets").join(format!("TKT-{n}.md")),
                format!("---\nticket: TKT-{n}\ntitle: t\nstatus: todo\n---\nbody\n"),
            )
            .expect("write ticket");
        }

        std::thread::sleep(Duration::from_millis(600));

        let notifications = sink.0.load(Ordering::SeqCst);
        assert!(
            (1..=4).contains(&notifications),
            "twenty files landing together are a handful of reads, not twenty — got {notifications}"
        );
    }

    #[test]
    fn a_directory_without_tickets_is_not_watchable() {
        let dir = tempfile::tempdir().expect("tempdir");

        let error = start_vault_watcher(dir.path(), Arc::new(Counting(AtomicUsize::new(0))), VAULT_DEBOUNCE)
            .expect_err("nothing to watch");

        assert_eq!(
            error.to_string(),
            format!("vault has no tickets directory: {}", dir.path().join("tickets").display())
        );
    }

    /// Dropping the handle must actually stop it — otherwise changing the vault path would leave
    /// the old folder still reporting, and the board would reload for a vault nobody is looking at.
    #[test]
    fn dropping_the_handle_stops_the_watching() {
        let dir = vault_with_tickets();
        let sink = Arc::new(Counting(AtomicUsize::new(0)));
        let watcher = start_vault_watcher(dir.path(), Arc::clone(&sink), Duration::from_millis(80))
            .expect("watchable");

        drop(watcher);
        std::fs::write(dir.path().join("tickets").join("TKT-1.md"), "x").expect("write");
        std::thread::sleep(Duration::from_millis(300));

        assert_eq!(sink.0.load(Ordering::SeqCst), 0);
    }
}
