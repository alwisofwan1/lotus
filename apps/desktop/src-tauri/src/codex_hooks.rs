//! Codex hook registration — `~/.codex/hooks.json`.
//!
//! **Why this exists.** Codex had exactly one signal into Lotus: the `notify` slot in
//! `~/.codex/config.toml`, which fires only on `agent-turn-complete` and carries
//! `{"pane_id"}` and nothing else (`mcp_config::build_codex_notify_script`). Its handler
//! (`mcp_ipc::hook_stop`) records pane turn-state and never touches the transcript store,
//! so **Chat mode showed zero lines for every Codex cell** — `provider_reports_steps`
//! admitted as much by answering `true` for `claude` alone.
//!
//! Codex 0.147 has a full hook system with the same shape as Claude's, and a diagnostic
//! capture against a live turn (`plans/session-history-hardening/issues/02`) showed the
//! payload is close enough to Claude's that `payload-extractors.mjs` reads it **unmodified**:
//! `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`, `last_assistant_message`
//! on `Stop`, `prompt` on `UserPromptSubmit`. So this module registers the *existing*
//! agent-notify pipeline against Codex rather than building anything new.
//!
//! **The `notify` slot stays.** It is the fastest turn-end signal (no node process, no
//! fs-watcher debounce) and it is what wakes an in-flight `wait_cell_idle`
//! (`mcp_ipc.rs:3549-3551`). This is the richer source, not the faster one; the two run
//! side by side.
//!
//! ## What this module deliberately does NOT do
//!
//! **It never writes `[hooks.state]`** — Codex's hook-trust store in `config.toml`. Decided
//! 2026-08-13, and the strongest reason is practical rather than principled: the hash
//! formula is not known (the three installed hashes differ from each other even though
//! their command is byte-identical, so it binds event context as well as content, and no
//! candidate of ours reproduced one). A hash computed wrong means the hook never runs and
//! Lotus gets **no signal at all** — Chat stays empty exactly as before, with nothing to
//! debug. Depending on a reverse-engineered private format across CLI versions buys a
//! smoother install for a silent-failure mode.
//!
//! The principled reason stands behind it: `--dangerously-bypass-hook-trust` calls itself
//! DANGEROUS, and Lotus — which launches agents with `--dangerously-skip-permissions` —
//! is the last program that should quietly widen a trust boundary on the operator's behalf.
//!
//! So [`trust_state`] *reads* that store and reports what it finds, and the UI says so once.
//! Silence is not an option: a hook registered but never trusted looks identical to no hook
//! at all, and this repo has already shipped that failure twice (`output-tail.ts` swallowing
//! a 404, and `pty/scrollback.rs` never being compiled in).

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::mcp_config::{
    agent_notify_index_path, atomic_write, codex_config_path, lotus_dir, McpConfigError,
};

/// Codex hook event → the `--event` name the agent-notify pipeline already understands.
///
/// Every right-hand value is an existing key in `event-mapping.mjs`'s `EVENT_TABLE`; none
/// were invented here. `PostToolUse` maps to `tool-post` and `run-hook.mjs` promotes it to
/// `tool-post-failed` from the payload, which is why failure is absent from this table.
///
/// `permission_request`, `subagent_start`/`subagent_stop`, and `pre_compact`/`post_compact`
/// exist in the Codex event enum but are **not** registered yet: their payloads have not
/// been captured, and registering an event whose shape is unknown would put guesses into
/// the transcript. `permission_request` is the one worth chasing next — Lotus infers
/// "needs permission" for Claude from a `Notification` plus a terminal-tail scrape, and
/// Codex reports it as a first-class event.
pub const CODEX_HOOK_EVENTS: [(&str, &str); 6] = [
    ("PreToolUse", "tool-pre"),
    ("PostToolUse", "tool-post"),
    ("Stop", "stop"),
    ("UserPromptSubmit", "prompt-submit"),
    ("SessionStart", "session-start"),
    ("SessionEnd", "session-end"),
];

