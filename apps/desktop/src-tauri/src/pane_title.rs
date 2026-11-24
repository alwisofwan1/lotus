//! Pane title generator — spawns the user's local `claude` CLI as a
//! short-lived sidecar to summarise a terminal pane's recent output into a
//! concise conversation title (≤ 48 chars, sentence case, language-mirrored).
//!
//! Pipeline
//! ────────
//!  1. Read the trailing N bytes of a PTY session's output ring buffer.
//!  2. Strip ANSI escape sequences and other control noise.
//!  3. Truncate head+tail if still too long (head 2/3, tail 1/3).
//!  4. Spawn `claude --print --model <model> "<prompt>"` with stdin closed.
//!  5. Capture stdout, sanitise (strip prefixes/quotes/trailing period),
//!     hard-cap at 48 chars (rune-aware).
//!
//! No new credential is required — the same `~/.claude/` auth that powers
//! the rest of Lotus is what `claude --print` uses.

use crate::no_window::NoWindow;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::timeout;

use crate::error::{other, AppError};
use crate::pty::{self, PtyState};

const SYSTEM_INSTRUCTION: &str = "You name coding conversations for a sidebar. Reply with ONLY the title: what the person is trying to get done, as a short noun phrase (3-6 words, at most 48 characters). Sentence case, no quotes, no trailing punctuation, no prefix. Use the language of the request. Never describe the tool, the terminal, or how the agent was launched.";

const DEFAULT_MODEL: &str = "claude-haiku-4-5";
const MAX_TITLE_CHARS: usize = 48;
const DEFAULT_TAIL_BYTES: usize = 12_000;
// 45s gives haiku-4-5 enough headroom for cold starts and slow networks.
// Empirically, ~95% of warm calls finish under 8s; the long tail is dominated
// by Anthropic edge cold-start (10–30s) — anything beyond 45s is a real
// outage and worth surfacing as failed.
const DEFAULT_TIMEOUT_SECS: u64 = 45;
const TRANSCRIPT_CHAR_BUDGET: usize = 4_000;

