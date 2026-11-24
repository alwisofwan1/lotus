//! Running an agent headless. Two kinds of run:
//!
//! - **Full** — every action kind since 2026-09-25 (decisions "Opsi B" for
//!   scheduled prompts, replacing slice 05 Q4 A, and for PR review, as bb's
//!   "Review with agent" does): behaves like any agent the user starts — the
//!   preset's own flags, every tool, the user's settings, skills and MCP
//!   servers — in a working folder. Its answer is still bound to a JSON schema,
//!   and anything for other people still waits for Send.
//! - **Sealed**: no tools, no MCP, no user settings. No action uses it now; it
//!   stays for a kind that must read untrusted text without being able to act.
//!
//! Every run the automation keeps is given a session id up front, so the
//! transcript survives and the user can open (`--resume`) it in a pane.

use crate::no_window::NoWindow;
use std::sync::Arc;

use serde_json::Value;

use crate::registry::BoxFuture;

/// A delegation preset as the user defined it in Lotus settings
/// (`delegation.presets[]`): an agent command and extra flags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Preset {
    /// e.g. `claude`, `ccs acme`.
    pub agent: String,
    /// e.g. `--model opus --dangerously-skip-permissions`.
    pub args: String,
    /// Set on the agent's process, e.g. `CLAUDE_CONFIG_DIR` for the account it runs on.
    /// The host fills it; the preset file never does.
    pub env: Vec<(String, String)>,
    /// Removed from the agent's environment (the default Claude account is no `CLAUDE_CONFIG_DIR`).
    pub unset: Vec<String>,
    /// Why the host cannot run this preset here (e.g. its account is gone). Refuses every command.
    pub unavailable: Option<String>,
}

/// What an automation changes on top of its saved agent (preset): the composer's model, reasoning
/// effort and Claude account (plans/automation-agent-health P2). Stored inside the automation's
/// `preset_id` as `<preset id>?model=…&effort=…&account=…`, so every config, form, view and MCP
/// tool that already carries a preset id carries the choice too, and old automations read as no choice.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentChoice {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub account: Option<String>,
}

/// A value goes into a pane's shell line: letters, digits and `.-_:[]` only.
fn safe_value(v: &str) -> bool {
    !v.is_empty() && v.len() <= 80 && v.chars().all(|c| c.is_ascii_alphanumeric() || ".-_:[]".contains(c))
}

/// Splits an automation's agent reference into the preset id and the choice on top.
pub fn parse_agent_ref(reference: &str) -> Result<(&str, AgentChoice), String> {
    let Some((id, query)) = reference.split_once('?') else { return Ok((reference, AgentChoice::default())) };
    let mut choice = AgentChoice::default();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').ok_or_else(|| format!("agent: {pair:?} is not key=value"))?;
        if !safe_value(value) {
            return Err(format!("agent: {key} {value:?} is not a model, effort or account name"));
        }
        let slot = match key {
            "model" => &mut choice.model,
            "effort" => &mut choice.effort,
            "account" => &mut choice.account,
            other => return Err(format!("agent: unknown setting {other:?}")),
        };
        *slot = Some(value.to_string());
    }
    Ok((id, choice))
}

/// `args` with `flag` (either `--flag v` or `--flag=v`) replaced by `flag value`.
pub fn set_flag(args: &str, flag: &str, value: &str) -> String {
    let prefixed = format!("{flag}=");
    let mut out: Vec<&str> = Vec::new();
    let mut tokens = args.split_whitespace();
    while let Some(token) = tokens.next() {
        if token == flag {
            tokens.next();
        } else if !token.starts_with(&prefixed) {
            out.push(token);
        }
    }
    let pair = format!("{flag} {value}");
    out.push(&pair);
    out.join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Preset flags that were not passed on, each with its value, for the
    /// run history.
    pub dropped: Vec<String>,
    /// Set on the agent's process on top of the user's environment.
    pub env: Vec<(String, String)>,
    /// Removed from the user's environment before `env` is set.
    pub unset: Vec<String>,
}

/// Marks a process as an agent an automation started. Lotus's MCP tools for
/// automations refuse any caller carrying it (PLAN §2.5 Q34), so a run can
/// never create, change or delete automations — whatever it was told to do.
pub const AUTOMATION_RUN_ENV: &str = "LOTUS_AUTOMATION_RUN";

