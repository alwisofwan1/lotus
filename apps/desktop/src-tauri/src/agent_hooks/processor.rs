//! Pure file → event processing logic.
//!
//! Decoupled from the actual `notify` filesystem watcher so it can be unit
//! tested with a fake sink. The watcher (in `watcher.rs`) is a thin glue
//! layer that calls [`process_drop_file`] for each filesystem event.

use std::fs;
use std::path::Path;
use std::thread::sleep;
use std::time::Duration;

use super::payload::{parse_drop_payload, DropPayload, DropPayloadError};

/// One read-retry after a brief delay. Defends against the rare case where
/// `notify` emits a Create/Modify event before the producer has finished
/// `rename`-ing the `.tmp` file into place. 50ms is well under the 100ms
/// debounce window so two retries within one batch is impossible.
const READ_RETRY_DELAY: Duration = Duration::from_millis(50);

/// Outcome of processing a single drop-file event. Tests assert on this;
/// production code only needs `Emitted` for happy-path metrics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessOutcome {
    /// Parsed and emitted to the sink. File has been unlinked.
    Emitted,
    /// File was unparseable JSON or had a missing required field. Unlinked
    /// to prevent the watcher from looping on it.
    InvalidUnlinked,
    /// Payload version is unknown — forward-compatible drop we cannot read.
    /// File unlinked so it doesn't accumulate.
    UnsupportedVersionUnlinked { actual: u32 },
    /// File vanished or could not be read after retry. Likely consumed by
    /// another process or temporary FS error. No-op.
    ReadFailed,
    /// `.tmp` file or non-JSON. The watcher should not have invoked us; we
    /// ignore safely.
    Skipped,
}

/// Sink for emitted hook events. Production wires this to `tauri::AppHandle`;
/// tests use an in-memory recorder.
pub trait HookEventSink: Send + Sync {
    /// Called once per successfully parsed payload.
    fn emit_hook(&self, payload: &DropPayload);
}

/// Process a single drop file:
///
/// 1. Skip `.tmp` and non-JSON files (defensive — watcher should pre-filter).
/// 2. Read bytes; retry once after a short delay if the read fails (covers
///    the `notify` Create event arriving before `rename` completes).
/// 3. Parse + validate. On any parse error, unlink the file and return.
/// 4. On success, emit through the sink and unlink.
///
/// Never panics. All filesystem failures degrade to a `ReadFailed` outcome.
pub fn process_drop_file<S: HookEventSink>(path: &Path, sink: &S) -> ProcessOutcome {
    let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
        return ProcessOutcome::Skipped;
    };
    if file_name.ends_with(".tmp") || !file_name.ends_with(".json") {
        return ProcessOutcome::Skipped;
    }

    let bytes = match read_with_retry(path) {
        Some(b) => b,
        None => return ProcessOutcome::ReadFailed,
    };

    match parse_drop_payload(&bytes) {
        Ok(payload) => {
            sink.emit_hook(&payload);
            let _ = fs::remove_file(path);
            ProcessOutcome::Emitted
        }
        Err(DropPayloadError::UnsupportedVersion { actual, .. }) => {
            let _ = fs::remove_file(path);
            ProcessOutcome::UnsupportedVersionUnlinked { actual }
        }
        Err(_) => {
            let _ = fs::remove_file(path);
            ProcessOutcome::InvalidUnlinked
        }
    }
}

