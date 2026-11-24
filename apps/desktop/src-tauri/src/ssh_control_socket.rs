//! Cleanup of stale SSH ControlMaster sockets owned by Lotus.
//!
//! Older Lotus SSH PTY builds used `ControlPath=~/.ssh/lotus-cm-%C` for
//! long-lived interactive sessions. When the app crashed, the OS could kill
//! the master process while leaving the socket file behind. A subsequent run
//! could then race into the orphaned socket and report "Connection to UNKNOWN
//! port 65535 timed out".
//!
//! SSH PTY creation is no longer part of the default CodeSpace terminal path,
//! but at app boot we still unlink legacy `~/.ssh/lotus-cm-*` sockets as a
//! harmless cleanup for users who ran older builds.

use std::fs;
use std::path::PathBuf;

const SOCKET_PREFIX: &str = "lotus-cm-";

fn ssh_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh"))
}

/// Best-effort unlink of every `~/.ssh/lotus-cm-*` entry. Returns the count
/// of sockets removed; per-entry errors are swallowed (logged via `tracing`
/// when available). Never panics. Safe to call from `tauri::Builder::setup`.
pub fn cleanup_stale_lotus_control_sockets() -> usize {
    let Some(dir) = ssh_dir() else {
        return 0;
    };
    cleanup_in(&dir)
}

fn cleanup_in(dir: &std::path::Path) -> usize {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // No `~/.ssh` yet — nothing to clean. Not an error.
        Err(_) => return 0,
    };

    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if !name_str.starts_with(SOCKET_PREFIX) {
            continue;
        }
        // Defense in depth: only unlink files (sockets show as files), never
        // recurse into directories with a coincidentally-matching prefix.
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        if fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    #[test]
    fn cleanup_removes_only_lotus_prefixed_files() {
        let tmp = tempfile::tempdir().unwrap();
        File::create(tmp.path().join("lotus-cm-abc")).unwrap();
        File::create(tmp.path().join("lotus-cm-xyz")).unwrap();
        File::create(tmp.path().join("config")).unwrap();
        File::create(tmp.path().join("known_hosts")).unwrap();

        let removed = cleanup_in(tmp.path());

        assert_eq!(removed, 2);
        assert!(!tmp.path().join("lotus-cm-abc").exists());
        assert!(!tmp.path().join("lotus-cm-xyz").exists());
        assert!(tmp.path().join("config").exists());
        assert!(tmp.path().join("known_hosts").exists());
    }

    #[test]
    fn cleanup_returns_zero_when_dir_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nonexistent-ssh-dir");
        assert_eq!(cleanup_in(&missing), 0);
    }

    #[test]
    fn cleanup_skips_directories_with_matching_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir(tmp.path().join("lotus-cm-dir")).unwrap();
        File::create(tmp.path().join("lotus-cm-file")).unwrap();

        let removed = cleanup_in(tmp.path());

        assert_eq!(removed, 1);
        assert!(tmp.path().join("lotus-cm-dir").exists());
        assert!(!tmp.path().join("lotus-cm-file").exists());
    }

    #[test]
    fn cleanup_handles_empty_directory() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(cleanup_in(tmp.path()), 0);
    }
}