/// Set on every read-only run (ADR-0039): the CLI then loads no CLAUDE.md or
/// `.claude/rules` file — not the user's global ones, not those of a parent
/// folder the checkout sits in — and no auto-memory. A review is read by the
/// team, and the reviewer's personal setup is not the team's rules; the
/// repository's own rules reach the agent from the PR's head commit instead.
/// Neither switch is in `claude --help`: both were verified live on 2.1.283
/// (2026-09-26), directly and through `ccs`.
pub const PERSONAL_CONTEXT_OFF: [(&str, &str); 2] =
    [("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"), ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")];

/// [`PERSONAL_CONTEXT_OFF`] as it starts a shell line.
pub(crate) fn personal_context_off_prefix() -> String {
    PERSONAL_CONTEXT_OFF.iter().map(|(k, v)| format!("{k}={v} ")).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CommandRefusal {
    #[error("agent {0:?} cannot run headless for an automation; use a claude or ccs preset")]
    UnsupportedAgent(String),
    #[error("the preset's agent field contains a flag ({0}); flags belong in args")]
    FlagInAgent(String),
    #[error("the preset has no agent")]
    EmptyAgent,
    #[error("{0}")]
    Unavailable(String),
    #[error("the {0:?} tool cannot be given to an automation; allowed: WebSearch, WebFetch")]
    ToolNotAllowed(String),
    #[error("the MCP tool {0:?} cannot be given to a review")]
    McpToolNotAllowed(String),
}

/// The only tools an automation may be granted (PLAN §2.5 Q35, slice 05 Q4):
/// read the web, nothing on this machine.
pub const GRANTABLE_TOOLS: &[&str] = &["WebSearch", "WebFetch"];

/// Agents built on Claude Code, which honour `--tools ""`,
/// `--strict-mcp-config` and `--json-schema`.
const SUPPORTED: &[&str] = &["claude", "ccs"];

/// Preset flags allowed through. An allowlist, so a flag added to a preset,
/// or to the CLI, later can never quietly hand the agent a tool.
const ALLOWED_FLAGS: &[&str] = &["--model"];

/// Builds the command for one tool-less, MCP-less, schema-bound, headless
/// run. The prompt is written to stdin, never passed as an argument.
pub fn build_agent_command(preset: &Preset, schema: &Value) -> Result<AgentCommand, CommandRefusal> {
    build_agent_command_with_tools(preset, schema, &[])
}

/// The program and its positional tokens (the ccs profile) from a preset's
/// `agent` field. Flags there are refused: they belong in `args`.
pub(crate) fn program_of(preset: &Preset) -> Result<(String, Vec<String>), CommandRefusal> {
    if let Some(why) = &preset.unavailable {
        return Err(CommandRefusal::Unavailable(why.clone()));
    }
    let mut agent = preset.agent.split_whitespace();
    let program = agent.next().ok_or(CommandRefusal::EmptyAgent)?.to_string();
    if !SUPPORTED.contains(&program.as_str()) {
        return Err(CommandRefusal::UnsupportedAgent(preset.agent.clone()));
    }
    let mut args = Vec::new();
    for token in agent {
        if token.starts_with('-') {
            return Err(CommandRefusal::FlagInAgent(token.to_string()));
        }
        args.push(token.to_string());
    }
    Ok((program, args))
}

/// Flags Lotus sets itself on a full run; a preset repeating one would make
/// the CLI's behaviour depend on which copy wins, so the preset's is dropped.
const OWNED_FLAGS: &[&str] = &[
    "-p", "--print", "--output-format", "--json-schema", "--session-id", "--resume", "-r", "--continue", "-c",
    "--no-session-persistence",
];
/// The [`OWNED_FLAGS`] that take no value.
const OWNED_SWITCHES: &[&str] = &["-p", "--print", "--continue", "-c", "--no-session-persistence"];

/// Builds the command for a full run: the preset exactly as the user runs it
/// (its permission flags included), plus headless, schema-bound output under
/// the given session id. No tool, MCP or settings restriction is added.
pub fn build_full_agent_command(preset: &Preset, schema: &Value, session_id: &str) -> Result<AgentCommand, CommandRefusal> {
    full_command(preset, schema, session_id, "--session-id")
}

/// [`build_full_agent_command`] that continues the existing conversation `session_id` (a
/// Follow-up Run, PLAN §8 Q7) instead of starting one under that id.
pub fn build_full_resume_command(preset: &Preset, schema: &Value, session_id: &str) -> Result<AgentCommand, CommandRefusal> {
    full_command(preset, schema, session_id, "--resume")
}

fn full_command(preset: &Preset, schema: &Value, session_id: &str, session_flag: &str) -> Result<AgentCommand, CommandRefusal> {
    let (program, mut args) = program_of(preset)?;
    let (kept, dropped) = without_owned_flags(&preset.args);
    args.extend(kept);
    // Streamed, so the run can show each step while the agent works.
    args.extend(["-p", "--output-format", "stream-json", "--verbose", session_flag].map(String::from));
    args.push(session_id.to_string());
    args.push("--json-schema".into());
    args.push(schema.to_string());
    let env = vec![(AUTOMATION_RUN_ENV.to_string(), "1".to_string())];
    Ok(AgentCommand { program, args, dropped, env, unset: vec![] })
}

/// The tools a read-only run (a PR review, ADR-0039) may use without asking:
/// read and search the folder, read the PR and the history. Anything else is
/// refused headless (`dontAsk`) and asks the user in a pane (`manual`).
pub const READ_ONLY_TOOLS: &[&str] = &[
    "Read",
    "Grep",
    "Glob",
    "Bash(gh pr view:*)",
    "Bash(gh pr diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    // Brings the PR's commits in so `git show` can read the code at its head; it writes only
    // remote-tracking refs. Seen live 2026-09-26: without it a pane run stopped to ask.
    "Bash(git fetch origin:*)",
];

/// Preset flags that would widen what a read-only run may do, dropped with
/// their values: these switches, `--permission-mode`, and these lists.
const PERMISSION_SWITCHES: &[&str] = &["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"];
const PERMISSION_LISTS: &[&str] = &["--allowedTools", "--allowed-tools"];

/// An MCP tool (`mcp__server__tool`) or a whole server (`mcp__server`) a
/// read-only run may use. Plain names only: no pattern, space or comma could
/// turn one entry into another permission.
pub fn check_mcp_tool(name: &str) -> Result<(), String> {
    let rest = name.strip_prefix("mcp__").unwrap_or_default();
    if rest.is_empty() || !rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err(format!("{name:?} is not an MCP tool or server name (mcp__server or mcp__server__tool)"));
    }
    Ok(())
}

/// A read-only pane run's arguments: the preset's own flags (owned and permission
/// flags removed) and the permission flags Lotus sets.
struct ReadOnlyArgs {
    preset: Vec<String>,
    /// `--permission-mode <mode> --allowedTools <list>`; the list is the last token.
    permission: Vec<String>,
}

/// Splits preset args for a read-only pane run: the owned flags and every
/// permission flag dropped (with values), then the fixed mode and allow list.
fn read_only_args(raw: &str, mode: &str, mcp_tools: &[String]) -> Result<ReadOnlyArgs, CommandRefusal> {
    if let Some(bad) = mcp_tools.iter().find(|t| check_mcp_tool(t).is_err()) {
        return Err(CommandRefusal::McpToolNotAllowed(bad.clone()));
    }
    let (owned_kept, _) = without_owned_flags(raw);
    let mut preset = Vec::new();
    let mut i = 0;
    while i < owned_kept.len() {
        let token = &owned_kept[i];
        let flag = token.split_once('=').map_or(token.as_str(), |(f, _)| f);
        i += 1;
        let (switch, list) = (PERMISSION_SWITCHES.contains(&flag), PERMISSION_LISTS.contains(&flag));
        if !(switch || list || flag == "--permission-mode") {
            preset.push(token.clone());
            continue;
        }
        // Its values go too.
        if !switch && !token.contains('=') {
            while owned_kept.get(i).is_some_and(|next| !next.starts_with('-')) {
                i += 1;
                if !list {
                    break;
                }
            }
        }
    }
    let allowed: Vec<&str> = READ_ONLY_TOOLS.iter().copied().chain(mcp_tools.iter().map(String::as_str)).collect();
    let permission = vec!["--permission-mode".to_string(), mode.to_string(), "--allowedTools".to_string(), allowed.join(",")];
    Ok(ReadOnlyArgs { preset, permission })
}

/// What a headless review may reach besides its sandbox (ADR-0052 §3–4, revised 2026-10-08):
/// the MCP servers its tools come from. The agent holds no GitHub token; it reads GitHub through
/// Lotus's `lotus_github_read`, which Lotus runs as the automation's gh login.
#[derive(Debug, Clone, PartialEq)]
pub struct ReviewFence {
    /// `{"mcpServers": {...}}` for `--mcp-config`: only the servers `tools` names.
    pub mcp_servers: Value,
    /// The MCP tools allowed: the automation's own, plus [`GITHUB_READ_TOOL`] and
    /// [`NOTION_READ_TOOL`] when it reads GitHub.
    pub tools: Vec<String>,
    /// The review may install dependencies and run tests: [`review_settings`] opens [`TEST_HOSTS`].
    pub run_tests: bool,
    /// With `run_tests`: the only folders the review may read ([`test_read_scope`]), its working
    /// folder first. The rest of the home folder is closed to Bash and to Read, Grep and Glob.
    pub read_scope: Vec<String>,
}

/// The Lotus MCP tool a review reads GitHub with; its full name is `mcp__<server>__` + this.
pub const GITHUB_READ_TOOL: &str = "lotus_github_read";

/// The Lotus MCP tool a headless review reads a linked Notion ticket or spec with (ADR-0052 §4).
pub const NOTION_READ_TOOL: &str = "lotus_notion_read";

/// Set on the Lotus MCP server a review starts: the gh login `lotus_github_read` reads as.
pub const REVIEW_GH_ACCOUNT_ENV: &str = "LOTUS_REVIEW_GH_ACCOUNT";

impl ReviewFence {
    /// `lotus_server` is this Lotus's key in `~/.claude.json` (`lotus` or `lotus-dev`). With a
    /// `github_account`, that server always starts, told the account, and its GitHub tool is
    /// allowed; a config without it fails the review rather than run blind.
    pub fn new(mcp_tools: &[String], claude_json: &Value, lotus_server: &str, github_account: Option<&str>) -> Result<Self, String> {
        let mut tools = mcp_tools.to_vec();
        if github_account.is_some() {
            tools.push(format!("mcp__{lotus_server}__{GITHUB_READ_TOOL}"));
            tools.push(format!("mcp__{lotus_server}__{NOTION_READ_TOOL}"));
        }
        let mut mcp_servers = mcp_servers_for(&tools, claude_json);
        if let Some(account) = github_account {
            let server = mcp_servers["mcpServers"].get_mut(lotus_server).ok_or_else(|| {
                format!("PR review reads GitHub through Lotus's MCP server `{lotus_server}`, which ~/.claude.json does not list; restart Lotus to register it")
            })?;
            server["env"][REVIEW_GH_ACCOUNT_ENV] = Value::String(account.to_string());
            // The sidecar refuses an agent whose LOTUS_PROFILE_KEY names another Lotus; the env
            // Lotus itself was started with may carry one (dev run from a release Lotus pane, seen
            // live 2026-10-08), so the server is told its own.
            server["env"]["LOTUS_PROFILE_KEY"] = Value::String(lotus_server.to_string());
        }
        Ok(Self { mcp_servers, tools, run_tests: false, read_scope: vec![] })
    }
}

/// What a headless review may use without asking (ADR-0052 §3): any command, but only inside
/// the sandbox [`review_settings`] describes. File edits go through Bash, which the sandbox
/// keeps inside the working folder; the Edit and Write tools are not sandboxed, so not listed.
pub const REVIEW_TOOLS: &[&str] = &["Bash", "Read", "Grep", "Glob", "Agent", "Task", "Skill", "TodoWrite"];

/// A first filter only: Bash rules match the command's text, so `sh -c 'git push'` passes them
/// (tested 2026-10-08). The sandbox, which reaches no host and holds no token, is what stops these.
pub const REVIEW_DENIED_TOOLS: &[&str] = &[
    "Bash(git push:*)",
    "Bash(git commit:*)",
    "Bash(git checkout:*)",
    "Bash(git reset:*)",
    "Bash(gh pr review:*)",
    "Bash(gh pr comment:*)",
    "Bash(gh pr merge:*)",
    "Bash(gh pr edit:*)",
    "Bash(gh api:*)",
    "Bash(rm:*)",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
];

/// Never readable by a review, by Bash (sandbox `denyRead`) or the Read/Grep tools (`Read(...)`
/// deny rules). `~/Library/Keychains`: without it `security find-generic-password -w` inside the
/// sandbox printed gh's token (tested 2026-10-08); with it only the System keychain is seen.
pub const REVIEW_SECRET_DIRS: &[&str] = &["~/.lotus", "~/.lotus-dev", "~/.config/gh", "~/.ssh", "~/Library/Keychains"];

/// The hosts a review's commands reach: none. GitHub comes through [`GITHUB_READ_TOOL`].
pub const REVIEW_HOSTS: &[&str] = &[];

/// The package registries a review that runs tests reaches (ADR-0052 §6): npm (also bun's and
/// pnpm's default) and PyPI. Nothing else, GitHub included.
pub const TEST_HOSTS: &[&str] = &["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

/// Package caches a review that runs tests keeps in its working folder: the sandbox refuses the
/// default ones in the home folder (npm failed with EPERM on `~/.npm`, tested 2026-10-08).
/// What a review that runs tests may read, besides nothing: `cwd` (its worktree), the git folder
/// the worktree belongs to (its `.git` file names it), and the toolchains on `path` that live in
/// `home` (outside it, `/usr` and `/opt/homebrew`, nothing is closed). A version manager's install
/// (`…/installs/node/24/bin`) opens the whole install, as `node` needs its `lib`; any other folder
/// only itself, so `~/.cargo/bin` opens without `~/.cargo/credentials.toml`.
pub fn test_read_scope(cwd: &std::path::Path, path: &str, home: &std::path::Path) -> Vec<String> {
    let mut scope = vec![cwd.to_string_lossy().into_owned()];
    let gitdir = std::fs::read_to_string(cwd.join(".git"))
        .ok()
        .and_then(|text| text.trim().strip_prefix("gitdir:").map(|d| std::path::PathBuf::from(d.trim())));
    // <checkout>/.git/worktrees/<name> → <checkout>/.git
    if let Some(common) = gitdir.as_deref().and_then(|d| d.parent()?.parent()) {
        scope.push(common.to_string_lossy().into_owned());
    }
    for dir in std::env::split_paths(path).filter(|d| d.starts_with(home) && d != home) {
        let installed = ["/installs/", "/versions/", "/.volta/", "/.nvm/"].iter().any(|m| dir.to_string_lossy().contains(m));
        let open = match dir.parent() {
            Some(parent) if installed && dir.ends_with("bin") => parent.to_path_buf(),
            _ => dir,
        };
        let open = open.to_string_lossy().into_owned();
        if !scope.contains(&open) {
            scope.push(open);
        }
    }
    scope
}

/// The only variables a review that runs tests gets from the user's environment: the PR's code
/// runs and can send what it sees, and a login shell's environment holds tokens.
pub const TEST_ENV_KEPT: &[&str] = &["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR"];

pub const TEST_CACHE_ENV: &[(&str, &str)] = &[
    ("npm_config_cache", ".lotus-cache/npm"),
    ("PIP_CACHE_DIR", ".lotus-cache/pip"),
    ("YARN_CACHE_FOLDER", ".lotus-cache/yarn"),
    ("BUN_INSTALL_CACHE_DIR", ".lotus-cache/bun"),
];

/// Credentials a review must not inherit from the user's environment: other GitHub tokens, and
/// the SSH agent, which would let git push over SSH as the user.
pub const REVIEW_UNSET_ENV: &[&str] =
    &["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "SSH_AUTH_SOCK"];

/// The `--settings` a headless review runs under. `dontAsk` with the sandbox on runs any Bash
/// command sandboxed and refuses the rest; `failIfUnavailable` makes a machine without the
/// sandbox fail the run rather than run unfenced.
///
/// `run_tests` opens [`TEST_HOSTS`]. The PR's own code then runs and npm can publish, so a file it
/// reads can leave: the whole home folder is closed to Bash but for `read_scope` (ADR-0052 §6).
pub fn review_settings(run_tests: bool, read_scope: &[String]) -> Value {
    let filesystem = if run_tests {
        let deny: Vec<&str> = std::iter::once("~").chain(REVIEW_SECRET_DIRS.iter().copied()).collect();
        serde_json::json!({ "denyRead": deny, "allowRead": read_scope })
    } else {
        serde_json::json!({ "denyRead": REVIEW_SECRET_DIRS })
    };
    serde_json::json!({
        "sandbox": {
            "enabled": true,
            "autoAllowBashIfSandboxed": true,
            "allowUnsandboxedCommands": false,
            "failIfUnavailable": true,
            "filesystem": filesystem,
            "network": { "allowedDomains": if run_tests { TEST_HOSTS } else { REVIEW_HOSTS } },
        },
        "permissions": {
            "deny": REVIEW_SECRET_DIRS.iter().map(|d| format!("Read({d}/**)")).collect::<Vec<_>>(),
        },
    })
}

/// The `mcpServers` entries of `claude_json` (the CLI's `~/.claude.json`) that `tools` name, as
/// `--mcp-config` takes them. A server no tool names is not started at all.
pub fn mcp_servers_for(tools: &[String], claude_json: &Value) -> Value {
    let known = claude_json.get("mcpServers").and_then(Value::as_object);
    let mut picked = serde_json::Map::new();
    for tool in tools {
        let Some(rest) = tool.strip_prefix("mcp__") else { continue };
        let server = rest.split_once("__").map_or(rest, |(server, _)| server);
        if let Some(def) = known.and_then(|k| k.get(server)) {
            picked.insert(server.to_string(), def.clone());
        }
    }
    serde_json::json!({ "mcpServers": picked })
}

/// Builds the command for a headless review (ADR-0052): any tool, fenced by the Claude Code
/// sandbox ([`review_settings`]), which holds no token and reaches no host, under `--permission-mode dontAsk`.
/// Only the user's own settings and skills load (`--setting-sources user`): the working folder is
/// the PR's code, whose `.claude/settings.json` hooks would run outside the sandbox. Only the MCP
/// servers in `fence` start. The preset keeps only its allowed flags (`--model`).
pub fn build_read_only_agent_command(
    preset: &Preset,
    schema: &Value,
    session_id: &str,
    fence: &ReviewFence,
) -> Result<AgentCommand, CommandRefusal> {
    read_only_command(preset, schema, session_id, fence, "--session-id")
}

/// [`build_read_only_agent_command`] that continues the conversation `session_id` (a review's
/// Follow-up Run, PLAN §8 Q20): exactly as fenced as the review it continues (ADR-0040 §5).
pub fn build_read_only_resume_command(
    preset: &Preset,
    schema: &Value,
    session_id: &str,
    fence: &ReviewFence,
) -> Result<AgentCommand, CommandRefusal> {
    read_only_command(preset, schema, session_id, fence, "--resume")
}

fn read_only_command(
    preset: &Preset,
    schema: &Value,
    session_id: &str,
    fence: &ReviewFence,
    session_flag: &str,
) -> Result<AgentCommand, CommandRefusal> {
    let mcp_tools = &fence.tools;
    if let Some(bad) = mcp_tools.iter().find(|t| check_mcp_tool(t).is_err()) {
        return Err(CommandRefusal::McpToolNotAllowed(bad.clone()));
    }
    let (program, mut args) = program_of(preset)?;
    let (flags, dropped) = filter_flags(&preset.args);
    args.extend(flags);
    // Streamed, so the run can show each step while the agent works.
    args.extend(["-p", "--output-format", "stream-json", "--verbose", session_flag].map(String::from));
    args.push(session_id.to_string());
    // Running tests, Read, Grep and Glob reach the working folder only (a deny would win over it).
    let scoped: Vec<String> = match (fence.run_tests, fence.read_scope.first()) {
        (true, Some(cwd)) => ["Read", "Grep", "Glob"].iter().map(|t| format!("{t}(/{cwd}/**)")).collect(),
        _ => vec![],
    };
    let allowed: Vec<&str> = REVIEW_TOOLS
        .iter()
        .copied()
        .filter(|t| scoped.is_empty() || !matches!(*t, "Read" | "Grep" | "Glob"))
        .chain(scoped.iter().map(String::as_str))
        .chain(mcp_tools.iter().map(String::as_str))
        .collect();
    args.extend(["--permission-mode".into(), "dontAsk".into(), "--allowedTools".into(), allowed.join(",")]);
    args.extend(["--disallowedTools".into(), REVIEW_DENIED_TOOLS.join(",")]);
    args.extend(["--setting-sources".into(), "user".into(), "--settings".into(), review_settings(fence.run_tests, &fence.read_scope).to_string()]);
    args.push("--strict-mcp-config".into());
    if !mcp_tools.is_empty() {
        args.extend(["--mcp-config".into(), fence.mcp_servers.to_string()]);
    }
    args.push("--json-schema".into());
    args.push(schema.to_string());
    let env = std::iter::once((AUTOMATION_RUN_ENV, "1"))
        .chain(PERSONAL_CONTEXT_OFF)
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let unset = REVIEW_UNSET_ENV.iter().map(|k| k.to_string()).collect();
    Ok(AgentCommand { program, args, dropped, env, unset })
}

/// Preset args for a read-only run typed into a shell (a pane, a reopened
/// run): `manual`, so a tool off the list asks the user in the pane. Preset
/// tokens go in as the user wrote them; only the allow list Lotus adds, which
/// holds spaces and parentheses, is single-quoted.
pub(crate) fn read_only_shell_args(raw: &str, mcp_tools: &[String]) -> Result<Vec<String>, CommandRefusal> {
    let ReadOnlyArgs { mut preset, permission, .. } = read_only_args(raw, "manual", mcp_tools)?;
    let last = permission.len() - 1;
    for (i, arg) in permission.into_iter().enumerate() {
        preset.push(if i == last { format!("'{}'", arg.replace('\'', "'\\''")) } else { arg });
    }
    Ok(preset)
}

/// The command a pane runs to reopen a read-only run: the conversation read
/// other people's text, so it stays read-only (ADR-0039).
pub fn read_only_resume_command(preset: &Preset, session_id: &str, mcp_tools: &[String]) -> Result<String, CommandRefusal> {
    let (program, profile) = program_of(preset)?;
    let mut parts = vec![program];
    parts.extend(profile);
    parts.extend(read_only_shell_args(&preset.args, mcp_tools)?);
    parts.extend(["--resume".to_string(), session_id.to_string()]);
    Ok(format!("{}{}", personal_context_off_prefix(), parts.join(" ")))
}

/// Splits preset args into (kept, dropped): the flags Lotus sets itself on a
/// full or pane run are dropped with their values, everything else is kept.
pub(crate) fn without_owned_flags(raw: &str) -> (Vec<String>, Vec<String>) {
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let (mut kept, mut dropped) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        let flag = token.split_once('=').map_or(token, |(f, _)| f);
        i += 1;
        if !OWNED_FLAGS.contains(&flag) {
            kept.push(token.to_string());
            continue;
        }
        let mut entry = token.to_string();
        let takes_value = !OWNED_SWITCHES.contains(&flag) && !token.contains('=');
        if takes_value && tokens.get(i).is_some_and(|next| !next.starts_with('-')) {
            entry.push(' ');
            entry.push_str(tokens[i]);
            i += 1;
        }
        dropped.push(entry);
    }
    (kept, dropped)
}

/// The command a pane runs to reopen a run's session: the preset as the user
/// runs it, resuming that session. Same shape as the Tasks module's
/// `resumeCommand` (`src/modules/tasks/services/delegation-preset.ts`).
pub fn resume_command(preset: &Preset, session_id: &str) -> String {
    [preset.agent.trim(), preset.args.trim(), "--resume", session_id]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// As [`build_agent_command`], granting exactly `tools` (each from
/// [`GRANTABLE_TOOLS`]). An empty list is `--tools ""`: none at all.
pub fn build_agent_command_with_tools(
    preset: &Preset,
    schema: &Value,
    tools: &[String],
) -> Result<AgentCommand, CommandRefusal> {
    build_sealed_agent_command(preset, schema, tools, None)
}

/// A sealed run. With `session_id` the transcript is kept under that id (so
/// it can be reopened); without, nothing is written to disk.
pub fn build_sealed_agent_command(
    preset: &Preset,
    schema: &Value,
    tools: &[String],
    session_id: Option<&str>,
) -> Result<AgentCommand, CommandRefusal> {
    if let Some(bad) = tools.iter().find(|t| !GRANTABLE_TOOLS.contains(&t.as_str())) {
        return Err(CommandRefusal::ToolNotAllowed(bad.clone()));
    }
    // Remaining agent tokens are positional (the ccs profile), never flags.
    let (program, mut args) = program_of(preset)?;

    let (kept, dropped) = filter_flags(&preset.args);
    args.extend(kept);
    let granted = tools.join(",");
    args.extend(["-p", "--output-format", "json", "--tools"].map(String::from));
    args.push(granted.clone());
    if !granted.is_empty() {
        // Granted tools must also be pre-approved, or headless mode denies them.
        args.push("--allowedTools".into());
        args.push(granted);
    }
    args.push("--strict-mcp-config".into());
    match session_id {
        Some(id) => args.extend(["--session-id".to_string(), id.to_string()]),
        None => args.push("--no-session-persistence".into()),
    }
    args.push("--json-schema".into());
    args.push(schema.to_string());
    let env = vec![(AUTOMATION_RUN_ENV.to_string(), "1".to_string())];
    Ok(AgentCommand { program, args, dropped, env, unset: vec![] })
}

/// Splits preset args into (allowed flags with values, dropped flags with
/// values). A flag's value is the next token when it does not start with `-`.
fn filter_flags(raw: &str) -> (Vec<String>, Vec<String>) {
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let (mut kept, mut dropped) = (Vec::new(), Vec::new());
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        let (flag, inline_value) = match token.split_once('=') {
            Some((flag, value)) if token.starts_with("--") => (flag, Some(value)),
            _ => (token, None),
        };
        let value = match inline_value {
            Some(value) => Some(value),
            None if tokens.get(i + 1).is_some_and(|next| !next.starts_with('-')) => {
                i += 1;
                Some(tokens[i])
            }
            None => None,
        };
        i += 1;
        if ALLOWED_FLAGS.contains(&flag) {
            kept.push(flag.to_string());
            if let Some(value) = value {
                kept.push(value.to_string());
            }
        } else {
            dropped.push(match value {
                Some(value) => format!("{flag} {value}"),
                None => flag.to_string(),
            });
        }
    }
    (kept, dropped)
}

/// What a run may do on this machine (see the module docs).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Access {
    /// No tools beyond [`AgentRequest::tools`], no MCP, no user settings.
    #[default]
    Sealed,
    /// A PR review, which reads other people's text. Headless: any tool, fenced by the sandbox,
    /// with no token and no network (ADR-0052, [`build_read_only_agent_command`]). In a pane:
    /// [`READ_ONLY_TOOLS`] without asking, the rest asks the user (ADR-0039). Plus the listed MCP
    /// tools, whatever the preset's permission flags say.
    ReadOnly {
        mcp_tools: Vec<String>,
        /// Headless only: the gh login the agent reads GitHub as, through [`GITHUB_READ_TOOL`].
        /// `None`: no GitHub access.
        github_account: Option<String>,
        /// Headless only: the agent may install dependencies and run the PR's tests (ADR-0052 §6).
        /// The sandbox then reaches [`TEST_HOSTS`]; package caches live in the working folder.
        run_tests: bool,
    },
    /// Everything the preset's agent can do when the user runs it.
    Full,
}

/// Where a kept run lives: its session id (chosen by Lotus, a UUID) and the
/// folder it runs in. `--resume` only finds a session from the same folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSession {
    pub id: String,
    pub cwd: std::path::PathBuf,
    /// Continue the conversation `id` already holds (`--resume`), rather than start it.
    pub resume: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentRequest {
    /// Which delegation preset to run as; resolved by the runner.
    pub preset_id: String,
    pub prompt: String,
    /// The reply must validate against this JSON Schema.
    pub schema: Value,
    /// Tools granted for a sealed run, from [`GRANTABLE_TOOLS`]. Usually none.
    pub tools: Vec<String>,
    pub access: Access,
    /// `None`: a throwaway scratch folder, and nothing is kept.
    pub session: Option<AgentSession>,
    /// The Lotus workspace (project) to run in, as a visible pane (see
    /// [`crate::pane`]). `None`: headless.
    pub workspace: Option<String>,
    /// The repository the run is about, so its pane can open in a checkout of it.
    pub repo: Option<String>,
    /// The automation run this agent works for; its steps are reported under it.
    pub run_id: Option<String>,
    /// Full and read-only runs: start ONLY the MCP servers in this `--mcp-config` file
    /// (`--strict-mcp-config`); the user's other servers, plugin ones included, stay off. A Factory
    /// agent's kit (FI4). `None`: as the access mode decides.
    pub mcp_config: Option<std::path::PathBuf>,
    /// Plugins loaded for this run only (`--plugin-dir`): a Factory agent's chosen skills (FI4).
    pub plugin_dirs: Vec<std::path::PathBuf>,
}

/// Runs one headless agent turn (sealed or full, see [`Access`]) and returns
/// its schema-bound JSON reply.
pub trait AgentRunner: Send + Sync {
    fn run(&self, request: AgentRequest) -> BoxFuture<Result<Value, String>>;

    /// [`run`](Self::run), also returning what the run cost in USD when the
    /// agent reported it, on failure too. A runner that cannot meter reports `None`.
    fn run_metered(&self, request: AgentRequest) -> BoxFuture<(Result<Value, String>, Option<f64>)> {
        let run = self.run(request);
        Box::pin(async move { (run.await, None) })
    }
}

/// Reads a run's stdout (`--output-format json`, or `stream-json`, whose last
/// line is the same result object): the reply is `structured_output`.
/// Anything else (an error subtype, text without structured output) is an
/// error, so a model that ignored the schema can never produce a draft.
///
/// The result is the last line that is a JSON object: a wrapper may print
/// status lines first. Seen 2026-09-25: `ccs` wrote
/// `[OK] Synchronized marketplace registry paths` to stdout before the JSON.
pub fn parse_agent_output(stdout: &str) -> Result<Value, String> {
    let v = result_object(stdout).ok_or_else(|| "the agent did not print a JSON result".to_string())?;
    if v["terminal_reason"] == "api_error" {
        return Err(api_error(&v));
    }
    if v["is_error"].as_bool().unwrap_or(false) {
        let subtype = v["subtype"].as_str().unwrap_or("error");
        return Err(format!("the agent run ended with {subtype}"));
    }
    match v.get("structured_output") {
        Some(out) if out.is_object() => Ok(out.clone()),
        _ => Err("the agent replied without structured output".into()),
    }
}

/// How [`parse_agent_output`] starts the error of a short outage: no HTTP status (the network) or
/// a 5xx. [`is_transient_error`] reads it.
const TRANSIENT_API_ERROR: &str = "the agent hit a temporary API error";

/// The CLI gave up on the API. Its result object says so (seen 2026-10-13, claude CLI, with the
/// API pointed at a closed port and at a server answering 500):
/// `"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":500|null,
/// "result":"API Error: 500 Internal server error. …"`.
fn api_error(v: &Value) -> String {
    let text = v["result"].as_str().unwrap_or("API Error");
    match v["api_error_status"].as_u64() {
        None => format!("{TRANSIENT_API_ERROR}: {text}"),
        Some(status) if status >= 500 => format!("{TRANSIENT_API_ERROR}: {text}"),
        Some(_) => format!("the agent hit an API error: {text}"),
    }
}

/// A run error from a short outage (network, API 5xx) that is worth one more try. Every other
/// error (a 4xx, the agent's own failure, a timeout) is not.
pub fn is_transient_error(error: &str) -> bool {
    // The CLI reports an expired login with no HTTP status, which reads as an outage here.
    error.starts_with(TRANSIENT_API_ERROR) && crate::failure::classify(error).retryable()
}

/// What the run cost in USD (`total_cost_usd` of the same result object
/// [`parse_agent_output`] reads), also when the run failed. `None` when the
/// agent printed no result or no cost.
pub fn parse_agent_cost(stdout: &str) -> Option<f64> {
    result_object(stdout)?.get("total_cost_usd")?.as_f64()
}

/// The result object of a run's stdout: the whole text when it is one object,
/// else the last line that is.
fn result_object(stdout: &str) -> Option<Value> {
    serde_json::from_str::<Value>(stdout.trim()).ok().filter(Value::is_object).or_else(|| {
        stdout
            .lines()
            .rev()
            .map(str::trim)
            .filter(|l| l.starts_with('{'))
            .find_map(|l| serde_json::from_str::<Value>(l).ok().filter(Value::is_object))
    })
}

/// Looks up a delegation preset by id (the host reads Lotus settings).
pub type PresetLookup = Arc<dyn Fn(&str) -> Option<Preset> + Send + Sync>;

/// The CLI-backed [`AgentRunner`]. A kept run works in its session's folder
/// (the automation's working folder, or its own empty one); a throwaway run
/// in an empty scratch folder, removed after. Not unit-tested (it spends
/// real tokens); `examples/review_pr.rs` smokes it.
pub struct CliAgentRunner {
    presets: PresetLookup,
    env: std::collections::HashMap<String, String>,
    /// One full run per folder at a time: two agents editing the same files
    /// at once would overwrite each other.
    folders: Arc<FolderLocks>,
    /// Told each step (see [`crate::activity`]) of a run that names its `run_id`.
    on_step: Option<StepSink>,
    on_process: Option<ProcessSink>,
    /// The CLI's `~/.claude.json`, where a review's MCP servers are defined, and this Lotus's
    /// server key in it. `None`: a review starts no MCP server.
    review_mcp: Option<(std::path::PathBuf, String)>,
}

#[derive(Clone, Copy, Debug)]
pub enum AgentProcessEvent { Spawned(u32), Exited(u32) }
pub type ProcessSink = Arc<dyn Fn(AgentProcessEvent) -> Result<(), String> + Send + Sync>;

/// Receives `(run_id, step)` while a run works.
pub type StepSink = Arc<dyn Fn(&str, String) + Send + Sync>;

type FolderLocks = std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, Arc<tokio::sync::Mutex<()>>>>;

impl CliAgentRunner {
    pub fn new(presets: PresetLookup, env: std::collections::HashMap<String, String>) -> Self {
        Self { presets, env, folders: Arc::default(), on_step: None, on_process: None, review_mcp: None }
    }

    /// Where a review finds its MCP server definitions, and which of them is this Lotus.
    pub fn with_review_mcp(mut self, claude_json: std::path::PathBuf, lotus_server: impl Into<String>) -> Self {
        self.review_mcp = Some((claude_json, lotus_server.into()));
        self
    }

    /// Factory evidence must be durable before delivering the prompt. A rejected callback
    /// drops the owned process/group; persisted PIDs never authorize killing external processes.
    pub fn with_process_events(mut self, sink: ProcessSink) -> Self { self.on_process = Some(sink); self }

    pub fn with_steps(mut self, sink: StepSink) -> Self {
        self.on_step = Some(sink);
        self
    }
}

fn folder_lock(locks: &FolderLocks, cwd: &std::path::Path) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = locks.lock().unwrap_or_else(|p| p.into_inner());
    Arc::clone(map.entry(cwd.to_path_buf()).or_default())
}

