import { submitAsKeystrokes, type SubmitKeystrokeOptions } from "@/lib/agent-runtime/tui-handover";
import { awaitTerminalHandover } from "./terminal-handover";
import {
  getTerminalSessionStatus,
  subscribeTerminalSessionStatus,
  writeTerminalSession,
  type TerminalRuntimeStatus,
} from "./terminal-session-registry";

/**
 * How long a new cell's agent gets to take its terminal over before the brief stops waiting. A cold
 * `claude` runs every SessionStart hook first (claude-mem, plugins), so 1.5 s was never enough.
 */
const SPAWN_BRIEF_HANDOVER_MS = 90_000;

/**
 * Phase C spawn-with-brief: once a cell is live, type + submit its first task so the agent boots
 * already working (the orchestrator pattern). Best-effort and fire-and-forget — the lead can still
 * verify via lotus_wait_cell_idle / lotus_gather_results.
 *
 * Two rules from `tui-handover.ts`, both broken by the fixed 1.5 s timer this replaced (seen
 * 2026-10-31: the brief sat unsent in a cold `claude`'s input box): wait for the agent's own
 * handover, then type the text and press Enter as separate writes. Behind a shell, the shell's
 * prompt does not count — typing there would run the brief as a command. When no handover comes,
 * the text is left typed but NOT submitted, where the operator can see it and press Enter.
 */
export async function deliverInitialPrompt(
  paneId: string,
  prompt: string,
  opts: { behindShell: boolean; handoverMs?: number; keystrokes?: SubmitKeystrokeOptions },
): Promise<"submitted" | "typed" | "gone"> {
  const text = prompt.replace(/\s+$/, "");
  if (!text) return "gone";
  const closed = new AbortController();
  const stopWatching = subscribeTerminalSessionStatus(paneId, (status) => {
    if (status === "exited" || status === "failed") closed.abort();
  });
  try {
    const handed = await awaitTerminalHandover(paneId, {
      timeoutMs: opts.handoverMs ?? SPAWN_BRIEF_HANDOVER_MS,
      signal: closed.signal,
      behindShell: opts.behindShell,
    });
    const write = (data: string) => {
      if (closed.signal.aborted || !isWritable(getTerminalSessionStatus(paneId))) {
        throw new Error(`pane ${paneId} closed before its brief was delivered`);
      }
      writeTerminalSession(paneId, data);
    };
    if (!handed) {
      if (closed.signal.aborted) return "gone";
      console.warn(`[spawn-brief] ${paneId}: no terminal handover in time; brief typed, not submitted`);
      write(text);
      return "typed";
    }
    await submitAsKeystrokes(write, text, opts.keystrokes);
    return "submitted";
  } catch (error) {
    console.warn("[spawn-brief]", error instanceof Error ? error.message : error);
    return "gone";
  } finally {
    stopWatching();
  }
}

function isWritable(status: TerminalRuntimeStatus): boolean {
  return status === "live" || status === "detached";
}
