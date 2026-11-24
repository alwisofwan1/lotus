//! Filesystem watcher loop using `notify-debouncer-mini`. Bridges incoming
//! filesystem events into [`super::processor::process_drop_file`].
//!
//! The watcher owns:
//!
//! - A `notify-debouncer-mini` debouncer (kept alive for the lifetime of the
//!   watcher to keep the underlying `notify::Watcher` registered).
//! - A worker thread that consumes the debounced events channel and dispatches
//!   each path to the processor.
//!
//! Dropping the [`AgentHooksWatcher`] handle stops the watcher: the debouncer
//! is dropped (closing the channel), and the worker thread observes the close
//! and exits.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, DebouncedEventKind, Debouncer,
};

use super::drop_dir::{drain_pending, ensure_drop_dir, DrainOutcome, DEFAULT_DRAIN_TTL};
use super::processor::{process_drop_file, HookEventSink};

/// Debounce window before notify events are flushed. Keeps a burst of writes
/// from one producer (e.g. multiple `Stop` hooks fired in rapid succession)
/// from creating excess thread wakeups, while staying low enough that the
/// agent's "finished" state surfaces without a perceptible delay.
const DEBOUNCE: Duration = Duration::from_millis(100);

/// Handle to a running watcher. Dropping this stops the watcher cleanly.
pub struct AgentHooksWatcher {
    // Option so we can explicitly drop it in our Drop impl before joining the
    // worker. The debouncer owns the mpsc::Sender; dropping it closes the
    // channel and lets `rx.recv()` in the worker return Err, exiting the loop.
    debouncer: Option<Debouncer<RecommendedWatcher>>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for AgentHooksWatcher {
    fn drop(&mut self) {
        // Drop the debouncer FIRST to close the events channel. That unblocks
        // the worker's `rx.recv()`, letting the loop exit. Then we can join
        // without deadlocking (joining before debouncer drop would hang forever
        // because the worker is blocked on a channel that never closes).
        drop(self.debouncer.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AgentHooksWatcherError {
    #[error("cannot create drop directory: {0}")]
    Mkdir(std::io::Error),
    #[error("notify watcher init failed: {0}")]
    NotifyInit(String),
    #[error("notify watcher could not subscribe to {path}: {error}")]
    NotifySubscribe { path: PathBuf, error: String },
}

/// Spawn a watcher rooted at `drop_dir`. The directory is created if missing.
/// Pre-existing files are drained synchronously before this returns: fresh
/// drops are emitted, stale drops are unlinked.
///
/// `sink` is an `Arc` so it can be shared with the worker thread.
pub fn spawn_watcher<S>(
    drop_dir: &Path,
    sink: Arc<S>,
) -> Result<AgentHooksWatcher, AgentHooksWatcherError>
where
    S: HookEventSink + 'static,
{
    ensure_drop_dir(drop_dir).map_err(AgentHooksWatcherError::Mkdir)?;

    // Drain pre-existing files before subscribing so the startup sweep is
    // deterministic. Files older than DEFAULT_DRAIN_TTL are unlinked
    // silently; fresh files are processed via the same code path that the
    // watcher uses below.
    for drained in drain_pending(drop_dir, DEFAULT_DRAIN_TTL, SystemTime::now()) {
        if matches!(drained.outcome, DrainOutcome::Emit) {
            process_drop_file(&drained.path, sink.as_ref());
        }
    }

    let (tx, rx) = mpsc::channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(DEBOUNCE, tx)
        .map_err(|e| AgentHooksWatcherError::NotifyInit(e.to_string()))?;
    debouncer
        .watcher()
        .watch(drop_dir, RecursiveMode::NonRecursive)
        .map_err(|e| AgentHooksWatcherError::NotifySubscribe {
            path: drop_dir.to_path_buf(),
            error: e.to_string(),
        })?;

    let worker_sink = Arc::clone(&sink);
    let worker = std::thread::Builder::new()
        .name("lotus-agent-hooks-watcher".into())
        .spawn(move || run_loop(rx, worker_sink))
        .map_err(|e| AgentHooksWatcherError::NotifyInit(e.to_string()))?;

    Ok(AgentHooksWatcher {
        debouncer: Some(debouncer),
        worker: Some(worker),
    })
}

/// Production sink: emits a `lotus://agent-hook` Tauri event to the frontend.
/// The payload is serialized as JSON by `tauri::Emitter::emit`.
pub struct TauriSink(pub tauri::AppHandle);

impl HookEventSink for TauriSink {
    fn emit_hook(&self, payload: &super::payload::DropPayload) {
        // Narration tool events have no frontend subscriber yet (Slice 6 of
        // plans/voice-narration-layer), so without this line the whole pipeline is invisible: the
        // drop file is consumed and unlinked within milliseconds and nothing observable happens.
        // One line in the dev terminal is the difference between "verified" and "assumed".
        if payload.event.starts_with("tool-") {
            eprintln!(
                "[narration] {} {} pane={} file={}",
                payload.event,
                payload.title,
                payload.pane_id.as_deref().unwrap_or("-"),
                if payload.body.is_empty() {
                    "-"
                } else {
                    payload.body.as_str()
                }
            );
        }
        if let Err(err) = tauri::Emitter::emit(&self.0, "lotus://agent-hook", payload) {
            eprintln!("[agent-hooks] emit failed: {err}");
        }
    }
}

fn run_loop<S>(rx: mpsc::Receiver<DebounceEventResult>, sink: Arc<S>)
where
    S: HookEventSink + 'static,
{
    while let Ok(events) = rx.recv() {
        let events = match events {
            Ok(e) => e,
            Err(err) => {
                eprintln!("[agent-hooks] notify error: {err}");
                continue;
            }
        };
        for ev in events {
            // Debouncer collapses related events; we only care that the
            // path *currently exists* and is a JSON drop.
            if !matches!(ev.kind, DebouncedEventKind::Any) {
                continue;
            }
            process_drop_file(&ev.path, sink.as_ref());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Instant;

    use crate::agent_hooks::payload::DropPayload;

    /// Sink that records every emitted payload. Cloneable via Arc.
    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<DropPayload>>,
    }

    impl RecordingSink {
        fn count(&self) -> usize {
            self.events.lock().unwrap().len()
        }
    }

    impl HookEventSink for RecordingSink {
        fn emit_hook(&self, payload: &DropPayload) {
            self.events.lock().unwrap().push(payload.clone());
        }
    }

    fn minimal_v1_bytes() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "sessionId": "watch-test",
            "agentType": "claude",
            "event": "stop",
            "status": "idle",
            "title": "ok",
            "body": "",
            "userPrompt": "",
            "cwd": "",
            "pid": null,
            "agentPid": null,
            "timestamp": 1,
        }))
        .unwrap()
    }

    /// Wait up to `timeout` for `cond` to become true. Polls every 25ms.
    fn wait_for(timeout: Duration, cond: impl Fn() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if cond() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        cond()
    }

    #[test]
    fn drains_existing_fresh_file_at_startup() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("seed.json"), minimal_v1_bytes()).unwrap();

