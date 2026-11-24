import { buildNodeIndex, type CanvasNodeRef } from "../canvas-nl-command";
import type { AgentStatusSnapshot } from "../agent-status-registry";

export interface S2sCanvasContextNodeInput {
  id: string;
  type?: string;
  data?: unknown;
}

export interface S2sCanvasLiveVoiceContext {
  nodeRefs: CanvasNodeRef[];
  roster: AgentStatusSnapshot[];
  /** Visible names only; aliases stay resolver/internal hints, not primary identity. */
  agentNames: string[];
  /** Compact target hints for realtime tool schema. */
  agentTargetHints: string[];
  /** Compact context lines for realtime instructions. */
  nodeSummaries: string[];
  hasBrowserNodes: boolean;
}

function targetAlias(alias: string): boolean {
  return /codex|claude|cloud|cursor|gemini|aider|opencode|\d|one|two|three|four|five/i.test(alias);
}

export function buildS2sCanvasLiveVoiceContext(
  nodes: readonly S2sCanvasContextNodeInput[],
  liveRoster: readonly AgentStatusSnapshot[],
): S2sCanvasLiveVoiceContext {
  const nodeRefs = buildNodeIndex([...nodes]);
  const roster = liveRoster.map((agent) => {
    const ref = nodeRefs.find((node) => node.id === agent.id);
    const aliases = Array.from(new Set([...(agent.aliases ?? []), ...(ref?.aliases ?? [])]));
    return { ...agent, ...(aliases.length ? { aliases } : {}) };
  });
  const agentNames = roster.map((agent) => agent.name);
  const agentTargetHints = nodeRefs
    .filter((node) => node.kind === "agent")
    .map((node) => {
      const aliases = (node.aliases ?? []).filter(targetAlias).slice(0, 6);
      return aliases.length ? `${node.name} (${aliases.join(" / ")})` : node.name;
    });
  const nodeSummaries = nodeRefs.map((node) => `${node.name} (${node.kind}${node.aliases?.length ? `; aliases: ${node.aliases.join(", ")}` : ""})`);
  const hasBrowserNodes = nodeRefs.some((node) => node.kind === "browser");
  return { nodeRefs, roster, agentNames, agentTargetHints, nodeSummaries, hasBrowserNodes };
}
