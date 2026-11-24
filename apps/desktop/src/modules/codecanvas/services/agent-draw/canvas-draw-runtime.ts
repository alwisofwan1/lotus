import type { Edge, Node } from "@xyflow/react";
import type { ShapeNodePatch } from "../../types/canvas";
import { frameNode, shapeNode } from "../canvas-node-factory";
import { buildCanvasWireEdge } from "../canvas-wire-style";
import { planDrawOps, type DrawShapeSpec } from "./canvas-draw-apply";
import { layoutDiagram, type DiagramGraph } from "./diagram-layout";

/**
 * Impure-input → pure-output runtime that turns a validated MCP draw request into a concrete
 * {@link DrawApplication}: the exact ReactFlow nodes/edges to add, patches to apply, and node
 * ids to remove — plus a receipt for the agent and a ledger batch id for draft undo. It composes
 * the two planners ({@link planDrawOps} for freeform ops, {@link layoutDiagram} for diagrams) and
 * builds nodes via the shared {@link shapeNode} factory so drawn shapes are indistinguishable from
 * hand-drawn ones. No React/DOM/store access; the hook injects id minting, the anchor, the set of
 * existing shape ids, and a text measurer via {@link DrawRuntimeContext}.
 */

/** Above this many freshly-created elements, a batch defaults to draft (needs Apply). */
const DRAFT_THRESHOLD = 3;

/** Wrapper class marking a node/edge as an unaccepted agent draft (styling + apply lookup). */
export const DRAFT_CLASS = "canvas-agent-draft";

/** Wrapper class that opts a freshly-drawn node/edge into the staggered "streaming" enter animation. */
export const STREAM_CLASS = "canvas-shape-enter";
/** Per-element stagger for the streaming draw-in (frame → shapes → connectors). */
export const STREAM_STEP_MS = 80;
/** Cap so a large diagram still finishes drawing promptly instead of trickling for many seconds. */
export const STREAM_MAX_DELAY_MS = 1600;

/** The staggered enter delay for the Nth committed element, clamped so big batches stay snappy. */
export function streamEnterDelayMs(index: number): number {
  return Math.min(index * STREAM_STEP_MS, STREAM_MAX_DELAY_MS);
}

/** Diagonal step (px) each successive diagram is nudged by so a new draw doesn't stack exactly on the last. */
export const DIAGRAM_STAGGER_STEP = 44;
/** After this many diagrams the stagger wraps back to the base, keeping every draw near the viewport. */
export const DIAGRAM_STAGGER_WRAP = 6;

/**
 * Offset a base anchor so the Nth diagram cascades off the previous ones instead of overlapping.
 * Wraps after {@link DIAGRAM_STAGGER_WRAP} so it never marches off-screen; negative indices are safe.
 */
export function staggerDiagramAnchor(base: { x: number; y: number }, index: number): { x: number; y: number } {
  const k = ((index % DIAGRAM_STAGGER_WRAP) + DIAGRAM_STAGGER_WRAP) % DIAGRAM_STAGGER_WRAP;
  return { x: Math.round(base.x + k * DIAGRAM_STAGGER_STEP), y: Math.round(base.y + k * DIAGRAM_STAGGER_STEP) };
}

export interface DrawRequest {
  requestId?: string;
  mode?: "ops" | "diagram";
  /** ops mode: the raw operations array. */
  ops?: unknown;
  /** diagram mode: the semantic graph. */
  graph?: DiagramGraph;
  direction?: "TB" | "LR";
  /** Wrap a diagram in a titled frame (default true); `false` disables it. */
  frame?: { title?: string } | boolean;
  /** Force draft (true) or direct-apply (false). Omit to use the size-based default. */
  draft?: boolean;
}

export interface DrawRuntimeContext {
  anchor: { x: number; y: number };
  existingShapeIds: Set<string>;
  makeId: () => string;
  /** Width (px) of one line at the diagram font — for text-based diagram sizing. */
  measure: (text: string) => number;
}

export interface DrawReceipt {
  batchId: string;
  mode: "ops" | "diagram";
  created: number;
  connectors: number;
  updated: number;
  deleted: number;
  rejected: Array<{ index: number; reason: string }>;
  draft: boolean;
  createdIds: string[];
  /** Something the agent should know (e.g. the diagram was drawn without a Frame at the Frame limit). */
  note?: string;
}

export interface DrawApplication {
  nodes: Node[];
  edges: Edge[];
  patches: Array<{ id: string; patch: ShapeNodePatch }>;
  removeIds: string[];
  draft: boolean;
  batchId: string;
  createdIds: string[];
  edgeIds: string[];
  receipt: DrawReceipt;
}

export type DrawRuntimeResult = DrawApplication | { error: string };

/** Stamp draft provenance onto node data so the renderer dims it and the ledger can revert it. */
function shapeToNode(
  id: string,
  spec: DrawShapeSpec & { groupIds?: string[] },
  draft: boolean,
  enterIndex: number,
  extraData?: Record<string, unknown>,
): Node {
  const node = shapeNode({
    id,
    position: spec.position,
    shape: spec.shape,
    size: { w: spec.size.w, h: spec.size.h },
    ...(spec.text !== undefined ? { text: spec.text } : {}),
    ...(spec.areaLabel !== undefined ? { areaLabel: spec.areaLabel } : {}),
    ...(spec.points ? { points: spec.points } : {}),
    ...(spec.style ? { style: spec.style } : {}),
    ...(spec.groupIds ? { groupIds: spec.groupIds } : {}),
  });
  return stampDrawNode(node, draft, enterIndex, extraData);
}