/// Marker prefix for transient/retryable failures. The frontend looks for
/// this so it can downgrade the console log severity and optionally retry.
const TRANSIENT_PREFIX: &str = "transient: ";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePaneTitleRequest {
    /// The pane whose conversation is titled. When given, the title is made from the agent's
    /// own transcript (first typed prompt + latest reply) and the PTY is never read — the
    /// screen is a TUI's paint, not a conversation. See `agent_hooks::session_title`.
    #[serde(default)]
    pub pane_id: Option<String>,
    /// PTY session id whose output should be summarised — the legacy source, used only when
    /// no `pane_id` is given (CodeSpace's retired terminal grid still calls it this way).
    #[serde(default)]
    pub session_id: String,
    /// Max bytes of trailing output to read from the ring buffer.
    pub max_bytes: Option<usize>,
    /// Override model (defaults to `claude-haiku-4-5`).
    pub model: Option<String>,
    /// Optional language hint for the response ("Indonesian", "English", …).
    /// When omitted, Claude follows the language of the transcript.
    pub language_hint: Option<String>,
    /// When false, only deterministic prompt extraction is allowed; the
    /// fallback sidecar must not be spawned.
    pub allow_ai_fallback: Option<bool>,
    /// Which CLI family this pane is running — "claude" (default), "codex".
    ///
    /// A pane is titled by ITS OWN agent, so a codex pane costs codex tokens and works when the
    /// user has never signed into Claude. `bb` reaches the same place from the other side: there,
    /// inference is a capability a provider plugin registers, and the titler asks whichever
    /// provider is configured without ever learning which agent runs the thread.
    pub provider: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePaneTitleResult {
    pub title: String,
    /// Number of bytes of transcript material the title was based on after
    /// ANSI stripping and truncation. Useful for telemetry/debug overlays.
    pub source_bytes: usize,
}

pub async fn generate_pane_title(
    request: GeneratePaneTitleRequest,
    pty_state: &PtyState,
    transcripts: &std::sync::Mutex<crate::agent_hooks::TranscriptStore>,
    mcp_state: &crate::mcp_ipc::McpIpcState,
) -> Result<GeneratePaneTitleResult, AppError> {
    let provider = TitleProvider::parse(request.provider.as_deref());
    let model = request
        .model
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string();

    if let Some(pane_id) = request.pane_id.as_deref().filter(|id| !id.is_empty()) {
        let path = crate::api_server::handlers::fleet::pane_transcript_path(
            transcripts,
            mcp_state,
            pane_id,
        )
        .ok_or_else(|| other("no agent transcript is known for this pane yet"))?;
        let facts = crate::agent_hooks::session_title_at(&path)
            .ok_or_else(|| other("the pane's transcript could not be read"))?;
        let first_prompt = facts
            .first_prompt
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| other("the pane's transcript has no prompt to title yet"))?;
        let source_bytes = first_prompt.len() + facts.last_reply.as_deref().map_or(0, str::len);
        let config_dir = crate::agent_hooks::claude_config_dir_of(&path);
        let short = &pane_id[..pane_id.len().min(8)];
        // Chat's titler: one prompt, one model setting (Settings › Chat › Titles) for every mode.
        let answer = crate::chat_runtime::title::generate_for_pane(
            provider,
            first_prompt,
            facts.last_reply.as_deref(),
            config_dir.as_deref(),
        )
        .await
        .map_err(other);
        match &answer {
            Ok(title) => eprintln!("[pane-title] {short} generated {title:?}"),
            Err(error) => eprintln!("[pane-title] {short} generate failed: {error}"),
        }
        return answer.map(|title| GeneratePaneTitleResult { title, source_bytes });
    }

    let max_bytes = request.max_bytes.unwrap_or(DEFAULT_TAIL_BYTES);
    let raw_tail = pty::read_output_tail(&request.session_id, max_bytes, pty_state);
    if raw_tail.trim().is_empty() {
        return Err(other(
            "no recent output to summarise — wait for the agent to produce a turn",
        ));
    }

    let cleaned = strip_ansi_and_controls(&raw_tail);
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return Err(other("output buffer was all control sequences"));
    }
    let transcript = truncate_head_tail(trimmed, TRANSCRIPT_CHAR_BUDGET);
    let source_bytes = transcript.len();

    if let Some(title) = derive_title_from_agent_prompt(&transcript) {
        return Ok(GeneratePaneTitleResult {
            title,
            source_bytes,
        });
    }

    if request.allow_ai_fallback == Some(false) {
        return Err(other(
            "no deterministic prompt title found in recent output",
        ));
    }

    let material = match request.language_hint.as_deref() {
        Some(hint) if !hint.trim().is_empty() => {
            format!("Reply in {hint}.\n\nTerminal output:\n{transcript}")
        }
        _ => format!("Terminal output:\n{transcript}"),
    };
    let raw_response = run_title_cli(provider, &model, SYSTEM_INSTRUCTION, &material, None, TitleAuth::Inherit, DEFAULT_TIMEOUT_SECS).await?;
    let title = usable_title(&raw_response, provider)?;

    Ok(GeneratePaneTitleResult {
        title,
        source_bytes,
    })
}

/// A pane's conversation as its agent names it.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PaneAgentTitle {
    /// Which conversation this is: the transcript's path. A new session (a fresh `claude`, a
    /// `/clear`) writes a new file, so a changed key means the pane is now a different
    /// conversation and its old title no longer describes it.
    pub session_key: String,
    /// The CLI's own title for it; absent until the CLI writes one, and for CLIs that never do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Whether the transcript holds a typed prompt yet, i.e. whether
    /// [`generate_pane_title`] has anything to title from.
    pub has_prompt: bool,
}

/// What the pane's agent calls its conversation — no model call, no subprocess.
///
/// `None` when no transcript is known for the pane: a plain shell, or an agent that reports no
/// hooks. A title the CLI wrote that is really an error message is dropped, not passed on.
pub fn pane_agent_title(
    pane_id: &str,
    transcripts: &std::sync::Mutex<crate::agent_hooks::TranscriptStore>,
    mcp_state: &crate::mcp_ipc::McpIpcState,
) -> Option<PaneAgentTitle> {
    let short = &pane_id[..pane_id.len().min(8)];
    let Some(path) = crate::api_server::handlers::fleet::pane_transcript_path(transcripts, mcp_state, pane_id) else {
        // One line per settled turn, in the dev terminal: "no title" has several causes and this
        // says which link broke (2026-10-10, a Codex pane that never got its name).
        eprintln!("[pane-title] {short} no transcript known");
        return None;
    };
    let Some(facts) = crate::agent_hooks::session_title_at(&path) else {
        eprintln!("[pane-title] {short} transcript unreadable: {path}");
        return None;
    };
    let title = facts
        .agent_title
        .map(|t| sanitise_title(&t))
        .filter(|t| t.chars().any(char::is_alphanumeric) && !looks_like_cli_error(t));
    eprintln!(
        "[pane-title] {short} {path} agent_title={title:?} has_prompt={}",
        facts.first_prompt.is_some()
    );
    Some(PaneAgentTitle {
        session_key: path,
        title,
        has_prompt: facts.first_prompt.is_some(),
    })
}

