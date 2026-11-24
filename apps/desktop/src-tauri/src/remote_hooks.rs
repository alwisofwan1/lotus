//! The hook an agent on another machine runs, and how it gets installed there.
//!
//! **Why `sh` and `curl` and nothing else.** The local hook is a node script, and that is fine: this
//! is the machine that ships node with the app. A VPS is not. `packages/host` made this call first
//! — a hook that needs a runtime the target may not have makes agent status depend on an install
//! nobody asked for — and the same reasoning applies here, so the remote script uses only what a
//! machine running an agent CLI certainly has.
//!
//! **What it can and cannot carry.** It reports *that* something happened — the event — and lets the
//! desktop derive status and title from it (`api_server::handlers::hooks::fill_derived_fields`). It
//! does **not** parse Claude's own hook JSON on stdin: doing that without `jq` is not worth the
//! shell, and with `jq` it would be a new requirement. So a remote agent gets headline, turn status
//! and needs-you; what it does not yet get is the message body and tool detail, which the node
//! producer extracts from that stdin. That is a known, bounded gap, not an oversight.
//!
//! Nothing secret is written to the machine: the script reads `LOTUS_API_PORT` / `LOTUS_API_KEY`
//! from its own environment, which the agent's spawn put there for that session only
//! (`ssh-argv.ts`'s `remoteEnvAssignments`).

use serde::Serialize;
use serde_json::{json, Value};

use crate::cli_tools::{run_ssh_shell_command, SshCommandMode, SshToolTarget};
use crate::error::{other, AppError};
use crate::remote_transport::RemoteTransport;

/// The literal path as it appears in settings.json, with `$HOME` already resolved by the shell that
/// installs it. Settings files are read by the CLI, not by a shell, so `$HOME` there would be text.
pub fn remote_hook_path_for(home: &str) -> String {
    format!("{}/.lotus-remote-hook.sh", home.trim_end_matches('/'))
}

/// The hook script itself.
///
/// Three guards before anything else, and each is a real case rather than defensive noise:
/// without `LOTUS_PANE_ID` the report could not be attributed to a pane; without the port or key
/// there is nowhere to send it and nothing to authenticate with. A session started by hand over
/// plain `ssh` has none of them and must stay silent rather than error.
///
/// It always exits 0. A hook that fails the agent it is reporting on would be worse than a hook
/// that says nothing — the local producer holds the same contract.
pub fn build_remote_hook_script() -> String {
    // `cat >/dev/null` drains Claude's JSON on stdin. It is not parsed (see the module docs), but
    // leaving it unread risks the CLI seeing a broken pipe on a hook it just invoked.
    r#"#!/bin/sh
# Lotus remote agent hook — reports a turn to the desktop that started this agent.
# Installed by Lotus. Safe to delete: the agent runs fine without it, just silently.
[ -n "$LOTUS_PANE_ID" ] || exit 0
[ -n "$LOTUS_API_PORT" ] || exit 0
[ -n "$LOTUS_API_KEY" ] || exit 0

_lotus_event="${1:-stop}"
_lotus_now="$(date +%s)000"
cat >/dev/null 2>&1

# JSON-escape: backslash first, then quote, or the escapes escape each other.
_lotus_json() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n'
}

_lotus_payload=$(printf '{"version":1,"agentType":"claude","event":"%s","status":"","title":"","body":"","userPrompt":"","cwd":"%s","pid":%s,"agentPid":%s,"timestamp":%s,"paneId":"%s"}' \
  "$(_lotus_json "$_lotus_event")" \
  "$(_lotus_json "$PWD")" \
  "$$" \
  "${PPID:-0}" \
  "$_lotus_now" \
  "$(_lotus_json "$LOTUS_PANE_ID")")

printf '%s' "$_lotus_payload" | curl -s -m 3 -X POST \
  "http://127.0.0.1:$LOTUS_API_PORT/api/hook/drop" \
  -H "Authorization: Bearer $LOTUS_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- >/dev/null 2>&1

