use crate::no_window::NoWindow;
use crate::paths;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub struct AgentCliProviderInvocation {
    pub args: Vec<String>,
    pub should_prepend_image_paths_to_prompt: bool,
}

#[derive(Debug, Clone)]
pub struct AgentCliProviderInvocationOptions<'a> {
    pub parser: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub flash: bool,
    pub provider_session_id: Option<&'a str>,
    pub image_paths: &'a [PathBuf],
    pub dangerously_skip_permissions: bool,
}

#[derive(Debug, Clone)]
pub struct AgentCliResolvedCommand {
    pub executable: String,
    pub prepend_args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCliProviderModels {
    pub models: Vec<String>,
    pub default_model: Option<String>,
    pub efforts: Vec<String>,
}

pub fn parser_supports_image_attachments(parser: &str) -> bool {
    matches!(parser, "claude-stream-json" | "codex-json")
}

pub fn probe_agent_cli_provider_auth(
    executable_name: &str,
    resolved: &AgentCliResolvedCommand,
    probe_auth: bool,
) -> (Option<String>, Option<String>) {
    if !probe_auth || executable_name != "cursor-agent" {
        return (None, None);
    }

    probe_cursor_auth_status(resolved)
}

pub fn discover_agent_cli_provider_models(
    agent_id: &str,
    command: &[String],
    run_command_for_stdout: impl Fn(&[String], &[&str]) -> String,
) -> AgentCliProviderModels {
    let mut models = BTreeSet::new();
    let mut default_model = default_model_for_agent(agent_id).map(str::to_string);

    for model in built_in_models_for_agent(agent_id) {
        models.insert(model.to_string());
    }

    if agent_id == "cursor" {
        let cursor_models = discover_models_from_cursor_cli(command, &run_command_for_stdout);
        for model in &cursor_models {
            models.insert(model.clone());
        }
        if let Some(cursor_default) = cursor_models.first() {
            default_model = Some(cursor_default.clone());
        }
    }

    let help_output = run_command_for_stdout(command, &["--help"]);
    for model in parse_models_from_help(&help_output) {
        models.insert(model.clone());
        if default_model.is_none() {
            default_model = Some(model);
        }
    }

    if agent_id == "codex" {
        // The CLI's own fetched list first: it is both current and ordered by the CLI's priority.
        let cache_models = discover_models_from_codex_cache();
        for model in &cache_models {
            models.insert(model.clone());
        }
        if let Some(cache_default) = cache_models.first() {
            default_model = Some(cache_default.clone());
        }

        let config_models = discover_models_from_codex_config();
        for model in &config_models {
            models.insert(model.clone());
        }
        if let Some(config_default) = config_models.first() {
            default_model = Some(config_default.clone());
        }
    }

    AgentCliProviderModels {
        models: models.into_iter().collect(),
        default_model,
        efforts: parse_efforts_from_help(&help_output),
    }
}

pub fn build_agent_cli_provider_invocation(
    options: AgentCliProviderInvocationOptions<'_>,
) -> Result<AgentCliProviderInvocation, String> {
    let args = match options.parser {
        "claude-stream-json" => build_claude_headless_args(
            options.model,
            options.effort,
            options.dangerously_skip_permissions || !options.image_paths.is_empty(),
        ),
        "codex-json" => {
            let codex_effort = resolve_codex_effort(options.model, options.effort, options.flash);
            let mut args = build_codex_headless_args(
                options.model,
                codex_effort,
                options.dangerously_skip_permissions,
            );

            for image_path in options.image_paths {
                args.push("--image".to_string());
                args.push(image_path.to_string_lossy().into_owned());
            }

            args
        }
        "cursor-stream-json" => {
            let mut args = Vec::new();
            if let Some(session_id) = options
                .provider_session_id
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                args.extend(["--resume".to_string(), session_id.to_string()]);
            }
            args.extend(build_cursor_headless_args(
                options.model,
                options.dangerously_skip_permissions,
            ));
            args
        }
        "raw" => Vec::new(),
        other => {
            return Err(format!("Unsupported parser type: {other}"));
        }
    };

