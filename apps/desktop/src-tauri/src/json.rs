use std::path::PathBuf;

use serde::{de::DeserializeOwned, Serialize};

use crate::error::{other, AppError};

pub fn read_json<T: DeserializeOwned>(path: &PathBuf) -> Option<T> {
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), AppError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::Io)?;
    }
    let content = serde_json::to_string_pretty(value).map_err(|e| other(e.to_string()))?;
    std::fs::write(path, content).map_err(AppError::Io)?;
    Ok(())
}

/// Generic helper to collect deserialized JSON entries from a directory.
/// `path_fn` maps each directory entry to the JSON file path to read.
pub fn collect_json_entries<T, F>(dir: &PathBuf, path_fn: F) -> Vec<T>
where
    T: DeserializeOwned,
    F: Fn(&std::fs::DirEntry) -> PathBuf,
{
    if !dir.exists() {
        return vec![];
    }
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| read_json::<T>(&path_fn(&e)))
                .collect()
        })
        .unwrap_or_default()
}
