import type { Edge, Node } from "@xyflow/react";

/**
 * Pure helpers for editing an EXISTING agent-drawn diagram in place. Diagrams are stamped with a
 * stable `diagramId` (per instance) and each shape with its semantic `diagramNodeId` at draw time
 * (see canvas-draw-runtime). These functions let the NL/agent path (a) show the model the current
 * diagrams so it reuses ids, (b) recognize a re-emitted graph as an edit of a specific diagram, and
 * (c) replace that diagram in place (remove the old nodes, redraw at the same spot). No React/DOM.
 */

export interface DiagramMemberSummary {
  nodeId: string;
  diagramNodeId: string;
  label: string;
  shape: string;
}

export interface DiagramSummary {
  diagramId: string;
  title?: string;
  nodes: DiagramMemberSummary[];
  edges: Array<{ from: string; to: string; label?: string }>;
  /** All canvas node ids in this diagram (members + frame) — the removal set for a replace. */
  nodeIds: string[];
  /** Canvas node id of the diagram's frame, if any — reused on edit so the frame glides, not re-mounts. */
  frameId?: string;
  /** Flow-space top-left of the diagram (min corner across its nodes) — the replace anchor. */
  topLeft: { x: number; y: number };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Group the canvas's shape nodes into the diagrams they belong to (by `diagramId`). */
export function collectDiagrams(nodes: readonly Node[], edges: readonly Edge[]): DiagramSummary[] {
  const groups = new Map<string, { members: Node[]; frame: Node | null }>();
  for (const node of nodes) {
    // A migrated/real Frame carrying `diagramId` is the diagram's frame (LOT2-121).
    if (node.type !== "shape" && node.type !== "frame") continue;
    const data = (node.data ?? {}) as Record<string, unknown>;
    const diagramId = str(data.diagramId);
    if (!diagramId) continue;
    const group = groups.get(diagramId) ?? { members: [], frame: null };
    if (node.type === "frame" || data.diagramFrame) group.frame = node;
    else group.members.push(node);
    groups.set(diagramId, group);
  }

  const result: DiagramSummary[] = [];
  for (const [diagramId, group] of groups) {
    const nodeIdToSemantic = new Map<string, string>();
    const members: DiagramMemberSummary[] = group.members.map((node) => {
      const data = (node.data ?? {}) as Record<string, unknown>;
      const diagramNodeId = str(data.diagramNodeId) ?? node.id;
      nodeIdToSemantic.set(node.id, diagramNodeId);
      return { nodeId: node.id, diagramNodeId, label: str(data.text) ?? "", shape: str(data.shape) ?? "rectangle" };
    });

    const memberEdges: DiagramSummary["edges"] = [];
    for (const edge of edges) {
      const from = nodeIdToSemantic.get(edge.source);
      const to = nodeIdToSemantic.get(edge.target);
      if (!from || !to) continue;
      const label = str((edge.data as Record<string, unknown> | undefined)?.customLabel) ?? (typeof edge.label === "string" ? str(edge.label) : undefined);
      memberEdges.push({ from, to, ...(label ? { label } : {}) });
    }

    const all = [...group.members, ...(group.frame ? [group.frame] : [])];
    const topLeft = {
      x: Math.min(...all.map((n) => n.position.x)),
      y: Math.min(...all.map((n) => n.position.y)),
    };
    result.push({
      diagramId,
      ...(group.frame ? { title: str((group.frame.data as Record<string, unknown>).title) ?? str((group.frame.data as Record<string, unknown>).areaLabel), frameId: group.frame.id } : {}),
      nodes: members,
      edges: memberEdges,
      nodeIds: all.map((n) => n.id),
      topLeft,
    });
  }
  return result;
}

/** An edit must re-send at least this fraction of an existing diagram's nodes to count as editing it. */
export const EDIT_MATCH_MIN_RATIO = 0.6;
/** …and at least this many nodes in absolute terms, so one shared generic id (e.g. "start") is never enough. */
export const EDIT_MATCH_MIN_OVERLAP = 2;

/**
 * Which existing diagram is a re-emitted graph editing? A real edit re-sends most of a diagram's
 * nodes (the model is shown them and told to reuse their ids), so we require a MAJORITY overlap
 * (≥{@link EDIT_MATCH_MIN_RATIO} of the diagram's nodes AND ≥{@link EDIT_MATCH_MIN_OVERLAP} nodes) —
 * this prevents a brand-new diagram that merely reuses a generic id like "start"/"end" from
 * replacing (destroying) an unrelated diagram. Returns null → treat as a brand-new diagram.
 */
export function findEditTargetDiagram(diagrams: readonly DiagramSummary[], newGraphNodeIds: readonly string[]): string | null {
  const wanted = new Set(newGraphNodeIds);
  let best: { diagramId: string; overlap: number } | null = null;
  for (const d of diagrams) {
    if (d.nodes.length === 0) continue;
    const overlap = d.nodes.reduce((n, m) => (wanted.has(m.diagramNodeId) ? n + 1 : n), 0);
    const strong = overlap >= EDIT_MATCH_MIN_OVERLAP && overlap / d.nodes.length >= EDIT_MATCH_MIN_RATIO;
    if (strong && (!best || overlap > best.overlap)) best = { diagramId: d.diagramId, overlap };
  }
  return best?.diagramId ?? null;
}

/** The replace plan for a diagram: where to redraw it and which nodes to remove first. */
export function planDiagramReplace(
  diagrams: readonly DiagramSummary[],
  diagramId: string,
): { anchor: { x: number; y: number }; removeNodeIds: string[] } | null {
  const target = diagrams.find((d) => d.diagramId === diagramId);
  if (!target) return null;
  return { anchor: target.topLeft, removeNodeIds: target.nodeIds };
}

/**
 * Bounds on the diagram block in the routing prompt.
 *
 * This block is the one unbounded part of that prompt, and it is sent on EVERY command — "arrange"
 * included, even though only `draw_diagram` can use it. Measured on a canvas of 8 large diagrams it
 * grew a 3.5KB prompt to 20KB of the user's own domain labels, all of it crossing to the BYOK provider.
 *
 * Caps are set well above a realistic canvas (typically one to three diagrams), so they bound the tail
 * rather than change everyday behavior. Gating the block on diagram-ish keywords was rejected instead:
 * a genuine edit is often phrased without any ("add a step to the login flow"), so keyword gating would
 * trade disclosure for wrong routing.
 */
const MAX_PROMPTED_DIAGRAMS = 6;
const MAX_PROMPTED_ELEMENTS_PER_DIAGRAM = 30;

/** Join at most `max` rendered elements, appending a count of what was withheld. */
function joinCapped(rendered: readonly string[], max: number): string {
  if (rendered.length <= max) return rendered.join(", ");
  // The "+N more" marker matters for correctness, not just honesty: a silently truncated list reads as
  // "this node does not exist", which makes the model mint a fresh id and redraw instead of editing.
  return `${rendered.slice(0, max).join(", ")}, …+${rendered.length - max} more`;
}

/** Compact prompt lines describing the current diagrams so the model reuses ids when editing. */
export function formatCurrentDiagrams(diagrams: readonly DiagramSummary[]): string[] {
  const listed = diagrams.slice(0, MAX_PROMPTED_DIAGRAMS).map((d) => {
    const nodes = joinCapped(
      d.nodes.map((n) => `${n.diagramNodeId}=${n.label || n.diagramNodeId}`),
      MAX_PROMPTED_ELEMENTS_PER_DIAGRAM,
    );
    const edges = joinCapped(
      d.edges.map((e) => `${e.from}→${e.to}${e.label ? `(${e.label})` : ""}`),
      MAX_PROMPTED_ELEMENTS_PER_DIAGRAM,
    );
    const title = d.title ? `"${d.title}"` : "(untitled)";
    return `Diagram ${title} — nodes: ${nodes}${edges ? `; edges: ${edges}` : ""}. To edit it, resend draw_diagram reusing these node ids plus your changes.`;
  });
  if (diagrams.length > MAX_PROMPTED_DIAGRAMS) {
    listed.push(`(+${diagrams.length - MAX_PROMPTED_DIAGRAMS} more diagrams on the canvas, not listed.)`);
  }
  return listed;
}