/** Draft provenance + streaming enter classes shared by drawn shapes and the diagram's Frame. */
function stampDrawNode(node: Node, draft: boolean, enterIndex: number, extraData?: Record<string, unknown>): Node {
  const data = { ...node.data, ...extraData } as Record<string, unknown>;
  if (draft) data.agentDraft = true;
  const next: Node = { ...node, data };
  // Wrapper classes: DRAFT_CLASS drives the dimmed/dashed draft look (stripped on Apply);
  // STREAM_CLASS + --canvas-enter-delay drive the staggered draw-in (transient, not persisted).
  next.className = [node.className, draft ? DRAFT_CLASS : "", STREAM_CLASS].filter(Boolean).join(" ");
  next.style = { ...node.style, "--canvas-enter-delay": `${streamEnterDelayMs(enterIndex)}ms` } as Node["style"];
  return next;
}

interface ConnectorSpec {
  id: string;
  source: string;
  target: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
}

function connectorEdge(c: ConnectorSpec, draft: boolean, enterIndex: number): Edge {
  const edge = buildCanvasWireEdge({
    id: c.id,
    source: c.source,
    target: c.target,
    kind: "connector",
    // Bind to real ShapeNode handles so ReactFlow accepts the edge (error #008 otherwise). The
    // path is floating, so the side is cosmetic; default to bottom→top when unspecified (ops mode).
    sourceHandle: c.sourceHandle ?? "wire-bottom",
    targetHandle: c.targetHandle ?? "wire-top",
    ...(c.label !== undefined ? { label: c.label } : {}),
  });
  // Connectors fade in after their endpoint shapes (they carry a later enter index).
  return {
    ...edge,
    ...(draft ? { data: { ...edge.data, agentDraft: true } } : {}),
    className: [edge.className, draft ? DRAFT_CLASS : "", STREAM_CLASS].filter(Boolean).join(" "),
    style: { ...edge.style, "--canvas-enter-delay": `${streamEnterDelayMs(enterIndex)}ms` } as Edge["style"],
  };
}

export function buildDrawApplication(request: DrawRequest, ctx: DrawRuntimeContext): DrawRuntimeResult {
  const mode = request.mode ?? (request.graph ? "diagram" : "ops");
  const batchId = ctx.makeId();

  if (mode === "ops") {
    const plan = planDrawOps(request.ops, ctx);
    if ("error" in plan) return { error: plan.error };

    const createdCount = plan.creates.length + plan.connectors.length;
    // A batch that mutates or removes EXISTING board content must be a draft even with few/no
    // creates — otherwise a destructive edit to the user's own shapes would apply with no way to undo.
    const touchesExisting = plan.updates.length > 0 || plan.deletes.length > 0;
    const draft = request.draft ?? (createdCount > DRAFT_THRESHOLD || touchesExisting);

    // Stagger the streaming draw-in: shapes first (0..n-1), then connectors after them.
    const nodes = plan.creates.map((c, i) => shapeToNode(c.id, c.spec, draft, i));
    const edges = plan.connectors.map((c, i) => connectorEdge(c, draft, nodes.length + i));
    const createdIds = nodes.map((n) => n.id);
    const edgeIds = edges.map((e) => e.id);

    return {
      nodes, edges,
      patches: plan.updates.map((u) => ({ id: u.id, patch: u.patch })),
      removeIds: plan.deletes,
      draft, batchId, createdIds, edgeIds,
      receipt: {
        batchId, mode, created: plan.creates.length, connectors: plan.connectors.length,
        updated: plan.updates.length, deleted: plan.deletes.length, rejected: plan.rejected, draft, createdIds,
      },
    };
  }

  if (mode === "diagram") {
    const frame = request.frame === undefined ? undefined : request.frame === true ? {} : request.frame;
    const layout = layoutDiagram(request.graph ?? { nodes: [], edges: [] }, {
      anchor: ctx.anchor,
      direction: request.direction,
      frame,
      measure: ctx.measure,
      makeId: ctx.makeId,
    });
    if (layout.error) return { error: layout.error };

    const createdCount = layout.shapes.length + layout.connectors.length;
    const draft = request.draft ?? createdCount > DRAFT_THRESHOLD;

    // Stamp a stable diagram identity so a later edit can find + replace this exact diagram, and a
    // semantic node id per shape so the model's re-emitted graph can re-match each node.
    const diagramId = layout.groupId ?? ctx.makeId();
    const nodes: Node[] = [];
    // Frame first so it paints behind its members; enter indices drive the staggered draw-in.
    // The frame is a REAL Frame node (ADR-0050) titled by the diagram label; members reference it
    // by `frameId`. The layout's legacy shared group id is not carried over.
    const frameId = layout.frame?.id;
    if (layout.frame) {
      const f = layout.frame.spec;
      const title = f.areaLabel?.trim() || "Diagram";
      nodes.push(stampDrawNode(frameNode({ id: layout.frame.id, position: f.position, title, diagramId, size: f.size }), draft, 0));
    }
    layout.shapes.forEach((s) => {
      const { groupIds: _legacy, ...spec } = s.spec;
      nodes.push(shapeToNode(s.id, spec, draft, nodes.length, { diagramId, diagramNodeId: s.diagramNodeId, ...(frameId ? { frameId } : {}) }));
    });
    const edges = layout.connectors.map((c, i) => connectorEdge(c, draft, nodes.length + i));
    const createdIds = nodes.map((n) => n.id);
    const edgeIds = edges.map((e) => e.id);

    return {
      nodes, edges, patches: [], removeIds: [],
      draft, batchId, createdIds, edgeIds,
      receipt: {
        batchId, mode, created: nodes.length, connectors: layout.connectors.length,
        updated: 0, deleted: 0, rejected: layout.rejected, draft, createdIds,
      },
    };
  }

  return { error: `Unknown draw mode "${String(mode)}". Use "ops" or "diagram".` };
}