/// Filename of this instance's Codex hook script.
const LOTUS_CODEX_HOOK_NAME: &str = "codex-hook.sh";

/// Absolute path of this instance's Codex hook script.
///
/// Instance-unique via [`lotus_dir`] (`~/.lotus` vs `~/.lotus-dev`), which is also what
/// makes ownership decidable: every entry this module adds or removes is matched on this
/// path, so a dev build and a release build never evict each other's registration. Same
/// rule `settings::apply_tool_hooks` uses for Claude.
pub fn codex_hook_script_path() -> Result<PathBuf, McpConfigError> {
    Ok(lotus_dir()?.join(LOTUS_CODEX_HOOK_NAME))
}

/// `~/.codex/hooks.json` — sibling of `config.toml`, resolved through the same helper so
/// a `CODEX_HOME` override keeps both in step.
pub fn codex_hooks_path() -> Result<PathBuf, McpConfigError> {
    Ok(codex_config_path()?
        .parent()
        .ok_or(McpConfigError::NoHome)?
        .join("hooks.json"))
}

/// The shell wrapper Codex invokes, one argument: the Codex event name.
///
/// Three things it must get right, each learned the hard way somewhere in this repo:
///
/// 1. **Exit 0, always.** A non-zero `PreToolUse` hook BLOCKS the tool call. The Claude
///    twin carries the same warning for the same reason.
/// 2. **Return fast.** Codex clamps hook timeouts per event (observed:
///    `clamping SessionEnd hook timeout to 3s`), so the `timeout` written into
///    `hooks.json` is a request, not a guarantee. The work here is one `exec` of node
///    with stdin inherited; nothing is read or parsed in shell.
/// 3. **Leave non-Lotus sessions alone.** This file is global, so it fires for every Codex
///    session on the machine — including ones Lotus never spawned. The `LOTUS_PANE_ID`
///    guard makes those cost a single shell spawn and exit.
///
/// The payload arrives as JSON on **stdin** (verified by capture — unlike the `notify`
/// slot, which passes it as the final argv argument). `node` inherits stdin, so nothing
/// here has to touch it.
pub fn build_codex_hook_script(drop_dir: &Path, notify_index: &Path) -> String {
    let mut cases = String::new();
    for (codex_event, lotus_event) in CODEX_HOOK_EVENTS {
        cases.push_str(&format!("{codex_event}) EV={lotus_event} ;; "));
    }
    format!(
        "#!/bin/sh\n\
         # Lotus Codex hook — managed by Lotus, do not edit manually.\n\
         # Fires for EVERY Codex session on this machine; the guard keeps that cheap for\n\
         # sessions that are not Lotus panes: one shell spawn and exit, no stdin read.\n\
         [ -n \"$LOTUS_PANE_ID\" ] || exit 0\n\
         # Codex event name -> the event name agent-notify already understands. An event we\n\
         # did not register is ignored rather than guessed at.\n\
         case \"$1\" in {cases}*) exit 0 ;; esac\n\
         # Payload is JSON on stdin (capture-verified); node inherits it.\n\
         # Failure is swallowed and the exit is always 0: a non-zero PreToolUse hook BLOCKS\n\
         # the tool call.\n\
         LOTUS_AGENT_PID=\"$PPID\" node \"{notify_index}\" \\\n  \
         --agent codex --event \"$EV\" --drop-dir \"{drop_dir}\" 2>/dev/null || true\n\
         exit 0\n",
        cases = cases,
        drop_dir = drop_dir.display(),
        notify_index = notify_index.display()
    )
}

/// Write this instance's Codex hook script (mode 0755). Idempotent — re-running on app
/// restart refreshes the body, so script fixes ship without the user doing anything.
pub fn install_codex_hook_script() -> Result<PathBuf, McpConfigError> {
    let script_path = codex_hook_script_path()?;
    if let Some(parent) = script_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let drop_dir = crate::agent_hooks::default_drop_dir().ok_or(McpConfigError::NoHome)?;
    let notify_index = agent_notify_index_path()?;
    std::fs::write(
        &script_path,
        build_codex_hook_script(&drop_dir, &notify_index),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path)?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms)?;
    }
    Ok(script_path)
}