/// The sanitised title, or an error when what came back is no title at all.
fn usable_title(raw: &str, provider: TitleProvider) -> Result<String, AppError> {
    let title = sanitise_title(raw);
    // "---": a task that was itself a document (release notes) got its frontmatter back (2026-11-15).
    if !title.chars().any(char::is_alphanumeric) {
        return Err(other(format!("{} returned no title: {title:?}", provider.binary())));
    }
    if looks_like_cli_error(&title) {
        return Err(other(format!("{} answered with an error: {title}", provider.binary())));
    }
    Ok(title)
}

/// A CLI's own failure message, printed where an answer goes.
///
/// Seen as pane titles before this guard: "You've hit your weekly limit · resets 6pm
/// (Asia/Jakarta)" seven times in nineteen days. The JSON output's `is_error` catches most of
/// these for Claude; this catches the rest, and every one from Codex.
pub(crate) fn looks_like_cli_error(title: &str) -> bool {
    const MARKERS: [&str; 9] = [
        "hit your",
        "usage limit",
        "rate limit",
        "not logged in",
        "please run /login",
        "invalid api key",
        "api error",
        "credit balance",
        "overloaded",
    ];
    let lower = title.to_lowercase();
    MARKERS.iter().any(|marker| lower.contains(marker))
}

/// Layer the captured login-shell env onto the sidecar.
///
/// Same reason as every other one-shot spawn here (`bridge_chat`, `codechat`): a Finder or launchd
/// launch never sourced the user's rc, so without this the CLI cannot see `CLAUDE_CONFIG_DIR` /
/// `CODEX_HOME` and reports "Not logged in" for a signed-in user. An empty captured value is a
/// MASK, which is why `apply_login_env_pairs` does the work rather than a plain `cmd.env` loop.
#[cfg(unix)]
fn apply_login_env(cmd: &mut Command) {
    crate::shell_env::apply_login_env_pairs(cmd.as_std_mut(), crate::shell_env::user_login_env());
}
#[cfg(not(unix))]
fn apply_login_env(_cmd: &mut Command) {}

/// The CLI families that can title a pane.
///
/// Deliberately small: these are the ones whose one-shot mode Lotus already drives and already
/// parses (`bridge_chat`). Anything else falls back to Claude rather than inventing a command
/// line for a binary nobody has measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleProvider {
    Claude,
    Codex,
}

