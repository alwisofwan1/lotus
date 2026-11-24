import type { Node } from "@xyflow/react";
import { resolveCanvasDispatchTarget } from "./canvas-agent-messaging";
import { normalizeNameQuery } from "./canvas-name-match";
import type { AgentStatusSnapshot } from "./agent-status-registry";

// Pure resolver for agent-issued "focus this" canvas-control requests. Maps a
// free-form target (node id, agent name, or node title) to a concrete canvas
// node id, so the MCP bridge can focus it. Order: exact id → agent roster
// (name/id) → exact title → title substring. Returns a structured result so the
// caller can hand the agent a meaningful error instead of silently no-op'ing.
export interface CanvasControlTargetResult {
  ok: boolean;
  nodeId?: string;
  error?: string;
}

function titleOf(node: Node): string | null {
  const t = (node.data as Record<string, unknown> | undefined)?.title;
  return typeof t === "string" ? t : null;
}

export function resolveCanvasControlTarget(
  target: string,
  nodes: Node[],
  roster: AgentStatusSnapshot[],
): CanvasControlTargetResult {
  const raw = (target ?? "").trim();
  if (!raw) return { ok: false, error: "No target node specified." };

  // 1. Exact node id — works for any node type.
  if (nodes.some((n) => n.id === raw)) return { ok: true, nodeId: raw };

  // 2. Agent roster (by id or name); only accept it if it maps to a live node.
  const viaRoster = resolveCanvasDispatchTarget(raw, roster);
  if (viaRoster.ok && nodes.some((n) => n.id === viaRoster.id)) {
    return { ok: true, nodeId: viaRoster.id };
  }

  // 3. Node title — exact before substring, both normalized so "Build terminal." matches.
  const ql = normalizeNameQuery(raw);
  const exact = ql ? nodes.find((n) => normalizeNameQuery(titleOf(n) ?? "") === ql) : undefined;
  if (exact) return { ok: true, nodeId: exact.id };
  const partial = ql ? nodes.find((n) => normalizeNameQuery(titleOf(n) ?? "").includes(ql)) : undefined;
  if (partial) return { ok: true, nodeId: partial.id };

  return { ok: false, error: `No canvas node matches "${raw}".` };
}
