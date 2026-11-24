import type { Edge, Node } from "@xyflow/react";

interface CanvasConnectionLike {
  source?: string | null;
  target?: string | null;
}

const SYSTEM_ONLY_NODE_TYPES = new Set(["skills", "skill"]);

function nodeType(nodes: readonly Node[], id: string | null | undefined): string | undefined {
  return nodes.find((node) => node.id === id)?.type;
}

/** Production guard for user-drawn CodeCanvas wires. System provenance wires are created by node actions. */
export function isValidCanvasConnection(
  connection: CanvasConnectionLike,
  nodes: readonly Node[],
  edges: readonly Edge[],
  ignoreEdgeId?: string,
): boolean {
  const { source, target } = connection;
  if (!source || !target || source === target) return false;
  if (SYSTEM_ONLY_NODE_TYPES.has(nodeType(nodes, source) ?? "")) return false;
  if (SYSTEM_ONLY_NODE_TYPES.has(nodeType(nodes, target) ?? "")) return false;
  return !edges.some((edge) => edge.id !== ignoreEdgeId && edge.source === source && edge.target === target);
}
