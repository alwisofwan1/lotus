//! Drop-directory resolution and startup drain.
//!
//! On startup, the watcher must catch up on any drop files that landed while
//! Lotus was closed. Files within the freshness window are emitted; older
//! files are unlinked silently. This avoids replaying stale "agent finished"
//! events from days ago every time the user opens the app.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Default drop directory: `~/.lotus/agent-hooks/global/`.
///
/// Returns `None` when the user's home directory cannot be resolved (rare;
/// the watcher startup logs and skips registration in that case).
pub fn default_drop_dir() -> Option<PathBuf> {
    // `lotus_state_dir()`, not a hardcoded `~/.lotus`: it is what splits dev
    // (`~/.lotus-dev`) from release, and hardcoding made both profiles watch one
    // directory. Observed live — the release app and a dev build raced for every
    // hook event, and whichever watcher unlinked the file first, the other never
    // saw it at all.
    Some(
        crate::paths::lotus_state_dir()
            .join("agent-hooks")
            .join("global"),
    )
}

/// Maximum age of a drop file we will still emit on startup drain. Files
/// older than this are considered stale and unlinked.
pub const DEFAULT_DRAIN_TTL: Duration = Duration::from_secs(5 * 60);

/// What the drainer did with a single file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainOutcome {
    /// Within TTL — caller should read & emit.
    Emit,
    /// Past TTL — drainer already unlinked.
    Stale,
    /// In-progress write (`.tmp`) — skipped, will be picked up by watcher.
    InProgress,
}

/// One file the drainer surfaced for the caller to consume.
#[derive(Debug, Clone)]
pub struct DrainedFile {
    pub path: PathBuf,
    pub outcome: DrainOutcome,
}

/// Ensure the drop directory exists. Idempotent. Errors only when the path
/// is blocked (e.g. a regular file at the same name) — which is unrecoverable
/// and should bubble up to the caller for logging.
pub fn ensure_drop_dir<P: AsRef<Path>>(dir: P) -> std::io::Result<()> {
    fs::create_dir_all(dir.as_ref())
}

/// Walk the drop directory once. For each `*.json` file:
///
/// - `Emit` if mtime is within `ttl`. Caller reads + emits.
/// - `Stale` if older than `ttl`. Drainer has already unlinked.
/// - `InProgress` for `*.tmp` files (writer hasn't renamed yet).
///
/// Returns an empty Vec for a non-existent or unreadable dir; logging /
/// telemetry is the caller's job.
pub fn drain_pending<P: AsRef<Path>>(dir: P, ttl: Duration, now: SystemTime) -> Vec<DrainedFile> {
    let dir = dir.as_ref();
    let entries = match fs::read_dir(dir) {
        Ok(it) => it,
        Err(_) => return Vec::new(),
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };

        if file_name.ends_with(".tmp") {
            out.push(DrainedFile {
                path,
                outcome: DrainOutcome::InProgress,
            });
            continue;
        }
        if !file_name.ends_with(".json") {
            continue;
        }

        let outcome = classify_age(&path, ttl, now);
        if matches!(outcome, DrainOutcome::Stale) {
            // Best-effort unlink. Failures here are tolerated: the next drain
            // pass will retry, and the watcher won't loop on these because
            // the same age check runs again.
            let _ = fs::remove_file(&path);
        }
        out.push(DrainedFile { path, outcome });
    }
    out
}