    Ok(AgentCliProviderInvocation {
        args,
        should_prepend_image_paths_to_prompt: options.parser == "claude-stream-json",
    })
}

fn probe_cursor_auth_status(
    resolved: &AgentCliResolvedCommand,
) -> (Option<String>, Option<String>) {
    let mut cmd = Command::new(&resolved.executable).no_window();
    if !resolved.prepend_args.is_empty() {
        cmd.args(&resolved.prepend_args);
    }
    cmd.arg("status")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let output = match cmd.output() {
        Ok(output) => output,
        Err(error) => {
            return (
                Some("unknown".to_string()),
                Some(format!("Cursor auth check failed: {error}")),
            )
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = [stdout.as_str(), stderr.as_str()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let combined_lower = combined.to_ascii_lowercase();

    if combined_lower.contains("not authenticated") {
        return (
            Some("not-authenticated".to_string()),
            Some("Cursor CLI is installed, but not logged in. Run `cursor-agent login` and verify with `cursor-agent status`.".to_string()),
        );
    }

    if combined_lower.contains("authenticated")
        || combined_lower.contains("logged in")
        || combined_lower.contains("api key")
    {
        return (
            Some("authenticated".to_string()),
            Some("Cursor CLI authentication looks ready.".to_string()),
        );
    }

    if !output.status.success() {
        return (
            Some("unknown".to_string()),
            Some(if combined.is_empty() {
                format!(
                    "Cursor auth check exited with code {}.",
                    output.status.code().unwrap_or(-1)
                )
            } else {
                truncate_for_provider_error(&combined)
            }),
        );
    }

    (
        Some("unknown".to_string()),
        Some(if combined.is_empty() {
            "Cursor auth status could not be determined from `cursor-agent status`.".to_string()
        } else {
            truncate_for_provider_error(&combined)
        }),
    )
}

fn truncate_for_provider_error(value: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = value.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }

    let shortened = trimmed.chars().take(LIMIT).collect::<String>();
    format!("{shortened}...")
}

fn built_in_models_for_agent(agent_id: &str) -> &'static [&'static str] {
    match agent_id {
        "claude" | "ccs-hss" | "csp" => &[
            // Tier aliases, newest first — the CLI resolves each to the latest model of its
            // tier (`claude --help`). `fable` is one of the three the CLI names itself and was
            // missing here, so no surface in Lotus offered Fable 5. Kept in step with
            // `packages/host/src/core/claude-models.ts`, which is what the phone reads.
            "fable",
            "opus",
            "opus[1m]",
            "sonnet",
            "sonnet[1m]",
            "haiku",
            "opusplan",
        ],
        // FALLBACK ONLY. The live list comes from `discover_models_from_codex_cache`, which reads
        // the file the CLI itself fetched; this is what to offer when that file is absent (the CLI
        // has never run) or unreadable. Mirrors `src/config/models/catalog.ts`.
        "codex" => &[
            "gpt-6-astra",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna",
            "gpt-5.5",
        ],
        "cursor" => &["auto"],
        _ => &[],
    }
}

fn default_model_for_agent(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        "claude" | "ccs-hss" | "csp" => Some("sonnet"),
        "codex" => Some("gpt-6-astra"),
        "cursor" => Some("auto"),
        _ => None,
    }
}

fn discover_models_from_cursor_cli(
    command: &[String],
    run_command_for_stdout: impl Fn(&[String], &[&str]) -> String,
) -> Vec<String> {
    for extra_args in [vec!["--list-models"], vec!["models"]] {
        let output = run_command_for_stdout(command, &extra_args);
        let models = parse_cursor_models_listing(&output);
        if !models.is_empty() {
            return models;
        }
    }

    vec![]
}