impl AgentRunner for CliAgentRunner {
    fn run(&self, request: AgentRequest) -> BoxFuture<Result<Value, String>> {
        let metered = self.run_metered(request);
        Box::pin(async move { metered.await.0 })
    }

    fn run_metered(&self, request: AgentRequest) -> BoxFuture<(Result<Value, String>, Option<f64>)> {
        let preset = (self.presets)(&request.preset_id);
        let env = self.env.clone();
        let folders = Arc::clone(&self.folders);
        let on_step = self.on_step.clone();
        let on_process = self.on_process.clone();
        let review_mcp = self.review_mcp.clone();
        Box::pin(async move {
            // Set as soon as the final stdout is read, so a run that then fails still reports its cost.
            let mut cost = None;
            let reply: Result<Value, String> = async {
            use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
            let preset = preset.ok_or_else(|| format!("no delegation preset with id {}", request.preset_id))?;
            let session_id = request.session.as_ref().map(|s| s.id.clone());
            let cmd = match &request.access {
                Access::Sealed => build_sealed_agent_command(&preset, &request.schema, &request.tools, session_id.as_deref()),
                // A full run always has a session id; a throwaway one gets a fresh id.
                Access::Full => match &request.session {
                    Some(session) if session.resume => build_full_resume_command(&preset, &request.schema, &session.id),
                    _ => build_full_agent_command(
                        &preset,
                        &request.schema,
                        &session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    ),
                },
                Access::ReadOnly { mcp_tools, github_account, run_tests } => {
                    let mut fence = review_fence(review_mcp.as_ref(), mcp_tools, github_account.as_deref())?;
                    fence.run_tests = *run_tests;
                    if *run_tests {
                        let cwd = request.session.as_ref().map(|s| s.cwd.clone()).unwrap_or_else(std::env::temp_dir);
                        let home = env.get("HOME").map(std::path::PathBuf::from).unwrap_or_default();
                        fence.read_scope = test_read_scope(&cwd, env.get("PATH").map_or("", String::as_str), &home);
                    }
                    match &request.session {
                        Some(session) if session.resume => {
                            build_read_only_resume_command(&preset, &request.schema, &session.id, &fence)
                        }
                        _ => build_read_only_agent_command(
                            &preset,
                            &request.schema,
                            &session_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                            &fence,
                        ),
                    }
                }
            }
            .map_err(|e| e.to_string())?;
            // Sealed runs have no MCP and no plugins, whatever the request says.
            let mut cmd = if request.access == Access::Sealed {
                cmd
            } else {
                with_kit(cmd, request.mcp_config.as_deref(), &request.plugin_dirs)
            };
            cmd.unset.extend(preset.unset.iter().cloned());
            cmd.env.extend(preset.env.iter().cloned());
            // A kept run stays in its folder; a throwaway one gets a scratch folder, removed after.
            let (dir, scratch) = match &request.session {
                Some(session) => {
                    std::fs::create_dir_all(&session.cwd)
                        .map_err(|e| format!("could not open the working folder {}: {e}", session.cwd.display()))?;
                    (session.cwd.clone(), false)
                }
                None => (tempfile_dir()?, true),
            };
            // Only a full run can write; read-only runs in one folder may overlap.
            let lock = (request.access == Access::Full).then(|| folder_lock(&folders, &dir));
            let _held = match &lock {
                Some(lock) => Some(lock.lock().await),
                None => None,
            };
            let running_tests = matches!(request.access, Access::ReadOnly { run_tests: true, .. });
            let inherited = env
                .iter()
                .filter(|(k, _)| !cmd.unset.contains(k))
                .filter(|(k, _)| !running_tests || TEST_ENV_KEPT.contains(&k.as_str()));
            let caches: Vec<(String, String)> = if running_tests {
                TEST_CACHE_ENV
                    .iter()
                    .map(|(k, rel)| (k.to_string(), dir.join(rel).to_string_lossy().into_owned()))
                    // The home folder is closed, `~/.gitconfig` with it: git would stop on it.
                    .chain([("GIT_CONFIG_GLOBAL".to_string(), "/dev/null".to_string())])
                    .collect()
            } else {
                vec![]
            };
            let mut command = tokio::process::Command::new(&cmd.program).no_window();
            command
                .args(&cmd.args)
                .env_clear()
                .envs(inherited)
                .envs(cmd.env.iter().cloned())
                .envs(caches)
                .current_dir(&dir)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                // A timeout drops this future; the agent must die with it.
                .kill_on_drop(true);
            // Its own process group, so the guard below can kill the agent's children too.
            #[cfg(unix)]
            command.process_group(0);
            let mut child = command
                .spawn()
                .map_err(|e| match e.kind() {
                    std::io::ErrorKind::NotFound => format!(
                        "could not start {}: it is not installed on this machine; choose another agent for this automation",
                        cmd.program
                    ),
                    _ => format!("could not start {}: {e}", cmd.program),
                })?;
            let pid = child.id().ok_or("agent process identity unavailable")?;
            let _group = KillGroupOnDrop(Some(pid));
            if let Some(sink) = &on_process { sink(AgentProcessEvent::Spawned(pid))?; }
            let mut stdin = child.stdin.take().ok_or("agent stdin unavailable")?;
            stdin.write_all(request.prompt.as_bytes()).await.map_err(|e| format!("could not send the prompt: {e}"))?;
            drop(stdin);
            let stdout_pipe = child.stdout.take().ok_or("agent stdout unavailable")?;
            let mut stderr_pipe = child.stderr.take().ok_or("agent stderr unavailable")?;
            // Read stderr alongside, so a chatty agent cannot fill its pipe and stall.
            let stderr_task = tokio::spawn(async move {
                let mut buf = Vec::new();
                let _ = stderr_pipe.read_to_end(&mut buf).await;
                buf
            });
            let mut lines = tokio::io::BufReader::new(stdout_pipe).lines();
            // Only the last JSON object line is the result; earlier lines (tool results with whole
            // files in them) are not kept.
            let mut stdout = String::new();
            while let Some(line) = lines.next_line().await.map_err(|e| format!("could not read the agent: {e}"))? {
                if let (Some(sink), Some(run_id)) = (&on_step, &request.run_id) {
                    if let Ok(event) = serde_json::from_str::<Value>(&line) {
                        for step in crate::activity::describe_event(&event, &dir) {
                            sink(run_id, step);
                        }
                    }
                }
                if line.trim_start().starts_with('{') {
                    stdout = line;
                }
            }
            child.wait().await.map_err(|e| format!("agent did not finish: {e}"))?;
            if let Some(sink) = &on_process { sink(AgentProcessEvent::Exited(pid))?; }
            let stderr = stderr_task.await.unwrap_or_default();
            if scratch {
                let _ = std::fs::remove_dir_all(&dir);
            }
            cost = parse_agent_cost(&stdout);
            parse_agent_output(&stdout).map_err(|e| {
                let stderr: String = String::from_utf8_lossy(&stderr).chars().take(300).collect();
                if stderr.trim().is_empty() { e } else { format!("{e} ({})", stderr.trim()) }
            })
            }
            .await;
            (reply, cost)
        })
    }
}