fn classify_age(path: &Path, ttl: Duration, now: SystemTime) -> DrainOutcome {
    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return DrainOutcome::Emit, // Treat missing metadata as fresh — safer to emit than drop.
    };
    let modified = metadata.modified().unwrap_or(now);
    let age = now.duration_since(modified).unwrap_or(Duration::ZERO);
    if age > ttl {
        DrainOutcome::Stale
    } else {
        DrainOutcome::Emit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::time::{Duration, SystemTime};

    fn write(dir: &Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).expect("write");
        path
    }

    fn touch_mtime(path: &Path, when: SystemTime) {
        let f = File::open(path).expect("open");
        f.set_modified(when).expect("set modified");
    }

    #[test]
    fn default_drop_dir_resolves_under_home() {
        let dir = default_drop_dir().expect("home dir");
        assert!(dir.ends_with("agent-hooks/global") || dir.ends_with("agent-hooks\\global"));
        // Path should include `.lotus` segment.
        let as_str = dir.to_string_lossy();
        assert!(as_str.contains(".lotus"));
    }

    #[test]
    fn ensure_drop_dir_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let target = tmp.path().join("a/b/c");
        ensure_drop_dir(&target).expect("first");
        ensure_drop_dir(&target).expect("second");
        assert!(target.is_dir());
    }

    #[test]
    fn drain_returns_empty_for_missing_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let missing = tmp.path().join("does-not-exist");
        assert!(drain_pending(&missing, DEFAULT_DRAIN_TTL, SystemTime::now()).is_empty());
    }

    #[test]
    fn drain_emits_fresh_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "fresh.json", "{}");
        let drained = drain_pending(tmp.path(), DEFAULT_DRAIN_TTL, SystemTime::now());
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].outcome, DrainOutcome::Emit);
    }

    #[test]
    fn drain_unlinks_stale_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let stale = write(tmp.path(), "stale.json", "{}");
        let long_ago = SystemTime::now() - Duration::from_secs(60 * 60); // 1h ago
        touch_mtime(&stale, long_ago);

        let drained = drain_pending(tmp.path(), Duration::from_secs(60), SystemTime::now());
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].outcome, DrainOutcome::Stale);
        assert!(!stale.exists(), "stale file should be unlinked");
    }

    #[test]
    fn drain_skips_tmp_files_as_in_progress() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let tmp_file = write(tmp.path(), "writing.json.tmp", "");
        let drained = drain_pending(tmp.path(), DEFAULT_DRAIN_TTL, SystemTime::now());
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].outcome, DrainOutcome::InProgress);
        assert!(tmp_file.exists(), "in-progress file must NOT be unlinked");
    }

    #[test]
    fn drain_ignores_non_json_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "stray.log", "ignore me");
        write(tmp.path(), "README.md", "ignore me");
        write(tmp.path(), "real.json", "{}");
        let drained = drain_pending(tmp.path(), DEFAULT_DRAIN_TTL, SystemTime::now());
        assert_eq!(drained.len(), 1);
        assert!(drained[0].path.ends_with("real.json"));
    }

    #[test]
    fn drain_partitions_mixed_dir_correctly() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write(tmp.path(), "fresh.json", "{}");
        let stale = write(tmp.path(), "stale.json", "{}");
        touch_mtime(&stale, SystemTime::now() - Duration::from_secs(60 * 60));
        write(tmp.path(), "mid-write.json.tmp", "");

        let drained = drain_pending(tmp.path(), Duration::from_secs(60), SystemTime::now());
        let by_outcome =
            |target: DrainOutcome| drained.iter().filter(|d| d.outcome == target).count();
        assert_eq!(by_outcome(DrainOutcome::Emit), 1);
        assert_eq!(by_outcome(DrainOutcome::Stale), 1);
        assert_eq!(by_outcome(DrainOutcome::InProgress), 1);
    }
}

#[cfg(test)]
mod dir_tests {
    use super::*;

    /// Pins the profile split. Hardcoding `~/.lotus` here is what made a release
    /// app and a dev build compete for the same drop files.
    #[test]
    fn default_drop_dir_follows_the_profile_state_dir() {
        let dir = default_drop_dir().expect("home dir");

        assert!(
            dir.starts_with(crate::paths::lotus_state_dir()),
            "got {dir:?}"
        );
        assert!(dir.ends_with("agent-hooks/global"), "got {dir:?}");
    }
}
