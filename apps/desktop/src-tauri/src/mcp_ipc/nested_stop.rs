//! Nested-agent stop attribution for `/v1/hook/stop`.
//!
//! Problem (RCA defect #3): a `claude -p` child spawned INSIDE an agent pane
//! (by the pane agent's Bash tool, or by the user at the pane's shell prompt
//! while an agent runs) inherits `LOTUS_PANE_ID` from the PTY environment.
//! When that nested CLI finishes, its Stop hook posts a "pane done" signal
//! even though the pane's MAIN agent is still mid-turn — waking
//! `wait_cell_idle` early and firing false "agent finished" callouts.
//!
//! Fix: the stop-hook script now reports `agent_pid` (`$PPID` = the CLI that
//! fired the hook). We walk that PID's ancestor chain toward the pane's own
//! child process. The stop is *legit* when the chain from the pane child down
//! to the reporting CLI contains no OTHER agent-CLI process; it is *nested*
//! when some ancestor (up to and including the pane child itself) is an agent
//! CLI — meaning the reporting CLI runs underneath another agent.
//!
//! Second case (2026-11-21): a FOREIGN agent. A detached daemon started from a
//! pane (claude-mem's worker) inherits that pane's `LOTUS_PANE_ID`, reparents
//! to init, and spawns its own CLIs for work from every pane. Their hooks then
//! report turns for a pane they have nothing to do with. A complete chain that
//! reaches init without meeting the pane child is that case, and is dropped.
//!
//! Everything else fails OPEN (signal delivered): missing process info, broken
//! chains, exotic supervisors, non-unix hosts. A dropped legit signal is far
//! worse (agent looks hung, wait stalls to timeout) than an occasional early
//! wake — the pre-existing behavior.

/// Tokens that identify an agent-CLI process on a command line. Matched as a
/// full path segment or standalone word — NOT a bare substring — so
/// `vim claude-notes.md` or `/opt/claudette/bin/tool` never match.
const AGENT_CLI_TOKENS: &[&str] = &[
    "claude",
    "codex",
    "cursor-agent",
    "gemini",
    "opencode",
    "copilot",
];

/// Is this process Claude Code's own session HOST rather than an agent?
///
/// Observed live 2026-11-23 (pane Juno): Claude Code 2.1.330 moved a running session out of the
/// pane's CLI into `claude daemon run --spawned-by {…"pid":<pane cli>}` →
/// `claude --bg-pty-host <sock>` → the session CLI (`--session-id <same id> --resume`). The pane
/// still shows that session; its hooks now come from the grandchild. Counted as agent CLIs, these
/// two made every hook read as "nested" and the pane sat on its last `running` fact for hours.
/// They are plumbing that carries the pane's OWN session, so the walk passes through them.
pub fn command_is_agent_host(command: &str) -> bool {
    let mut words = command.split_whitespace();
    if command
        .split_whitespace()
        .any(|w| matches!(w, "--bg-pty-host" | "bg-pty-host" | "--bg-spare" | "bg-spare"))
    {
        return true;
    }
    // `claude daemon run …`: the binary, then the two subcommand words.
    words.next().is_some_and(|bin| command_is_agent_cli(bin))
        && words.next() == Some("daemon")
        && words.next() == Some("run")
}

/// The pid a Claude daemon names as the CLI that started it (`--spawned-by {…"pid":2227}`).
///
/// A transient daemon can outlive that CLI's parenthood and reparent to launchd; this is the
/// only link left back to the pane then.
fn host_spawned_by(command: &str) -> Option<u32> {
    let json = command.split_once("--spawned-by")?.1;
    let digits = json.split_once("\"pid\":")?.1.trim_start();
    let end = digits.find(|c: char| !c.is_ascii_digit()).unwrap_or(digits.len());
    digits[..end].parse().ok()
}

/// Cap on the ancestor walk. Realistic chains are 2–4 hops
/// (pane shell → wrapper → CLI); 8 gives generous headroom while bounding
/// the `ps` shell-outs a malformed process table could trigger.
const MAX_ANCESTOR_HOPS: usize = 8;