fn read_with_retry(path: &Path) -> Option<Vec<u8>> {
    match fs::read(path) {
        Ok(b) => Some(b),
        Err(_) => {
            sleep(READ_RETRY_DELAY);
            fs::read(path).ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// In-memory sink that records every emitted payload.
    #[derive(Default)]
    struct FakeSink {
        emitted: Mutex<Vec<DropPayload>>,
    }

    impl FakeSink {
        fn emitted(&self) -> Vec<DropPayload> {
            self.emitted.lock().unwrap().clone()
        }
    }

    impl HookEventSink for FakeSink {
        fn emit_hook(&self, payload: &DropPayload) {
            self.emitted.lock().unwrap().push(payload.clone());
        }
    }

    fn write_drop(dir: &Path, name: &str, json: &serde_json::Value) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, serde_json::to_vec(json).unwrap()).unwrap();
        path
    }

    fn minimal_v1() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "sessionId": "abc",
            "agentType": "claude",
            "event": "stop",
            "status": "idle",
            "title": "Finished working",
            "body": "Done.",
            "userPrompt": "do thing",
            "cwd": "/tmp/proj",
            "pid": 1,
            "agentPid": 2,
            "timestamp": 1_000_000,
        })
    }

    #[test]
    fn emits_and_unlinks_valid_drop() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let path = write_drop(tmp.path(), "drop.json", &minimal_v1());

        let outcome = process_drop_file(&path, &sink);
        assert_eq!(outcome, ProcessOutcome::Emitted);
        assert!(!path.exists(), "valid drop should be unlinked");

        let events = sink.emitted();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].agent_type, "claude");
        assert_eq!(events[0].event, "stop");
    }

    #[test]
    fn unlinks_invalid_json_without_emitting() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let path = tmp.path().join("garbage.json");
        std::fs::write(&path, b"not json {").unwrap();

        let outcome = process_drop_file(&path, &sink);
        assert_eq!(outcome, ProcessOutcome::InvalidUnlinked);
        assert!(!path.exists());
        assert!(sink.emitted().is_empty());
    }

    #[test]
    fn unlinks_unsupported_version_without_emitting() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let mut json = minimal_v1();
        json["version"] = serde_json::json!(99);
        let path = write_drop(tmp.path(), "future.json", &json);

        let outcome = process_drop_file(&path, &sink);
        assert!(matches!(
            outcome,
            ProcessOutcome::UnsupportedVersionUnlinked { actual: 99 }
        ));
        assert!(!path.exists());
        assert!(sink.emitted().is_empty());
    }

    #[test]
    fn unlinks_payload_with_missing_required_field() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let mut json = minimal_v1();
        json["agentType"] = serde_json::json!("");
        let path = write_drop(tmp.path(), "missing.json", &json);

        let outcome = process_drop_file(&path, &sink);
        assert_eq!(outcome, ProcessOutcome::InvalidUnlinked);
        assert!(!path.exists());
    }

    #[test]
    fn skips_tmp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let path = tmp.path().join("x.json.tmp");
        std::fs::write(&path, b"{}").unwrap();

        let outcome = process_drop_file(&path, &sink);
        assert_eq!(outcome, ProcessOutcome::Skipped);
        assert!(path.exists(), "must not unlink .tmp files");
        assert!(sink.emitted().is_empty());
    }

    #[test]
    fn skips_non_json_file() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let path = tmp.path().join("notes.md");
        std::fs::write(&path, b"hello").unwrap();

        let outcome = process_drop_file(&path, &sink);
        assert_eq!(outcome, ProcessOutcome::Skipped);
        assert!(path.exists());
    }

    #[test]
    fn read_failed_for_missing_file() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let path = tmp.path().join("ghost.json");

        let outcome = process_drop_file(&path, &sink);
        assert_eq!(outcome, ProcessOutcome::ReadFailed);
        assert!(sink.emitted().is_empty());
    }

    #[test]
    fn processes_consecutive_drops_without_state_leak() {
        let tmp = tempfile::tempdir().unwrap();
        let sink = FakeSink::default();
        let p1 = write_drop(tmp.path(), "1.json", &minimal_v1());
        let p2 = write_drop(tmp.path(), "2.json", &minimal_v1());

        assert_eq!(process_drop_file(&p1, &sink), ProcessOutcome::Emitted);
        assert_eq!(process_drop_file(&p2, &sink), ProcessOutcome::Emitted);
        assert_eq!(sink.emitted().len(), 2);
    }
}
