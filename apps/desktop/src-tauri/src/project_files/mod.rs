mod files;
mod git;
mod listing;
mod paths;
mod search;

pub use files::{read_project_file, FileContent};
pub use git::{git_blame_file, git_diff, git_repo_status, GitBlameEntry};
pub use listing::list_project_directory;
pub use search::{search_codebase, SearchResult};

const DEFAULT_SEARCH_RESULTS: u32 = 20;
const MAX_SEARCH_RESULTS: u32 = 100;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const DEFAULT_DIRECTORY_DEPTH: u32 = 2;
const MAX_DIRECTORY_DEPTH: u32 = 6;
const MAX_DIRECTORY_ENTRIES: usize = 1_000;
const MAX_DIFF_BYTES: usize = 256 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lotus-project-files-roundtrip-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ))
    }

    fn ripgrep_available() -> bool {
        Command::new("rg")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn search_result_can_be_read_back_through_workspace_file_tool() {
        if !ripgrep_available() {
            return;
        }

        let root = unique_temp_dir("search-read");
        let src = root.join("src");
        fs::create_dir_all(&src).expect("create source dir");
        fs::write(
            src.join("lib.rs"),
            "pub fn codechat_roundtrip_marker() -> &'static str {\n    \"lotus-search-read-roundtrip\"\n}\n",
        )
        .expect("write source file");

        let project_path = root.to_string_lossy().into_owned();
        let results = search_codebase(
            project_path.clone(),
            "lotus-search-read-roundtrip".to_string(),
            Some("*.rs".to_string()),
            Some(5),
        )
        .expect("search codebase");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "src/lib.rs");
        assert_eq!(results[0].line_number, 2);

        let file = read_project_file(
            project_path,
            results[0].path.clone(),
            Some(results[0].line_number),
            Some(results[0].line_number),
        )
        .expect("read searched file");

        assert_eq!(file.path, "src/lib.rs");
        assert!(file.content.contains("lotus-search-read-roundtrip"));
        let _ = fs::remove_dir_all(&root);
    }
}
