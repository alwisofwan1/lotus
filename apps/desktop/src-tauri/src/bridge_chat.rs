//! Bridge-style chat: per-message subprocess invocation of a provider CLI
//! (`claude` or `codex`). Each call spawns a one-shot process, parses the
//! provider's NDJSON stdout, and returns the assembled assistant text plus
//! a session id for multi-turn continuation (when the provider supports it).
//!
//! See `src/modules/codespace/services/bridge/headless-session.ts` for the
//! local Bridge orchestrator implementation this mirrors.

use crate::no_window::NoWindow;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{other, AppError};

const DEFAULT_CLAUDE_MODEL: &str = "claude-sonnet-4-6";
const DEFAULT_QWEN_MODEL: &str = "qwen3.6-plus";
// Empty = "let codex pick its own default". Hardcoding e.g. "gpt-5-codex"
// breaks ChatGPT-account auth where only specific models are entitled.
const DEFAULT_CODEX_MODEL: &str = "";
/// Hard cap on a single bridge call's wall-clock time.
const CHAT_TIMEOUT_SECS: u64 = 180;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
    Qwen,
}

impl Provider {
    fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("").to_ascii_lowercase().as_str() {
            "codex" => Self::Codex,
            "qwen" | "qwen-cli" => Self::Qwen,
            // Default + explicit "claude" both go here.
            _ => Self::Claude,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Qwen => "qwen",
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Qwen => "qwen",
        }
    }

    fn default_model(self) -> &'static str {
        match self {
            Self::Claude => DEFAULT_CLAUDE_MODEL,
            Self::Codex => DEFAULT_CODEX_MODEL,
            Self::Qwen => DEFAULT_QWEN_MODEL,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeChatRequest {
    pub text: String,
    /// Provider session id from a previous reply (Claude + Qwen).
    pub session_id: Option<String>,
    /// Override the default model for the chosen provider.
    pub model: Option<String>,
    /// Override cwd for the subprocess. Defaults to home dir.
    pub cwd: Option<String>,
    /// Provider name: "claude" (default), "codex", or "qwen".
    pub provider: Option<String>,
    /// API key injected by the frontend from the model registry.
    /// Required for qwen-cli and openai-compat providers.
    #[serde(default)]
    pub api_key: Option<String>,
    /// Base URL for the API endpoint, injected from the model registry.
    #[serde(default)]
    pub base_url: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeChatResponse {
    /// Provider session id — same as input on resume; fresh on first call.
    /// For providers that don't support resume (Codex), echoes back the input
    /// or a generated placeholder so the client can keep a stable handle.
    pub session_id: String,
    pub text: String,
    pub is_error: bool,
    /// Echoes back the provider used to handle this request.
    pub provider: String,
}

/// Drives one bridge chat turn. Blocks until the subprocess exits.
pub fn chat(req: BridgeChatRequest) -> Result<BridgeChatResponse, AppError> {
    let provider = Provider::parse(req.provider.as_deref());
    let cwd = req
        .cwd
        .clone()
        .unwrap_or_else(crate::fs_browse::get_homedir);
    let model = req
        .model
        .clone()
        .unwrap_or_else(|| provider.default_model().to_string());

    match provider {
        Provider::Claude => run_claude(&req.text, req.session_id.as_deref(), &model, &cwd),
        Provider::Codex => run_codex(&req.text, &model, &cwd),
        Provider::Qwen => run_qwen(
            &req.text,
            req.session_id.as_deref(),
            &model,
            &cwd,
            req.api_key.as_deref(),
            req.base_url.as_deref(),
        ),
    }
}

// ─── Claude (stateful via --resume) ───────────────────────────────────────────

/// Layer the captured login-shell env (CLAUDE_CONFIG_DIR / CODEX_HOME / auth / real PATH) onto a
/// one-shot provider CLI. `std::process::Command` inherits the parent env, but a Finder/launchd launch
/// (or any parent that never sourced the user's rc) lacks the auth env, so `claude`/`codex` report
/// "Not logged in · Please run /login" even though the user is authenticated. Unix-only; layered on
/// top of the inherited env so explicit per-provider keys set afterward still win.
#[cfg(unix)]
fn apply_login_env(cmd: &mut Command) {
    // Via `shell_env::apply_login_env_pairs`, not a plain `cmd.env` loop: an empty captured value
    // is a *mask* (unset this in the child), and passing it through as a value makes `claude`
    // write its whole config home into the cwd. See that function.
    crate::shell_env::apply_login_env_pairs(cmd, crate::shell_env::user_login_env());
}
#[cfg(not(unix))]
fn apply_login_env(_cmd: &mut Command) {}

fn run_claude(
    text: &str,
    session_id: Option<&str>,
    model: &str,
    cwd: &str,
) -> Result<BridgeChatResponse, AppError> {
    let bin = crate::pty::resolve_command_executable(Provider::Claude.binary());
    let mut cmd = Command::new(&bin).no_window();
    apply_login_env(&mut cmd);
    cmd.arg("--print")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--dangerously-skip-permissions")
        .arg("--model")
        .arg(model);

    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(sid);
    }

    cmd.arg(text)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (stdout, stderr, status) = run_with_timeout(cmd, None)?;

    if !status.success() && stdout.is_empty() {
        return Err(other(format!(
            "claude exited with {:?}: {}",
            status.code(),
            String::from_utf8_lossy(&stderr).trim()
        )));
    }

    let mut resp = parse_claude_stream_json(&stdout, session_id)?;
    resp.provider = Provider::Claude.as_str().to_string();
    Ok(resp)
}

/// Parses Claude `stream-json` (NDJSON). Public for unit tests.
pub fn parse_claude_stream_json(
    stdout: &[u8],
    fallback_session_id: Option<&str>,
) -> Result<BridgeChatResponse, AppError> {
    let text_owned = String::from_utf8_lossy(stdout);
    let mut session_id: Option<String> = fallback_session_id.map(String::from);
    let mut assistant_text = String::new();
    let mut is_error = false;

    for line in text_owned.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let event: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
        match ty {
            "system" => {
                if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                    session_id = Some(id.to_string());
                }
            }
            "assistant" => {
                if let Some(content) = event
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in content {
                        let block_ty = block.get("type").and_then(Value::as_str).unwrap_or("");
                        if block_ty == "text" {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                assistant_text.push_str(t);
                            }
                        }
                    }
                }
            }
            "result" => {
                if event.get("is_error").and_then(Value::as_bool) == Some(true) {
                    is_error = true;
                }
            }
            _ => {}
        }
    }

    let session_id = session_id.ok_or_else(|| {
        other("claude stream-json had no session id (subprocess may have failed early)")
    })?;

    Ok(BridgeChatResponse {
        session_id,
        text: assistant_text,
        is_error,
        provider: String::new(), // filled in by caller
    })
}

