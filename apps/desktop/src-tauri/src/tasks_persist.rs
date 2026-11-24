//! Persistent storage for Bridge tasks. Mirrors the atomic-write +
//! 0600-perms pattern used by `mcp_config.rs` so the on-disk semantics
//! are consistent across all Lotus-managed JSON state under `~/.claude/`.
//!
//! File layout:
//!   ~/.claude/lotus-tasks/{workspaceId}.json
//!
//! The frontend `task-store.ts` already validates payload shape and
//! caps; this module's only job is safe atomic disk I/O. workspaceId
//! is sanitized to prevent path traversal.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum TaskPersistError {
    #[error("cannot resolve user home directory")]
    NoHome,
    #[error("workspaceId is empty or contains illegal characters")]
    InvalidWorkspaceId,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub fn tasks_dir() -> Result<PathBuf, TaskPersistError> {
    let home = dirs::home_dir().ok_or(TaskPersistError::NoHome)?;
    Ok(home.join(".claude").join("lotus-tasks"))
}

fn task_file_path_in(base: &Path, workspace_id: &str) -> Result<PathBuf, TaskPersistError> {
    let safe = sanitize_workspace_id(workspace_id)?;
    Ok(base.join(format!("{safe}.json")))
}

/// Allow only `[A-Za-z0-9_-]+` to avoid path traversal or filesystem-reserved
/// characters. workspaceId from the frontend is opaque (e.g. "ws_alpha",
/// timestamp suffixes) so this is a tight whitelist by design.
fn sanitize_workspace_id(id: &str) -> Result<String, TaskPersistError> {
    if id.is_empty() {
        return Err(TaskPersistError::InvalidWorkspaceId);
    }
    let ok = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !ok {
        return Err(TaskPersistError::InvalidWorkspaceId);
    }
    Ok(id.to_string())
}

/// Atomic write: stage to `{target}.tmp` then rename. Sets 0600 on Unix
/// so other local users cannot read another user's task state.
pub(crate) fn atomic_write<P: AsRef<Path>>(target: P, contents: &[u8]) -> std::io::Result<()> {
    let target = target.as_ref();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("tmp");
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&tmp, perms)?;
    }
    fs::rename(tmp, target)?;
    Ok(())
}

/// Read the workspace's tasks file. Returns `Ok(None)` if the file does
/// not exist (first-time read) — frontend layer treats null as empty.
pub fn read_tasks(workspace_id: &str) -> Result<Option<String>, TaskPersistError> {
    read_tasks_in(&tasks_dir()?, workspace_id)
}

pub fn read_tasks_in(base: &Path, workspace_id: &str) -> Result<Option<String>, TaskPersistError> {
    let path = task_file_path_in(base, workspace_id)?;
    match fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(TaskPersistError::Io(err)),
    }
}

/// Atomic write of the full tasks payload. Caller (frontend) is
/// responsible for serialization shape and field caps.
pub fn write_tasks(workspace_id: &str, payload: &str) -> Result<PathBuf, TaskPersistError> {
    write_tasks_in(&tasks_dir()?, workspace_id, payload)
}

pub fn write_tasks_in(
    base: &Path,
    workspace_id: &str,
    payload: &str,
) -> Result<PathBuf, TaskPersistError> {
    let path = task_file_path_in(base, workspace_id)?;
    atomic_write(&path, payload.as_bytes())?;
    Ok(path)
}

/// Why a task file was set aside, written into its new name.
#[derive(Debug, Clone, Copy)]
pub enum Retired {
    Moved,
    Deleted,
}

/// Rename the workspace's task file aside instead of deleting it: `{id}.json.moved-{stamp}` (or
/// `deleted-`) is no longer read by anything, and still there to restore by hand.
pub fn retire_tasks_in(
    base: &Path,
    workspace_id: &str,
    why: Retired,
    stamp: u64,
) -> Result<(), TaskPersistError> {
    let path = task_file_path_in(base, workspace_id)?;
    let why = match why {
        Retired::Moved => "moved",
        Retired::Deleted => "deleted",
    };
    let retired = base.join(format!(
        "{}.json.{why}-{stamp}",
        sanitize_workspace_id(workspace_id)?
    ));
    fs::rename(path, retired)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn sanitize_accepts_alphanumeric_underscore_dash() {
        assert!(sanitize_workspace_id("ws_alpha-1").is_ok());
    }

    #[test]
    fn sanitize_rejects_empty() {
        assert!(sanitize_workspace_id("").is_err());
    }

    #[test]
    fn sanitize_rejects_path_traversal() {
        assert!(sanitize_workspace_id("../etc/passwd").is_err());
        assert!(sanitize_workspace_id("ws/with/slash").is_err());
        assert!(sanitize_workspace_id("ws.with.dots").is_err());
    }

    #[test]
    fn read_returns_none_when_file_missing() {
        let base = temp_base();
        let result = read_tasks_in(base.path(), "ws_brand_new").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn write_then_read_round_trips_payload() {
        let base = temp_base();
        let payload = r#"{"v":1,"tasks":[{"id":"task_x","title":"hello"}]}"#;
        let path = write_tasks_in(base.path(), "ws_a", payload).unwrap();
        assert!(path.exists());
        let read = read_tasks_in(base.path(), "ws_a").unwrap();
        assert_eq!(read.as_deref(), Some(payload));
    }

    #[test]
    fn write_overwrites_existing_payload_atomically() {
        let base = temp_base();
        write_tasks_in(base.path(), "ws_a", r#"{"v":1,"tasks":[]}"#).unwrap();
        write_tasks_in(base.path(), "ws_a", r#"{"v":1,"tasks":[{"id":"task_x"}]}"#).unwrap();
        let read = read_tasks_in(base.path(), "ws_a").unwrap().unwrap();
        assert!(read.contains("task_x"));
    }

    #[test]
    fn write_isolates_per_workspace() {
        let base = temp_base();
        write_tasks_in(base.path(), "ws_a", r#"{"v":1,"tasks":[{"id":"a"}]}"#).unwrap();
        write_tasks_in(base.path(), "ws_b", r#"{"v":1,"tasks":[{"id":"b"}]}"#).unwrap();
        assert!(read_tasks_in(base.path(), "ws_a")
            .unwrap()
            .unwrap()
            .contains("\"a\""));
        assert!(read_tasks_in(base.path(), "ws_b")
            .unwrap()
            .unwrap()
            .contains("\"b\""));
    }

    #[test]
    fn read_propagates_invalid_workspace_id() {
        let base = temp_base();
        let err = read_tasks_in(base.path(), "../oops").unwrap_err();
        assert!(matches!(err, TaskPersistError::InvalidWorkspaceId));
    }

    #[cfg(unix)]
    #[test]
    fn write_sets_0600_perms_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let base = temp_base();
        let path = write_tasks_in(base.path(), "ws_perm", "{}").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