impl TitleProvider {
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or("").to_ascii_lowercase().as_str() {
            "codex" => Self::Codex,
            _ => Self::Claude,
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// Which Claude sign-in a title call uses.
#[derive(Debug, Clone, Copy)]
pub enum TitleAuth<'a> {
    /// Whatever the login env carries (pane titles).
    Inherit,
    /// The subscription login: an inherited `ANTHROPIC_API_KEY` is dropped so it never bills,
    /// as the chat bridge's `sessionEnv` does.
    Login,
    /// Chat's API key mode: the title is billed where the chat is.
    ApiKey(&'a str),
}

/// One title from material the caller wrote, e.g. Chat's first message (plans/chat-auto-title).
pub async fn title_from_material(
    provider: TitleProvider,
    model: &str,
    system: &str,
    material: &str,
    claude_config_dir: Option<&Path>,
    auth: TitleAuth<'_>,
    timeout_secs: u64,
) -> Result<String, AppError> {
    let raw = run_title_cli(provider, model, system, material, claude_config_dir, auth, timeout_secs).await?;
    usable_title(&raw, provider)
}

async fn run_title_cli(
    provider: TitleProvider,
    model: &str,
    system: &str,
    material: &str,
    claude_config_dir: Option<&Path>,
    auth: TitleAuth<'_>,
    timeout_secs: u64,
) -> Result<String, AppError> {
    // Resolved and env-layered like every other one-shot spawn in this app: a Finder or launchd
    // launch has no login shell behind it, so a raw `Command::new("claude")` finds neither the
    // binary nor the auth env and reports "Not logged in" for a user who is signed in.
    let bin = crate::pty::resolve_command_executable(provider.binary());
    let mut cmd = Command::new(&bin).no_window();
    apply_login_env(&mut cmd);
    // A scratch cwd: the title call must not load a project's CLAUDE.md / AGENTS.md, and must not
    // be filed under whatever folder the app happened to start in (243 calls had landed in
    // `~/.claude/projects/-/`, the slug of `/`).
    let scratch = std::env::temp_dir().join("lotus-pane-title");
    let _ = std::fs::create_dir_all(&scratch);
    cmd.current_dir(&scratch);

    let codex_prompt;
    let stdin_prompt = match provider {
        TitleProvider::Claude => {
            // Measured 2026-10-10 against the old bare `--print`: ~25.7K input tokens (skills, MCP
            // listings, hooks' context) and 8.6 s median became 583 tokens and 1.3 s, and no
            // session file. Each flag removes one source of that weight:
            //   --setting-sources ""     no user/project settings → no hooks (claude-mem's Stop
            //                            hook held results ~110 s here), no plugins
            //   --strict-mcp-config      no MCP servers (the Lotus sidecar included)
            //   --tools "" + --disable-slash-commands   nothing to list, nothing to call
            //   --no-session-persistence nothing written to `projects/`
            //   --output-format json     `is_error` tells a quota/auth failure from an answer
            // `--bare` would do most of this in one flag, but it skips the keychain read and a
            // ccs profile then reports "Not logged in".
            cmd.arg("--print")
                .arg("--model")
                .arg(model)
                .arg("--no-session-persistence")
                .arg("--setting-sources")
                .arg("")
                .arg("--strict-mcp-config")
                .arg("--tools")
                .arg("")
                .arg("--disable-slash-commands")
                .arg("--output-format")
                .arg("json")
                .arg("--system-prompt")
                .arg(system)
                .arg(material);
            // Thinking was ~1.3K of the 1.3K output tokens for a five-word answer.
            cmd.env("MAX_THINKING_TOKENS", "0");
            // The pane's own account, not the default profile's: a ccs pane titled on another
            // profile spent that profile's quota and hit its weekly limit.
            if let Some(dir) = claude_config_dir {
                cmd.env("CLAUDE_CONFIG_DIR", dir);
            }
            match auth {
                TitleAuth::Inherit => {}
                TitleAuth::Login => {
                    cmd.env_remove("ANTHROPIC_API_KEY");
                }
                TitleAuth::ApiKey(key) => {
                    cmd.env("ANTHROPIC_API_KEY", key);
                }
            }
            cmd.stdin(Stdio::null());
            None
        }
        TitleProvider::Codex => {
            codex_prompt = format!("{system}\n\n{material}\n\nTitle:");
            // Mirrors `bridge_chat::run_codex`, including why `--model` is omitted when empty:
            // ChatGPT-account auth entitles specific models, and forcing one is a 400.
            cmd.arg("exec");
            if !model.trim().is_empty() {
                cmd.arg("--model").arg(model);
            }
            cmd.args(CODEX_TITLE_ARGS);
            cmd.stdin(Stdio::piped());
            Some(codex_prompt.as_str())
        }
    };

    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| {
        other(format!("failed to spawn `{}` CLI: {e}", provider.binary()))
    })?;

    if let Some(text) = stdin_prompt {
        if let Some(mut stdin) = child.stdin.take() {
            // Best effort, then dropped to close the pipe: a child that already exited is reported
            // by the exit status below, which says more than a write error would.
            let _ = stdin.write_all(text.as_bytes()).await;
        }
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| other("title sidecar produced no stdout pipe"))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| other("title sidecar produced no stderr pipe"))?;

    let mut stdout_buf = Vec::with_capacity(512);
    let mut stderr_buf = Vec::with_capacity(256);