/// `cmd` with only the MCP servers in `mcp_config` (any `--mcp-config` already on it, from the
/// preset or a fence, is replaced; `--strict-mcp-config` is set) and with `plugin_dirs` loaded.
/// Verified live on 2.1.294 (2026-10-08): strict MCP drops user and plugin servers alike, in full
/// and read-only runs; a `--plugin-dir` skill is offered as `<plugin>:<folder>`.
pub fn with_kit(mut cmd: AgentCommand, mcp_config: Option<&std::path::Path>, plugin_dirs: &[std::path::PathBuf]) -> AgentCommand {
    if let Some(config) = mcp_config {
        let mut kept = Vec::with_capacity(cmd.args.len());
        let mut tokens = std::mem::take(&mut cmd.args).into_iter().peekable();
        while let Some(token) = tokens.next() {
            if token.starts_with("--mcp-config=") || token == "--strict-mcp-config" {
                continue;
            }
            if token == "--mcp-config" {
                // Its values run to the next flag.
                while tokens.peek().is_some_and(|next| !next.starts_with('-')) {
                    tokens.next();
                }
                continue;
            }
            kept.push(token);
        }
        cmd.args = kept;
        cmd.args.push("--strict-mcp-config".into());
        cmd.args.push("--mcp-config".into());
        cmd.args.push(config.to_string_lossy().into_owned());
    }
    for dir in plugin_dirs {
        cmd.args.push("--plugin-dir".into());
        cmd.args.push(dir.to_string_lossy().into_owned());
    }
    cmd
}

