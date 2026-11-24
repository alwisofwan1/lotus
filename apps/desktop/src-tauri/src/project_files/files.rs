use super::paths::{relative_to_root, resolve_project_child, resolve_project_root};
use super::MAX_FILE_BYTES;
use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub total_lines: u32,
}

/// Read file content with optional line range.
pub fn read_project_file(
    project_path: String,
    file_path: String,
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> Result<FileContent, String> {
    let root = resolve_project_root(&project_path)?;
    let full_path = resolve_project_child(&project_path, &file_path)?;
    let metadata = fs::metadata(&full_path)
        .map_err(|error| format!("Failed to inspect `{file_path}`: {error}"))?;

    if !metadata.is_file() {
        return Err(format!("Project path `{file_path}` is not a file."));
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err(format!(
            "Refusing to read `{file_path}` because it is larger than {} bytes.",
            MAX_FILE_BYTES
        ));
    }

    let bytes =
        fs::read(&full_path).map_err(|error| format!("Failed to read `{file_path}`: {error}"))?;
    if bytes.contains(&0) {
        return Err(format!("Refusing to read binary file `{file_path}`."));
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("Refusing to read non-UTF-8 file `{file_path}`."))?;

    let lines: Vec<&str> = content.lines().collect();
    let total_lines = lines.len() as u32;
    let filtered = select_line_range(&content, &lines, start_line, end_line);

    Ok(FileContent {
        path: relative_to_root(&root, &full_path),
        content: filtered,
        total_lines,
    })
}

fn select_line_range(
    content: &str,
    lines: &[&str],
    start_line: Option<u32>,
    end_line: Option<u32>,
) -> String {
    let Some(start_line) = start_line else {
        return content.to_string();
    };

    let start = start_line.saturating_sub(1) as usize;
    if start >= lines.len() {
        return String::new();
    }

    let end = end_line.unwrap_or(lines.len() as u32) as usize;
    let end = end.min(lines.len());
    if end <= start {
        return String::new();
    }

    lines[start..end].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "lotus-codechat-files-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ))
    }

    #[test]
    fn read_project_file_clamps_ranges_past_eof() {
        let root = unique_temp_dir("range");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("file.txt"), "one\ntwo\nthree").expect("write file");

        let content = read_project_file(
            root.to_string_lossy().into_owned(),
            "file.txt".to_string(),
            Some(10),
            Some(12),
        )
        .expect("read file");

        assert_eq!(content.content, "");
        assert_eq!(content.total_lines, 3);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_project_file_rejects_binary_files() {
        let root = unique_temp_dir("binary");
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join("file.bin"), [0, 1, 2]).expect("write binary");

        let error = read_project_file(
            root.to_string_lossy().into_owned(),
            "file.bin".to_string(),
            None,
            None,
        )
        .expect_err("binary file must be rejected");

        assert!(error.contains("binary"));
        let _ = fs::remove_dir_all(&root);
    }
}