fn parse_cursor_models_listing(output: &str) -> Vec<String> {
    let mut models = BTreeSet::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        for token in extract_quoted_tokens(trimmed) {
            if is_cursor_model_token(&token) {
                models.insert(token);
            }
        }

        let normalized = trimmed
            .trim_start_matches("- ")
            .trim_start_matches("* ")
            .trim_start_matches("• ")
            .trim();
        let lower = normalized.to_ascii_lowercase();
        if let Some(model_token) = extract_cursor_model_from_slash_command(normalized) {
            models.insert(model_token);
            continue;
        }
        if lower.contains("available model")
            || lower.contains("subscription")
            || lower.contains("switch model")
            || lower.contains("list model")
            || lower.starts_with("how to ")
            || lower.starts_with("you can ")
            || lower.starts_with("use ")
        {
            continue;
        }

        let first_token = normalized
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .trim_matches(|ch: char| matches!(ch, ',' | ':' | ';' | ')' | '('));
        if is_cursor_model_token(first_token) {
            models.insert(first_token.to_string());
        }
    }

    models.into_iter().collect()
}

fn is_cursor_model_token(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lower = trimmed.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "list" | "models" | "model" | "available" | "switch" | "chat" | "agent" | "--list-models"
    ) {
        return false;
    }

    trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '[' | ']'))
}

fn extract_cursor_model_from_slash_command(line: &str) -> Option<String> {
    let marker_index = line.find("/model ")?;
    let candidate = line[marker_index + "/model ".len()..]
        .split_whitespace()
        .next()?
        .trim_matches(|ch: char| matches!(ch, ',' | ':' | ';' | '.' | ')' | '(' | '"' | '\''));

    if is_cursor_model_token(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

fn parse_models_from_help(help_text: &str) -> Vec<String> {
    let mut models = BTreeSet::new();

    for line in help_text.lines() {
        if !line.contains("--model") {
            continue;
        }
        for quoted in extract_quoted_tokens(line) {
            if quoted
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
            {
                models.insert(quoted);
            }
        }
    }

    models.into_iter().collect()
}

fn parse_efforts_from_help(help_text: &str) -> Vec<String> {
    for line in help_text.lines() {
        if !line.contains("--effort") {
            continue;
        }
        if let Some(start) = line.rfind('(') {
            if let Some(end) = line[start..].find(')') {
                let inner = &line[start + 1..start + end];
                return inner
                    .split(',')
                    .map(|token| token.trim().to_string())
                    .filter(|token| token.chars().all(|ch| ch.is_ascii_lowercase()))
                    .collect();
            }
        }
    }

    vec![]
}

fn extract_quoted_tokens(line: &str) -> Vec<String> {
    let mut tokens = BTreeSet::new();

    for quote in ['\'', '"', '`'] {
        for (index, token) in line.split(quote).enumerate() {
            if index % 2 == 1 {
                let trimmed = token.trim();
                if !trimmed.is_empty() {
                    tokens.insert(trimmed.to_string());
                }
            }
        }
    }

    tokens.into_iter().collect()
}

/// The models codex itself fetched, newest-priority first.
///
/// `~/.codex/models_cache.json` is written by the CLI (0.154.0 here) after it refreshes its model
/// list from the server, so it is the provider speaking rather than Lotus guessing. It also tells
/// the truth a hardcoded list cannot: entries carry `visibility`, and a hidden one
/// (`gpt-reserve`, `codex-auto-review`) must never reach a picker.
///
/// Written by another process and absent until the CLI has run once, so every failure mode here is
/// "return nothing and let the built-in fallback answer".
fn discover_models_from_codex_cache() -> Vec<String> {
    let path = paths::codex_dir().join("models_cache.json");
    let Ok(contents) = fs::read_to_string(path) else {
        return vec![];
    };
    parse_codex_models_cache(&contents)
}

fn parse_codex_models_cache(contents: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(contents) else {
        return vec![];
    };
    let Some(models) = value.get("models").and_then(|m| m.as_array()) else {
        return vec![];
    };

    let mut ranked: Vec<(i64, String)> = Vec::new();
    for model in models {
        // Anything the CLI hides is internal; only an explicit non-"hide" entry is offerable.
        if model.get("visibility").and_then(|v| v.as_str()) == Some("hide") {
            continue;
        }
        let Some(slug) = model.get("slug").and_then(|s| s.as_str()) else {
            continue;
        };
        // No priority means "sort last" rather than "drop": an unranked model still exists.
        let priority = model
            .get("priority")
            .and_then(|p| p.as_i64())
            .unwrap_or(i64::MAX);
        ranked.push((priority, slug.to_string()));
    }
    ranked.sort_by(|a, b| a.0.cmp(&b.0));
    ranked.into_iter().map(|(_, slug)| slug).collect()
}

fn discover_models_from_codex_config() -> Vec<String> {
    let path = paths::codex_dir().join("config.toml");
    let Ok(contents) = fs::read_to_string(path) else {
        return vec![];
    };

    let mut models = BTreeSet::new();
    for line in contents.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("model") {
            continue;
        }
        if let Some(value) = parse_toml_string_assignment(trimmed, "model") {
            models.insert(value);
        }
    }

    models.into_iter().collect()
}

fn parse_toml_string_assignment(line: &str, key: &str) -> Option<String> {
    let (lhs, rhs) = line.split_once('=')?;
    if lhs.trim() != key {
        return None;
    }
    let value = rhs.trim();
    let stripped = value.strip_prefix('"')?.strip_suffix('"')?;
    if stripped.is_empty() {
        None
    } else {
        Some(stripped.to_string())
    }
}

fn build_claude_headless_args(
    model: &str,
    effort: &str,
    dangerously_skip_permissions: bool,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--effort".to_string(),
        effort.to_string(),
    ];

    if dangerously_skip_permissions {
        args.push("--dangerously-skip-permissions".to_string());
    }

    args
}