/// A review's fence, from the MCP servers in the CLI's config. Without a config no server starts,
/// and a review that reads GitHub fails naming the missing Lotus server.
fn review_fence(
    review_mcp: Option<&(std::path::PathBuf, String)>,
    mcp_tools: &[String],
    github_account: Option<&str>,
) -> Result<ReviewFence, String> {
    let Some((path, lotus_server)) = review_mcp else {
        return ReviewFence::new(mcp_tools, &Value::Null, "lotus", github_account);
    };
    let config = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    ReviewFence::new(mcp_tools, &config, lotus_server, github_account)
}

/// Kills the agent's whole process group when dropped (a timeout, or the run's end): `kill_on_drop`
/// reaches only the agent itself, not the builds and servers it started.
struct KillGroupOnDrop(Option<u32>);

impl Drop for KillGroupOnDrop {
    fn drop(&mut self) {
        if let Some(pgid) = self.0 {
            // `kill(-pgid, SIGKILL)`; already-gone is fine.
            #[cfg(unix)]
            let _ = std::process::Command::new("kill").no_window().args(["-KILL", "--", &format!("-{pgid}")]).output();
            // No process groups here; /T kills the agent's process tree instead.
            #[cfg(windows)]
            let _ = std::process::Command::new("taskkill").no_window().args(["/T", "/F", "/PID", &pgid.to_string()]).output();
        }
    }
}

fn tempfile_dir() -> Result<std::path::PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("lotus-review-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create a scratch dir: {e}"))?;
    Ok(dir)
}