// ─── Codex (stateless — single-turn) ──────────────────────────────────────────

fn run_codex(text: &str, model: &str, cwd: &str) -> Result<BridgeChatResponse, AppError> {
    let bin = crate::pty::resolve_command_executable(Provider::Codex.binary());
    // Codex CLI requires the `exec` subcommand for non-interactive runs;
    // `--json`, `--dangerously-bypass-approvals-and-sandbox`, and the trailing
    // `-` (read prompt from stdin) all live on `exec`, not on the root binary.
    // Verified against codex-cli 0.139.0 (`codex exec --help`).
    let mut cmd = Command::new(&bin).no_window();
    apply_login_env(&mut cmd);
    cmd.arg("exec");

    // Only pass `--model` when the caller explicitly chose one. Codex/ChatGPT
    // account auth restricts available models, and overriding the default
    // (e.g. forcing "gpt-5-codex") triggers HTTP 400 "model not supported".
    if !model.is_empty() {
        cmd.arg("--model").arg(model);
    }

    cmd.arg("-c")
        .arg(r#"model_reasoning_effort="medium""#)
        .arg("--json")
        .arg("--dangerously-bypass-approvals-and-sandbox")
        // Bridge cwd defaults to the home dir when no project is attached, which
        // is rarely a git repo — without this, codex `exec` can refuse to run.
        .arg("--skip-git-repo-check")
        .arg("-") // read prompt from stdin
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (stdout, stderr, status) = run_with_timeout(cmd, Some(text))?;

    let mut resp = parse_codex_jsonl(&stdout)?;
    resp.provider = Provider::Codex.as_str().to_string();
    Ok(finalize_codex_reply(
        resp,
        &stderr,
        status.code(),
        status.success(),
    ))
}

/// Folds the subprocess outcome into the parsed reply. codex-cli 0.139 always
/// emits a `thread.started` event first, so stdout is never empty even on
/// failure — the old `stdout.is_empty()` guard never fired and the real cause
/// (auth, sandbox, config, or a plain-text `Error: ...` line that bypasses the
/// JSONL parser) was silently dropped, leaving the user with "(empty response)".
/// Whenever the turn produced no assistant text but clearly failed, surface
/// stderr (or the exit code) so the failure is always actionable.
fn finalize_codex_reply(
    mut resp: BridgeChatResponse,
    stderr: &[u8],
    status_code: Option<i32>,
    success: bool,
) -> BridgeChatResponse {
    if resp.text.trim().is_empty() && (!success || resp.is_error) {
        let stderr_msg = String::from_utf8_lossy(stderr).trim().to_string();
        resp.text = if stderr_msg.is_empty() {
            format!("codex exited with code {status_code:?} and produced no output")
        } else {
            stderr_msg
        };
        resp.is_error = true;
    }
    resp
}

/// Parses Codex `exec --json` NDJSON output. Public for unit tests.
///
/// Event shapes (codex-cli ≥ 0.128):
/// - `{"type":"thread.started","thread_id":"<uuid>"}`             → captures id
/// - `{"type":"turn.started"}` / `{"type":"turn.completed",...}`  → ignored
/// - `{"type":"item.completed","item":{"type":"agent_message","text":"..."}}`
///                                                                → assistant text
/// - `{"type":"error","message":"..."}` /
///   `{"type":"turn.failed","error":{"message":"..."}}`           → is_error + capture msg
///
/// When an error occurs and no agent_message is produced, the extracted error
/// message is placed in `text` so the user sees a meaningful explanation
/// instead of "(empty response)".
pub fn parse_codex_jsonl(stdout: &[u8]) -> Result<BridgeChatResponse, AppError> {
    let text_owned = String::from_utf8_lossy(stdout);
    let mut assistant_text = String::new();
    let mut is_error = false;
    let mut error_messages: Vec<String> = Vec::new();
    let mut thread_id: Option<String> = None;

    for line in text_owned.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let event: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ty = event.get("type").and_then(Value::as_str).unwrap_or("");

        if ty == "thread.started" {
            if let Some(id) = event.get("thread_id").and_then(Value::as_str) {
                thread_id = Some(id.to_string());
            }
        }

        if ty == "item.completed" {
            if let Some(item) = event.get("item") {
                if item.get("type").and_then(Value::as_str) == Some("agent_message") {
                    if let Some(t) = item.get("text").and_then(Value::as_str) {
                        if !assistant_text.is_empty() {
                            assistant_text.push('\n');
                        }
                        assistant_text.push_str(t);
                    }
                }
            }
        }

        if ty.contains("error") || ty == "turn.failed" {
            is_error = true;
            if let Some(msg) = extract_codex_error_message(&event) {
                error_messages.push(msg);
            }
        }
    }

    // If we got an error and no clean assistant text, surface the error so
    // the user sees what went wrong instead of "(empty response)".
    if is_error && assistant_text.is_empty() && !error_messages.is_empty() {
        // Dedupe — codex usually emits the same payload twice (error + turn.failed).
        error_messages.dedup();
        assistant_text = error_messages.join("\n");
    }

    // Codex doesn't support `--resume` in the headless `exec` flow we use,
    // but we surface the thread_id so the client can display it / debug.
    let session_id = thread_id.unwrap_or_else(|| format!("codex-{}", uuid::Uuid::new_v4()));

    Ok(BridgeChatResponse {
        session_id,
        text: assistant_text,
        is_error,
        provider: String::new(),
    })
}

