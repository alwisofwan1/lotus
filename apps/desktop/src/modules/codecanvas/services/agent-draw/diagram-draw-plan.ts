import { FRAME_LIMIT_NOTICE, MAX_FRAMES, framesInOrder } from "../canvas-frames";
import type { Edge, Node } from "@xyflow/react";
import { buildDrawApplication, staggerDiagramAnchor, STREAM_CLASS, type DrawApplication, type DrawRuntimeResult } from "./canvas-draw-runtime";
import type { DiagramGraph } from "./diagram-layout";
import { collectDiagrams, findEditTargetDiagram, planDiagramReplace, type DiagramSummary } from "./diagram-edit";

/** Strip the streaming enter class (+ its delay) so a node glides to a new position instead of re-mounting. */
function stopStreaming(node: Node): Node {
  const className = (node.className ?? "").split(/\s+/).filter((c) => c && c !== STREAM_CLASS).join(" ") || undefined;
  const style = { ...(node.style as Record<string, unknown> | undefined) };
  delete style["--canvas-enter-delay"];
  return { ...node, className, style: style as Node["style"] };
}

/**
 * Node-level reconciliation for a diagram EDIT. The layout minted fresh ids for the whole new graph;
 * here we re-map every shape that still exists (matched by its semantic `diagramNodeId`, plus the
 * frame) back to its OLD canvas id and drop its stream-in animation. Because the committed nodes
 * array then carries the same id at a new position, ReactFlow diffs it as a MOVE and glides it —
 * only genuinely-new nodes stream in and deleted ones disappear. All nodes keep the diagram's
 * original `diagramId` so its identity persists across successive edits.
 */
function reconcileEdit(application: DrawApplication, target: DiagramSummary): DrawApplication {
  const oldByNid = new Map(target.nodes.map((m) => [m.diagramNodeId, m.nodeId]));
  const remap = new Map<string, string>();
  for (const n of application.nodes) {
    const data = n.data as { diagramNodeId?: string };
    if (n.type === "frame" && target.frameId) remap.set(n.id, target.frameId);
    else if (data.diagramNodeId && oldByNid.has(data.diagramNodeId)) remap.set(n.id, oldByNid.get(data.diagramNodeId)!);
  }

  const nodes = application.nodes.map((n) => {
    const data: Record<string, unknown> = { ...(n.data as Record<string, unknown>), diagramId: target.diagramId };
    // Members point at the new Frame's minted id; follow it to the reused one.
    const oldFrame = typeof data.frameId === "string" ? remap.get(data.frameId) : undefined;
    if (oldFrame) data.frameId = oldFrame;
    const oldId = remap.get(n.id);
    if (!oldId) return { ...n, data }; // genuinely new → keep fresh id + stream-in
    return stopStreaming({ ...n, id: oldId, data }); // matched → reuse old id, glide
  });
  const edges = application.edges.map((e) => ({ ...e, source: remap.get(e.source) ?? e.source, target: remap.get(e.target) ?? e.target }));
  const createdIds = nodes.map((n) => n.id);

  return { ...application, nodes, edges, createdIds, edgeIds: edges.map((e) => e.id) };
}

/**
 * The single orchestrator for drawing a diagram from a semantic graph, shared by BOTH entry points
 * (the NL command centre and the MCP agent bridge) so edit-in-place behaves identically for typed
 * and agent-issued requests. It decides new-vs-edit by id overlap, then either:
 *   • NEW  → anchor at the base point, staggered off existing diagrams;
 *   • EDIT → anchor at the target diagram's spot, force draft (so the replace is revertible), and
 *            inject the old diagram's node ids into removeIds so the commit swaps it atomically.
 * Pure: the caller supplies the board, a base anchor, id minting, and text measurement.
 */
export interface PlanDiagramDrawParams {
  graph: DiagramGraph;
  direction?: "TB" | "LR";
  title?: string;
  /** Wrap the diagram in a titled frame (default true); false = loose shapes. */
  frame?: boolean;
  nodes: readonly Node[];
  edges: readonly Edge[];
  /** Flow-space anchor for a brand-new diagram (viewport centre / near a node). */
  baseAnchor: { x: number; y: number };
  makeId: () => string;
  measure: (text: string) => number;
}

export function planDiagramDraw(params: PlanDiagramDrawParams): DrawRuntimeResult {
  const { graph, direction, title, frame = true, nodes, edges, baseAnchor, makeId, measure } = params;
  const diagrams = collectDiagrams(nodes, edges);
  const targetId = findEditTargetDiagram(diagrams, graph.nodes.map((n) => n.id));
  const replace = targetId ? planDiagramReplace(diagrams, targetId) : null;
  const anchor = replace ? replace.anchor : staggerDiagramAnchor(baseAnchor, diagrams.length);
  // Decision 33: at the Frame limit a diagram is drawn loose (the old, Frame-less behaviour), never refused.
  // A replace frees the Frame of the diagram it swaps out.
  const removing = new Set(replace?.removeNodeIds ?? []);
  const frameCount = framesInOrder(nodes).filter((f) => !removing.has(f.id)).length;
  const frameLimited = frame && frameCount >= MAX_FRAMES;

  const application = buildDrawApplication(
    // Force draft on a replace so the destructive swap is always revertible via the pill.
    { mode: "diagram", graph, direction, frame: frame && !frameLimited ? { title: title ?? "" } : false, ...(replace ? { draft: true } : {}) },
    {
      anchor,
      existingShapeIds: new Set(nodes.filter((n) => n.type === "shape").map((n) => n.id)),
      makeId,
      measure,
    },
  );
  if ("error" in application) return application;
  if (frameLimited) application.receipt = { ...application.receipt, note: `${FRAME_LIMIT_NOTICE}: the diagram was drawn without a Frame.` };
  if (!replace || !targetId) return application;
  // Edit: reconcile so unchanged nodes glide (reuse old ids), then remove the whole old diagram
  // (matched old ids are filtered from the board and re-appended by the reconciled creates → glide;
  // deleted old ids are filtered and not re-added → gone).
  const target = diagrams.find((d) => d.diagramId === targetId)!;
  const reconciled = reconcileEdit(application, target);
  return { ...reconciled, removeIds: [...reconciled.removeIds, ...replace.removeNodeIds] };
}
