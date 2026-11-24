import { isTauri } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";

/** Subscribe to the authoritative stop-hook turn-end signal; returns an unsubscribe. */
export type AgentStoppedSubscriber = (
  onStopped: (paneId: string, sessionId?: string | null, limit?: string | null) => void,
) => () => void;

/**
 * The Rust `mcp://agent-stopped` Tauri event. It is emitted by the agent CLI's Stop hook
 * (correlated by `LOTUS_PANE_ID` — the agent node id on the canvas, the cell id in the shell) — an
 * EXACT, per-turn, instant "the agent finished responding" signal, immune to the TUI repaints that
 * defeat the byte-idle heuristic. Fires for Claude-family runners (their Stop hook is installed in
 * `~/.claude/settings.json`) and Codex (its `notify` script); runners without a hook simply never
 * emit it and fall to the caller's idle path.
 *
 * Shared by CodeCanvas's done callouts and the shell's unread marks, so both surfaces hear the same
 * turn end. `limit` is set when the turn died on a usage limit (Claude's `StopFailure` hook): the
 * CLI's own words, e.g. "You've hit your 5-hour limit · resets 2:20pm".
 */
export const subscribeAgentStopped: AgentStoppedSubscriber = (onStopped) => {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<{ paneId?: string; sessionId?: string | null; limit?: string | null }>("mcp://agent-stopped", (event) => {
        const paneId = event.payload?.paneId;
        if (paneId) onStopped(paneId, event.payload?.sessionId ?? null, event.payload?.limit ?? null);
      });
      if (cancelled) safeTauriUnlisten(off);
      else unlisten = off;
    } catch {
      /* listen unavailable — the idle fallback still runs. */
    }
  })();
  return () => {
    cancelled = true;
    safeTauriUnlisten(unlisten);
  };
};
