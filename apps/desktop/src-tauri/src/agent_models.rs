//! The models an agent CLI offers, as the CLI itself reports them — names, order, and the
//! reasoning levels each one takes.
//!
//! Same idea as bb's `provider.list_models`: ask the provider instead of keeping a list in Lotus.
//! A hardcoded list goes stale on every release (the Agent Presets picker said "Opus 5" while
//! `--model opus` already ran Opus 5.5); the CLI never does.
//!
//! - **Claude** answers the stream-json `initialize` control request with a `models` array
//!   (`value`, `displayName`, `description`, `supportedEffortLevels`). Measured 2026-10-13: 0.34 s,
//!   no turn, no prompt. Hooks are switched off and nothing is saved, so opening a picker never
//!   fires SessionStart hooks or leaves a session in `/resume`.
//! - **Codex** keeps the list it fetched in `~/.codex/models_cache.json` (`display_name`,
//!   `priority`, `visibility`, `supported_reasoning_levels`) — the file `codex app-server`'s
//!   `model/list` serves from.
//!
//! `None` means "the CLI did not say": the caller falls back to `config/models/catalog.ts`.

use crate::no_window::NoWindow;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::paths;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    /// What `--model` takes.
    pub value: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Least first. Empty = the model takes no effort flag.
    pub efforts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_effort: Option<String>,
    /// Set when `value` is a moving alias: the model it runs today (`opus` → `claude-opus-5-5`).
    /// A preset that saves the alias moves to the next model on its own; a pinned id never does.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolves_to: Option<String>,
}

const CLAUDE_TIMEOUT: Duration = Duration::from_secs(12);

pub fn list_agent_models(agent_id: &str) -> Option<Vec<AgentModel>> {
    let models = match agent_id {
        "claude" | "ccs" | "csp" => list_claude_models()?,
        "codex" => parse_codex_cache(&std::fs::read_to_string(paths::codex_dir().join("models_cache.json")).ok()?),
        _ => return None,
    };
    (!models.is_empty()).then_some(models)
}

/// `claude -p` in stream-json, one `initialize` control request, read until its response.
///
/// Always plain `claude`, also for `ccs`: a profile changes the account, not the CLI's model list.
fn list_claude_models() -> Option<Vec<AgentModel>> {
    let executable = crate::pty::resolve_command_executable("claude");
    let mut cmd = Command::new(executable).no_window();
    cmd.args([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ])
    .current_dir(paths::home_dir())
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(unix)]
    crate::shell_env::apply_login_env_pairs(&mut cmd, crate::shell_env::user_login_env());

    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    // Stdin stays open until the answer is in: closing it ends the session before it replies.
    if writeln!(stdin, r#"{{"type":"control_request","request_id":"lotus-models","request":{{"subtype":"initialize"}}}}"#).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    }

    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.contains(r#""control_response""#) {
                let _ = tx.send(line);
                return;
            }
        }
    });
    let answer = rx.recv_timeout(CLAUDE_TIMEOUT).ok();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    parse_claude_initialize(&answer?)
}

fn parse_claude_initialize(line: &str) -> Option<Vec<AgentModel>> {
    let value: Value = serde_json::from_str(line).ok()?;
    let models = value.pointer("/response/response/models")?.as_array()?;
    Some(
        models
            .iter()
            .filter_map(|model| {
                let value = model.get("value")?.as_str()?;
                // `default` is "whatever claude starts on" — the picker's own CLI default row.
                if value == "default" {
                    return None;
                }
                let efforts = if model.get("supportsEffort").and_then(Value::as_bool) == Some(true) {
                    strings(model.get("supportedEffortLevels"))
                } else {
                    vec![]
                };
                Some(AgentModel {
                    value: value.to_string(),
                    label: text(model.get("displayName")).unwrap_or_else(|| value.to_string()),
                    description: text(model.get("description")),
                    efforts,
                    default_effort: None,
                    resolves_to: text(model.get("resolvedModel")).filter(|resolved| resolved != value),
                })
            })
            .collect(),
    )
}

