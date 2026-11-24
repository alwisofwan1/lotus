use crate::error::AppError;
use crate::json;
use crate::paths::claude_dir;
use std::path::{Path, PathBuf};

pub fn get_settings() -> serde_json::Value {
    json::read_json::<serde_json::Value>(&claude_dir().join("settings.json"))
        .unwrap_or(serde_json::json!({}))
}

pub fn save_settings(settings: serde_json::Value) -> Result<(), AppError> {
    json::write_json(
        &claude_dir().join("settings.json"),
        &sanitize_settings(settings),
    )
}

// ── Where a spawned agent actually reads its settings ─────────────────────────

/// The Claude config directory an agent **spawned by Lotus** will read.
///
/// Not always `~/.claude`, which is the assumption every hook installer here used to
/// make. `pty::apply_inherited_env` copies the captured login environment into every
/// PTY, and that environment carries `CLAUDE_CONFIG_DIR` whenever the operator uses
/// ccs — pointing at `~/.ccs/instances/<profile>`, a directory Claude reads *instead
/// of* `~/.claude`, not in addition to it. `shell_env::user_login_env` even fills the
/// variable in itself when the login shell did not set it, so this is the normal case
/// on a ccs machine rather than an exotic one.
///
/// Measured 2026-08-09 on this machine: two `claude -p` runs identical but for this
/// variable — one profile whose `settings.json` carried our hook entries, one whose
/// did not — produced **two** hook events and **zero**. Zero is a phone whose Chat mode
/// renders nothing, for every pane, forever, with nothing on screen to tell it apart
/// from an agent that simply has not spoken yet.
///
/// Falls back to `~/.claude` when the variable names a directory that is not there:
/// a path Claude itself would have to create is not evidence about where it reads.
pub fn spawned_agent_claude_dir() -> PathBuf {
    if let Some(dir) = crate::usage::chosen_claude_dir() {
        return dir; // picked with "Use" in the rail's usage popover; see `pty::apply_inherited_env`
    }
    crate::shell_env::user_login_env()
        .get("CLAUDE_CONFIG_DIR")
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .unwrap_or_else(claude_dir)
}

/// Every `settings.json` this instance's hooks are installed into.
///
/// Two entries at most, and usually one: `~/.claude/settings.json`, which is what any
/// session with no override reads, plus [`spawned_agent_claude_dir`]'s file when that
/// resolves somewhere else. **Both**, rather than only the second, because the override
/// is a property of the login shell *as it was at app start* — a session started later,
/// or from a different profile, still reads the global file, and hooks in only one of
/// the two leaves the other silent.
///
/// Deduplicated by canonical path, so the common ccs layout — an instance whose
/// `settings.json` is a symlink onto `~/.claude/settings.json` — is read-modify-written
/// once instead of twice through the same inode, where the second pass would be working
/// from a copy it had already replaced.
pub fn hook_settings_paths() -> Vec<PathBuf> {
    dedup_by_canonical_path(vec![
        claude_dir().join("settings.json"),
        spawned_agent_claude_dir().join("settings.json"),
    ])
}

/// Drops paths that resolve to the same file, keeping the first spelling of each.
///
/// A missing file has no canonical form, so it stands for itself — which is right: two
/// different paths that do not exist yet are two files we are about to create.
pub(crate) fn dedup_by_canonical_path(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut kept: Vec<PathBuf> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    for path in paths {
        let key = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        kept.push(path);
    }
    kept
}

fn read_settings_at(path: &Path) -> serde_json::Value {
    json::read_json::<serde_json::Value>(&path.to_path_buf()).unwrap_or(serde_json::json!({}))
}

/// Writes one hook-carrying settings file, sanitising **only** the app's own.
///
/// [`sanitize_settings`] migrates a legacy Lotus theme key. That is a rewrite of our
/// own record and belongs on our own file; a ccs profile's `settings.json` is the
/// operator's, and the only thing we have any business changing in it is the hook
/// entries we put there.
fn write_hook_settings(path: &Path, settings: serde_json::Value) -> Result<(), AppError> {
    let ours = *path == claude_dir().join("settings.json");
    let value = if ours {
        sanitize_settings(settings)
    } else {
        settings
    };
    json::write_json(&path.to_path_buf(), &value)
}

fn sanitize_settings(mut settings: serde_json::Value) -> serde_json::Value {
    let Some(root) = settings.as_object_mut() else {
        return settings;
    };

    let legacy_lotus_theme = root
        .get("theme")
        .and_then(|value| value.as_str())
        .filter(|theme| is_lotus_theme_id(theme))
        .map(str::to_string);

    if let Some(theme) = legacy_lotus_theme {
        root.entry("orchids_theme".to_string())
            .or_insert_with(|| serde_json::Value::String(theme));
        root.remove("theme");
    }

    // Code › Pane titles › Title model is retired: one Chat › Titles model names every mode.
    // A pick made there carries over unless Chat already has one of its own.
    let pane_title_model = root
        .get_mut("codespace")
        .and_then(|codespace| codespace.as_object_mut())
        .and_then(|codespace| codespace.remove("paneTitleModel"))
        .and_then(|model| model.as_str().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string));
    if let Some(model) = pane_title_model {
        let chat = root.entry("chat".to_string()).or_insert_with(|| serde_json::json!({}));
        if let Some(chat) = chat.as_object_mut() {
            let has_own = chat.get("titleModel").and_then(|m| m.as_str()).is_some_and(|m| !m.trim().is_empty());
            if !has_own {
                chat.insert("titleModel".to_string(), serde_json::Value::String(model));
            }
        }
    }

    settings
}

/// Applies [`sanitize_settings`] to the saved file once at start, so a retired key is folded
/// even for someone who never opens Settings again. Writes only when something changed.
pub fn fold_retired_settings() {
    let current = get_settings();
    let next = sanitize_settings(current.clone());
    if next != current {
        let _ = json::write_json(&claude_dir().join("settings.json"), &next);
    }
}

fn is_lotus_theme_id(theme: &str) -> bool {
    matches!(
        theme,
        "void"
            | "ghost"
            | "plasma"
            | "carbon"
            | "hex"
            | "neon-tokyo"
            | "obsidian"
            | "nebula"
            | "storm"
            | "infrared"
            | "nova"
            | "stealth"
            | "hologram"
            | "dracula"
            | "bridgemind"
            | "synthwave"
            | "cybernetics"
            | "quantum"
            | "mecha"
            | "abyss"
            | "gruvbox"
            | "gruvbox-dark"
            | "gruvbox-light"
            | "paper"
            | "chalk"
            | "solar"
            | "arctic"
            | "parchment"
            | "ivory"
    )
}

