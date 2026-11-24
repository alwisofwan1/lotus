import { getPtySessionMetrics, writeToSession } from "@/lib/tauri-api";
import {
  getTerminalRuntimeSessionId,
  subscribeTerminalSessionStatus,
} from "@/modules/codespace/services/terminal-session-registry";
import { waitForPtyReady, type PtyReadyReason } from "@/modules/codespace/services/task-execution/waitForPtyReady";
import { quietSettler, writePromptToPty } from "@/modules/codespace/services/task-execution/writePrompt";
import { awaitSessionId } from "@/modules/tasks/services/await-session";
import type { AddPane } from "@/modules/tasks/services/task-spawner";

/**
 * "Create with agent": opens an interactive `claude` pane and types the user's request into it.
 *
 * The agent then works through the lotus-automation skill and the `lotus_automation_*` MCP tools
 * (PLAN §2.5). Interactive on purpose — it has to show a summary and wait for the user's yes — and
 * whatever it creates is saved OFF, so opening it here can never start an automation by itself.
 * Same pane mechanics as Tasks' Delegate: text first, return on its own once the pane is quiet.
 */

export interface AgentPaneDeps {
  addPane: (workspaceId: string, agentCommand: string) => string | null;
  awaitSessionId: (paneId: string) => Promise<string | null>;
  waitReady: (sessionId: string) => Promise<{ reason: PtyReadyReason }>;
  write: (sessionId: string, data: string) => Promise<void>;
  settle: (sessionId: string) => Promise<void>;
  /** Milliseconds since the pane last printed anything. */
  idleMs: (sessionId: string) => Promise<number>;
  pause: (ms: number) => Promise<void>;
}

/** How long the agent gets to react to a return before it is pressed again. */
const REACT_MS = 1_500;
/** Extra returns at most. An extra return on an empty composer does nothing, so this is safe. */
const EXTRA_RETURNS = 2;

/** Resolves to `null` once the prompt is typed, or to why it was not. */
export async function startAgentWithPrompt(
  workspaceId: string | null,
  prompt: string,
  deps: AgentPaneDeps,
): Promise<string | null> {
  if (!workspaceId) return "Open a workspace in Code mode first — the agent needs somewhere to run.";
  const paneId = deps.addPane(workspaceId, "claude");
  if (!paneId) return "Lotus could not open a pane for the agent.";
  const sessionId = await deps.awaitSessionId(paneId);
  if (!sessionId) return "The agent's terminal did not start.";
  const ready = await deps.waitReady(sessionId);
  if (ready.reason === "gone" || ready.reason === "aborted") return "The agent's terminal closed before it was ready.";
  await writePromptToPty(sessionId, prompt, deps.write, deps.settle);
  /*
    Seen live 2026-09-25: a fresh claude showed the whole prompt in its box and never ran it, and
    one return pressed by hand then started it at once. So the text lands; a return can be lost
    while the agent is still starting. Silence after the return means it was — press it again.
  */
  for (let extra = 0; ; extra += 1) {
    await deps.pause(REACT_MS);
    if ((await deps.idleMs(sessionId)) < REACT_MS) return null;
    if (extra === EXTRA_RETURNS) return "The prompt is in the agent's box but did not start — press Enter in that pane.";
    await deps.write(sessionId, "\r");
  }
}

/** The real pane, PTY and registry wiring, around the grid's `addPane`. */
export function agentPaneDeps(addPane: AddPane): AgentPaneDeps {
  return {
    addPane: (workspaceId, agentCommand) => addPane(workspaceId, agentCommand),
    awaitSessionId: (paneId) =>
      awaitSessionId(paneId, { peek: getTerminalRuntimeSessionId, subscribe: subscribeTerminalSessionStatus }),
    waitReady: (sessionId) => waitForPtyReady(sessionId, getPtySessionMetrics),
    write: writeToSession,
    settle: quietSettler(getPtySessionMetrics),
    // Unknown metrics read as "reacted": never press return into a pane we cannot see.
    idleMs: async (sessionId) => (await getPtySessionMetrics(sessionId).catch(() => null))?.idleMs ?? 0,
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