/// The `hooks.json` command for one event: the script path plus the Codex event name.
pub fn build_codex_hook_command(script_path: &Path, codex_event: &str) -> String {
    format!("\"{}\" {}", script_path.display(), codex_event)
}

/// Timeout written per entry. Ten seconds is a ceiling, not a target — the script returns
/// in milliseconds — and Codex clamps it further per event anyway.
const HOOK_TIMEOUT_SECS: u64 = 10;

/// Pure: add THIS instance's entries to a parsed `hooks.json`, leaving every other entry
/// exactly where it was.
///
/// **Append, never replace, and never insert.** Other applications register here too — a
/// dev machine already had `Heard.app` on all three tool events — and the whole install is
/// worthless if it makes someone else's hook go quiet. Appending at the end also keeps the
/// positional trust keys of existing entries (`path:event:group:hook`) pointing at the same
/// commands they pointed at before, so nobody is re-prompted because of us.
///
/// Idempotent by ownership: entries whose command mentions our script path are dropped
/// first, so re-running on every app start refreshes rather than duplicates.
pub fn apply_codex_hooks(mut root: Value, script_path: &Path) -> Value {
    if !root.is_object() {
        root = json!({});
    }
    let script_str = script_path.display().to_string();
    let hooks = root
        .as_object_mut()
        .expect("root is an object")
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }

    for (codex_event, _) in CODEX_HOOK_EVENTS {
        // Codex caps synchronous SessionEnd hooks at 3s, including during shutdown.
        // Requesting more only emits a warning; other events retain their budget.
        let timeout = if codex_event == "SessionEnd" {
            3
        } else {
            HOOK_TIMEOUT_SECS
        };
        let entry = json!({
            "hooks": [{
                "type": "command",
                "command": build_codex_hook_command(script_path, codex_event),
                "timeout": timeout,
            }]
        });
        let slot = hooks
            .as_object_mut()
            .expect("hooks is an object")
            .entry(codex_event.to_string())
            .or_insert_with(|| json!([]));
        if !slot.is_array() {
            *slot = json!([]);
        }
        let arr = slot.as_array_mut().expect("event slot is array");
        arr.retain(|g| !group_mentions(g, &script_str));
        arr.push(entry);
    }

    root
}

/// Pure: strip THIS instance's entries. The other instance's registration and every other
/// application's survive; emptied arrays and an emptied `hooks` object are pruned so the
/// file stays tidy.
pub fn strip_codex_hooks(mut root: Value, script_path: &Path) -> Value {
    let Some(obj) = root.as_object_mut() else {
        return root;
    };
    let script_str = script_path.display().to_string();
    let prune = if let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (codex_event, _) in CODEX_HOOK_EVENTS {
            if let Some(arr) = hooks.get_mut(codex_event).and_then(|s| s.as_array_mut()) {
                arr.retain(|g| !group_mentions(g, &script_str));
                if arr.is_empty() {
                    hooks.remove(codex_event);
                }
            }
        }
        hooks.is_empty()
    } else {
        false
    };
    if prune {
        obj.remove("hooks");
    }
    root
}

/// Whether a matcher-group contains a command mentioning `needle`.
fn group_mentions(group: &Value, needle: &str) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .is_some_and(|c| c.contains(needle))
            })
        })
        .unwrap_or(false)
}