    let work = async {
        let stdout_fut = stdout.read_to_end(&mut stdout_buf);
        let stderr_fut = stderr.read_to_end(&mut stderr_buf);
        let exit_fut = child.wait();
        let (so, se, ex) = tokio::join!(stdout_fut, stderr_fut, exit_fut);
        so.map_err(|e| other(format!("stdout read: {e}")))?;
        se.map_err(|e| other(format!("stderr read: {e}")))?;
        let status = ex.map_err(|e| other(format!("wait: {e}")))?;
        Ok::<_, AppError>(status)
    };

    let status = match timeout(Duration::from_secs(timeout_secs), work).await {
        Ok(res) => res?,
        Err(_) => {
            // Transient: the model is slow or there's a transient network
            // hiccup. The frontend treats `transient:` as retryable.
            return Err(other(format!(
                "{TRANSIENT_PREFIX}{} sidecar timed out after {timeout_secs}s — model may be slow or offline",
                provider.binary()
            )));
        }
    };

    let stdout_text = String::from_utf8_lossy(&stdout_buf).into_owned();
    let stderr_text = String::from_utf8_lossy(&stderr_buf).into_owned();

    if !status.success() {
        let detail = stderr_text.trim();
        let snippet = if detail.is_empty() {
            "(no stderr)"
        } else {
            detail
        };
        return Err(other(format!(
            "{} exited with {status}: {snippet}",
            provider.binary()
        )));
    }

    // Codex speaks JSONL even for one line of text, and the reply is buried in it. The parser is
    // `bridge_chat`'s, so there is one place that knows what codex-cli emits.
    if provider == TitleProvider::Codex {
        return Ok(crate::bridge_chat::parse_codex_jsonl(stdout_text.as_bytes())?.text);
    }

    parse_claude_print_json(&stdout_text)
}

/// The answer in `claude --print --output-format json`'s one object, or its error.
fn parse_claude_print_json(stdout: &str) -> Result<String, AppError> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|e| other(format!("claude title output was not JSON: {e}")))?;
    let result = value
        .get("result")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    if value.get("is_error").and_then(serde_json::Value::as_bool) == Some(true) {
        return Err(other(format!("claude reported an error: {}", result.trim())));
    }
    Ok(result)
}