        let sink = Arc::new(RecordingSink::default());
        let _w = spawn_watcher(tmp.path(), Arc::clone(&sink)).expect("spawn");

        // Drain runs synchronously inside spawn_watcher.
        assert_eq!(sink.count(), 1);
        assert!(!tmp.path().join("seed.json").exists());
    }

    #[test]
    fn drains_unlinks_stale_files_at_startup() {
        let tmp = tempfile::tempdir().unwrap();
        let stale_path = tmp.path().join("stale.json");
        std::fs::write(&stale_path, minimal_v1_bytes()).unwrap();
        let f = std::fs::File::open(&stale_path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(60 * 60))
            .unwrap();

        let sink = Arc::new(RecordingSink::default());
        let _w = spawn_watcher(tmp.path(), Arc::clone(&sink)).expect("spawn");

        // Stale = unlinked, not emitted.
        assert_eq!(sink.count(), 0);
        assert!(!stale_path.exists(), "stale file must be unlinked");
    }

    #[test]
    fn watches_for_new_files_after_startup() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = Arc::new(RecordingSink::default());
        let _w = spawn_watcher(tmp.path(), Arc::clone(&sink)).expect("spawn");
        assert_eq!(sink.count(), 0);

        // Write atomically: tmp + rename, mirroring the producer.
        let target = tmp.path().join("live.json");
        let staged = tmp.path().join("live.json.tmp");
        std::fs::write(&staged, minimal_v1_bytes()).unwrap();
        std::fs::rename(&staged, &target).unwrap();

        // notify + 100ms debounce + worker dispatch. Generous timeout for CI.
        assert!(
            wait_for(Duration::from_secs(3), || sink.count() >= 1),
            "expected event emit within 3s, got {} so far",
            sink.count()
        );
        assert!(!target.exists(), "live drop should have been unlinked");
    }

    #[test]
    fn missing_home_directory_is_an_error_path() {
        // We cannot easily simulate `dirs::home_dir() == None`, but we can
        // exercise the alternate error: passing an unwritable path.
        let blocker_dir = tempfile::tempdir().unwrap();
        let blocker = blocker_dir.path().join("blocker");
        std::fs::write(&blocker, b"").unwrap();
        // Can't create a subdir inside a regular file.
        let bad = blocker.join("nested-watch-target");

        let sink = Arc::new(RecordingSink::default());
        let result = spawn_watcher(&bad, sink);
        assert!(matches!(result, Err(AgentHooksWatcherError::Mkdir(_))));
    }
}