/// Extracts a human-readable error message from a Codex error/turn.failed
/// event. Codex nests its API errors as JSON-encoded strings inside the
/// `message` field, so we try to unwrap one level of nesting.
fn extract_codex_error_message(event: &Value) -> Option<String> {
    // Top-level message (raw string or JSON-encoded API error).
    let raw = event.get("message").and_then(Value::as_str).or_else(|| {
        event
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
    })?;

    // Try to drill into the nested API error shape:
    //   {"type":"error","status":400,"error":{"type":"...","message":"..."}}
    if let Ok(nested) = serde_json::from_str::<Value>(raw) {
        if let Some(inner) = nested
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
        {
            return Some(inner.to_string());
        }
    }

    Some(raw.to_string())
}

// ─── Qwen (stateful via --resume; stream-json via qwen-code CLI) ─────────────

/// Runs one turn via the `qwen` CLI (qwen-code). Injects the DashScope API key
/// and base URL as env vars so the CLI can route to the correct endpoint.
///
/// Session continuity: qwen-code's `--resume` flag resumes the last checkpoint.
/// Because multiple Bridge panes may run in parallel we pass the session_id as
/// the `--resume` target when available. On the first call (no session_id),
/// qwen-code creates a new session and we synthesise a stable handle from the
/// current timestamp so the frontend can track multi-turn state.
fn run_qwen(
    text: &str,
    session_id: Option<&str>,
    model: &str,
    cwd: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<BridgeChatResponse, AppError> {
    let bin = crate::pty::resolve_command_executable(Provider::Qwen.binary());
    let mut cmd = Command::new(&bin).no_window();

    cmd.arg("--output-format").arg("stream-json").arg("--yolo"); // skip per-tool approval prompts (equivalent to --dangerously-skip-permissions)

    if !model.is_empty() {
        cmd.arg("--model").arg(model);
    }

    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(sid);
    }

    // Positional prompt — must come last, after all flags and --resume.
    cmd.arg(text);

    // Inject credentials from the model registry. The qwen-code CLI reads
    // DASHSCOPE_API_KEY (or OPENAI_API_KEY for OpenAI-compat mode) from env.
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        cmd.env("DASHSCOPE_API_KEY", key);
        cmd.env("OPENAI_API_KEY", key);
    }
    if let Some(url) = base_url.filter(|u| !u.is_empty()) {
        cmd.env("OPENAI_BASE_URL", url);
    }

    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let (stdout, stderr, status) = run_with_timeout(cmd, None)?;

    if !status.success() && stdout.is_empty() {
        return Err(other(format!(
            "qwen exited with {:?}: {}",
            status.code(),
            String::from_utf8_lossy(&stderr).trim()
        )));
    }

    let mut resp = parse_qwen_stream_json(&stdout, session_id)?;
    resp.provider = Provider::Qwen.as_str().to_string();
    Ok(resp)
}