/// Serialize for a file we did not create.
///
/// Pretty-printed **with a trailing newline**, because `hooks.json` is someone else's file
/// and ours is not the only tool that reads or diffs it. `serde_json` emits none, which was
/// caught by an end-to-end install/uninstall round trip: the content came back correct but
/// the file had lost the newline it arrived with.
///
/// What is **not** preserved is top-level key order — `serde_json::Value` is a `BTreeMap`,
/// so keys come back alphabetized. Accepted rather than fixed: it is what every other
/// config this app touches already does (`~/.claude.json`, `settings.json`), JSON objects
/// are unordered by definition, and it moves nothing that matters. In particular it cannot
/// disturb Codex's trust keys, which are `<path>:<event>:<group>:<hook>` — the event is
/// named, and the group index counts within that event's own array.
fn to_pretty_bytes(value: &Value) -> Result<Vec<u8>, McpConfigError> {
    let mut body = serde_json::to_vec_pretty(value)?;
    body.push(b'\n');
    Ok(body)
}

/// Register this instance's hooks, creating `hooks.json` if it does not exist.
pub fn install_codex_hooks() -> Result<PathBuf, McpConfigError> {
    let script_path = install_codex_hook_script()?;
    let path = codex_hooks_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let root = read_json_object_or_empty(&path)?;
    let next = apply_codex_hooks(root, &script_path);
    atomic_write(&path, &to_pretty_bytes(&next)?)?;
    Ok(path)
}

/// Remove this instance's hooks. No-op when the file is absent.
pub fn uninstall_codex_hooks() -> Result<(), McpConfigError> {
    let script_path = codex_hook_script_path()?;
    let path = codex_hooks_path()?;
    if !path.exists() {
        return Ok(());
    }
    let root = read_json_object_or_empty(&path)?;
    let next = strip_codex_hooks(root, &script_path);
    atomic_write(&path, &to_pretty_bytes(&next)?)?;
    let _ = std::fs::remove_file(script_path);
    Ok(())
}

/// Read a JSON object, or an empty one when the file is missing, blank, or not an object.
///
/// Deliberately tolerant of a malformed file *shape* but **not** of malformed JSON: a
/// parse error propagates. `hooks.json` is shared, and silently replacing a file we merely
/// failed to parse would delete another application's registration.
fn read_json_object_or_empty(path: &Path) -> Result<Value, McpConfigError> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(json!({})),
        Ok(text) => {
            let parsed: Value = serde_json::from_str(&text)?;
            Ok(if parsed.is_object() {
                parsed
            } else {
                json!({})
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(err) => Err(err.into()),
    }
}

/// What Codex's trust store says about this instance's registration.
///
/// Three answers, and the middle one is why this type is not a `bool`: a hook that is
/// registered but not yet trusted produces exactly the same observable behaviour as no
/// hook at all — silence — and the operator can only fix what they are told about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexHookTrust {
    /// Not registered in `hooks.json` at all.
    NotInstalled,
    /// Registered, but Codex has no trust record for it — it will not run until the
    /// operator approves it once.
    AwaitingApproval,
    /// Registered and carrying a trust record.
    Trusted,
}

/// Read `[hooks.state]` from a `config.toml` body and report this instance's standing.
///
/// Pure, and takes the file bodies rather than reading them, so the parsing rule is
/// testable without a home directory.
///
/// **Deliberately not a TOML parse.** The only thing needed is whether a key exists whose
/// group index matches where our entry sits, and `config.toml` here is a flat file of
/// `[hooks.state."<path>:<event>:<group>:<hook>"]` headers. Pulling in a full parse to
/// answer an existence question would also mean re-serializing a file this module has
/// decided never to write.
pub fn trust_state(hooks_json: &Value, config_toml: &str, script_path: &Path) -> CodexHookTrust {
    let script_str = script_path.display().to_string();
    let Some(hooks) = hooks_json.get("hooks").and_then(|h| h.as_object()) else {
        return CodexHookTrust::NotInstalled;
    };

    let mut found_any = false;
    for (codex_event, _) in CODEX_HOOK_EVENTS {
        let Some(arr) = hooks.get(codex_event).and_then(|s| s.as_array()) else {
            continue;
        };
        let Some(index) = arr.iter().position(|g| group_mentions(g, &script_str)) else {
            continue;
        };
        found_any = true;
        // Trust keys use snake_case for the event while `hooks.json` uses CamelCase.
        let key_fragment = format!(":{}:{}:0\"", to_snake(codex_event), index);
        if !config_toml.contains(&key_fragment) {
            return CodexHookTrust::AwaitingApproval;
        }
    }

    if found_any {
        CodexHookTrust::Trusted
    } else {
        CodexHookTrust::NotInstalled
    }
}