exit 0
"#
    .to_string()
}

/// Which Claude hook events the remote script is wired to, and the event name it reports for each.
///
/// The names on the right are the ones `event_status` knows; the ones on the left are Claude's.
pub const REMOTE_HOOK_EVENTS: [(&str, &str); 4] = [
    ("Stop", "stop"),
    ("Notification", "notification"),
    ("PreToolUse", "tool-pre"),
    ("PostToolUse", "tool-post"),
];

/// Add this desktop's hooks to a remote `settings.json`, leaving everything else alone.
///
/// Pure, and non-destructive by construction: only entries whose command mentions **our** script
/// path are replaced, so a machine that already has its own hooks — or another Lotus instance's —
/// keeps them. Re-running it twice produces the same file, which is what makes installing on every
/// connect safe.
pub fn apply_remote_hooks(mut settings: Value, script_path: &str) -> Value {
    if !settings.is_object() {
        settings = json!({});
    }
    let hooks = settings
        .as_object_mut()
        .expect("settings is an object")
        .entry("hooks".to_string())
        .or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }

    for (claude_event, reported_as) in REMOTE_HOOK_EVENTS {
        let command = format!("\"{script_path}\" {reported_as}");
        // `matcher` selects which tool a hook applies to, so it belongs to tool events only.
        let entry = if claude_event.ends_with("ToolUse") {
            json!({ "matcher": "*", "hooks": [{ "type": "command", "command": command }] })
        } else {
            json!({ "hooks": [{ "type": "command", "command": command }] })
        };

        let slot = hooks
            .as_object_mut()
            .expect("hooks is an object")
            .entry(claude_event.to_string())
            .or_insert_with(|| json!([]));
        if !slot.is_array() {
            *slot = json!([]);
        }
        let arr = slot.as_array_mut().expect("event slot is an array");
        arr.retain(|existing| !mentions_script(existing, script_path));
        arr.push(entry);
    }

    settings
}

/// Remove this desktop's hooks from a remote `settings.json`, and nothing else.
///
/// Emptied arrays and an emptied `hooks` object are pruned, so a machine we stop using is left as
/// close to how we found it as a merge can manage.
#[cfg(test)]
pub fn strip_remote_hooks(mut settings: Value, script_path: &str) -> Value {
    let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return settings;
    };

    for (claude_event, _) in REMOTE_HOOK_EVENTS {
        if let Some(slot) = hooks.get_mut(claude_event).and_then(Value::as_array_mut) {
            slot.retain(|existing| !mentions_script(existing, script_path));
        }
    }
    hooks.retain(|_, value| !value.as_array().map(|a| a.is_empty()).unwrap_or(false));

    if hooks.is_empty() {
        settings
            .as_object_mut()
            .expect("settings is an object")
            .remove("hooks");
    }
    settings
}

// ── Putting it on the machine ─────────────────────────────────────────────────

/// Markers around the install script's real output.
///
/// A remote shell is entitled to greet, print a motd, or emit a prompt escape, and any of that
/// lands on the same stdout as the answer. `fs_browse_ssh` gets away without markers because its
/// lines are self-identifying; a settings file is arbitrary text and cannot be.
const REPORT_BEGIN: &str = "---LOTUS-HOOK-BEGIN---";
const REPORT_END: &str = "---LOTUS-HOOK-END---";

/// The here-doc delimiter used to carry file bodies over ssh without quoting them.
///
/// Quoted (`<<'...'`), so the remote shell expands nothing inside — no `$HOME`, no backtick, no
/// escape. That is what lets the script and the settings JSON travel verbatim.
const HEREDOC: &str = "LOTUS_HOOK_EOF";

/// What an install did, in the terms the caller can act on.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHookInstall {
    /// The absolute path the script now lives at on that machine.
    pub script_path: String,
    /// `false` when settings.json already said exactly this, so nothing was written.
    ///
    /// Reconnecting to a machine that is already set up is the common case, and it costs one round
    /// trip rather than two.
    pub changed: bool,
    /// Claude hook events wired to the script.
    pub events: usize,
}

