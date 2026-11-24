import dagre from "@dagrejs/dagre";
import type { CanvasShapeKind } from "../../types/canvas";
import type { DrawRejection, DrawShapeSpec } from "./canvas-draw-apply";

/**
 * Pure diagram layout: turn a semantic node/edge graph into positioned canvas shapes plus
 * connector specs, with an optional wrapping frame. The agent emits *relationships only* —
 * this module (via dagre) assigns every coordinate, which is the industry-standard mitigation
 * for LLMs being poor at absolute spatial layout (overlap, out-of-bounds, token cost).
 *
 * Pure and deterministic: dagre is fed injected sizes, and text measurement + id minting come
 * in through {@link DiagramLayoutOptions}, so the same graph always yields the same layout.
 */

export type DiagramNodeKind = "process" | "decision" | "terminator" | "note";

export interface DiagramNode {
  id: string;
  label: string;
  kind?: DiagramNodeKind;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagramLayoutOptions {
  /** Absolute flow-space top-left the whole diagram (frame if present, else bbox) is anchored to. */
  anchor: { x: number; y: number };
  /** Layout flow: top-to-bottom (default) or left-to-right. */
  direction?: "TB" | "LR";
  /** Wrap the diagram in a titled frame (default), or `false` to emit loose shapes. */
  frame?: { title?: string } | false;
  /** Width (px) of one line of label text at the diagram font — injected to stay pure. */
  measure: (text: string) => number;
  /** Mints fresh, unique node/edge/frame ids. */
  makeId: () => string;
}

export interface LaidOutShape {
  id: string;
  /** The semantic graph node id this shape came from — stamped on the node so an edit can re-match it. */
  diagramNodeId: string;
  spec: DrawShapeSpec & { groupIds?: string[] };
}

export interface LaidOutConnector {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** Handle ids the edge binds to (must exist on ShapeNode). Side follows the flow direction. */
  sourceHandle: string;
  targetHandle: string;
}

export interface DiagramLayout {
  shapes: LaidOutShape[];
  connectors: LaidOutConnector[];
  frame: LaidOutShape | null;
  /** Group id shared by the frame and all member shapes (present only when framed). */
  groupId: string | null;
  bounds: { x: number; y: number; w: number; h: number };
  rejected: DrawRejection[];
  /** Set only when the whole graph is unusable; shapes/connectors are then empty. */
  error?: string;
}

export const MAX_DIAGRAM_NODES = 120;

const KIND_TO_SHAPE: Record<DiagramNodeKind, CanvasShapeKind> = {
  process: "rectangle",
  decision: "diamond",
  terminator: "ellipse",
  note: "text",
};

const FRAME_PAD = 0;
const FRAME_TITLE_PAD = 0;

/** Per-kind box sizing from a measured label width. Diamonds/terminators need extra slack. */
function sizeForKind(kind: DiagramNodeKind, labelWidth: number): { w: number; h: number } {
  switch (kind) {
    case "decision":
      return { w: Math.max(140, labelWidth + 64), h: 92 };
    case "terminator":
      return { w: Math.max(120, labelWidth + 48), h: 52 };
    case "note":
      return { w: Math.max(100, labelWidth + 24), h: 54 };
    case "process":
    default:
      return { w: Math.max(120, labelWidth + 40), h: 56 };
  }
}

function empty(anchor: { x: number; y: number }, error?: string): DiagramLayout {
  return {
    shapes: [], connectors: [], frame: null, groupId: null,
    bounds: { x: anchor.x, y: anchor.y, w: 0, h: 0 }, rejected: [], ...(error ? { error } : {}),
  };
}

export function layoutDiagram(graph: DiagramGraph, options: DiagramLayoutOptions): DiagramLayout {
  const { anchor, direction = "TB", measure, makeId } = options;
  const wantFrame = options.frame !== false;
  const frameTitle = typeof options.frame === "object" && options.frame ? options.frame.title : undefined;

  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return empty(anchor, "Diagram has no nodes.");
  }
  if (graph.nodes.length > MAX_DIAGRAM_NODES) {
    return empty(anchor, `Diagram too large: ${graph.nodes.length} nodes exceeds the ${MAX_DIAGRAM_NODES}-node limit.`);
  }

  const rejected: DrawRejection[] = [];

  // Dedupe node ids, mint a canvas shape id per surviving node, and size each box.
  const byDiagramId = new Map<string, { canvasId: string; kind: DiagramNodeKind; label: string; w: number; h: number }>();
  graph.nodes.forEach((node, index) => {
    if (!node || typeof node.id !== "string" || !node.id) {
      rejected.push({ index, reason: "node is missing an id." });
      return;
    }
    if (byDiagramId.has(node.id)) {
      rejected.push({ index, reason: `duplicate node id "${node.id}".` });
      return;
    }
    const kind: DiagramNodeKind = node.kind && node.kind in KIND_TO_SHAPE ? node.kind : "process";
    const label = typeof node.label === "string" ? node.label : "";
    const { w, h } = sizeForKind(kind, Math.ceil(measure(label || " ")));
    byDiagramId.set(node.id, { canvasId: makeId(), kind, label, w, h });
  });

