//! Hot exit: a copy of each unsaved editor buffer on disk, so a crash, a force quit or a power
//! cut does not lose the edits. The next time the file opens, the copy is put back as unsaved
//! edits (`editor-backups.ts`).
//!
//! The webview owns what a backup holds (the text, the saved text, the mtime, the encoding) and
//! sends it as one JSON string; this module only stores it under a key (the workspace location
//! plus the path). Files are named by a stable hash of the key, and the key is kept inside the
//! file and checked on read, so a hash collision reads as "no backup" instead of another file's
//! text.
//!
//! Backups live in `<lotus state dir>/editor-backups/`, readable by the user only. One not
//! touched for [`MAX_AGE_DAYS`] belongs to a file nobody opened again; it is swept once per run.

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::AppError;

const MAX_AGE_DAYS: u64 = 30;

#[derive(Serialize, Deserialize)]
struct StoredBackup {
    key: String,
    data: String,
}

pub fn backups_dir() -> PathBuf {
    crate::paths::lotus_state_dir().join("editor-backups")
}

/// FNV-1a: stable across Rust versions and runs, unlike `DefaultHasher`, so a backup written
/// by one build is found by the next.
fn key_hash(key: &str) -> u64 {
    key.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn backup_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{:016x}.json", key_hash(key)))
}

fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub fn write(dir: &Path, key: &str, data: String) -> Result<(), AppError> {
    static SWEEP: Once = Once::new();
    SWEEP.call_once(|| sweep(dir, Duration::from_secs(MAX_AGE_DAYS * 24 * 60 * 60)));
    ensure_dir(dir)?;
    let bytes = serde_json::to_vec(&StoredBackup {
        key: key.to_string(),
        data,
    })
    .map_err(|err| AppError::Other(err.to_string()))?;
    crate::editor_fs::write_file_atomically(&backup_file(dir, key), &bytes)?;
    Ok(())
}

pub fn read(dir: &Path, key: &str) -> Result<Option<String>, AppError> {
    let bytes = match std::fs::read(backup_file(dir, key)) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    // A torn or foreign file is no backup; the next write replaces it.
    Ok(serde_json::from_slice::<StoredBackup>(&bytes)
        .ok()
        .filter(|stored| stored.key == key)
        .map(|stored| stored.data))
}

pub fn delete(dir: &Path, key: &str) -> Result<(), AppError> {
    match std::fs::remove_file(backup_file(dir, key)) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
        _ => Ok(()),
    }
}

fn sweep(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > max_age);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_reads_and_deletes_by_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = "local\0/repo/src/main.rs";
        assert_eq!(read(dir.path(), key).unwrap(), None);
        write(dir.path(), key, "{\"content\":\"edited\"}".into()).unwrap();
        assert_eq!(read(dir.path(), key).unwrap().as_deref(), Some("{\"content\":\"edited\"}"));
        write(dir.path(), key, "{\"content\":\"newer\"}".into()).unwrap();
        assert_eq!(read(dir.path(), key).unwrap().as_deref(), Some("{\"content\":\"newer\"}"));
        assert_eq!(read(dir.path(), "ssh:box\0/repo/src/main.rs").unwrap(), None);
        delete(dir.path(), key).unwrap();
        assert_eq!(read(dir.path(), key).unwrap(), None);
        // Deleting what is not there is not an error.
        delete(dir.path(), key).unwrap();
    }

    #[test]
    fn a_file_holding_another_key_is_no_backup() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "a", "x".into()).unwrap();
        std::fs::rename(backup_file(dir.path(), "a"), backup_file(dir.path(), "b")).unwrap();
        assert_eq!(read(dir.path(), "b").unwrap(), None);
        std::fs::write(backup_file(dir.path(), "c"), b"{torn").unwrap();
        assert_eq!(read(dir.path(), "c").unwrap(), None);
    }

    #[test]
    fn the_hash_is_stable_across_builds() {
        // Pinned: a change here orphans every backup on disk.
        assert_eq!(key_hash(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(key_hash("a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn sweep_removes_only_old_backups() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "fresh", "x".into()).unwrap();
        sweep(dir.path(), Duration::from_secs(3600));
        assert!(read(dir.path(), "fresh").unwrap().is_some());
        sweep(dir.path(), Duration::ZERO);
        std::thread::sleep(Duration::from_millis(5));
        sweep(dir.path(), Duration::ZERO);
        assert!(read(dir.path(), "fresh").unwrap().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn only_the_user_can_read_backups() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("editor-backups");
        write(&dir, "k", "x".into()).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }
}