/// Marker substring of the LEGACY inline stop-hook command Lotus used to
/// install (a `curl` one-liner with a baked port/secret). Kept so newer
/// builds can still recognise and clean up entries written by older builds.
/// The route path `/v1/hook/stop` must never be renamed for this reason.
const LOTUS_HOOK_MARKER: &str = "/v1/hook/stop";

/// True when `command` is a legacy inline stop-hook entry: an old-format
/// `curl … /v1/hook/stop` one-liner. Matching requires BOTH tokens — the
/// route alone also appears inside the new script files, and `curl` alone
/// would match arbitrary user hooks. Legacy entries embed a port/secret that
/// rotates every app start, so they are stale by design; removing the OTHER
/// instance's legacy entry is safe because that instance re-installs its
/// (new-style) hook on its own next start.
fn command_is_legacy_inline_stop_hook(command: &str) -> bool {
    command.contains(LOTUS_HOOK_MARKER) && command.contains("curl")
}

/// Build the shell `command` string installed under `hooks.Stop[].hooks[]`
/// in `~/.claude/settings.json`. It simply invokes this instance's dropped
/// stop-hook script (see `mcp_config::build_claude_stop_hook_script`), which
/// reads the live IPC port/secret at RUN time — so this settings entry never
/// goes stale across app restarts, and the instance-unique path (`.lotus/` vs
/// `.lotus-dev/`) doubles as the ownership marker for dev/release coexistence.
pub fn build_stop_hook_command(script_path: &Path) -> String {
    format!("\"{}\"", script_path.display())
}

/// Pure merge: take the current `~/.claude/settings.json` value and return a
/// new value with the Lotus Stop hook installed. Idempotent — entries owned
/// by THIS instance (command contains our script path) plus legacy inline
/// curl entries (any instance — see
/// [`command_is_legacy_inline_stop_hook`]) are removed first. The OTHER
/// instance's script entry, user-authored hooks for other events
/// (`PreToolUse`, `PostToolUse`, …), and any non-Lotus entries inside `Stop`
/// are preserved untouched so dev and release builds can coexist.
pub fn apply_stop_hook(mut settings: serde_json::Value, script_path: &Path) -> serde_json::Value {
    let command = build_stop_hook_command(script_path);

    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    let hooks = settings
        .as_object_mut()
        .expect("settings is an object")
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }

    let script_str = script_path.display().to_string();
    for (event_key, matcher) in STOP_HOOK_EVENTS {
        let stop = hooks
            .as_object_mut()
            .expect("hooks is an object")
            .entry(event_key.to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !stop.is_array() {
            *stop = serde_json::json!([]);
        }
        let stop_arr = stop.as_array_mut().expect("stop event is array");
        stop_arr.retain(|entry| !hook_entry_is_our_stop_hook(entry, &script_str));
        stop_arr.push(serde_json::json!({
            "matcher": matcher,
            "hooks": [
                { "type": "command", "command": command },
            ],
        }));
    }

    settings
}

/// The turn-end events the stop-hook script serves. `StopFailure` runs INSTEAD of `Stop` when a turn
/// dies on an API error; only a usage limit is taken, so a Code pane can offer "Continue on <account>".
const STOP_HOOK_EVENTS: [(&str, &str); 2] = [("Stop", "*"), ("StopFailure", "rate_limit")];

/// The Claude hook events narration listens on, with the phase argument each passes to the
/// shared script. One script serves all of them so there is a single body to keep in sync.
///
/// **`UserPromptSubmit` was added 2026-08-08, and it closes a hole rather than adding a
/// feature.** Nothing else in Claude's payloads carries what the operator typed: `Stop`
/// sends `last_assistant_message` and the tool events send neither. So Chat on the phone
/// had no reliable way to put "you asked" beside "it answered" — it inferred the prompt
/// from a field that rides at most once per turn on an entry of its own, and a device
/// showed the result: six replies stacked as one document with a single question stranded
/// underneath them.
pub const CLAUDE_HOOK_EVENTS: [(&str, &str); 3] = [
    ("PreToolUse", "pre"),
    ("PostToolUse", "post"),
    ("UserPromptSubmit", "user"),
];

/// The settings.json command for one tool-hook phase: the script path plus `pre` / `post`.
/// The phase is positional and nothing else is passed: the wrapper this invokes is
/// generated by `install_claude_tool_hook_script`, which bakes the drop directory
/// into its body from `default_drop_dir()`. Adding `--drop-dir` here would be an
/// argument it never reads.
pub fn build_tool_hook_command(script_path: &Path, phase: &str) -> String {
    format!("\"{}\" {}", script_path.display(), phase)
}

/// Drop directory this instance watches, passed to every hook command.
///
/// The script cannot infer it: the same file is installed to `~/.lotus` by a
/// release build and `~/.lotus-dev` by a dev build, and its own hardcoded default
/// sent both copies to the release directory. Same principle as `LOTUS_STATE_DIR`
/// and `ADAPTER` — the parent decides, because the child has no way to know.
fn drop_dir_arg() -> String {
    crate::paths::lotus_state_dir()
        .join("agent-hooks")
        .join("global")
        .display()
        .to_string()
}

#[cfg(test)]
mod drop_dir_arg_tests {
    use super::*;

    /// Both hook commands must name the directory, or the installed copy of the
    /// script falls back to its own hardcoded `~/.lotus` and a dev build's events
    /// land in the release build's drop dir.
    #[test]
    fn the_node_hook_command_names_the_drop_dir_and_the_wrapper_does_not() {
        let script = Path::new("/Users/x/.lotus-dev/agent-notify/index.mjs");

        let notify = build_agent_notify_command(script, "stop");

        assert!(notify.contains("--drop-dir"), "got {notify}");
        assert!(
            notify.contains(&drop_dir_arg()),
            "must name THIS profile's dir: {notify}"
        );

        // The tool hook deliberately does NOT: its wrapper has the directory baked
        // into its body, so a flag here would be an argument nothing reads.
        let tool = build_tool_hook_command(script, "pre");
        assert!(!tool.contains("--drop-dir"), "got {tool}");
        assert!(
            tool.ends_with(" pre"),
            "phase stays last and positional: {tool}"
        );
    }

    /// Quoted, because a home directory can contain spaces and the command is
    /// re-parsed by a shell.
    #[test]
    fn the_drop_dir_is_quoted() {
        let cmd = build_agent_notify_command(Path::new("/tmp/index.mjs"), "stop");

        assert!(
            cmd.contains(&format!("--drop-dir \"{}\"", drop_dir_arg())),
            "got {cmd}"
        );
    }
}