/// First round trip: put the script there, and bring back `$HOME` and the current settings.
///
/// Reading and writing in the same trip is tempting and wrong — the merge happens in Rust, where it
/// is tested, rather than in a shell that would have to parse JSON without `jq`.
pub(crate) fn build_install_script() -> String {
    let script = build_remote_hook_script();
    format!(
        concat!(
            "mkdir -p \"$HOME/.claude\" || exit 4\n",
            "cat > \"$HOME/.lotus-remote-hook.sh\" <<'{heredoc}'\n",
            "{script}",
            "{heredoc}\n",
            "chmod 700 \"$HOME/.lotus-remote-hook.sh\" || exit 5\n",
            "printf '%s\\n' '{begin}'\n",
            "printf 'HOME\\t%s\\n' \"$HOME\"\n",
            "printf 'SETTINGS\\n'\n",
            // An absent settings.json is the normal first-time case, not a failure: `cat` is allowed
            // to find nothing and the parser reads that as `{}`.
            "cat \"$HOME/.claude/settings.json\" 2>/dev/null\n",
            "printf '\\n%s\\n' '{end}'\n",
        ),
        heredoc = HEREDOC,
        script = script,
        begin = REPORT_BEGIN,
        end = REPORT_END,
    )
}

/// `(home, settings text)` from the install script's stdout.
///
/// Everything outside the markers is shell chatter and is dropped. Empty settings text means the
/// file was not there.
pub(crate) fn parse_install_output(stdout: &str) -> Result<(String, String), AppError> {
    let begin = stdout
        .find(REPORT_BEGIN)
        .ok_or_else(|| other("The machine did not report back after installing the hook."))?;
    let rest = &stdout[begin + REPORT_BEGIN.len()..];
    let end = rest
        .find(REPORT_END)
        .ok_or_else(|| other("The machine's answer was cut off while installing the hook."))?;
    let body = &rest[..end];

    let mut home = String::new();
    let mut settings = String::new();
    let mut in_settings = false;
    for line in body.lines() {
        if in_settings {
            settings.push_str(line);
            settings.push('\n');
            continue;
        }
        if let Some(value) = line.trim_end_matches('\r').strip_prefix("HOME\t") {
            home = value.trim().to_string();
        } else if line.trim_end_matches('\r') == "SETTINGS" {
            in_settings = true;
        }
    }

    if home.is_empty() {
        return Err(other("The machine did not say where its home directory is."));
    }
    Ok((home, settings.trim().to_string()))
}

/// Second round trip: put the merged settings back.
///
/// Written to a sibling temp file and `mv`d into place, so a connection that drops mid-write leaves
/// the old settings intact rather than half a file the CLI cannot read.
pub(crate) fn build_settings_write_script(pretty_json: &str) -> Result<String, AppError> {
    if pretty_json.lines().any(|line| line.trim_end() == HEREDOC) {
        // Unreachable for JSON serde produced, and cheaper to refuse than to reason about.
        return Err(other(
            "Refusing to write settings that would end the transfer early.",
        ));
    }
    Ok(format!(
        concat!(
            "mkdir -p \"$HOME/.claude\" || exit 4\n",
            "cat > \"$HOME/.claude/settings.json.lotus-tmp\" <<'{heredoc}'\n",
            "{body}\n",
            "{heredoc}\n",
            "mv \"$HOME/.claude/settings.json.lotus-tmp\" \"$HOME/.claude/settings.json\" || exit 6\n",
        ),
        heredoc = HEREDOC,
        body = pretty_json,
    ))
}