/// Hidden entries (`gpt-reserve`, `codex-auto-review`) are internal and never offered.
fn parse_codex_cache(contents: &str) -> Vec<AgentModel> {
    let Ok(value) = serde_json::from_str::<Value>(contents) else {
        return vec![];
    };
    let Some(models) = value.get("models").and_then(Value::as_array) else {
        return vec![];
    };
    let mut ranked: Vec<(i64, AgentModel)> = models
        .iter()
        .filter(|model| model.get("visibility").and_then(Value::as_str) != Some("hide"))
        .filter_map(|model| {
            let slug = model.get("slug")?.as_str()?;
            let efforts = model
                .get("supported_reasoning_levels")
                .and_then(Value::as_array)
                .map(|levels| levels.iter().filter_map(|l| text(l.get("effort"))).collect())
                .unwrap_or_default();
            let priority = model.get("priority").and_then(Value::as_i64).unwrap_or(i64::MAX);
            Some((
                priority,
                AgentModel {
                    value: slug.to_string(),
                    label: text(model.get("display_name")).unwrap_or_else(|| slug.to_string()),
                    description: text(model.get("description")),
                    efforts,
                    default_effort: text(model.get("default_reasoning_level")),
                    resolves_to: None,
                },
            ))
        })
        .collect();
    ranked.sort_by_key(|(priority, _)| *priority);
    ranked.into_iter().map(|(_, model)| model).collect()
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| text(Some(item))).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed from the real reply of claude on 2026-10-13.
    const CLAUDE_INIT: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"lotus-models","response":{"models":[
      {"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default (recommended)","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
      {"value":"opus","resolvedModel":"claude-opus-5-5","displayName":"Opus 5.5","description":"For complex work and everyday tasks","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
      {"value":"claude-haiku-4-5-20251001","displayName":"Haiku 4.5","description":"Fastest for quick answers"},
      {"value":"claude-opus-4-6","displayName":"Opus 4.6","supportsEffort":true,"supportedEffortLevels":["low","medium","high","max"]}
    ]}}}"#;

    #[test]
    fn claude_models_keep_the_cli_order_names_and_levels_without_the_default_row() {
        let models = parse_claude_initialize(CLAUDE_INIT).unwrap();
        let names: Vec<_> = models.iter().map(|m| (m.value.as_str(), m.label.as_str())).collect();
        assert_eq!(names, [("opus", "Opus 5.5"), ("claude-haiku-4-5-20251001", "Haiku 4.5"), ("claude-opus-4-6", "Opus 4.6")]);
        assert_eq!(models[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert!(models[1].efforts.is_empty(), "no supportsEffort means no effort flag");
        assert_eq!(models[2].efforts, ["low", "medium", "high", "max"]);
        assert_eq!(models[0].resolves_to.as_deref(), Some("claude-opus-5-5"), "opus is an alias");
        assert_eq!(models[2].resolves_to, None, "a pinned id is not");
    }

    #[test]
    fn a_reply_without_models_is_not_an_empty_list() {
        assert!(parse_claude_initialize(r#"{"type":"control_response","response":{"response":{}}}"#).is_none());
        assert!(parse_claude_initialize("not json").is_none());
    }

    #[test]
    fn codex_models_follow_priority_and_drop_hidden_ones() {
        let cache = r#"{"models":[
          {"slug":"gpt-5.6-sol","display_name":"GPT-5.6-Sol","priority":5,"visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"xhigh"}]},
          {"slug":"gpt-reserve","display_name":"GPT-Reserve","priority":4,"visibility":"hide"},
          {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","priority":1,"visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"}]}
        ]}"#;
        let models = parse_codex_cache(cache);
        let names: Vec<_> = models.iter().map(|m| m.label.as_str()).collect();
        assert_eq!(names, ["GPT-6.1-Sol", "GPT-5.6-Sol"]);
        assert_eq!(models[0].efforts, ["low", "ultra"]);
        assert_eq!(models[0].default_effort.as_deref(), Some("low"));
        assert!(parse_codex_cache("{}").is_empty());
    }

    /// Spawns the real CLI: `cargo test --lib agent_models -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_lists() {
        for agent in ["claude", "codex"] {
            let models = list_agent_models(agent);
            println!("{agent}: {:?}", models.as_ref().map(|m| m.iter().map(|x| x.label.clone()).collect::<Vec<_>>()));
            assert!(models.is_some(), "{agent} reported no models");
        }
    }
}
