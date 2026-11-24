import type { AgentState } from "./narration/agent-state-registry";
import type { LiveAgentRef } from "./file-node/file-agent-link";

export interface ChangedByBoardRow {
  path: string;
  /** Relative to the board's root. */
  relativePath: string;
  /** The agent that touched it most recently. */
  agent: string;
  /** That agent's node on the board. */
  agentNodeId: string;
  status: "A" | "M";
}

/**
 * The Code app's "Changed by this board": the files this board's agents touched, from the agent
 * state registry's `filesTouched`. One row per path, newest first. The registry keeps no per-file
 * clock, so "newest" is the agent whose last event is latest, then the file it touched last.
 * The registry is process-wide, so an agent with no node on THIS board never contributes (the rule
 * `agentEditingFile` uses).
 */
export function changedByBoard(input: {
  states: readonly AgentState[];
  rootDir: string;
  live: readonly LiveAgentRef[];
  statusOf: (path: string) => "A" | "M";
}): ChangedByBoardRow[] {
  const root = input.rootDir.replace(/\/+$/, "");
  const seen = new Set<string>();
  const rows: ChangedByBoardRow[] = [];
  const newestAgentFirst = [...input.states].sort((a, b) => b.lastEventAt - a.lastEventAt);
  for (const state of newestAgentFirst) {
    const agent = input.live.find((a) => (a.hookPaneId ?? a.id) === state.paneId);
    if (!agent) continue;
    for (let i = state.filesTouched.length - 1; i >= 0; i -= 1) {
      const path = state.filesTouched[i];
      if (seen.has(path) || !path.startsWith(`${root}/`)) continue;
      seen.add(path);
      rows.push({ path, relativePath: path.slice(root.length + 1), agent: agent.name, agentNodeId: agent.id, status: input.statusOf(path) });
    }
  }
  return rows;
}
