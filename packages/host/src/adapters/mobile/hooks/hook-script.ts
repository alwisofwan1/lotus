/**
 * The shell hook a standalone host installs, and the rules that keep it harmless.
 *
 * **No node.** ADR-F ships this host as a single binary with no node on the target; a hook that
 * needed node would make TUI permission depend on the runtime the artifact deliberately dropped.
 * This needs `sh` and `curl`, which a VPS has. It is the same shape the desktop's Stop hook has
 * used since `plans/honest-agent-status/` — the drop-file producer stays for the rich payload
 * Fase 3 needs (`hooks/watcher.ts`), and both land in one turn map.
 *
 * **It must never fail.** A `PreToolUse` hook exiting non-zero BLOCKS the tool call — the ADR-8
 * spike used exactly that to implement gating. So every path ends `exit 0`, curl's status is
 * discarded, and stderr goes nowhere.
 *
 * **It must be nearly free for sessions that are not ours.** The hook is registered in the GLOBAL
 * `~/.claude/settings.json`, so it fires in every Claude session on the machine — including ones
 * a person started by hand in their own terminal. The `LOTUS_PANE_ID` guard is what keeps that to
 * one shell spawn and an exit: no file read, no curl, no stdin.
 */

/** Events Claude fires that this host has a status for. Anything else exits at the `case`. */
export interface HookScriptOptions {
  /** Where the host advertises its port and secret — `<state dir>/lotus-mcp-ipc.json`. */
  discoveryPath: string;
}

export function buildClaudeHookScript(opts: HookScriptOptions): string {
  return `#!/bin/sh
# Lotus agent hook — managed by Lotus, do not edit manually.
#
# Fires in EVERY Claude session on this machine, so the guard comes first: a session that is not
# a Lotus pane costs one shell spawn and an exit.
[ -n "$LOTUS_PANE_ID" ] || exit 0

# The phase names the status. Anything unmapped is not a turn fact and is dropped here rather
# than sent, so the host never has to reason about a status nobody defined.
case "$1" in
  notification|needs-input) STATUS=needs-input ;;
  stop|agent-response|after-agent) STATUS=idle ;;
  error) STATUS=error ;;
  session-start|prompt-submit|before-agent|user|post-tool) STATUS=running ;;
  session-end) STATUS=ended ;;
  *) exit 0 ;;
esac

# Read the host's port and secret at fire time, never at install time: the port is OS-assigned
# and changes on every restart, so a value baked into this file would be stale by the next one.
IPC="${opts.discoveryPath}"
[ -r "$IPC" ] || exit 0
PORT=$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$IPC")
SECRET=$(sed -n 's/.*"secret"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$IPC")
[ -n "$PORT" ] || exit 0

# The CLI's own payload goes through UNTOUCHED, and Lotus's two facts ride in headers beside it.
#
# Two reasons, both paid for. The path to the runner's transcript exists only inside that payload
# (\`transcript_path\`, sent by Claude and Codex on every event), and every attempt to rebuild JSON
# by hand in \`sh\` in this project has cost an escaping bug. \`head -c\` caps it so a giant tool
# input cannot be piped at the host.
#
# Status discarded and stderr dropped on purpose: a non-zero exit here would block the tool call.
head -c 65536 | curl -s -m 3 -X POST "http://127.0.0.1:$PORT/v1/hook/turn" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -H "X-Lotus-Pane-Id: $LOTUS_PANE_ID" \
  -H "X-Lotus-Status: $STATUS" \
  --data-binary @- 2>/dev/null || true
exit 0
`;
}

/**
 * Merges the hook into a Claude settings document without disturbing what is already there.
 *
 * **The shape is Claude's, not ours.** An entry is `{ hooks: [{ type: "command", command }] }`,
 * optionally with a `matcher`. A flat `{ command }` is accepted by nobody: it was written into a
 * real settings file on 2026-09-06, sat there looking installed, and Claude never fired it. That
 * is the shape of every silent failure this project keeps meeting — a write that succeeds and
 * does nothing.
 *
 * The file is the operator's, shared with every other tool that registers hooks, so this adds one
 * entry per event and leaves every other key, event and command untouched. Re-running replaces
 * only the entry whose command is this script, which is what makes reinstalling idempotent.
 */
export function withClaudeHook(
  settings: Record<string, unknown>,
  scriptPath: string,
  events: Readonly<Record<string, string>> = CLAUDE_HOOK_EVENTS,
): Record<string, unknown> {
  const hooks = { ...(asRecord(settings["hooks"]) ?? {}) };

  for (const [event, phase] of Object.entries(events)) {
    // The phase rides in the command string, because Claude does not pass the event name as an
    // argument — it sends JSON on stdin. Registering the bare script left `$1` empty, every fire
    // fell through the `case` to `exit 0`, and the host saw nothing (measured 2026-09-06).
    const entry = { hooks: [{ type: "command", command: `${scriptPath} ${phase}` }] };
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const others = existing.filter((e) => !ownedBy(e, scriptPath));
    hooks[event] = [...others, entry];
  }

  return { ...settings, hooks };
}

/**
 * Claude's hook events, and the phase each one means to this host.
 *
 * `Notification` is the one that matters for permission: Claude fires it when it needs the
 * operator. The rest keep the turn map honest about what a cell is doing between questions.
 *
 * `PostToolUse` is here for a third reason, and it is the difference between watching an agent
 * work and seeing its output arrive all at once. Every fire is what tells this host to publish a
 * pane's new steps (slice 3.6); without it the only fires inside a turn are its first and its
 * last, so Chat would sit still for a minute and then fill in. Once per tool call is the cost —
 * one local `curl`, capped at three seconds, and it cannot fail the tool because the script
 * always exits 0.
 */
export const CLAUDE_HOOK_EVENTS: Readonly<Record<string, string>> = {
  Notification: "notification",
  Stop: "stop",
  PostToolUse: "post-tool",
  SessionStart: "session-start",
  SessionEnd: "session-end",
  UserPromptSubmit: "user",
};

/** Whether an entry is this host's, in either the nested shape or the flat one it once wrote. */
function ownedBy(entry: unknown, scriptPath: string): boolean {
  for (const command of commandsOf(entry)) {
    if (command === scriptPath || command.startsWith(`${scriptPath} `)) return true;
  }
  return false;
}

/** Every command an entry carries, whatever shape it is in. */
function commandsOf(entry: unknown): string[] {
  const record = asRecord(entry);
  if (record === undefined) return [];
  const own = typeof record["command"] === "string" ? [record["command"]] : [];
  const nested = Array.isArray(record["hooks"])
    ? (record["hooks"] as unknown[]).flatMap((h) => {
        const inner = asRecord(h);
        return typeof inner?.["command"] === "string" ? [inner["command"]] : [];
      })
    : [];
  return [...own, ...nested];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
