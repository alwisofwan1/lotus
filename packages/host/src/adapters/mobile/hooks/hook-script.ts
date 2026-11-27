/**
 * Shell hook: **no node** (ADR-F), only `sh` and `curl`. **Must never fail**: a non-zero
 * `PreToolUse` hook BLOCKS the tool (ADR-8), so every path ends `exit 0`. It is GLOBAL, so the
 * `LOTUS_PANE_ID` guard keeps foreign sessions to one shell spawn.
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
 * Merges the hook into a Claude settings document, touching nothing else (the file is shared);
 * re-running replaces only our own entry. The shape is Claude's `{ hooks: [{ type: "command",
 * command }] }`: a flat `{ command }` looks installed but never fires.
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
 * Claude's hook events and their phase. `Notification` is Claude needing the operator;
 * `PostToolUse` makes the host publish new steps (slice 3.6), else Chat sits still until the
 * turn's last fire (cost: one local `curl` per tool call, capped at 3s).
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