fn resolve_codex_effort(model: &str, effort: &str, flash: bool) -> &'static str {
    if flash {
        if model.contains("codex") {
            "low"
        } else {
            "minimal"
        }
    } else {
        match effort {
            "minimal" => "minimal",
            "low" => "low",
            "high" => "high",
            _ => "medium",
        }
    }
}

fn build_cursor_headless_args(model: &str, dangerously_skip_permissions: bool) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        // Cursor can block headless automation on untrusted workspaces.
        // Agent CLI sessions are already scoped to a user-selected project, so
        // we trust that workspace up front to avoid interactive trust prompts.
        "--trust".to_string(),
        "--model".to_string(),
        model.to_string(),
    ];

    if dangerously_skip_permissions {
        args.push("--force".to_string());
    }

    args
}

fn build_codex_headless_args(
    model: &str,
    effort: &str,
    dangerously_skip_permissions: bool,
) -> Vec<String> {
    let mut args = vec![
        "--model".to_string(),
        model.to_string(),
        "-c".to_string(),
        format!(r#"model_reasoning_effort="{effort}""#),
        "--json".to_string(),
    ];

    if dangerously_skip_permissions {
        args.push("--dangerously-bypass-approvals-and-sandbox".to_string());
    }
    // else: use Codex default behavior (with approval prompts)

    args.push("-".to_string());
    args
}

#[cfg(test)]
mod tests {

    /// The real shape of `~/.codex/models_cache.json` (codex 0.154.0, fetched 2026-09-10),
    /// trimmed to the fields this parser reads.
    const CODEX_CACHE: &str = r#"{
      "fetched_at": "2026-09-10T08:20:13.574916Z",
      "client_version": "0.154.0",
      "models": [
        {"slug": "gpt-6-astra", "display_name": "GPT-6-Astra", "visibility": "list", "priority": 1},
        {"slug": "gpt-reserve", "display_name": "GPT-Reserve", "visibility": "hide", "priority": 3},
        {"slug": "gpt-5.6-sol", "display_name": "GPT-5.6-Sol", "visibility": "list", "priority": 6},
        {"slug": "gpt-5.5", "display_name": "GPT-5.5", "visibility": "list", "priority": 12},
        {"slug": "codex-auto-review", "visibility": "hide", "priority": 43}
      ]
    }"#;

    #[test]
    fn reads_the_codex_models_the_cli_itself_fetched() {
        let models = parse_codex_models_cache(CODEX_CACHE);

        // Ordered by the CLI's own `priority`, so its first choice stays first.
        assert_eq!(models, vec!["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"]);
    }

    #[test]
    fn skips_a_codex_model_the_cli_hides() {
        let models = parse_codex_models_cache(CODEX_CACHE);

        // `visibility: "hide"` is internal plumbing, not a choice to offer.
        assert!(!models.contains(&"gpt-reserve".to_string()));
        assert!(!models.contains(&"codex-auto-review".to_string()));
    }

    #[test]
    fn returns_nothing_for_an_unreadable_cache_instead_of_panicking() {
        // The cache is absent until the CLI has run once, and it is written by another process.
        assert!(parse_codex_models_cache("").is_empty());
        assert!(parse_codex_models_cache("not json").is_empty());
        assert!(parse_codex_models_cache(r#"{"models": "wrong type"}"#).is_empty());
    }

    #[test]
    fn built_in_codex_models_are_the_fallback_and_are_not_retired_ids() {
        let models = built_in_models_for_agent("codex");

        // Used only when the cache cannot be read. These eight were the list until 2026-09-10 and
        // are absent from the CLI's own list, so asking for one asks for a model that is gone.
        for retired in [
            "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark",
            "gpt-5.2-codex", "gpt-5.2", "gpt-5.1-codex-max", "gpt-5.1-codex-mini",
        ] {
            assert!(!models.contains(&retired), "{retired} should no longer be offered");
        }
        assert!(models.contains(&"gpt-6-astra"));
        assert_eq!(default_model_for_agent("codex"), Some("gpt-6-astra"));
    }
    use super::*;

    #[test]
    fn claude_invocation_prepends_images_and_skips_permissions_for_image_paths() {
        let image_paths = vec![PathBuf::from("/tmp/agent-cli-image.png")];
        let invocation = build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: "claude-stream-json",
            model: "sonnet",
            effort: "medium",
            flash: false,
            provider_session_id: None,
            image_paths: &image_paths,
            dangerously_skip_permissions: false,
        })
        .expect("claude invocation");

        assert!(invocation.should_prepend_image_paths_to_prompt);
        assert!(invocation
            .args
            .contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn flash_mode_uses_supported_reasoning_effort_values() {
        assert_eq!(resolve_codex_effort("gpt-5-codex", "medium", true), "low");
        assert_eq!(resolve_codex_effort("gpt-5", "medium", true), "minimal");
    }

    #[test]
    fn codex_invocation_uses_full_auto_by_default() {
        let invocation = build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: "codex-json",
            model: "gpt-5.4",
            effort: "medium",
            flash: false,
            provider_session_id: None,
            image_paths: &[],
            dangerously_skip_permissions: false,
        })
        .expect("codex invocation");

        assert!(!invocation
            .args
            .contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        // Normal mode: no approval bypass flag, uses Codex default behavior
        assert_eq!(invocation.args.last(), Some(&"-".to_string()));
    }

    #[test]
    fn codex_invocation_can_bypass_approvals_when_requested() {
        let invocation = build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: "codex-json",
            model: "gpt-5.4",
            effort: "medium",
            flash: false,
            provider_session_id: None,
            image_paths: &[],
            dangerously_skip_permissions: true,
        })
        .expect("codex invocation");

        assert!(invocation
            .args
            .contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
        assert!(!invocation.args.contains(&"--full-auto".to_string()));
    }

    #[test]
    fn codex_invocation_passes_image_paths_as_cli_args() {
        let image_paths = vec![PathBuf::from("/tmp/agent-cli-image.png")];
        let invocation = build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: "codex-json",
            model: "gpt-5.4",
            effort: "medium",
            flash: false,
            provider_session_id: None,
            image_paths: &image_paths,
            dangerously_skip_permissions: false,
        })
        .expect("codex invocation");

        assert!(!invocation.should_prepend_image_paths_to_prompt);
        assert!(invocation
            .args
            .windows(2)
            .any(|pair| pair == ["--image".to_string(), "/tmp/agent-cli-image.png".to_string()]));
    }

    #[test]
    fn cursor_invocation_includes_workspace_trust() {
        let invocation = build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: "cursor-stream-json",
            model: "auto",
            effort: "medium",
            flash: false,
            provider_session_id: None,
            image_paths: &[],
            dangerously_skip_permissions: false,
        })
        .expect("cursor invocation");

        assert_eq!(
            invocation.args,
            vec![
                "--print".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--trust".to_string(),
                "--model".to_string(),
                "auto".to_string(),
            ]
        );
    }

    #[test]
    fn cursor_invocation_resumes_session_and_adds_force_only_when_requested() {
        let invocation = build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: "cursor-stream-json",
            model: "sonnet",
            effort: "medium",
            flash: false,
            provider_session_id: Some("cursor-session-123"),
            image_paths: &[],
            dangerously_skip_permissions: true,
        })
        .expect("cursor invocation");

        assert!(invocation
            .args
            .windows(2)
            .any(|pair| pair == ["--resume".to_string(), "cursor-session-123".to_string()]));
        assert!(invocation.args.contains(&"--trust".to_string()));
        assert!(invocation.args.contains(&"--force".to_string()));
    }

    #[test]
    fn unsupported_parser_returns_clear_error() {
        let result = build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: "unknown",
            model: "default",
            effort: "medium",
            flash: false,
            provider_session_id: None,
            image_paths: &[],
            dangerously_skip_permissions: false,
        });

        assert_eq!(result.unwrap_err(), "Unsupported parser type: unknown");
    }

    #[test]
    fn cursor_model_listing_extracts_first_token_per_model_line() {
        let output = "\
Available models for your subscription:
auto Default routing
sonnet Claude Sonnet
gpt-5.4 GPT 5.4
";

        let models = parse_cursor_models_listing(output);
        assert_eq!(models, vec!["auto", "gpt-5.4", "sonnet"]);
    }

    #[test]
    fn cursor_model_listing_ignores_instructional_copy() {
        let output = "\
How to Manage Models via CLI
List Models: Use agent models or the --list-models flag to see all available options.
Switch Models: Within an active chat, use /model sonnet.
";

        let models = parse_cursor_models_listing(output);
        assert_eq!(models, vec!["sonnet"]);
    }

    #[test]
    fn quoted_token_parser_reads_multiple_quote_styles() {
        let tokens = extract_quoted_tokens("Use 'sonnet', \"auto\", and `gpt-5.4`");
        assert_eq!(tokens, vec!["auto", "gpt-5.4", "sonnet"]);
    }

    #[test]
    fn cursor_model_token_filter_rejects_command_words() {
        assert!(is_cursor_model_token("sonnet"));
        assert!(is_cursor_model_token("gpt-5.4"));
        assert!(!is_cursor_model_token("models"));
        assert!(!is_cursor_model_token("--list-models"));
    }

    #[test]
    fn provider_model_discovery_merges_built_ins_help_and_efforts() {
        let command = vec!["claude".to_string()];
        let discovered = discover_agent_cli_provider_models("claude", &command, |_command, args| {
            if args == ["--help"] {
                "Usage: claude --model 'claude-sonnet-4-6' --effort (low, medium, high, max)"
                    .to_string()
            } else {
                String::new()
            }
        });

        assert!(discovered.models.contains(&"sonnet".to_string()));
        assert!(discovered.models.contains(&"claude-sonnet-4-6".to_string()));
        assert_eq!(discovered.default_model, Some("sonnet".to_string()));
        assert_eq!(discovered.efforts, vec!["low", "medium", "high", "max"]);
    }

    #[test]
    fn provider_model_discovery_prefers_cursor_cli_default() {
        let command = vec!["cursor-agent".to_string()];
        let discovered = discover_agent_cli_provider_models("cursor", &command, |_command, args| {
            if args == ["--list-models"] {
                "sonnet Claude Sonnet\ngpt-5.4 GPT 5.4".to_string()
            } else {
                String::new()
            }
        });

        assert_eq!(discovered.default_model, Some("gpt-5.4".to_string()));
        assert_eq!(discovered.models, vec!["auto", "gpt-5.4", "sonnet"]);
    }

    #[test]
    fn auth_probe_is_only_enabled_for_cursor_agent() {
        let resolved = AgentCliResolvedCommand {
            executable: "missing-command".to_string(),
            prepend_args: vec![],
        };

        assert_eq!(
            probe_agent_cli_provider_auth("claude", &resolved, true),
            (None, None)
        );
        assert_eq!(
            probe_agent_cli_provider_auth("cursor-agent", &resolved, false),
            (None, None)
        );
    }
}
