use std::path::Path;

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedDropPath {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_file: bool,
    pub is_directory: bool,
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string()
}

pub fn inspect_paths(paths: Vec<String>) -> Result<Vec<InspectedDropPath>, AppError> {
    paths
        .into_iter()
        .map(|path| {
            let meta = std::fs::metadata(&path).map_err(|err| AppError::Other(err.to_string()))?;
            Ok(InspectedDropPath {
                name: basename(&path),
                path,
                size: meta.len(),
                is_file: meta.is_file(),
                is_directory: meta.is_dir(),
            })
        })
        .collect()
}
