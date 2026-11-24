//! Checked atomic snapshots and leases held across reaper artifact mutations.
use super::{group_absent, journal_path, Data, Event};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub(crate) fn write_snapshot(
    root: &Path,
    path: &Path,
    data: &impl Serialize,
    limit: usize,
) -> Result<(), String> {
    super::super::settings::checked_path(root, path)?;
    std::fs::create_dir_all(root).map_err(|_| "Cannot create execution checkpoint storage")?;
    let bytes = serde_json::to_vec(data).map_err(|_| "Cannot serialize execution checkpoint")?;
    if bytes.len() > limit {
        return Err("Execution checkpoint exceeds its bound".into());
    }
    let temp = root.join(format!(".execution-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp)
            .map_err(|_| "Cannot prepare execution checkpoint")?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist execution checkpoint")?;
        super::super::settings::checked_path(root, path)?;
        std::fs::rename(&temp, path).map_err(|_| "Cannot replace execution checkpoint")?;
        File::open(root)
            .and_then(|f| f.sync_all())
            .map_err(|_| "Cannot sync execution checkpoint directory")?;
        Ok(())
    })();
    let _ = std::fs::remove_file(temp);
    result
}

pub struct CleanupLease(File);
impl Drop for CleanupLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
/// Hold the returned lease through cleanup, not just the inspection (avoids check/delete races).
pub fn cleanup_lease(root: &Path, id: &str) -> Result<Option<CleanupLease>, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("Invalid execution ID".into());
    }
    let path = journal_path(root, id);
    let lock_path = root.join(format!("{id}.lease"));
    super::super::settings::checked_path(root, &path)?;
    super::super::settings::checked_path(root, &lock_path)?;
    if !path.exists() && !lock_path.exists() {
        return Ok(None);
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|_| "Execution lease cannot be inspected")?;
    lock.try_lock().map_err(|_| "Execution is still owned")?;
    let guard = CleanupLease(lock);
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(|_| "Execution journal unavailable")?
        .take(65537)
        .read_to_end(&mut bytes)
        .map_err(|_| "Execution journal unreadable")?;
    if bytes.len() > 65536 {
        return Err("Execution journal exceeds its bound".into());
    }
    let data: Data = serde_json::from_slice(&bytes).map_err(|_| "Execution evidence unknown")?;
    if data.version != 1
        || data.truncated
        || data
            .processes
            .iter()
            .any(|p| !p.exited || !group_absent(p.group))
        || data
            .events
            .back()
            .is_some_and(|e| matches!(e.event, Event::Intent))
    {
        return Err("Unresolved execution evidence must be retained".into());
    }
    Ok(Some(guard))
}
pub fn retention_required(root: &Path, id: &str) -> bool {
    cleanup_lease(root, id).is_err()
}