/// `PreToolUse` → `pre_tool_use`. Matches the casing Codex uses for trust keys.
fn to_snake(camel: &str) -> String {
    let mut out = String::with_capacity(camel.len() + 4);
    for (i, ch) in camel.char_indices() {
        if ch.is_ascii_uppercase() {
            if i != 0 {
                out.push('_');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Convenience: read both files from disk and report standing. `None` when the paths
/// cannot be resolved at all.
pub fn trust_state_on_disk() -> Option<CodexHookTrust> {
    let script_path = codex_hook_script_path().ok()?;
    let hooks = read_json_object_or_empty(&codex_hooks_path().ok()?).unwrap_or_else(|_| json!({}));
    let config = std::fs::read_to_string(codex_config_path().ok()?).unwrap_or_default();
    Some(trust_state(&hooks, &config, &script_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn script() -> PathBuf {
        PathBuf::from("/Users/x/.lotus/codex-hook.sh")
    }

    fn other_app_group() -> Value {
        json!({
            "hooks": [{
                "type": "command",
                "command": "/Applications/Heard.app/Contents/MacOS/python -m heard.hook codex",
                "timeout": 60,
            }]
        })
    }

    fn with_other_app() -> Value {
        json!({
            "hooks": {
                "Stop": [other_app_group()],
                "PreToolUse": [other_app_group()],
                "PostToolUse": [other_app_group()],
            }
        })
    }

    #[test]
    fn registers_every_event_the_pipeline_understands() {
        let out = apply_codex_hooks(json!({}), &script());
        let hooks = out["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), CODEX_HOOK_EVENTS.len());
        for (codex_event, _) in CODEX_HOOK_EVENTS {
            let arr = hooks[codex_event].as_array().unwrap();
            assert_eq!(arr.len(), 1, "{codex_event}");
            let cmd = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(cmd.contains("codex-hook.sh"), "{cmd}");
            assert!(
                cmd.ends_with(codex_event),
                "event must be the argument: {cmd}"
            );
        }
    }

    #[test]
    fn reinstall_migrates_session_end_timeout_without_changing_other_hooks() {
        let mut before = apply_codex_hooks(with_other_app(), &script());
        before["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"] = json!(10);
        let mut expected = before.clone();
        expected["hooks"]["SessionEnd"][0]["hooks"][0]["timeout"] = json!(3);

        let after = apply_codex_hooks(before, &script());
        assert_eq!(after, expected);
        assert_eq!(apply_codex_hooks(after.clone(), &script()), after);
    }

    /// The failure that made `codex-notify-fallback.sh` necessary, in its new form.
    #[test]
    fn another_applications_hook_survives_installation() {
        let out = apply_codex_hooks(with_other_app(), &script());
        for event in ["Stop", "PreToolUse", "PostToolUse"] {
            let arr = out["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 2, "{event}: ours appended, theirs kept");
            assert!(
                arr[0]["hooks"][0]["command"]
                    .as_str()
                    .unwrap()
                    .contains("heard.hook"),
                "{event}: theirs must stay FIRST so its trust key index does not move"
            );
        }
    }

    #[test]
    fn installing_twice_does_not_duplicate() {
        let once = apply_codex_hooks(with_other_app(), &script());
        let twice = apply_codex_hooks(once.clone(), &script());
        assert_eq!(once, twice);
    }

    #[test]
    fn a_second_instance_does_not_evict_the_first() {
        let dev = PathBuf::from("/Users/x/.lotus-dev/codex-hook.sh");
        let out = apply_codex_hooks(apply_codex_hooks(json!({}), &script()), &dev);
        let arr = out["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(arr.len(), 2, "release and dev registrations coexist");
    }

    #[test]
    fn uninstall_removes_only_ours() {
        let installed = apply_codex_hooks(with_other_app(), &script());
        let out = strip_codex_hooks(installed, &script());
        for event in ["Stop", "PreToolUse", "PostToolUse"] {
            let arr = out["hooks"][event].as_array().unwrap();
            assert_eq!(arr.len(), 1);
            assert!(arr[0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("heard.hook"));
        }
        // Events only we registered are pruned rather than left as empty arrays.
        assert!(out["hooks"].get("SessionStart").is_none());
    }

    #[test]
    fn install_then_uninstall_restores_the_original_file() {
        let before = with_other_app();
        let after = strip_codex_hooks(apply_codex_hooks(before.clone(), &script()), &script());
        assert_eq!(before, after);
    }

    #[test]
    fn uninstalling_from_a_file_only_we_wrote_leaves_no_empty_scaffolding() {
        let out = strip_codex_hooks(apply_codex_hooks(json!({}), &script()), &script());
        assert_eq!(out, json!({}), "no orphaned `hooks: {{}}`");
    }

    #[test]
    fn a_file_that_is_not_an_object_is_replaced_rather_than_crashing() {
        let out = apply_codex_hooks(json!([1, 2, 3]), &script());
        assert!(out["hooks"]["Stop"].is_array());
    }

    #[test]
    fn a_file_we_did_not_create_keeps_its_trailing_newline() {
        let body = to_pretty_bytes(&apply_codex_hooks(json!({}), &script())).unwrap();
        assert_eq!(body.last(), Some(&b'\n'), "config files end with a newline");
    }

    #[test]
    fn trust_reports_not_installed_before_registration() {
        assert_eq!(
            trust_state(&json!({}), "", &script()),
            CodexHookTrust::NotInstalled
        );
        assert_eq!(
            trust_state(&with_other_app(), "", &script()),
            CodexHookTrust::NotInstalled,
            "another app's registration is not ours"
        );
    }

    #[test]
    fn trust_reports_awaiting_approval_when_the_store_has_no_record() {
        let installed = apply_codex_hooks(with_other_app(), &script());
        let config = r#"
[hooks.state."/Users/x/.codex/hooks.json:stop:0:0"]
trusted_hash = "sha256:aaa"
"#;
        assert_eq!(
            trust_state(&installed, config, &script()),
            CodexHookTrust::AwaitingApproval,
            "index 0 is the other app; ours sits at 1 and has no record"
        );
    }

    #[test]
    fn trust_reports_trusted_once_every_registered_event_has_a_record() {
        let installed = apply_codex_hooks(json!({}), &script());
        let mut config = String::new();
        for (codex_event, _) in CODEX_HOOK_EVENTS {
            config.push_str(&format!(
                "[hooks.state.\"/Users/x/.codex/hooks.json:{}:0:0\"]\ntrusted_hash = \"sha256:a\"\n",
                to_snake(codex_event)
            ));
        }
        assert_eq!(
            trust_state(&installed, &config, &script()),
            CodexHookTrust::Trusted
        );
    }

    /// One missing record is enough: a half-trusted registration reports steps for some
    /// events and silently drops the rest, which reads as a broken transcript rather than
    /// an unapproved hook.
    #[test]
    fn one_missing_record_is_not_trusted() {
        let installed = apply_codex_hooks(json!({}), &script());
        let mut config = String::new();
        for (codex_event, _) in CODEX_HOOK_EVENTS.iter().skip(1) {
            config.push_str(&format!(
                "[hooks.state.\"/Users/x/.codex/hooks.json:{}:0:0\"]\ntrusted_hash = \"sha256:a\"\n",
                to_snake(codex_event)
            ));
        }
        assert_eq!(
            trust_state(&installed, &config, &script()),
            CodexHookTrust::AwaitingApproval
        );
    }

    #[test]
    fn snake_case_matches_the_trust_key_vocabulary() {
        assert_eq!(to_snake("PreToolUse"), "pre_tool_use");
        assert_eq!(to_snake("PostToolUse"), "post_tool_use");
        assert_eq!(to_snake("Stop"), "stop");
        assert_eq!(to_snake("UserPromptSubmit"), "user_prompt_submit");
        assert_eq!(to_snake("SessionStart"), "session_start");
        assert_eq!(to_snake("SessionEnd"), "session_end");
    }

    #[test]
    fn the_script_guards_on_pane_id_and_always_exits_zero() {
        let body = build_codex_hook_script(
            Path::new("/Users/x/.lotus/agent-hooks/global"),
            Path::new("/Users/x/.lotus/agent-notify/index.mjs"),
        );
        assert!(body.contains("[ -n \"$LOTUS_PANE_ID\" ] || exit 0"));
        assert!(body.contains("--agent codex"));
        assert!(body.trim_end().ends_with("exit 0"));
        assert!(
            body.contains("|| true"),
            "node failure must not fail the hook"
        );
    }

    /// Every event we register must translate to a name the pipeline already knows, and
    /// an event we did not register must fall through without inventing one.
    #[test]
    fn the_script_maps_each_event_and_ignores_the_rest() {
        let body = build_codex_hook_script(Path::new("/d"), Path::new("/i"));
        for (codex_event, lotus_event) in CODEX_HOOK_EVENTS {
            assert!(
                body.contains(&format!("{codex_event}) EV={lotus_event} ;;")),
                "{codex_event} -> {lotus_event}"
            );
        }
        assert!(body.contains("*) exit 0 ;;"), "unknown event is ignored");
    }
}

#[cfg(test)]
mod script_shape_tests {
    use super::*;
    use std::io::Write;

    /// The script is generated by string formatting, so a malformed `case` would ship as a
    /// hook that fails on every tool call. `sh -n` parses without executing.
    #[test]
    fn the_generated_script_is_valid_shell() {
        let body = build_codex_hook_script(
            Path::new("/tmp/lotus-drop"),
            Path::new("/tmp/lotus/agent-notify/index.mjs"),
        );
        let mut file = tempfile::NamedTempFile::new().expect("temp file");
        file.write_all(body.as_bytes()).expect("write");
        let out = std::process::Command::new("sh")
            .arg("-n")
            .arg(file.path())
            .output()
            .expect("run sh -n");
        assert!(
            out.status.success(),
            "sh -n rejected the generated script:\n{}\n--- script ---\n{body}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
}

/// End-to-end check against a real Codex CLI. `#[ignore]`d because it writes to the
/// operator's `~/.codex/hooks.json` and needs `codex` on PATH — but it is the only thing
/// that proves the registration actually produces a transcript entry, so it is kept in the
/// tree rather than done once by hand and forgotten.
///
/// Run: `cargo test --lib codex_hooks_e2e -- --ignored --nocapture`
/// then drive one Codex turn with `LOTUS_PANE_ID` set, then check the drop directory.
#[cfg(test)]
mod codex_hooks_e2e {
    use super::*;

    #[test]
    #[ignore = "writes to ~/.codex/hooks.json; run explicitly"]
    fn install_for_real() {
        let path = install_codex_hooks().expect("install");
        println!("hooks.json: {}", path.display());
        println!(
            "script    : {}",
            codex_hook_script_path().unwrap().display()
        );
        println!("drop dir  : {:?}", crate::agent_hooks::default_drop_dir());
        println!("trust     : {:?}", trust_state_on_disk());
    }

    #[test]
    #[ignore = "writes to ~/.codex/hooks.json; run explicitly"]
    fn uninstall_for_real() {
        uninstall_codex_hooks().expect("uninstall");
        println!("uninstalled; trust now {:?}", trust_state_on_disk());
    }
}