/// Install the hook on `target` and wire it into that machine's `~/.claude/settings.json`.
///
/// **What it refuses to do.** A settings.json that is not valid JSON is left exactly as it is and
/// reported: the alternative is replacing a file we could not read with one we invented, on someone
/// else's machine. A first-time machine with no settings.json at all is not that case — there is
/// nothing to lose — and gets a fresh one.
pub fn install_remote_hooks(
    target: SshToolTarget,
    transport: Option<&RemoteTransport>,
) -> Result<RemoteHookInstall, AppError> {
    let output = run_ssh_shell_command(
        &target,
        &build_install_script(),
        SshCommandMode::NoTty,
        transport,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(other(format!(
            "Could not install the Lotus hook on {}: {}",
            target.host,
            stderr.trim()
        )));
    }

    let (home, settings_text) = parse_install_output(&String::from_utf8_lossy(&output.stdout))?;
    let script_path = remote_hook_path_for(&home);

    let existing: Value = if settings_text.is_empty() {
        json!({})
    } else {
        serde_json::from_str(&settings_text).map_err(|error| {
            other(format!(
                "{}'s ~/.claude/settings.json is not valid JSON ({error}), so Lotus left it alone.                  Fix or remove that file and reconnect.",
                target.host
            ))
        })?
    };

    let merged = apply_remote_hooks(existing.clone(), &script_path);
    if merged == existing {
        return Ok(RemoteHookInstall {
            script_path,
            changed: false,
            events: REMOTE_HOOK_EVENTS.len(),
        });
    }

    // Pretty, because this is a file its owner may open and edit by hand.
    let pretty = serde_json::to_string_pretty(&merged)
        .map_err(|error| other(format!("Could not serialise settings: {error}")))?;
    let write = run_ssh_shell_command(
        &target,
        &build_settings_write_script(&pretty)?,
        SshCommandMode::NoTty,
        transport,
    )?;
    if !write.status.success() {
        let stderr = String::from_utf8_lossy(&write.stderr);
        return Err(other(format!(
            "Could not write ~/.claude/settings.json on {}: {}",
            target.host,
            stderr.trim()
        )));
    }

    Ok(RemoteHookInstall {
        script_path,
        changed: true,
        events: REMOTE_HOOK_EVENTS.len(),
    })
}