/// True when `command` (a full command line, e.g. from `ps -o command=`)
/// names a known agent CLI. A word matches when the token appears as a
/// standalone word or as a path segment of a word; a trailing `.exe` is
/// tolerated for interop with Windows-style command lines.
///
/// Examples: `/usr/local/bin/claude --resume x` → true (segment),
/// `node /x/claude/cli.js` → true (mid-path segment), `zsh -il` → false,
/// `vim claude-notes.md` → false (segment is `claude-notes.md`, not `claude`).
pub fn command_is_agent_cli(command: &str) -> bool {
    command.split_whitespace().any(|word| {
        word.split(['/', '\\']).any(|segment| {
            let seg = segment.to_ascii_lowercase();
            let seg = seg.strip_suffix(".exe").unwrap_or(&seg);
            AGENT_CLI_TOKENS.iter().any(|token| seg == *token)
        })
    })
}

/// Decide whether a hook signal from `agent_pid` is NOT the pane's own agent's
/// (nested under it, or foreign to the pane), i.e. should be suppressed. `pane_child_pid` is the direct child Lotus spawned
/// into the pane's PTY (the shell, or the agent CLI itself for direct-spawn
/// panes). `proc(pid)` returns `(ppid, command_line)` for a live pid, `None`
/// otherwise — injected so the walk is a pure function testable against fake
/// process tables.
///
/// Rules:
/// - `agent_pid == pane_child_pid` → legit (direct-spawn pane, the pane's own
///   CLI reported). The agent's own command is never inspected — it IS an
///   agent CLI by definition.
/// - Otherwise walk strict ancestors of `agent_pid`. Reaching
///   `pane_child_pid` within [`MAX_ANCESTOR_HOPS`] with NO visited ancestor
///   (pane child included) matching an agent CLI → legit: the reporting CLI
///   hangs off the pane's shell/wrapper chain directly. Any agent-CLI
///   ancestor on that path → nested.
/// - Chain reaches init (pid 1) without meeting the pane child → foreign:
///   suppressed. The chain is complete, so this is evidence, not a guess.
/// - Chain never reaches the pane child for any other reason (cap hit, lookup
///   failure) → fail open: delivered.
pub fn hook_not_from_pane(
    agent_pid: u32,
    pane_child_pid: u32,
    proc: &impl Fn(u32) -> Option<(u32, String)>,
) -> bool {
    if agent_pid == pane_child_pid {
        return false;
    }
    let Some((first_parent, _own_command)) = proc(agent_pid) else {
        return false; // no process info → fail open
    };
    let mut current = first_parent;
    let mut saw_agent_cli_ancestor = false;
    // Only Claude's own host processes sat between the reporter and `current` so far.
    let mut via_host_only = false;
    let mut hops_so_far = 0usize;
    for _ in 0..MAX_ANCESTOR_HOPS {
        if current <= 1 {
            return true; // reached init without meeting the pane child → foreign
        }
        let Some((parent, command)) = proc(current) else {
            return false; // broken chain → fail open
        };
        if current == pane_child_pid {
            // Chain verified: nested iff another agent CLI sits between the
            // reporting CLI and the pane child, or the pane child itself is
            // an agent CLI (direct-spawn pane with a grand-child CLI) — unless
            // the only things in between are Claude's session host, which
            // carries the pane child's own session.
            if via_host_only {
                return false;
            }
            return saw_agent_cli_ancestor || command_is_agent_cli(&command);
        }
        hops_so_far += 1;
        if command_is_agent_host(&command) {
            via_host_only = hops_so_far == 1 || via_host_only;
            // A daemon that reparented to launchd still names the CLI that started it.
            if parent <= 1 {
                if let Some(spawner) = host_spawned_by(&command) {
                    current = spawner;
                    continue;
                }
            }
        } else {
            via_host_only = false;
            if command_is_agent_cli(&command) {
                saw_agent_cli_ancestor = true;
            }
        }
        if parent == current {
            return false; // self-parent loop guard (defensive) → fail open
        }
        current = parent;
    }
    false // cap exhausted → fail open
}

/// Production process lookup: `(ppid, command_line)` for `pid` via
/// `ps -o ppid=,command= -p <pid>`. Shelling out is deliberate — it needs no
/// extra crate, works identically on macOS/Linux, and the walk is bounded by
/// [`MAX_ANCESTOR_HOPS`] so worst case is a handful of ~10ms invocations on
/// an endpoint that is already fire-and-forget. Non-unix hosts and every
/// parse failure return `None`, which the caller treats as fail-open.
#[cfg(unix)]
pub fn proc_lookup(pid: u32) -> Option<(u32, String)> {
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=,command=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let trimmed = line.trim_start();
    let (ppid_str, command) = trimmed.split_once(char::is_whitespace)?;
    let ppid: u32 = ppid_str.trim().parse().ok()?;
    Some((ppid, command.trim().to_string()))
}

