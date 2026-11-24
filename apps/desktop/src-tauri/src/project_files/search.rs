use crate::no_window::NoWindow;
use super::paths::{normalize_rg_path, resolve_project_root};
use super::{DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SearchResult {
    pub path: String,
    pub line_number: u32,
    pub content: String,
}

/// Search codebase using ripgrep JSON output.
pub fn search_codebase(
    project_path: String,
    pattern: String,
    file_glob: Option<String>,
    max_results: Option<u32>,
) -> Result<Vec<SearchResult>, String> {
    let root = resolve_project_root(&project_path)?;
    let max = max_results
        .unwrap_or(DEFAULT_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);

    let mut cmd = Command::new("rg").no_window();
    cmd.args(["--json", "--line-number", "--color", "never"]);
    cmd.args(["--max-count", &max.to_string()]);

    if let Some(glob) = file_glob.as_deref().filter(|glob| !glob.trim().is_empty()) {
        cmd.args(["--glob", glob]);
    }

    cmd.arg(&pattern).arg(".").current_dir(&root);

    let output = cmd
        .output()
        .map_err(|error| format!("ripgrep failed: {error}"))?;

    match output.status.code() {
        Some(0) | Some(1) => {}
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "ripgrep failed.".to_string()
            } else {
                stderr
            });
        }
    }

    if output.status.code() == Some(1) {
        return Ok(Vec::new());
    }

    parse_rg_json_matches(&String::from_utf8_lossy(&output.stdout), max as usize)
}

fn parse_rg_json_matches(stdout: &str, max: usize) -> Result<Vec<SearchResult>, String> {
    let mut results = Vec::new();

    for line in stdout.lines() {
        if results.len() >= max {
            break;
        }

        let value: Value = serde_json::from_str(line)
            .map_err(|error| format!("Failed to parse ripgrep JSON output: {error}"))?;
        if value.get("type").and_then(Value::as_str) != Some("match") {
            continue;
        }

        let Some(data) = value.get("data") else {
            continue;
        };
        let path = data
            .get("path")
            .and_then(|path| path.get("text"))
            .and_then(Value::as_str)
            .map(normalize_rg_path);
        let line_number = data
            .get("line_number")
            .and_then(Value::as_u64)
            .and_then(|line| u32::try_from(line).ok());
        let content = data
            .get("lines")
            .and_then(|lines| lines.get("text"))
            .and_then(Value::as_str)
            .map(|line| line.trim_end_matches(['\r', '\n']).to_string());

        if let (Some(path), Some(line_number), Some(content)) = (path, line_number, content) {
            results.push(SearchResult {
                path,
                line_number,
                content,
            });
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_rg_json_matches_reads_match_events() {
        let stdout = r#"{"type":"begin","data":{"path":{"text":"./src/main.rs"}}}
{"type":"match","data":{"path":{"text":"./src/main.rs"},"lines":{"text":"fn main() {}\n"},"line_number":7}}
{"type":"end","data":{"path":{"text":"./src/main.rs"}}}"#;

        let results = parse_rg_json_matches(stdout, 10).expect("parse rg json");

        assert_eq!(
            results,
            vec![SearchResult {
                path: "src/main.rs".to_string(),
                line_number: 7,
                content: "fn main() {}".to_string(),
            }]
        );
    }
}