pub(crate) fn strip_ansi_and_controls(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    // CSI: ESC [ ... final-byte (0x40..=0x7E)
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        let code = nc as u32;
                        if (0x40..=0x7E).contains(&code) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    // OSC: ESC ] ... BEL or ESC\
                    while let Some(&nc) = chars.peek() {
                        chars.next();
                        if nc == '\x07' {
                            break;
                        }
                        if nc == '\x1b' && matches!(chars.peek(), Some('\\')) {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        let code = c as u32;
        if code < 0x20 && c != '\n' && c != '\t' {
            continue;
        }
        if code == 0x7F {
            continue;
        }
        out.push(c);
    }
    out
}

fn derive_title_from_agent_prompt(transcript: &str) -> Option<String> {
    transcript
        .lines()
        .rev()
        .filter_map(extract_prompt_text)
        .map(|prompt| sanitise_title(&sentence_case(&prompt)))
        .find(|title| !title.is_empty())
}

fn extract_prompt_text(line: &str) -> Option<String> {
    let trimmed = line.trim();
    let prompt = trimmed
        .strip_prefix('›')
        .or_else(|| trimmed.strip_prefix('>'))
        .map(str::trim)?;
    if prompt.is_empty() || prompt.starts_with('_') {
        return None;
    }
    let lowered = prompt.to_lowercase();
    if matches!(
        lowered.as_str(),
        "claude" | "codex" | "gemini" | "opencode" | "cursor" | "aider"
    ) {
        return None;
    }
    if lowered.contains("for shortcuts") || lowered.contains("for agents") {
        return None;
    }
    Some(prompt.to_string())
}

fn sentence_case(input: &str) -> String {
    let trimmed = input.trim();
    let Some(first) = trimmed.chars().next() else {
        return String::new();
    };
    let mut out = first.to_uppercase().collect::<String>();
    out.push_str(&trimmed[first.len_utf8()..]);
    out
}

fn truncate_head_tail(input: &str, max_chars: usize) -> String {
    let total = input.chars().count();
    if total <= max_chars {
        return input.to_string();
    }
    let head_n = max_chars * 2 / 3;
    let tail_n = max_chars - head_n;
    let head: String = input.chars().take(head_n).collect();
    let tail_rev: String = input.chars().rev().take(tail_n).collect();
    let tail: String = tail_rev.chars().rev().collect();
    format!("{head}\n…\n{tail}")
}

fn sanitise_title(raw: &str) -> String {
    let mut s = raw.trim().to_string();

    // Drop common LLM preambles.
    const PREFIXES: [&str; 7] = [
        "Title:",
        "title:",
        "TITLE:",
        "**Title:**",
        "Here's a title:",
        "Here is a title:",
        "Suggested title:",
    ];
    for pref in PREFIXES {
        if let Some(rest) = s.strip_prefix(pref) {
            s = rest.trim().to_string();
            break;
        }
    }

    // Take only the first non-empty line (Claude sometimes adds explanations
    // even when told not to).
    if let Some(first_line) = s.lines().map(str::trim).find(|l| !l.is_empty()) {
        s = first_line.to_string();
    }

    // Iteratively peel surrounding wrappers (quotes / asterisks / backticks)
    // AND a trailing period, since the LLM sometimes nests them
    // (`**Title.**`). Loop until a full pass changes nothing.
    let wrappers: &[char] = &['"', '\'', '*', '`', '“', '”', '‘', '’'];
    loop {
        let before = s.clone();
        if let Some(first) = s.chars().next() {
            if wrappers.contains(&first) {
                s = s.chars().skip(1).collect::<String>().trim().to_string();
            }
        }
        if let Some(last) = s.chars().last() {
            if wrappers.contains(&last) {
                let take = s.chars().count().saturating_sub(1);
                s = s.chars().take(take).collect::<String>().trim().to_string();
            }
        }
        if s.ends_with('.') && !s.ends_with("...") && !s.ends_with('…') {
            s.pop();
            s = s.trim_end().to_string();
        }
        if s == before {
            break;
        }
    }

    // Hard cap length, rune-aware. Append ellipsis if we trim.
    let len = s.chars().count();
    if len > MAX_TITLE_CHARS {
        let take = MAX_TITLE_CHARS.saturating_sub(1);
        let mut clipped: String = s.chars().take(take).collect();
        clipped = clipped.trim_end().to_string();
        clipped.push('…');
        s = clipped;
    }

    s
}

/// `codex exec` flags for a title call.
///
/// The material is conversation text, and a reply can quote a web page or a pasted log, so it may
/// carry instructions. The call therefore runs read-only with no approvals: Codex can answer, but
/// cannot write or run anything (`--dangerously-bypass-approvals-and-sandbox` let it do both).
/// Checked live 2026-10-10 on codex-cli 0.162.1: a title still comes back.
/// `--ephemeral`: no rollout file, so a title call never shows up as a thread.
const CODEX_TITLE_ARGS: &[&str] = &[
    "--json",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    "approval_policy=\"never\"",
    "--skip-git-repo-check",
    "-",
];

#[cfg(test)]
mod tests {
    #[test]
    fn codex_title_call_cannot_write_or_run_anything() {
        let args = super::CODEX_TITLE_ARGS;
        assert!(!args.iter().any(|a| a.contains("dangerously")));
        assert!(args.windows(2).any(|w| w == ["--sandbox", "read-only"]));
        assert!(args.contains(&"approval_policy=\"never\""));
    }

    #[test]
    fn cli_errors_are_not_titles() {
        assert!(super::looks_like_cli_error("You've hit your weekly limit · resets 6pm (Asia/Jakarta)"));
        assert!(super::looks_like_cli_error("Not logged in · Please run /login"));
        assert!(super::looks_like_cli_error("API Error: 529 overloaded"));
        assert!(!super::looks_like_cli_error("Fitur auto title codeshare"));
    }

    #[test]
    fn claude_json_answer_is_its_result() {
        assert_eq!(
            super::parse_claude_print_json(r#"{"type":"result","is_error":false,"result":"Analisis fitur auto title"}"#).unwrap(),
            "Analisis fitur auto title"
        );
    }

    #[test]
    fn claude_json_error_is_an_error_not_a_title() {
        let out = super::parse_claude_print_json(r#"{"is_error":true,"result":"You've hit your weekly limit"}"#);
        assert!(out.is_err());
        assert!(super::parse_claude_print_json("plain text").is_err());
    }

    #[test]
    fn usable_title_rejects_a_line_with_no_words() {
        use super::TitleProvider;
        assert!(super::usable_title("---", TitleProvider::Claude).is_err());
        assert!(super::usable_title("***\nRelease notes", TitleProvider::Claude).is_err());
        assert_eq!(super::usable_title("Rilis 0.9", TitleProvider::Claude).unwrap(), "Rilis 0.9");
    }

    #[test]
    fn usable_title_rejects_errors_and_empties() {
        use super::TitleProvider;
        assert!(super::usable_title("  ", TitleProvider::Claude).is_err());
        assert!(super::usable_title("You've hit your usage limit", TitleProvider::Codex).is_err());
        assert_eq!(super::usable_title("\"Fix login.\"", TitleProvider::Claude).unwrap(), "Fix login");
    }

    #[test]
    fn a_pane_is_titled_by_its_own_cli_family() {
        assert_eq!(TitleProvider::parse(Some("codex")), TitleProvider::Codex);
        assert_eq!(TitleProvider::parse(Some("Codex")), TitleProvider::Codex);
        assert_eq!(TitleProvider::parse(Some("claude")), TitleProvider::Claude);
    }

    #[test]
    fn an_unmeasured_family_falls_back_rather_than_guessing_a_command_line() {
        // cursor-agent and opencode have no one-shot mode this app drives, so they are titled by
        // Claude instead of by a flag nobody has run.
        assert_eq!(TitleProvider::parse(Some("cursor")), TitleProvider::Claude);
        assert_eq!(TitleProvider::parse(Some("opencode")), TitleProvider::Claude);
        assert_eq!(TitleProvider::parse(None), TitleProvider::Claude);
    }

    use super::*;

    #[test]
    fn sanitise_strips_quotes_and_prefix() {
        assert_eq!(
            sanitise_title("\"Debug rendering issues\""),
            "Debug rendering issues"
        );
        assert_eq!(
            sanitise_title("Title: Fixing bridge memory bug"),
            "Fixing bridge memory bug"
        );
        assert_eq!(
            sanitise_title("**Refactoring the codebase**."),
            "Refactoring the codebase"
        );
    }

    #[test]
    fn sanitise_keeps_first_line_only() {
        let raw = "Investigating SSH timeout\nThe agent kept dropping connections...";
        assert_eq!(sanitise_title(raw), "Investigating SSH timeout");
    }

    #[test]
    fn sanitise_caps_at_48_chars_with_ellipsis() {
        let long = "This is a very long conversation title that should definitely be truncated past the limit";
        let result = sanitise_title(long);
        assert!(
            result.chars().count() <= MAX_TITLE_CHARS,
            "got: {} ({} chars)",
            result,
            result.chars().count()
        );
        assert!(result.ends_with('…'));
    }

    #[test]
    fn truncate_head_tail_keeps_both_ends() {
        let s: String = "abcdefghij".repeat(100);
        let result = truncate_head_tail(&s, 200);
        assert!(result.chars().count() < s.chars().count());
        assert!(result.contains('…'));
    }

    #[test]
    fn derives_title_from_current_claude_prompt_line() {
        let transcript =
            "Claude Code v2.1.181\n› claude\n› buatkan puisi\nBerikut adalah sebuah puisi";
        assert_eq!(
            derive_title_from_agent_prompt(transcript).as_deref(),
            Some("Buatkan puisi")
        );
    }

    #[test]
    fn ignores_agent_launch_commands_as_prompt_titles() {
        let transcript = "workspace via node\n› claude\nClaude Code v2.1.181";
        assert!(derive_title_from_agent_prompt(transcript).is_none());
    }

    #[test]
    fn strip_ansi_handles_csi_and_osc() {
        let raw = "\x1b[31mred\x1b[0m \x1b]0;title\x07 plain";
        assert_eq!(strip_ansi_and_controls(raw), "red  plain");
    }

    #[test]
    fn strip_ansi_keeps_newlines_and_tabs() {
        let raw = "line one\nline\ttwo";
        assert_eq!(strip_ansi_and_controls(raw), "line one\nline\ttwo");
    }
}