/// Parses qwen-code 0.15.x `--output-format stream-json` NDJSON output.
///
/// qwen-code ≥ 0.15 emits Claude-compatible stream-json: the same `system`,
/// `assistant`, and `stream_event / content_block_delta` envelope that Claude
/// CLI produces. Delegates to `parse_claude_stream_json` and falls back to a
/// time-based session id rather than hard-erroring when the system init event
/// is absent (early exit, dry-run, etc.).
pub fn parse_qwen_stream_json(
    stdout: &[u8],
    fallback_session_id: Option<&str>,
) -> Result<BridgeChatResponse, AppError> {
    match parse_claude_stream_json(stdout, fallback_session_id) {
        Ok(resp) => Ok(resp),
        Err(_) => Ok(BridgeChatResponse {
            session_id: fallback_session_id
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| {
                    format!(
                        "qwen-{}",
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_millis())
                            .unwrap_or(0)
                    )
                }),
            text: String::new(),
            is_error: true,
            provider: String::new(),
        }),
    }
}

// ─── Subprocess runner with timeout + stdin write ─────────────────────────────

fn run_with_timeout(
    mut cmd: Command,
    stdin_input: Option<&str>,
) -> Result<(Vec<u8>, Vec<u8>, std::process::ExitStatus), AppError> {
    let mut child = cmd.spawn().map_err(|e| other(format!("spawn: {e}")))?;

    if let Some(input) = stdin_input {
        if let Some(mut stdin) = child.stdin.take() {
            // Best effort — if write fails, child likely already exited.
            let _ = stdin.write_all(input.as_bytes());
            // Drop closes the pipe, signaling EOF.
        }
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| other("child stdout pipe missing"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| other("child stderr pipe missing"))?;

    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::with_capacity(64 * 1024);
        let mut reader = stdout;
        let _ = reader.read_to_end(&mut buf);
        buf
    });
    let stderr_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut reader = stderr;
        let _ = reader.read_to_end(&mut buf);
        buf
    });

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| other(format!("wait: {e}")))? {
            Some(s) => break s,
            None => {
                if started.elapsed().as_secs() >= CHAT_TIMEOUT_SECS {
                    let _ = child.kill();
                    return Err(other(format!(
                        "subprocess exceeded {CHAT_TIMEOUT_SECS}s timeout"
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    };

    let stdout_bytes = stdout_handle.join().unwrap_or_default();
    let stderr_bytes = stderr_handle.join().unwrap_or_default();
    Ok((stdout_bytes, stderr_bytes, status))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ─── Provider parsing ─────────────────────────────────────────────────────

    #[test]
    fn provider_defaults_to_claude() {
        assert_eq!(Provider::parse(None), Provider::Claude);
        assert_eq!(Provider::parse(Some("")), Provider::Claude);
        assert_eq!(Provider::parse(Some("claude")), Provider::Claude);
        assert_eq!(Provider::parse(Some("CLAUDE")), Provider::Claude);
    }

    #[test]
    fn provider_recognizes_codex_case_insensitive() {
        assert_eq!(Provider::parse(Some("codex")), Provider::Codex);
        assert_eq!(Provider::parse(Some("Codex")), Provider::Codex);
    }

    #[test]
    fn provider_unknown_falls_back_to_claude() {
        assert_eq!(Provider::parse(Some("gemini")), Provider::Claude);
    }

    // ─── Claude parser ───────────────────────────────────────────────────────

    #[test]
    fn claude_parser_extracts_session_id_and_text() {
        let stdout = br#"
{"type":"system","subtype":"init","session_id":"sess-abc-123"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hello! "}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"How can I help?"}]}}
{"type":"result","subtype":"success","is_error":false}
"#;
        let resp = parse_claude_stream_json(stdout, None).unwrap();
        assert_eq!(resp.session_id, "sess-abc-123");
        assert_eq!(resp.text, "Hello! How can I help?");
        assert!(!resp.is_error);
    }

    #[test]
    fn claude_parser_uses_fallback_session_id_when_no_system_event() {
        let stdout = br#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        let resp = parse_claude_stream_json(stdout, Some("fallback-id")).unwrap();
        assert_eq!(resp.session_id, "fallback-id");
        assert_eq!(resp.text, "hi");
    }

    #[test]
    fn claude_parser_ignores_tool_use_blocks() {
        let stdout = br#"{"type":"system","session_id":"s1"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"path":"/x"}},{"type":"text","text":"after tool"}]}}
"#;
        let resp = parse_claude_stream_json(stdout, None).unwrap();
        assert_eq!(resp.text, "after tool");
    }

    #[test]
    fn claude_parser_marks_is_error_from_result_event() {
        let stdout = br#"
{"type":"system","session_id":"s1"}
{"type":"result","is_error":true}
"#;
        let resp = parse_claude_stream_json(stdout, None).unwrap();
        assert!(resp.is_error);
    }

    #[test]
    fn claude_parser_skips_garbage_lines() {
        let stdout = br#"
some stderr leakage
{"type":"system","session_id":"s1"}
[INFO] another non-json line
{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}
"#;
        let resp = parse_claude_stream_json(stdout, None).unwrap();
        assert_eq!(resp.text, "ok");
    }

    #[test]
    fn claude_parser_errors_when_no_session_id_anywhere() {
        let stdout = br#"{"type":"assistant","message":{"content":[]}}"#;
        let err = parse_claude_stream_json(stdout, None).unwrap_err();
        assert!(err.to_string().contains("session id"));
    }

    // ─── Codex parser ────────────────────────────────────────────────────────

    #[test]
    fn codex_parser_extracts_agent_message_text_and_thread_id() {
        // Real fixture from `codex exec --json` (codex-cli 0.128.0)
        let stdout =
            br#"{"type":"thread.started","thread_id":"019e03d2-081e-7303-beb3-e9f675bafb50"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Four"}}
{"type":"turn.completed","usage":{"input_tokens":23620,"output_tokens":212}}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert_eq!(resp.text, "Four");
        assert_eq!(resp.session_id, "019e03d2-081e-7303-beb3-e9f675bafb50");
        assert!(!resp.is_error);
    }

    #[test]
    fn codex_parser_falls_back_to_synthetic_id_when_no_thread_started() {
        let stdout = br#"{"type":"item.completed","item":{"type":"agent_message","text":"x"}}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert!(resp.session_id.starts_with("codex-"));
    }

    #[test]
    fn codex_parser_concatenates_multiple_agent_messages_with_newlines() {
        let stdout = br#"
{"type":"item.completed","item":{"type":"agent_message","text":"first"}}
{"type":"item.completed","item":{"type":"agent_message","text":"second"}}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert_eq!(resp.text, "first\nsecond");
    }

    #[test]
    fn codex_parser_skips_non_agent_message_items() {
        let stdout = br#"
{"type":"item.completed","item":{"type":"tool_call","name":"shell"}}
{"type":"item.completed","item":{"type":"agent_message","text":"final"}}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert_eq!(resp.text, "final");
    }

    #[test]
    fn codex_parser_marks_error_on_error_typed_events() {
        let stdout = br#"
{"type":"task.error","message":"something broke"}
{"type":"item.completed","item":{"type":"agent_message","text":""}}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert!(resp.is_error);
    }

    #[test]
    fn codex_parser_surfaces_unsupported_model_error_message() {
        // Real fixture from `codex exec --json -m gpt-5-codex -` with a
        // ChatGPT-account login (HTTP 400 from the upstream API).
        let stdout = br#"{"type":"thread.started","thread_id":"019e03d6-a6e4-7b70-aa7d-0593cbc92efd"}
{"type":"turn.started"}
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.\"}}"}
{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.\"}}"}}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert!(resp.is_error);
        assert!(
            resp.text.contains("gpt-5-codex") && resp.text.contains("ChatGPT account"),
            "expected unwrapped API error message in text, got: {:?}",
            resp.text,
        );
    }

    #[test]
    fn codex_parser_handles_plain_string_error_message() {
        // Some error events have a plain string message rather than nested JSON.
        let stdout = br#"
{"type":"turn.failed","error":{"message":"network unreachable"}}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert!(resp.is_error);
        assert!(resp.text.contains("network unreachable"));
    }

    #[test]
    fn codex_parser_keeps_assistant_text_when_both_text_and_error_present() {
        // If codex managed to emit text before erroring, prefer the text.
        let stdout = br#"
{"type":"item.completed","item":{"type":"agent_message","text":"partial response"}}
{"type":"error","message":"late failure"}
"#;
        let resp = parse_codex_jsonl(stdout).unwrap();
        assert!(resp.is_error);
        assert_eq!(resp.text, "partial response");
    }

    // ─── Codex reply finalization (stderr surfacing) ─────────────────────────

    fn codex_resp(text: &str, is_error: bool) -> BridgeChatResponse {
        BridgeChatResponse {
            session_id: "codex-x".into(),
            text: text.into(),
            is_error,
            provider: "codex".into(),
        }
    }

    #[test]
    fn finalize_codex_leaves_successful_reply_untouched() {
        let resp = finalize_codex_reply(codex_resp("Hi", false), b"", Some(0), true);
        assert_eq!(resp.text, "Hi");
        assert!(!resp.is_error);
    }

    #[test]
    fn finalize_codex_surfaces_stderr_when_failed_with_empty_text() {
        // codex 0.139 emits `thread.started` then dies — stdout parses to empty
        // text, the real cause (`Error: ...`) only lives on stderr.
        let resp = finalize_codex_reply(
            codex_resp("", false),
            b"Error: thread/resume failed: no rollout found (code -32600)\n",
            Some(1),
            false,
        );
        assert!(resp.is_error);
        assert!(
            resp.text.contains("no rollout found"),
            "got: {:?}",
            resp.text
        );
    }

    #[test]
    fn finalize_codex_synthesizes_message_when_stderr_also_empty() {
        let resp = finalize_codex_reply(codex_resp("", true), b"   ", Some(2), false);
        assert!(resp.is_error);
        assert!(
            resp.text.contains("exited with code"),
            "got: {:?}",
            resp.text
        );
        assert!(resp.text.contains('2'), "got: {:?}", resp.text);
    }

    #[test]
    fn finalize_codex_keeps_parsed_error_text_over_stderr() {
        // When the JSONL parser already extracted an error message, prefer it.
        let resp = finalize_codex_reply(
            codex_resp("model not supported", true),
            b"noisy stderr",
            Some(1),
            false,
        );
        assert_eq!(resp.text, "model not supported");
    }

    // ─── Provider: Qwen ───────────────────────────────────────────────────────

    #[test]
    fn provider_recognizes_qwen_and_qwen_cli() {
        assert_eq!(Provider::parse(Some("qwen")), Provider::Qwen);
        assert_eq!(Provider::parse(Some("qwen-cli")), Provider::Qwen);
        assert_eq!(Provider::parse(Some("QWEN")), Provider::Qwen); // lowercased before match
    }

    #[test]
    fn qwen_provider_has_correct_binary_and_default_model() {
        assert_eq!(Provider::Qwen.binary(), "qwen");
        assert_eq!(Provider::Qwen.as_str(), "qwen");
        assert_eq!(Provider::Qwen.default_model(), DEFAULT_QWEN_MODEL);
    }

    // ─── Qwen stream-json parser ─────────────────────────────────────────────

    #[test]
    fn qwen_parser_extracts_text_and_session_id() {
        // qwen-code 0.15.x emits Claude-compatible stream-json
        let stdout = br#"
{"type":"system","subtype":"init","session_id":"qwen-session-1"}
{"type":"assistant","message":{"content":[{"type":"text","text":"Hello "},{"type":"text","text":"World"}]}}
{"type":"result","subtype":"success","is_error":false}
"#;
        let resp = parse_qwen_stream_json(stdout, None).unwrap();
        assert_eq!(resp.text, "Hello World");
        assert!(!resp.is_error);
        assert_eq!(resp.session_id, "qwen-session-1");
    }

    #[test]
    fn qwen_parser_uses_fallback_session_id_when_no_system_event() {
        let stdout =
            br#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hi there"}]}}"#;
        let resp = parse_qwen_stream_json(stdout, Some("sess")).unwrap();
        assert_eq!(resp.text, "Hi there");
        assert_eq!(resp.session_id, "sess");
    }

    #[test]
    fn qwen_parser_ignores_tool_use_blocks() {
        let stdout = br#"{"type":"system","session_id":"s"}
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{}},{"type":"text","text":"done"}]}}
"#;
        let resp = parse_qwen_stream_json(stdout, None).unwrap();
        assert_eq!(resp.text, "done");
    }

    #[test]
    fn qwen_parser_marks_error_from_result_event() {
        let stdout = br#"
{"type":"system","session_id":"s"}
{"type":"result","is_error":true}
"#;
        let resp = parse_qwen_stream_json(stdout, None).unwrap();
        assert!(resp.is_error);
    }

    #[test]
    fn qwen_parser_marks_error_on_nonzero_exit_code() {
        let stdout = br#"
{"type":"system","session_id":"s"}
{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}
{"type":"result","is_error":true}
"#;
        let resp = parse_qwen_stream_json(stdout, Some("s")).unwrap();
        assert!(resp.is_error);
        assert_eq!(resp.text, "partial");
    }

    #[test]
    fn qwen_parser_skips_garbage_lines() {
        let stdout = br#"
some stderr mixed in
{"type":"system","session_id":"s1"}
[INFO] another non-json line
{"type":"assistant","message":{"content":[{"type":"text","text":"clean response"}]}}
"#;
        let resp = parse_qwen_stream_json(stdout, Some("s")).unwrap();
        assert_eq!(resp.text, "clean response");
        assert!(!resp.is_error);
    }

    #[test]
    fn qwen_parser_generates_synthetic_session_id_when_none_provided() {
        // No session_id in stream, no fallback → parse_claude_stream_json errors
        // → qwen error path generates synthetic "qwen-<uuid>" id
        let stdout = br#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        let resp = parse_qwen_stream_json(stdout, None).unwrap();
        assert!(
            resp.session_id.starts_with("qwen-"),
            "synthetic id must start with qwen-"
        );
    }

    #[test]
    fn qwen_parser_uses_fallback_session_id_over_synthetic() {
        let stdout = br#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}"#;
        let resp = parse_qwen_stream_json(stdout, Some("my-session")).unwrap();
        assert_eq!(resp.session_id, "my-session");
    }

    #[test]
    fn qwen_parser_concatenates_multiple_content_chunks() {
        let stdout = br#"
{"type":"system","session_id":"s"}
{"type":"assistant","message":{"content":[{"type":"text","text":"chunk1 "}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"chunk2 "}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"chunk3"}]}}
"#;
        let resp = parse_qwen_stream_json(stdout, Some("s")).unwrap();
        assert_eq!(resp.text, "chunk1 chunk2 chunk3");
    }
}