/// Pure merge: install this instance's tool hooks into `hooks.PreToolUse` / `hooks.PostToolUse`.
///
/// Same coexistence contract as [`apply_stop_hook`]: idempotent, removes only entries whose command
/// contains OUR script path, and leaves the other instance's entries and any user-authored tool
/// hooks untouched. `~/.claude/settings.json` is global and shared, so anything we do not
/// positively own must survive.
pub fn apply_tool_hooks(mut settings: serde_json::Value, script_path: &Path) -> serde_json::Value {
    if !settings.is_object() {
        settings = serde_json::json!({});
    }
    let script_str = script_path.display().to_string();
    let hooks = settings
        .as_object_mut()
        .expect("settings is an object")
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }

    for (event_key, phase) in CLAUDE_HOOK_EVENTS {
        let command = build_tool_hook_command(script_path, phase);
        // `matcher` selects which tool a hook applies to, so it belongs to the tool events
        // only. `UserPromptSubmit` has no tool to match.
        let entry = if phase == "user" {
            serde_json::json!({ "hooks": [{ "type": "command", "command": command }] })
        } else {
            serde_json::json!({
                "matcher": "*",
                "hooks": [{ "type": "command", "command": command }],
            })
        };
        let slot = hooks
            .as_object_mut()
            .expect("hooks is an object")
            .entry(event_key.to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !slot.is_array() {
            *slot = serde_json::json!([]);
        }
        let arr = slot.as_array_mut().expect("event slot is array");
        arr.retain(|e| !hook_entry_command_matches(e, &|c: &str| c.contains(&script_str)));
        arr.push(entry);
    }

    settings
}

/// Pure removal: strip THIS instance's tool hooks. The other instance's entries and user-authored
/// hooks survive; emptied arrays and an emptied `hooks` object are pruned so the file stays tidy.
pub fn strip_tool_hooks(mut settings: serde_json::Value, script_path: &Path) -> serde_json::Value {
    let Some(root) = settings.as_object_mut() else {
        return settings;
    };
    let script_str = script_path.display().to_string();
    let prune_hooks = if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (event_key, _) in CLAUDE_HOOK_EVENTS {
            if let Some(arr) = hooks.get_mut(event_key).and_then(|s| s.as_array_mut()) {
                arr.retain(|e| !hook_entry_command_matches(e, &|c: &str| c.contains(&script_str)));
                if arr.is_empty() {
                    hooks.remove(event_key);
                }
            }
        }
        hooks.is_empty()
    } else {
        false
    };
    if prune_hooks {
        root.remove("hooks");
    }
    settings
}

/// Pure removal: strip THIS instance's Stop hook (plus legacy inline curl
/// entries) from `hooks.Stop`. The other instance's script entry survives.
/// Empty `Stop` arrays + an empty `hooks` object are pruned so the file
/// stays tidy.
pub fn strip_stop_hook(mut settings: serde_json::Value, script_path: &Path) -> serde_json::Value {
    let Some(root) = settings.as_object_mut() else {
        return settings;
    };
    let script_str = script_path.display().to_string();
    let prune_hooks = if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (event_key, _) in STOP_HOOK_EVENTS {
            if let Some(stop) = hooks.get_mut(event_key).and_then(|s| s.as_array_mut()) {
                stop.retain(|entry| !hook_entry_is_our_stop_hook(entry, &script_str));
                if stop.is_empty() {
                    hooks.remove(event_key);
                }
            }
        }
        hooks.is_empty()
    } else {
        false
    };
    if prune_hooks {
        root.remove("hooks");
    }
    settings
}

/// Shared entry-shape walker: apply `pred` to every command string inside a
/// `hooks.<Event>[]` entry, handling both the modern
/// `{ "matcher", "hooks": [{ "command" }] }` shape and the older flat
/// `{ "type": "command", "command" }` prototype shape.
fn hook_entry_command_matches(entry: &serde_json::Value, pred: &dyn Fn(&str) -> bool) -> bool {
    let Some(arr) = entry.get("hooks").and_then(|h| h.as_array()) else {
        // Older shape: { "type": "command", "command": "..." } directly.
        return entry
            .get("command")
            .and_then(|c| c.as_str())
            .map(pred)
            .unwrap_or(false);
    };
    arr.iter().any(|inner| {
        inner
            .get("command")
            .and_then(|c| c.as_str())
            .map(pred)
            .unwrap_or(false)
    })
}

/// Ownership test for `hooks.Stop` entries: OURS when the command references
/// this instance's script path, or when it is a legacy inline curl entry
/// (stale-by-design old format, any instance). The other instance's
/// `claude-stop-hook.sh` entry does NOT match, so dev/release coexist.
fn hook_entry_is_our_stop_hook(entry: &serde_json::Value, script_str: &str) -> bool {
    hook_entry_command_matches(entry, &|c: &str| {
        c.contains(script_str) || command_is_legacy_inline_stop_hook(c)
    })
}

/// Read → merge → write the Stop hook. Drops this instance's runtime-config
/// stop-hook script into the state dir first, then installs a settings entry
/// that merely invokes it. Uses [`get_settings`] / [`save_settings`] so it
/// round-trips through the same path the rest of the app uses.
///
/// `_port` / `_secret` are intentionally unused: the dropped script reads the
/// live port/secret from `lotus-mcp-ipc.json` at RUN time (that is the whole
/// point — the settings entry can never go stale). The parameters are kept so
/// the bootstrap call site in `lib.rs` stays source-compatible.
pub fn install_stop_hook(_port: u16, _secret: &str) -> Result<(), AppError> {
    let script_path = crate::mcp_config::install_claude_stop_hook_script()
        .map_err(|e| crate::error::other(format!("write claude-stop-hook.sh: {e}")))?;
    let tool_script = crate::mcp_config::install_claude_tool_hook_script()
        .map_err(|e| crate::error::other(format!("write claude-tool-hook.sh: {e}")))?;
    // Every file a spawned agent might read, not just ours — see `hook_settings_paths`.
    // One read-modify-write per file for both hook families: each round-trips the whole
    // document, so applying them separately would make the second clobber the first.
    write_each(hook_settings_paths(), |current| {
        apply_tool_hooks(apply_stop_hook(current, &script_path), &tool_script)
    })
}

/// Applies one merge to every settings file, and reports the first failure **after**
/// trying them all.
///
/// Stopping at the first error would be worse than it looks: the two files are a global
/// one and a per-profile one, and abandoning the second because the first was read-only
/// is how a machine ends up with hooks installed nowhere the agent reads.
fn write_each(
    paths: Vec<PathBuf>,
    merge: impl Fn(serde_json::Value) -> serde_json::Value,
) -> Result<(), AppError> {
    let mut failure = None;
    for path in paths {
        let next = merge(read_settings_at(&path));
        if let Err(err) = write_hook_settings(&path, next) {
            failure.get_or_insert(err);
        }
    }
    match failure {
        Some(err) => Err(err),
        None => Ok(()),
    }
}