#[cfg(not(unix))]
pub fn proc_lookup(_pid: u32) -> Option<(u32, String)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Build an injectable `proc` from `(pid, ppid, command)` rows.
    fn table(rows: &[(u32, u32, &str)]) -> impl Fn(u32) -> Option<(u32, String)> {
        let map: HashMap<u32, (u32, String)> = rows
            .iter()
            .map(|(pid, ppid, cmd)| (*pid, (*ppid, cmd.to_string())))
            .collect();
        move |pid| map.get(&pid).cloned()
    }

    // ── command_is_agent_cli ────────────────────────────────────────────────

    #[test]
    fn agent_cli_matches_path_segment_binary() {
        assert!(command_is_agent_cli("/usr/local/bin/claude --resume x"));
    }

    #[test]
    fn agent_cli_matches_mid_path_segment() {
        assert!(command_is_agent_cli("node /x/claude/cli.js"));
    }

    #[test]
    fn agent_cli_rejects_plain_shell() {
        assert!(!command_is_agent_cli("zsh -il"));
    }

    #[test]
    fn agent_cli_rejects_substring_in_filename() {
        // Word/path-segment boundaries, not bare substring matching.
        assert!(!command_is_agent_cli("vim claude-notes.md"));
    }

    #[test]
    fn agent_cli_matches_hyphenated_token_and_other_clis() {
        assert!(command_is_agent_cli("cursor-agent --headless"));
        assert!(command_is_agent_cli("/opt/tools/codex exec"));
        assert!(command_is_agent_cli("gemini"));
        assert!(!command_is_agent_cli("geminid --daemon"));
    }

    // ── hook_not_from_pane ────────────────────────────────────────────────

    /// Direct spawn: the pane child IS the reporting CLI → legit without any
    /// process-table access at all.
    #[test]
    fn direct_spawn_agent_is_legit() {
        let proc = table(&[]);
        assert!(!hook_not_from_pane(100, 100, &proc));
    }

    /// Classic pane: zsh pane child, user ran `claude` at the prompt.
    #[test]
    fn shell_spawned_agent_is_legit() {
        let proc = table(&[
            (100, 50, "zsh -il"),
            (200, 100, "/usr/local/bin/claude --resume abc"),
        ]);
        assert!(!hook_not_from_pane(200, 100, &proc));
    }

    /// Custom wrapper between shell and CLI (zsh → wrapper.sh → claude).
    #[test]
    fn wrapper_spawned_agent_is_legit() {
        let proc = table(&[
            (100, 50, "zsh -il"),
            (150, 100, "/bin/sh /Users/u/bin/wrapper.sh"),
            (200, 150, "claude"),
        ]);
        assert!(!hook_not_from_pane(200, 100, &proc));
    }

    /// The RCA case: pane agent's Bash tool ran another `claude -p`
    /// (zsh → claude → sh → claude). The inner CLI's stop must be suppressed.
    #[test]
    fn agent_nested_under_pane_agent_is_nested() {
        let proc = table(&[
            (100, 50, "zsh -il"),
            (200, 100, "/usr/local/bin/claude"),
            (300, 200, "sh -c 'claude -p \"summarize\"'"),
            (400, 300, "claude -p summarize"),
        ]);
        assert!(hook_not_from_pane(400, 100, &proc));
    }

    /// Direct-spawn pane (pane child IS claude) with a nested CLI beneath it
    /// (claude → sh → claude): the pane child itself is the agent ancestor.
    #[test]
    fn agent_nested_under_direct_spawn_pane_is_nested() {
        let proc = table(&[
            (100, 50, "claude --resume xyz"),
            (300, 100, "sh -c claude"),
            (400, 300, "claude -p task"),
        ]);
        assert!(hook_not_from_pane(400, 100, &proc));
    }

    /// Broken chain (missing table entry mid-walk) → fail open, treat legit.
    #[test]
    fn broken_chain_fails_open_as_legit() {
        let proc = table(&[
            (400, 300, "claude -p task"),
            // 300 is missing: lookup fails mid-walk.
        ]);
        assert!(!hook_not_from_pane(400, 100, &proc));
    }

    /// Chain that never reaches the pane child within the hop cap → fail open.
    #[test]
    fn cap_exhaustion_fails_open_as_legit() {
        // 20 → 19 → … → 1, pane child 999 never appears.
        let rows: Vec<(u32, u32, String)> = (1..=20)
            .map(|pid| (pid, pid - 1, format!("proc-{pid}")))
            .collect();
        let map: HashMap<u32, (u32, String)> = rows
            .into_iter()
            .map(|(pid, ppid, cmd)| (pid, (ppid, cmd)))
            .collect();
        let proc = move |pid: u32| map.get(&pid).cloned();
        assert!(!hook_not_from_pane(20, 999, &proc));
    }

    /// Observed live 2026-11-21: claude-mem's worker daemon was started from pane Remy,
    /// inherited its LOTUS_PANE_ID, detached to launchd, and spawned a `claude` per
    /// observation. Those CLIs' hooks kept pane Remy "working" after its turn ended.
    /// A chain that reaches init without meeting the pane child is not this pane's.
    #[test]
    fn agent_under_detached_daemon_is_not_from_pane() {
        let proc = table(&[
            (3347, 2032, "/Users/u/.local/share/claude/versions/2.1.330"),
            (13941, 3624, "/Users/u/.local/bin/claude --output-format stream-json"),
            (3624, 1, "bun /x/claude-mem/scripts/worker-service.cjs --daemon"),
            (1, 0, "/sbin/launchd"),
        ]);
        assert!(hook_not_from_pane(13941, 3347, &proc));
    }

    /// The chain `ps` showed live 2026-11-23 for pane Juno (pane child 2227): the session was
    /// moved into Claude's daemon and every Stop since was dropped as nested.
    #[test]
    fn session_moved_into_claude_daemon_is_from_pane() {
        let proc = table(&[
            (2227, 77840, "/Users/u/.local/share/claude/versions/2.1.330 --dangerously-skip-permissions"),
            (20451, 2227, r#"/Users/u/.local/bin/claude daemon run --origin transient --spawned-by {"label":"claude","pid":2227}"#),
            (20491, 20451, "/Users/u/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --bg-pty-host /tmp/cc/pty/1ab9abe6.sock 167 49 -- /x/2.1.330"),
            (20510, 20491, "/Users/u/.local/share/claude/versions/2.1.330 --session-id 1ab9abe6 --fork-session --resume /x.jsonl"),
        ]);
        assert!(!hook_not_from_pane(20510, 2227, &proc));
    }

    /// Same, after the transient daemon reparented to launchd: `--spawned-by` is the link back.
    #[test]
    fn reparented_claude_daemon_follows_spawned_by() {
        let proc = table(&[
            (2227, 77840, "/Users/u/.local/share/claude/versions/2.1.330"),
            (20451, 1, r#"/Users/u/.local/bin/claude daemon run --spawned-by {"label":"claude","pid":2227}"#),
            (20491, 20451, "/x/MacOS/claude --bg-pty-host /tmp/s.sock"),
            (20510, 20491, "/x/versions/2.1.330 --session-id s"),
        ]);
        assert!(!hook_not_from_pane(20510, 2227, &proc));
    }

    /// A host does not launder a real nesting: the pane agent's Bash tool ran `claude -p`, and
    /// THAT session got moved into a daemon. A shell still sits between it and the pane child.
    #[test]
    fn daemon_under_nested_shell_is_still_nested() {
        let proc = table(&[
            (100, 50, "claude --resume xyz"),
            (300, 100, "sh -c claude"),
            (350, 300, "claude daemon run --spawned-by {\"pid\":300}"),
            (360, 350, "claude --bg-pty-host /tmp/s.sock"),
            (400, 360, "claude -p task"),
        ]);
        assert!(hook_not_from_pane(400, 100, &proc));
    }

    #[test]
    fn agent_host_recognises_daemon_and_pty_host_only() {
        assert!(command_is_agent_host("/u/.local/bin/claude daemon run --origin transient"));
        assert!(command_is_agent_host("claude bg-pty-host --bg-pty-host /tmp/x.sock 200 50"));
        assert!(command_is_agent_host("claude bg-spare --bg-spare /tmp/x.claim.sock"));
        assert!(!command_is_agent_host("claude -p 'explain daemon run'"));
        assert!(!command_is_agent_host("/usr/local/bin/claude --resume abc"));
    }

    /// No process info for the reporting pid at all → fail open.
    #[test]
    fn missing_agent_pid_info_fails_open_as_legit() {
        let proc = table(&[]);
        assert!(!hook_not_from_pane(400, 100, &proc));
    }
}
