//! What a headless agent is doing, as it does it: each `stream-json` event
//! the CLI prints becomes zero or more short, plain steps ("Read src/app.ts")
//! that the run shows while it works.

use std::path::Path;

use serde_json::Value;

/// Longest step, in characters; a longer one is cut with `…`.
const MAX_STEP_CHARS: usize = 100;

/// The steps one `stream-json` line holds: one per tool call, and one per
/// tool the permission mode refused. Thinking, text, other tool results and
/// bookkeeping are not steps; nor is `ToolSearch`, which only loads a tool.
/// Paths inside `cwd` are shown relative to it.
pub fn describe_event(event: &Value, cwd: &Path) -> Vec<String> {
    let Some(content) = event["message"]["content"].as_array() else { return vec![] };
    if event["type"] == "user" {
        return content.iter().filter(|c| c["is_error"] == true).filter_map(refused_tool).collect();
    }
    if event["type"] != "assistant" {
        return vec![];
    }
    content
        .iter()
        .filter(|c| c["type"] == "tool_use")
        .filter_map(|c| describe_tool(c["name"].as_str().unwrap_or_default(), &c["input"], cwd))
        .map(|step| cut(&step))
        .collect()
}

fn describe_tool(name: &str, input: &Value, cwd: &Path) -> Option<String> {
    let text = |key: &str| input[key].as_str().unwrap_or_default().trim().to_string();
    let first_line = |key: &str| text(key).lines().next().unwrap_or_default().to_string();
    Some(match name {
        "ToolSearch" => return None,
        "Bash" if !text("description").is_empty() => text("description"),
        "Bash" => format!("Ran `{}`", first_line("command")),
        "Read" => format!("Read {}", relative(&text("file_path"), cwd)),
        "Grep" => format!("Searched for `{}`", first_line("pattern")),
        "Glob" => format!("Looked for files `{}`", text("pattern")),
        "Skill" => format!("Used the skill {}", text("skill")),
        "WebSearch" => format!("Searched the web for `{}`", text("query")),
        "WebFetch" => format!("Opened {}", text("url")),
        "StructuredOutput" => "Wrote the result".to_string(),
        _ if name.ends_with("__lotus_automation_submit") => "Handed the result to Lotus".to_string(),
        _ if name.ends_with("__lotus_github_read") => github_read(&text("path")),
        _ if name.ends_with("__lotus_notion_read") => notion_read(&text("reference")),
        _ => match name.strip_prefix("mcp__").and_then(|rest| rest.split_once("__")) {
            Some((server, tool)) => format!("Used {server}: {tool}"),
            None => format!("Used {name}"),
        },
    })
}

/// `/repos/o/acme-api/pulls/3019/files?per_page=100` → `Read GitHub acme-api#3019 files`, so
/// the step says which PR it read rather than the tool's name.
fn github_read(path: &str) -> String {
    let path = path.split('?').next().unwrap_or_default().trim_end_matches('/');
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    match parts.as_slice() {
        ["repos", _, repo, "pulls" | "issues", number, rest @ ..] if number.chars().all(|c| c.is_ascii_digit()) => match rest.first() {
            Some(what) => format!("Read GitHub {repo}#{number} {what}"),
            None => format!("Read GitHub {repo}#{number}"),
        },
        ["repos", _, repo, "contents", file @ ..] if !file.is_empty() => format!("Read GitHub {repo}: {}", file.join("/")),
        _ => format!("Read GitHub {path}"),
    }
}

/// A ticket key reads as itself (`Read Notion TKT-1234`); a link or page id says nothing to a person.
fn notion_read(reference: &str) -> String {
    let is_key = reference.split_once('-').is_some_and(|(team, number)| {
        team.starts_with(|c: char| c.is_ascii_uppercase())
            && team.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
            && !number.is_empty()
            && number.chars().all(|c| c.is_ascii_digit())
    });
    if is_key { format!("Read Notion {reference}") } else { "Read a Notion page".to_string() }
}

/// `Permission to use Write has been denied …` → `Not allowed: Write (the run only reads)`.
fn refused_tool(result: &Value) -> Option<String> {
    // A result's content is a string, or a list of text blocks.
    let text = result["content"].as_str().or_else(|| result["content"][0]["text"].as_str())?;
    let tool = text.strip_prefix("Permission to use ")?.split_once(" has been denied")?.0;
    Some(cut(&format!("Not allowed: {tool} (the run only reads)")))
}

fn relative(path: &str, cwd: &Path) -> String {
    Path::new(path).strip_prefix(cwd).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string())
}

fn cut(step: &str) -> String {
    if step.chars().count() <= MAX_STEP_CHARS {
        return step.to_string();
    }
    let kept: String = step.chars().take(MAX_STEP_CHARS - 1).collect();
    format!("{}…", kept.trim_end())
}

/// One step of a run, as shown while it works.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub at_ms: i64,
    pub text: String,
}

/// The latest steps of the latest runs, in memory: what a run shows while it
/// works, and for a while after. Lost on restart, on purpose — the transcript
/// is the record.
pub struct ActivityLog {
    per_run: usize,
    runs: usize,
    log: std::sync::Mutex<std::collections::VecDeque<(String, std::collections::VecDeque<Step>)>>,
}

impl ActivityLog {
    /// Keeps `per_run` steps for each of the `runs` most recent runs.
    pub fn new(per_run: usize, runs: usize) -> Self {
        Self { per_run, runs, log: Default::default() }
    }

    pub fn push(&self, run_id: &str, at_ms: i64, text: String) {
        let mut log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        if !log.iter().any(|(id, _)| id == run_id) {
            if log.len() == self.runs {
                log.pop_front();
            }
            log.push_back((run_id.to_string(), Default::default()));
        }
        if let Some((_, steps)) = log.iter_mut().find(|(id, _)| id == run_id) {
            if steps.len() == self.per_run {
                steps.pop_front();
            }
            steps.push_back(Step { at_ms, text });
        }
    }

    pub fn steps(&self, run_id: &str) -> Vec<Step> {
        let log = self.log.lock().unwrap_or_else(|p| p.into_inner());
        log.iter().find(|(id, _)| id == run_id).map(|(_, s)| s.iter().cloned().collect()).unwrap_or_default()
    }
}