/// Inverse of [`install_stop_hook`]. Best-effort: if the settings file does
/// not exist, this returns `Ok(())` rather than creating an empty one. Also
/// removes the dropped script so no orphan file lingers in the state dir.
pub fn uninstall_stop_hook() -> Result<(), AppError> {
    let Ok(script_path) = crate::mcp_config::claude_stop_hook_script_path() else {
        return Ok(());
    };
    let _ = std::fs::remove_file(&script_path);
    let tool_script = crate::mcp_config::claude_tool_hook_script_path().ok();
    if let Some(tool_script) = &tool_script {
        let _ = std::fs::remove_file(tool_script);
    }
    // Every file the installer writes, or an uninstall leaves entries pointing at a
    // script it has just deleted — a hook that fails silently on every turn.
    write_each(existing(hook_settings_paths()), |current| {
        let next = strip_stop_hook(current, &script_path);
        match &tool_script {
            Some(tool_script) => strip_tool_hooks(next, tool_script),
            None => next,
        }
    })
}

/// Keeps only the settings files that are already there.
///
/// Uninstall must not *create* one: an empty `settings.json` written into a profile
/// that never had one is a file the operator now owns for no reason.
fn existing(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    paths.into_iter().filter(|path| path.exists()).collect()
}

// ── Agent-notify hooks ────────────────────────────────────────────────────────

/// Marker substring identifying agent-notify entries written by ANY Lotus
/// instance (dev or release). Used only for the read-only status probe
/// [`hooks_has_agent_notify`]. Install/uninstall ownership is deliberately
/// narrower — the full instance script path — so the dev and release builds
/// stop stripping each other's entries (they share ~/.claude/settings.json
/// but write `~/.lotus/...` vs `~/.lotus-dev/...` script paths).
const AGENT_NOTIFY_HOOK_MARKER: &str = "agent-notify/index.mjs";

fn build_agent_notify_command(script_path: &Path, event: &str) -> String {
    format!(
        // `$PPID` is the CLI that fired the hook: the evidence `hook_not_from_pane` walks.
        "LOTUS_AGENT_PID=\"$PPID\" node {} --agent claude --event {} --drop-dir \"{}\" 2>/dev/null || true",
        script_path.display(),
        event,
        drop_dir_arg(),
    )
}

/// Pure merge: install agent-notify hooks under `hooks.Stop` and
/// `hooks.Notification`. Idempotent — stale entries are stripped first.
/// All other hooks and top-level keys are preserved.
pub fn apply_agent_notify_hooks(
    mut settings: serde_json::Value,
    script_path: &Path,
) -> serde_json::Value {
    settings = strip_agent_notify_hooks(settings, script_path);

    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    let stop_cmd = build_agent_notify_command(script_path, "stop");
    let notif_cmd = build_agent_notify_command(script_path, "notification");

    let root = settings.as_object_mut().expect("settings is an object");
    let hooks = root
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !hooks.is_object() {
        *hooks = serde_json::json!({});
    }
    let hooks = hooks.as_object_mut().expect("hooks is an object");

    for (event_key, cmd) in [("Stop", stop_cmd), ("Notification", notif_cmd)] {
        let entry = serde_json::json!({
            "matcher": "*",
            "hooks": [{ "type": "command", "command": cmd }],
        });
        let arr = hooks
            .entry(event_key.to_string())
            .or_insert_with(|| serde_json::json!([]));
        if !arr.is_array() {
            *arr = serde_json::json!([]);
        }
        arr.as_array_mut().expect("event arr is array").push(entry);
    }

    settings
}

/// Pure removal: strip THIS instance's agent-notify entries (matched by the
/// full `script_path`) from `hooks.Stop` and `hooks.Notification`. The other
/// instance's entries survive — see [`AGENT_NOTIFY_HOOK_MARKER`] for why the
/// generic suffix must not be used here. Prunes empty arrays and the `hooks`
/// container.
pub fn strip_agent_notify_hooks(
    mut settings: serde_json::Value,
    script_path: &Path,
) -> serde_json::Value {
    let Some(root) = settings.as_object_mut() else {
        return settings;
    };
    let script_str = script_path.display().to_string();
    let prune_hooks = if let Some(hooks) = root.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for event_key in ["Stop", "Notification"] {
            let should_remove =
                if let Some(arr) = hooks.get_mut(event_key).and_then(|a| a.as_array_mut()) {
                    arr.retain(|entry| !hook_entry_is_our_agent_notify(entry, &script_str));
                    arr.is_empty()
                } else {
                    false
                };
            if should_remove {
                hooks.remove(event_key);
            }
        }
        hooks.is_empty()
    } else {
        false
    };
    if prune_hooks {
        root.remove("hooks");
    }
    settings
}

/// Any-instance probe (read-only, powers the status readout in `lib.rs`).
fn hook_entry_is_agent_notify(entry: &serde_json::Value) -> bool {
    hook_entry_command_matches(entry, &|c: &str| c.contains(AGENT_NOTIFY_HOOK_MARKER))
}

/// Ownership test for install/uninstall: OURS only when the command carries
/// this instance's full script path (e.g. `/.lotus-dev/agent-notify/index.mjs`).
fn hook_entry_is_our_agent_notify(entry: &serde_json::Value, script_str: &str) -> bool {
    hook_entry_command_matches(entry, &|c: &str| c.contains(script_str))
}

/// Read → merge → write agent-notify hooks into every file a spawned agent reads.
pub fn install_agent_notify_hooks(script_path: &Path) -> Result<(), AppError> {
    write_each(hook_settings_paths(), |current| {
        apply_agent_notify_hooks(current, script_path)
    })
}

/// Best-effort removal of agent-notify hooks. Recomputes this instance's script path
/// so only OUR entries are stripped, from each file the installer wrote to.
pub fn uninstall_agent_notify_hooks() -> Result<(), AppError> {
    let Ok(script_path) = crate::mcp_config::agent_notify_index_path() else {
        return Ok(());
    };
    write_each(existing(hook_settings_paths()), |current| {
        strip_agent_notify_hooks(current, &script_path)
    })
}

/// Whether an agent this instance spawns will actually run this instance's hooks.
///
/// The question Chat depends on is not "did we install our hooks" but "will the agent
/// read the file we installed them into" — see [`spawned_agent_claude_dir`] for how
/// those two came apart. It stays a live question even with the installer writing to
/// both files: the operator can switch ccs profile after Lotus started, and the profile
/// Lotus captured at boot is then not the one the next agent inherits.
///
/// When this is false the transcript store never receives a single entry, so
/// `GET /api/fleet/:pane_id/transcript` answers `total: 0` for every pane forever. That
/// is indistinguishable, on a phone, from an agent that has not spoken yet — which is
/// why the route reports this as `hostSupports: false` rather than letting Chat render
/// an empty page and leave the operator to guess.
pub fn hooks_reach_spawned_agents() -> bool {
    let Ok(tool_script) = crate::mcp_config::claude_tool_hook_script_path() else {
        return false;
    };
    let Ok(notify_index) = crate::mcp_config::agent_notify_index_path() else {
        return false;
    };
    settings_carry_our_hooks(
        &read_settings_at(&spawned_agent_claude_dir().join("settings.json")),
        &tool_script.display().to_string(),
        &notify_index.display().to_string(),
    )
}

