import { computeLineChanges } from "@/modules/codespace/services/editor-line-diff";
import type { AgentState } from "../narration/agent-state-registry";

/** +/− line counts of `current` against `base`. */
export function lineDiffCounts(base: string, current: string): { added: number; removed: number } {
  const lineCount = (text: string) => (text === "" ? 0 : text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length);
  let currentChanged = 0;
  for (const change of computeLineChanges(base, current)) {
    if (change.kind !== "deleted") currentChanged += change.endLine - change.startLine + 1;
  }
  const unchanged = lineCount(current) - currentChanged;
  return { added: currentChanged, removed: Math.max(0, lineCount(base) - unchanged) };
}

export interface LiveAgentRef {
  /** The canvas node id. */
  id: string;
  name: string;
  /** The pane id the agent state registry knows it by, when it differs from `id`. */
  hookPaneId?: string;
}

/** The live agent that touched `path` most recently, or null. Agents no longer on the board never answer. */
export function agentEditingFile(input: {
  states: readonly AgentState[];
  live: readonly LiveAgentRef[];
  path: string;
}): { nodeId: string; name: string } | null {
  let best: { nodeId: string; name: string; at: number } | null = null;
  for (const state of input.states) {
    if (!state.filesTouched.includes(input.path)) continue;
    const agent = input.live.find((a) => (a.hookPaneId ?? a.id) === state.paneId);
    if (!agent) continue;
    if (!best || state.lastEventAt > best.at) best = { nodeId: agent.id, name: agent.name, at: state.lastEventAt };
  }
  return best ? { nodeId: best.nodeId, name: best.name } : null;
}