  if (byDiagramId.size === 0) return empty(anchor, "Diagram has no valid nodes.");

  // Feed dagre injected sizes; it returns node *centers*.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: direction, nodesep: 48, ranksep: 64, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const [, n] of byDiagramId) g.setNode(n.canvasId, { width: n.w, height: n.h });

  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const validEdges: Array<{ source: string; target: string; label?: string }> = [];
  edges.forEach((edge, index) => {
    const from = edge && byDiagramId.get(edge.from);
    const to = edge && byDiagramId.get(edge.to);
    if (!from) return void rejected.push({ index, reason: `edge \`from\` "${edge?.from}" is not a node in this diagram.` });
    if (!to) return void rejected.push({ index, reason: `edge \`to\` "${edge?.to}" is not a node in this diagram.` });
    if (from === to) return void rejected.push({ index, reason: "edge endpoints must differ." });
    g.setEdge(from.canvasId, to.canvasId);
    validEdges.push({ source: from.canvasId, target: to.canvasId, ...(typeof edge.label === "string" && edge.label.trim() ? { label: edge.label.trim() } : {}) });
  });

  dagre.layout(g);

  // Convert centers → top-lefts and find the raw bbox. Keep the semantic diagram node id so the
  // runtime can stamp it on the shape — that's what lets a later edit match this node again.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const placed = new Map<string, { x: number; y: number; w: number; h: number; kind: DiagramNodeKind; label: string; diagramNodeId: string }>();
  for (const [diagramNodeId, n] of byDiagramId) {
    const laid = g.node(n.canvasId);
    const x = laid.x - n.w / 2;
    const y = laid.y - n.h / 2;
    placed.set(n.canvasId, { x, y, w: n.w, h: n.h, kind: n.kind, label: n.label, diagramNodeId });
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + n.w); maxY = Math.max(maxY, y + n.h);
  }

  // Translate so the diagram's top-left lands at the anchor; when framed, inset the contents
  // by the frame padding so the anchor is the frame's corner (not a shape's).
  const insetX = wantFrame ? FRAME_PAD : 0;
  const insetY = wantFrame ? FRAME_TITLE_PAD : 0;
  const dx = anchor.x + insetX - minX;
  const dy = anchor.y + insetY - minY;
  const groupId = wantFrame ? makeId() : null;

  const shapes: LaidOutShape[] = [];
  for (const [canvasId, p] of placed) {
    shapes.push({
      id: canvasId,
      diagramNodeId: p.diagramNodeId,
      spec: {
        shape: KIND_TO_SHAPE[p.kind],
        position: { x: Math.round(p.x + dx), y: Math.round(p.y + dy) },
        size: { w: Math.round(p.w), h: Math.round(p.h) },
        text: p.label,
        ...(groupId ? { groupIds: [groupId] } : {}),
      },
    });
  }

  // Bind each connector to the handles that face the flow: TB routes bottom→top, LR routes
  // right→left. The path itself is floating (recomputed node-to-node), so this is mainly what
  // makes ReactFlow accept the edge; it also picks a sensible entry/exit side.
  const [srcHandle, tgtHandle] = direction === "LR" ? ["wire-right", "wire-left"] : ["wire-bottom", "wire-top"];
  const connectors: LaidOutConnector[] = validEdges.map((e) => ({
    id: makeId(),
    ...e,
    sourceHandle: srcHandle,
    targetHandle: tgtHandle,
  }));

  const contentW = maxX - minX;
  const contentH = maxY - minY;
  let frame: LaidOutShape | null = null;
  let bounds: DiagramLayout["bounds"];
  if (wantFrame && groupId) {
    const fw = Math.round(contentW + FRAME_PAD * 2);
    const fh = Math.round(contentH + FRAME_TITLE_PAD + FRAME_PAD);
    frame = {
      id: makeId(),
      diagramNodeId: "__frame__",
      spec: {
        shape: "rectangle",
        position: { x: anchor.x, y: anchor.y },
        size: { w: fw, h: fh },
        ...(frameTitle ? { areaLabel: frameTitle } : {}),
        // Flat container look (not hand-drawn): straight edges + subtle solid fill.
        style: { sloppiness: "architect", fillStyle: "solid", strokeWidth: 1 },
        groupIds: [groupId],
      },
    };
    bounds = { x: anchor.x, y: anchor.y, w: fw, h: fh };
  } else {
    bounds = { x: anchor.x, y: anchor.y, w: Math.round(contentW), h: Math.round(contentH) };
  }

  return { shapes, connectors, frame, groupId, bounds, rejected };
}