/// Pure half of [`hooks_reach_spawned_agents`], so the rule is testable without a home
/// directory.
///
/// **Both** families are required, because Chat is not one signal. The tool-hook script
/// under `UserPromptSubmit` is what produces the "you asked" bubble and the steps under
/// it; the agent-notify entry under `Stop` is the only thing that ever carries the
/// agent's own last message — which is the line the operator opened the screen to read.
/// Either one missing is a Chat that lies by omission, so neither alone counts.
fn settings_carry_our_hooks(
    settings: &serde_json::Value,
    tool_script: &str,
    notify_index: &str,
) -> bool {
    let carries = |event_key: &str, needle: &str| {
        settings
            .get("hooks")
            .and_then(|hooks| hooks.get(event_key))
            .and_then(|arr| arr.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .any(|entry| hook_entry_command_matches(entry, &|c: &str| c.contains(needle)))
            })
            .unwrap_or(false)
    };
    carries("UserPromptSubmit", tool_script) && carries("Stop", notify_index)
}

/// Returns true if `settings` already has at least one agent-notify hook entry
/// under `hooks.<event_key>[]`.
pub fn hooks_has_agent_notify(settings: &serde_json::Value, event_key: &str) -> bool {
    settings
        .get("hooks")
        .and_then(|h| h.get(event_key))
        .and_then(|arr| arr.as_array())
        .map(|entries| entries.iter().any(hook_entry_is_agent_notify))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// This instance's script path (dev-flavoured) used across the tests.
    fn our_script() -> std::path::PathBuf {
        std::path::PathBuf::from("/home/user/.lotus-dev/claude-stop-hook.sh")
    }

    /// The OTHER instance's script path — must always survive our merges so
    /// dev and release builds can coexist in one ~/.claude/settings.json.
    fn other_script_cmd() -> &'static str {
        "\"/home/user/.lotus/claude-stop-hook.sh\""
    }

    fn our_tool_script() -> std::path::PathBuf {
        std::path::PathBuf::from("/home/user/.lotus-dev/claude-tool-hook.sh")
    }

    #[test]
    fn apply_tool_hooks_registers_both_tool_events() {
        // Narration needs the in-flight signal (PreToolUse) and the outcome (PostToolUse).
        let next = apply_tool_hooks(json!({}), &our_tool_script());
        for event in ["PreToolUse", "PostToolUse"] {
            let arr = next["hooks"][event].as_array().expect("event array");
            assert_eq!(arr.len(), 1, "{event} has exactly our entry");
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(
                cmd.contains("claude-tool-hook.sh"),
                "{event} invokes our script"
            );
        }
    }

    #[test]
    fn apply_tool_hooks_passes_the_phase_so_one_script_serves_both_events() {
        let next = apply_tool_hooks(json!({}), &our_tool_script());
        let pre = next["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        let post = next["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert!(pre.ends_with(" pre"), "pre phase argument: {pre}");
        assert!(post.ends_with(" post"), "post phase argument: {post}");
    }

    /// Added 2026-08-08. Nothing else in Claude's payloads carries what the operator
    /// typed, so without this hook a consumer rebuilding a conversation has to infer the
    /// prompt from a field that rides at most once per turn — and a phone showed what
    /// that produces: replies stacked as one document with the question stranded under
    /// them.
    #[test]
    fn apply_tool_hooks_registers_the_prompt_event_too() {
        let next = apply_tool_hooks(json!({}), &our_tool_script());

        let arr = next["hooks"]["UserPromptSubmit"]
            .as_array()
            .expect("event array");
        assert_eq!(arr.len(), 1);
        let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(
            cmd.ends_with(" user"),
            "phase argument names the event: {cmd}"
        );
    }

    /// `matcher` selects which tool a hook applies to. `UserPromptSubmit` has no tool.
    #[test]
    fn the_prompt_event_carries_no_matcher_and_the_tool_events_do() {
        let next = apply_tool_hooks(json!({}), &our_tool_script());

        assert!(next["hooks"]["UserPromptSubmit"][0]
            .get("matcher")
            .is_none());
        assert_eq!(next["hooks"]["PreToolUse"][0]["matcher"], "*");
    }

    /// Uninstall has to reach it as well, or a removed instance keeps firing on every
    /// prompt typed anywhere on the machine.
    #[test]
    fn strip_tool_hooks_removes_the_prompt_event() {
        let installed = apply_tool_hooks(json!({}), &our_tool_script());

        let next = strip_tool_hooks(installed, &our_tool_script());

        assert!(
            next.get("hooks").is_none(),
            "everything ours was pruned: {next}"
        );
    }

    #[test]
    fn apply_tool_hooks_is_idempotent_and_preserves_foreign_entries() {
        // Same coexistence contract as the Stop hook: re-running must not stack duplicates, and
        // the other instance's script plus any user-authored tool hook must survive.
        let prior = json!({
            "hooks": {
                "PreToolUse": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/local/bin/user-lint" }] },
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "\"/home/user/.lotus/claude-tool-hook.sh\" pre" }] },
                ],
            },
        });
        let once = apply_tool_hooks(prior, &our_tool_script());
        let twice = apply_tool_hooks(once, &our_tool_script());
        let cmds: Vec<&str> = twice["hooks"]["PreToolUse"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["hooks"][0]["command"].as_str().unwrap())
            .collect();
        assert!(cmds.contains(&"/usr/local/bin/user-lint"), "user hook kept");
        assert!(
            cmds.iter()
                .any(|c| c.contains("/.lotus/claude-tool-hook.sh")),
            "other instance kept"
        );
        assert_eq!(
            cmds.iter()
                .filter(|c| c.contains("/.lotus-dev/claude-tool-hook.sh"))
                .count(),
            1,
            "exactly one of ours after two applies"
        );
    }

    #[test]
    fn strip_tool_hooks_removes_only_ours_and_prunes_empties() {
        let installed = apply_tool_hooks(json!({}), &our_tool_script());
        let stripped = strip_tool_hooks(installed, &our_tool_script());
        assert!(
            stripped.get("hooks").is_none(),
            "empty hook arrays and the hooks object are pruned: {stripped}"
        );
    }

    #[test]
    fn stop_hook_command_invokes_instance_script() {
        let cmd = build_stop_hook_command(&our_script());
        // Quoted absolute path: survives spaces in $HOME and needs no shell
        // interpolation — port/secret are read by the script at runtime.
        assert_eq!(cmd, "\"/home/user/.lotus-dev/claude-stop-hook.sh\"");
    }

    #[test]
    fn apply_stop_hook_cleans_legacy_inline_keeps_other_instance_and_user() {
        // The RCA scenario: settings contain (a) a user's own Stop hook,
        // (b) a stale legacy inline curl entry (old Lotus format, either
        // instance), (c) the other instance's new-style script entry.
        // After apply: user kept, other instance kept, exactly one of ours.
        let prior = json!({
            "hooks": {
                "Stop": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/local/bin/notify-me" }] },
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s -X POST \"http://127.0.0.1:1111/v1/hook/stop\" -H \"Authorization: Bearer old\" || true" }] },
                    { "matcher": "*", "hooks": [{ "type": "command", "command": other_script_cmd() }] },
                ],
            },
        });
        let next = apply_stop_hook(prior, &our_script());
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        let cmds: Vec<&str> = stop
            .iter()
            .map(|e| e["hooks"][0]["command"].as_str().unwrap())
            .collect();
        assert!(cmds.contains(&"/usr/local/bin/notify-me"), "user hook kept");
        assert!(cmds.contains(&other_script_cmd()), "other instance kept");
        assert!(
            !cmds.iter().any(|c| c.contains("curl")),
            "legacy inline entry removed (stale by design; self-heals on that instance's next start)"
        );
        assert_eq!(
            cmds.iter()
                .filter(|c| c.contains("/.lotus-dev/claude-stop-hook.sh"))
                .count(),
            1,
            "exactly one entry of ours"
        );
        assert_eq!(stop.len(), 3);
    }

    #[test]
    fn strip_stop_hook_keeps_other_instance_script_entry() {
        let prior = json!({
            "hooks": {
                "Stop": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": other_script_cmd() }] },
                    { "matcher": "*", "hooks": [{ "type": "command", "command": build_stop_hook_command(&our_script()) }] },
                ],
            },
        });
        let next = strip_stop_hook(prior, &our_script());
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], other_script_cmd());
    }

    #[test]
    fn stop_hook_also_serves_usage_limit_failures_and_strips_cleanly() {
        let next = apply_stop_hook(apply_stop_hook(json!({}), &our_script()), &our_script());
        let failure = next["hooks"]["StopFailure"].as_array().unwrap();
        assert_eq!(failure.len(), 1, "re-applying does not duplicate");
        assert_eq!(failure[0]["matcher"], "rate_limit");
        assert_eq!(failure[0]["hooks"][0]["command"], build_stop_hook_command(&our_script()));
        assert_eq!(strip_stop_hook(next, &our_script()), json!({}));
    }

    #[test]
    fn apply_agent_notify_hooks_keeps_other_instance_entries() {
        // Same dev/release coexistence rule for agent-notify: ownership is
        // the full instance script path, not the generic index.mjs suffix.
        let release = std::path::PathBuf::from("/home/user/.lotus/agent-notify/index.mjs");
        let dev = std::path::PathBuf::from("/home/user/.lotus-dev/agent-notify/index.mjs");
        let prior = apply_agent_notify_hooks(json!({}), &release);
        let next = apply_agent_notify_hooks(prior, &dev);
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "release + dev entries coexist");
        // Re-applying the dev entry must not duplicate it or touch release.
        let again = apply_agent_notify_hooks(next, &dev);
        let stop = again["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        let notif = again["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 2);
        assert!(stop.iter().any(|e| e["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("/.lotus/agent-notify/index.mjs")));
    }

    #[test]
    fn strip_agent_notify_hooks_keeps_other_instance_entries() {
        let release = std::path::PathBuf::from("/home/user/.lotus/agent-notify/index.mjs");
        let dev = std::path::PathBuf::from("/home/user/.lotus-dev/agent-notify/index.mjs");
        let both = apply_agent_notify_hooks(apply_agent_notify_hooks(json!({}), &release), &dev);
        let next = strip_agent_notify_hooks(both, &dev);
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1, "only our instance's entry stripped");
        assert!(stop[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("/.lotus/agent-notify/index.mjs"));
    }

    #[test]
    fn apply_stop_hook_inserts_into_empty_settings() {
        let next = apply_stop_hook(json!({}), &our_script());
        let stop = next["hooks"]["Stop"].as_array().expect("Stop array");
        assert_eq!(stop.len(), 1);
        let inner = &stop[0]["hooks"][0];
        assert_eq!(inner["type"], "command");
        assert!(inner["command"]
            .as_str()
            .unwrap()
            .contains("/.lotus-dev/claude-stop-hook.sh"));
    }

    #[test]
    fn apply_stop_hook_preserves_unrelated_top_level_keys() {
        let prior = json!({
            "theme": "dark",
            "permissions": { "allow": ["Read"] },
        });
        let next = apply_stop_hook(prior, &our_script());
        assert_eq!(next["theme"], "dark");
        assert_eq!(next["permissions"]["allow"][0], "Read");
        assert!(next["hooks"]["Stop"].is_array());
    }

    #[test]
    fn sanitize_settings_folds_the_retired_pane_title_model_into_chat() {
        let next = sanitize_settings(json!({ "codespace": { "paneTitleModel": "claude-haiku-4-5", "autoPaneTitles": true } }));
        assert_eq!(next["chat"]["titleModel"], "claude-haiku-4-5");
        assert!(next["codespace"].get("paneTitleModel").is_none());
        assert_eq!(next["codespace"]["autoPaneTitles"], true);

        let kept = sanitize_settings(json!({ "chat": { "titleModel": "claude-sonnet-4-6" }, "codespace": { "paneTitleModel": "claude-haiku-4-5" } }));
        assert_eq!(kept["chat"]["titleModel"], "claude-sonnet-4-6");
        assert!(kept["codespace"].get("paneTitleModel").is_none());
    }

    #[test]
    fn sanitize_settings_moves_legacy_lotus_theme_to_namespaced_key() {
        let next = sanitize_settings(json!({
            "theme": "gruvbox",
            "effortLevel": "medium",
        }));

        assert!(next.get("theme").is_none());
        assert_eq!(next["orchids_theme"], "gruvbox");
        assert_eq!(next["effortLevel"], "medium");
    }

    #[test]
    fn sanitize_settings_moves_retired_gruvbox_modes_to_namespaced_key() {
        for theme in ["gruvbox-dark", "gruvbox-light"] {
            let next = sanitize_settings(json!({ "theme": theme }));

            assert!(next.get("theme").is_none());
            assert_eq!(next["orchids_theme"], theme);
        }
    }

    #[test]
    fn sanitize_settings_preserves_non_lotus_theme_values() {
        let next = sanitize_settings(json!({
            "theme": "dark",
            "effortLevel": "medium",
        }));

        assert_eq!(next["theme"], "dark");
        assert!(next.get("orchids_theme").is_none());
    }

    #[test]
    fn apply_stop_hook_preserves_other_hook_events() {
        let prior = json!({
            "hooks": {
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo pre" }] }],
            },
        });
        let next = apply_stop_hook(prior, &our_script());
        assert!(next["hooks"]["PreToolUse"].is_array());
        assert_eq!(
            next["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "echo pre"
        );
        assert!(next["hooks"]["Stop"].is_array());
    }

    #[test]
    fn apply_stop_hook_preserves_user_authored_stop_entries() {
        let prior = json!({
            "hooks": {
                "Stop": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/local/bin/notify-me" }] },
                ],
            },
        });
        let next = apply_stop_hook(prior, &our_script());
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "user entry retained, lotus entry appended");
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/local/bin/notify-me");
    }

    #[test]
    fn apply_stop_hook_is_idempotent_and_refreshes_legacy_inline_entry() {
        // Old builds wrote an inline curl with a baked port/secret. A new
        // build must replace it with the script entry — exactly one of ours.
        let legacy = json!({
            "hooks": {
                "Stop": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "curl -s -X POST \"http://127.0.0.1:1111/v1/hook/stop\" -H \"Authorization: Bearer old\" || true" }] },
                ],
            },
        });
        let first = apply_stop_hook(legacy, &our_script());
        let second = apply_stop_hook(first, &our_script());
        let stop = second["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1, "must not duplicate Lotus entries");
        let cmd = stop[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("/.lotus-dev/claude-stop-hook.sh"));
        assert!(!cmd.contains("1111"), "legacy baked port gone");
    }

    #[test]
    fn apply_stop_hook_replaces_non_object_settings() {
        let next = apply_stop_hook(json!("garbage"), &our_script());
        assert!(next["hooks"]["Stop"].is_array());
    }

    #[test]
    fn strip_stop_hook_removes_only_lotus_entry() {
        let prior = json!({
            "theme": "dark",
            "hooks": {
                "Stop": [
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "/usr/local/bin/notify-me" }] },
                    { "matcher": "*", "hooks": [{ "type": "command", "command": "curl http://127.0.0.1:1/v1/hook/stop" }] },
                ],
            },
        });
        let next = strip_stop_hook(prior, &our_script());
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/local/bin/notify-me");
        assert_eq!(next["theme"], "dark");
    }

    #[test]
    fn strip_stop_hook_prunes_empty_containers() {
        let prior = apply_stop_hook(json!({}), &our_script());
        let next = strip_stop_hook(prior, &our_script());
        assert!(next.get("hooks").is_none(), "empty hooks container removed");
    }

    #[test]
    fn strip_stop_hook_preserves_agent_notify_entries() {
        // Production scenario: bootstrap installs both the stop-hook script
        // entry AND the agent-notify hook. Tearing down only the stop hook
        // must never strip agent-notify, since their markers are disjoint.
        let prior =
            apply_agent_notify_hooks(apply_stop_hook(json!({}), &our_script()), &fake_script());
        let next = strip_stop_hook(prior, &our_script());
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1, "agent-notify Stop entry survives");
        assert!(stop[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("agent-notify/index.mjs"));
        assert!(
            next["hooks"]["Notification"].is_array(),
            "agent-notify Notification entry untouched"
        );
    }

    #[test]
    fn strip_stop_hook_recognises_legacy_flat_command_entries() {
        // Earlier prototypes wrote `{ "type": "command", "command": "..." }` directly
        // (no inner `hooks` array). Removal must still pick those up.
        let prior = json!({
            "hooks": {
                "Stop": [
                    { "type": "command", "command": "curl http://127.0.0.1:9/v1/hook/stop" },
                ],
            },
        });
        let next = strip_stop_hook(prior, &our_script());
        assert!(next.get("hooks").is_none());
    }

    // ── agent-notify hook tests ───────────────────────────────────────────────

    fn fake_script() -> std::path::PathBuf {
        std::path::PathBuf::from("/home/user/.lotus/agent-notify/index.mjs")
    }

    #[test]
    fn apply_agent_notify_hooks_inserts_stop_and_notification() {
        let next = apply_agent_notify_hooks(json!({}), &fake_script());
        let stop = next["hooks"]["Stop"].as_array().expect("Stop array");
        assert_eq!(stop.len(), 1);
        assert!(stop[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("agent-notify/index.mjs"));
        assert!(stop[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("--event stop"));
        let notif = next["hooks"]["Notification"]
            .as_array()
            .expect("Notification array");
        assert_eq!(notif.len(), 1);
        assert!(notif[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("--event notification"));
    }

    #[test]
    fn apply_agent_notify_hooks_is_idempotent() {
        let first = apply_agent_notify_hooks(json!({}), &fake_script());
        let second = apply_agent_notify_hooks(first, &fake_script());
        let stop = second["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1, "must not duplicate entries");
        let notif = second["hooks"]["Notification"].as_array().unwrap();
        assert_eq!(notif.len(), 1);
    }

    #[test]
    fn apply_agent_notify_hooks_preserves_stop_hook_and_other_events() {
        let prior = apply_stop_hook(json!({}), &our_script());
        let next = apply_agent_notify_hooks(prior, &fake_script());
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        // stop-hook script entry + agent-notify stop hook
        assert_eq!(stop.len(), 2);
        let cmds: Vec<&str> = stop
            .iter()
            .map(|e| e["hooks"][0]["command"].as_str().unwrap())
            .collect();
        assert!(cmds.iter().any(|c| c.contains("claude-stop-hook.sh")));
        assert!(cmds.iter().any(|c| c.contains("agent-notify/index.mjs")));
    }

    #[test]
    fn apply_agent_notify_hooks_preserves_user_authored_hooks() {
        let prior = json!({
            "hooks": {
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo pre" }] }],
            },
        });
        let next = apply_agent_notify_hooks(prior, &fake_script());
        assert!(next["hooks"]["PreToolUse"].is_array());
        assert!(next["hooks"]["Stop"].is_array());
        assert!(next["hooks"]["Notification"].is_array());
    }

    #[test]
    fn strip_agent_notify_hooks_removes_only_its_entries() {
        let with_hooks =
            apply_agent_notify_hooks(apply_stop_hook(json!({}), &our_script()), &fake_script());
        let next = strip_agent_notify_hooks(with_hooks, &fake_script());
        // stop-hook script entry should survive; agent-notify entry gone
        let stop = next["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert!(stop[0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("claude-stop-hook.sh"));
        // Notification array should be pruned entirely
        assert!(next["hooks"].get("Notification").is_none());
    }

    #[test]
    fn strip_agent_notify_hooks_is_noop_on_clean_settings() {
        let prior = json!({ "theme": "dark" });
        let next = strip_agent_notify_hooks(prior, &fake_script());
        assert_eq!(next["theme"], "dark");
        assert!(next.get("hooks").is_none());
    }

    #[test]
    fn markers_do_not_cross_contaminate() {
        // Ensure the two marker strings are disjoint so strip functions never
        // delete each other's entries.
        assert!(
            !LOTUS_HOOK_MARKER.contains(AGENT_NOTIFY_HOOK_MARKER),
            "stop-hook marker must not match agent-notify marker"
        );
        assert!(
            !AGENT_NOTIFY_HOOK_MARKER.contains(LOTUS_HOOK_MARKER),
            "agent-notify marker must not match stop-hook marker"
        );
    }

    // ── Reaching the config dir the agent actually reads ──────────────────────

    const TOOL_SCRIPT: &str = "/home/user/.lotus-dev/claude-tool-hook.sh";
    const NOTIFY_INDEX: &str = "/home/user/.lotus-dev/agent-notify/index.mjs";

    /// The settings a healthy install produces, as the probe will see them.
    fn installed() -> serde_json::Value {
        apply_agent_notify_hooks(
            apply_tool_hooks(json!({}), &std::path::PathBuf::from(TOOL_SCRIPT)),
            &std::path::PathBuf::from(NOTIFY_INDEX),
        )
    }

    #[test]
    fn hooks_are_reachable_when_both_families_are_in_the_file() {
        assert!(settings_carry_our_hooks(
            &installed(),
            TOOL_SCRIPT,
            NOTIFY_INDEX
        ));
    }

    /// The exact shape of the bug this was written for: a ccs profile whose
    /// `settings.json` is a real file with no `hooks` key at all. Measured on
    /// 2026-08-09 — a `claude -p` run under it produced zero hook events.
    #[test]
    fn a_profile_with_no_hooks_at_all_is_not_reachable() {
        let profile = json!({ "tui": {}, "skipDangerousModePermissionPrompt": true });
        assert!(!settings_carry_our_hooks(
            &profile,
            TOOL_SCRIPT,
            NOTIFY_INDEX
        ));
    }

    /// Steps without the reply is still a broken Chat, so half an install fails the
    /// probe. This is the half that loses `last_assistant_message` — the one line the
    /// operator opened the screen for.
    #[test]
    fn tool_hooks_without_the_stop_notify_entry_are_not_enough() {
        let half = apply_tool_hooks(json!({}), &std::path::PathBuf::from(TOOL_SCRIPT));
        assert!(!settings_carry_our_hooks(&half, TOOL_SCRIPT, NOTIFY_INDEX));
    }

    /// And the other half: the reply arrives with no question above it and no steps
    /// under it.
    #[test]
    fn the_stop_notify_entry_alone_is_not_enough() {
        let half = apply_agent_notify_hooks(json!({}), &std::path::PathBuf::from(NOTIFY_INDEX));
        assert!(!settings_carry_our_hooks(&half, TOOL_SCRIPT, NOTIFY_INDEX));
    }

    /// The OTHER instance's entries must not read as ours — otherwise a release build's
    /// hooks would make a dev build report a pipeline it does not own.
    #[test]
    fn another_instances_entries_do_not_count_as_reachable() {
        let theirs = apply_agent_notify_hooks(
            apply_tool_hooks(
                json!({}),
                &std::path::PathBuf::from("/home/user/.lotus/claude-tool-hook.sh"),
            ),
            &std::path::PathBuf::from("/home/user/.lotus/agent-notify/index.mjs"),
        );
        assert!(!settings_carry_our_hooks(
            &theirs,
            TOOL_SCRIPT,
            NOTIFY_INDEX
        ));
    }

    /// The ccs layout that must not be written twice: a profile whose `settings.json`
    /// is a symlink onto the global one. Two spellings, one inode — and a second
    /// read-modify-write would start from the copy the first had already replaced.
    #[cfg(unix)]
    #[test]
    fn a_profile_symlinked_onto_the_global_file_is_written_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global = dir.path().join("settings.json");
        std::fs::write(&global, "{}").expect("write global");
        let profile = dir.path().join("profile-settings.json");
        std::os::unix::fs::symlink(&global, &profile).expect("symlink");

        let kept = dedup_by_canonical_path(vec![global.clone(), profile]);

        assert_eq!(
            kept,
            vec![global],
            "the first spelling wins, the alias goes"
        );
    }

    /// A profile that genuinely reads a different file gets its own entry — that is the
    /// whole point of installing to more than one place.
    #[test]
    fn two_real_files_are_both_kept() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global = dir.path().join("settings.json");
        let profile = dir.path().join("work/settings.json");
        std::fs::write(&global, "{}").expect("write global");
        std::fs::create_dir_all(profile.parent().unwrap()).expect("mkdir");
        std::fs::write(&profile, "{}").expect("write profile");

        let kept = dedup_by_canonical_path(vec![global.clone(), profile.clone()]);

        assert_eq!(kept, vec![global, profile]);
    }

    /// The regression this whole path exists for: the profile file must come out of an
    /// install carrying the entries too, even when it did not exist beforehand.
    ///
    /// Before this, the installer wrote `~/.claude/settings.json` and nothing else, so
    /// on a ccs machine the hooks landed in a file the agent never opens — and Chat on
    /// the phone was blank for every pane, permanently, with no error anywhere.
    #[test]
    fn an_install_reaches_every_settings_file_including_one_that_was_absent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let global = dir.path().join("settings.json");
        std::fs::write(&global, r#"{"theme":"dark"}"#).expect("write global");
        let profile = dir.path().join("work/settings.json");

        write_each(vec![global.clone(), profile.clone()], |current| {
            apply_agent_notify_hooks(
                apply_tool_hooks(current, &std::path::PathBuf::from(TOOL_SCRIPT)),
                &std::path::PathBuf::from(NOTIFY_INDEX),
            )
        })
        .expect("install");

        for path in [&global, &profile] {
            assert!(
                settings_carry_our_hooks(&read_settings_at(path), TOOL_SCRIPT, NOTIFY_INDEX),
                "{} must carry both hook families",
                path.display()
            );
        }
        // And the file that already had content keeps it — this merges, it does not own
        // the operator's settings.
        assert_eq!(read_settings_at(&global)["theme"], "dark");
    }

    /// Two paths that do not exist yet are two files we are about to create, so neither
    /// is dropped for lacking a canonical form.
    #[test]
    fn absent_files_stand_for_themselves() {
        let a = std::path::PathBuf::from("/nowhere/a/settings.json");
        let b = std::path::PathBuf::from("/nowhere/b/settings.json");

        assert_eq!(
            dedup_by_canonical_path(vec![a.clone(), b.clone()]),
            vec![a, b]
        );
    }
}