fn mentions_script(entry: &Value, script_path: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|command| command.contains(script_path))
            })
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCRIPT: &str = "/home/alwi/.lotus-remote-hook.sh";

    #[test]
    fn the_script_says_nothing_when_it_was_not_started_by_lotus() {
        let script = build_remote_hook_script();
        for guard in ["$LOTUS_PANE_ID", "$LOTUS_API_PORT", "$LOTUS_API_KEY"] {
            assert!(
                script.contains(&format!("[ -n \"{guard}\" ] || exit 0")),
                "missing guard for {guard}"
            );
        }
    }

    /// A hook that fails the agent it reports on is worse than one that says nothing.
    #[test]
    fn the_script_can_never_fail_the_agent() {
        let script = build_remote_hook_script();
        assert!(script.trim_end().ends_with("exit 0"));
        assert!(script.contains("curl -s -m 3"), "and it never hangs the agent either");
    }

    #[test]
    fn the_script_needs_nothing_but_sh_and_curl() {
        let script = build_remote_hook_script();
        for forbidden in ["node ", "jq ", "python"] {
            assert!(
                !script.contains(forbidden),
                "the whole point is that a VPS may not have {forbidden}"
            );
        }
    }

    #[test]
    fn the_script_leaves_status_for_the_desktop_to_derive() {
        let script = build_remote_hook_script();
        assert!(script.contains(r#""status":"","title":"""#));
    }

    /// Asserting on a shell script's TEXT proves the text. This runs it.
    ///
    /// `sh -n` first (a syntax error would only show up on the remote machine, in a hook whose
    /// output goes to /dev/null), then the script itself against a fake `curl` that keeps whatever
    /// was piped into it — which is the only way to find out whether the JSON it assembles is JSON.
    #[test]
    fn the_script_actually_produces_valid_json() {
        let dir = tempfile::tempdir().expect("temp dir");
        let script = dir.path().join("hook.sh");
        std::fs::write(&script, build_remote_hook_script()).expect("write script");

        let syntax = std::process::Command::new("/bin/sh")
            .arg("-n")
            .arg(&script)
            .output()
            .expect("sh -n");
        assert!(
            syntax.status.success(),
            "generated script is not valid shell: {}",
            String::from_utf8_lossy(&syntax.stderr)
        );

        // A `curl` that records its stdin instead of making a request.
        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin dir");
        let captured = dir.path().join("payload.json");
        std::fs::write(
            bin.join("curl"),
            format!("#!/bin/sh\ncat > {}\n", captured.display()),
        )
        .expect("write fake curl");
        set_executable(&bin.join("curl"));
        set_executable(&script);

        let status = std::process::Command::new("/bin/sh")
            .arg(&script)
            .arg("tool-post")
            .env("PATH", format!("{}:{}", bin.display(), crate::cli_tools::TEST_PATH))
            .env("LOTUS_PANE_ID", "canvas:p1:node-9")
            .env("LOTUS_API_PORT", "9877")
            .env("LOTUS_API_KEY", "secret")
            .current_dir(dir.path())
            .stdin(std::process::Stdio::null())
            .status()
            .expect("run script");
        assert!(status.success(), "the hook must always exit 0");

        let raw = std::fs::read_to_string(&captured).expect("curl captured a payload");
        let value: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|error| panic!("hook did not produce JSON: {error}\n{raw}"));

        assert_eq!(value["version"], 1);
        assert_eq!(value["agentType"], "claude");
        assert_eq!(value["event"], "tool-post");
        assert_eq!(value["paneId"], "canvas:p1:node-9");
        assert_eq!(value["status"], "", "status is the desktop's to derive");
        assert!(value["timestamp"].as_i64().unwrap_or(0) > 1_600_000_000_000);

        // And the desktop turns that into the same status the local producer would.
        let filled = crate::api_server::handlers::hooks::fill_derived_fields(raw.as_bytes());
        let payload = crate::agent_hooks::parse_drop_payload(&filled)
            .expect("what the script sends is a payload the desktop accepts");
        assert_eq!(payload.status, "running");
        assert_eq!(payload.title, "Tool");
    }

    /// A pane id or a path containing a quote must not be able to break the JSON it sits in.
    #[test]
    fn a_hostile_pane_id_cannot_break_the_payload() {
        let dir = tempfile::tempdir().expect("temp dir");
        let script = dir.path().join("hook.sh");
        std::fs::write(&script, build_remote_hook_script()).expect("write script");
        set_executable(&script);

        let bin = dir.path().join("bin");
        std::fs::create_dir_all(&bin).expect("bin dir");
        let captured = dir.path().join("payload.json");
        std::fs::write(
            bin.join("curl"),
            format!("#!/bin/sh\ncat > {}\n", captured.display()),
        )
        .expect("write fake curl");
        set_executable(&bin.join("curl"));

        let nasty = r#"pane"with\quotes"#;
        std::process::Command::new("/bin/sh")
            .arg(&script)
            .env("PATH", format!("{}:{}", bin.display(), crate::cli_tools::TEST_PATH))
            .env("LOTUS_PANE_ID", nasty)
            .env("LOTUS_API_PORT", "9877")
            .env("LOTUS_API_KEY", "secret")
            .current_dir(dir.path())
            .stdin(std::process::Stdio::null())
            .status()
            .expect("run script");

        let raw = std::fs::read_to_string(&captured).expect("captured");
        let value: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|error| panic!("escaping failed: {error}\n{raw}"));
        assert_eq!(value["paneId"], nasty);
    }

    /// The installer, run for real against a throwaway `$HOME`.
    ///
    /// Asserting on the script's text would pass just as happily with an unbalanced here-doc. This
    /// runs it and then looks at the filesystem it left behind.
    fn run_install(home: &std::path::Path) -> String {
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(build_install_script())
            .env("HOME", home)
            .env("PATH", crate::cli_tools::TEST_PATH)
            .output()
            .expect("run install script");
        assert!(
            output.status.success(),
            "install script failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    #[test]
    fn the_installer_really_puts_a_runnable_script_on_the_machine() {
        let dir = tempfile::tempdir().expect("temp dir");
        let home = dir.path();
        let stdout = run_install(home);

        let installed = home.join(".lotus-remote-hook.sh");
        assert_eq!(
            std::fs::read_to_string(&installed).expect("the script is there"),
            build_remote_hook_script(),
            "the here-doc must carry the script across byte for byte"
        );

        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&installed).expect("metadata").permissions().mode();
        assert_eq!(mode & 0o111, 0o100, "settings.json calls it by path, so it must be executable");

        let (reported_home, settings) = parse_install_output(&stdout).expect("a report came back");
        assert_eq!(reported_home, home.to_string_lossy());
        assert!(settings.is_empty(), "a machine with no settings.json says so by saying nothing");
        assert_eq!(
            remote_hook_path_for(&reported_home),
            installed.to_string_lossy(),
            "the path written into settings.json must be the path the file is at"
        );
    }

    #[test]
    fn a_machine_that_already_has_settings_hands_them_over_untouched() {
        let dir = tempfile::tempdir().expect("temp dir");
        let home = dir.path();
        std::fs::create_dir_all(home.join(".claude")).expect("claude dir");
        let original = r#"{"permissions":{"allow":["Bash(ls:*)"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/usr/local/bin/mine.sh"}]}]}}"#;
        std::fs::write(home.join(".claude/settings.json"), original).expect("write settings");

        let (_, settings) = parse_install_output(&run_install(home)).expect("report");
        assert_eq!(
            serde_json::from_str::<Value>(&settings).expect("valid json"),
            serde_json::from_str::<Value>(original).expect("valid json"),
        );
    }

    /// A motd, a `zsh: no job control` warning, a prompt escape — all of it lands on the same
    /// stdout as the answer, and none of it may end up inside the settings we parse.
    #[test]
    fn shell_chatter_around_the_report_is_dropped() {
        let stdout = format!(
            "Welcome to Ubuntu 24.04\n\x1b[1m\n{REPORT_BEGIN}\nHOME\t/home/alwi\nSETTINGS\n{{\"a\":1}}\n{REPORT_END}\nlogout\n"
        );
        let (home, settings) = parse_install_output(&stdout).expect("report");
        assert_eq!(home, "/home/alwi");
        assert_eq!(settings, "{\"a\":1}");
    }

    #[test]
    fn a_machine_that_said_nothing_is_an_error_not_an_empty_install() {
        assert!(parse_install_output("Permission denied\n").is_err());
        assert!(
            parse_install_output(&format!("{REPORT_BEGIN}\nHOME\t/home/alwi\nSETTINGS\n")).is_err(),
            "a truncated answer must not be read as an empty settings file"
        );
        assert!(
            parse_install_output(&format!("{REPORT_BEGIN}\nSETTINGS\n{REPORT_END}")).is_err(),
            "without $HOME there is no path to write into settings.json"
        );
    }

    /// The write half, also run for real: the merged JSON has to survive the trip and land atomically.
    #[test]
    fn the_write_script_really_replaces_the_settings_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let home = dir.path();
        std::fs::create_dir_all(home.join(".claude")).expect("claude dir");
        std::fs::write(home.join(".claude/settings.json"), "{\"old\":true}").expect("seed");

        let merged = apply_remote_hooks(json!({"permissions": {"allow": ["Bash(ls:*)"]}}), SCRIPT);
        let pretty = serde_json::to_string_pretty(&merged).expect("pretty");
        let script = build_settings_write_script(&pretty).expect("script");

        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .env("HOME", home)
            .env("PATH", crate::cli_tools::TEST_PATH)
            .output()
            .expect("run write script");
        assert!(
            output.status.success(),
            "write script failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let written = std::fs::read_to_string(home.join(".claude/settings.json")).expect("settings");
        assert_eq!(
            serde_json::from_str::<Value>(&written).expect("valid json"),
            merged,
            "what lands on disk must be what we merged, quotes and all"
        );
        assert!(
            !home.join(".claude/settings.json.lotus-tmp").exists(),
            "the temp file must not be left behind"
        );
    }

    /// An install run twice writes the same file, which is what makes installing on every connect
    /// safe — and the second run is detected as a no-op before a second round trip is spent.
    #[test]
    fn installing_over_an_install_changes_nothing() {
        let once = apply_remote_hooks(json!({}), SCRIPT);
        let twice = apply_remote_hooks(once.clone(), SCRIPT);
        assert_eq!(once, twice);
    }

    #[test]
    fn a_body_that_could_end_the_transfer_early_is_refused() {
        assert!(build_settings_write_script("{\n  \"x\": 1\n}").is_ok());
        assert!(build_settings_write_script(&format!("{{\n{HEREDOC}\n}}")).is_err());
    }

    fn set_executable(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).expect("chmod");
    }

    #[test]
    fn a_home_becomes_the_absolute_path_settings_json_needs() {
        assert_eq!(remote_hook_path_for("/home/alwi"), SCRIPT);
        assert_eq!(remote_hook_path_for("/home/alwi/"), SCRIPT);
    }

    #[test]
    fn hooks_are_added_for_every_event_we_report() {
        let settings = apply_remote_hooks(json!({}), SCRIPT);
        for (claude_event, reported_as) in REMOTE_HOOK_EVENTS {
            let arr = settings["hooks"][claude_event].as_array().expect(claude_event);
            assert_eq!(arr.len(), 1);
            let command = arr[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(command.contains(SCRIPT));
            assert!(command.ends_with(reported_as));
        }
    }

    #[test]
    fn a_tool_event_carries_a_matcher_and_the_others_do_not() {
        let settings = apply_remote_hooks(json!({}), SCRIPT);
        assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], "*");
        assert!(settings["hooks"]["Stop"][0].get("matcher").is_none());
    }

    /// The machine belongs to the operator, not to us: anything already there survives.
    #[test]
    fn hooks_that_were_already_there_are_left_alone() {
        let existing = json!({
            "model": "opus",
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "/usr/local/bin/their-hook" }] }],
                "SessionStart": [{ "hooks": [{ "type": "command", "command": "echo hi" }] }],
            },
        });
        let settings = apply_remote_hooks(existing, SCRIPT);

        assert_eq!(settings["model"], "opus");
        assert_eq!(settings["hooks"]["SessionStart"][0]["hooks"][0]["command"], "echo hi");
        let stop = settings["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2, "theirs stays, ours is added");
        assert_eq!(stop[0]["hooks"][0]["command"], "/usr/local/bin/their-hook");
    }

    /// Installing on every connect must be safe, so the second run has to produce the first result.
    #[test]
    fn installing_twice_leaves_one_entry_not_two() {
        let once = apply_remote_hooks(json!({}), SCRIPT);
        let twice = apply_remote_hooks(once.clone(), SCRIPT);
        assert_eq!(once, twice);
        assert_eq!(twice["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn stripping_removes_only_ours_and_tidies_up_after_itself() {
        let settings = json!({
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "keep-me" }] }],
            },
        });
        let installed = apply_remote_hooks(settings, SCRIPT);
        let stripped = strip_remote_hooks(installed, SCRIPT);

        let stop = stripped["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], "keep-me");
        assert!(
            stripped["hooks"].get("PreToolUse").is_none(),
            "an emptied event is pruned rather than left as []"
        );
    }

    #[test]
    fn stripping_everything_removes_the_hooks_object_itself() {
        let stripped = strip_remote_hooks(apply_remote_hooks(json!({}), SCRIPT), SCRIPT);
        assert!(stripped.get("hooks").is_none());
    }

    #[test]
    fn a_settings_file_that_is_not_an_object_is_replaced_rather_than_corrupted() {
        let settings = apply_remote_hooks(json!("nonsense"), SCRIPT);
        assert!(settings["hooks"]["Stop"].is_array());
    }
}
