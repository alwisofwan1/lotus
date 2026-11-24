import type { Edge, Node } from "@xyflow/react";

/**
 * Pure scene read-back: summarize the canvas for an agent so it can EDIT what's already there
 * (e.g. "add an email-verification step to the login flow") rather than only drawing anew. Follows
 * tldraw's tiered model — shapes in view are described in full (id, kind, bounds, text); shapes far
 * outside the viewport (or beyond a cap) collapse into a counted cluster so a huge board doesn't
 * blow the token budget. No React/DOM/store access; the caller passes the live nodes/edges.
 */

export interface SceneBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneShape {
  id: string;
  shape: string;
  bounds: SceneBounds;
  text?: string;
  areaLabel?: string;
  /** The Frame this shape belongs to, when framed. */
  frameId?: string;
}

/** A Frame (named, coloured area) and everything that sits in it, any node kind. */
export interface SceneFrame {
  id: string;
  title: string;
  colorId?: string;
  bounds: SceneBounds;
  members: Array<{ id: string; type: string }>;
}

export interface SceneConnector {
  source: string;
  target: string;
  label?: string;
}

/** A group of shapes not described in detail (off-viewport / beyond the cap). */
export interface SceneCluster {
  count: number;
  bounds: SceneBounds;
}

export interface SceneReadback {
  frames: SceneFrame[];
  shapes: SceneShape[];
  connectors: SceneConnector[];
  clusters: SceneCluster[];
  counts: { shapes: number; connectors: number; otherNodes: number; frames: number };
}

export interface SceneReadbackOptions {
  /** Flow-space visible rect; shapes intersecting it are detailed, the rest clustered. */
  viewport?: SceneBounds;
  /** Cap on detailed shapes (default 60). Overflow collapses into a cluster. */
  maxDetailed?: number;
}

const DEFAULT_MAX_DETAILED = 60;

function nodeBounds(node: Node): SceneBounds {
  const w = node.width ?? node.measured?.width ?? (typeof node.style?.width === "number" ? node.style.width : 0);
  const h = node.height ?? node.measured?.height ?? (typeof node.style?.height === "number" ? node.style.height : 0);
  return { x: node.position.x, y: node.position.y, w, h };
}

function intersects(a: SceneBounds, b: SceneBounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function clusterOf(bounds: SceneBounds[]): SceneCluster | null {
  if (bounds.length === 0) return null;
  const minX = Math.min(...bounds.map((b) => b.x));
  const minY = Math.min(...bounds.map((b) => b.y));
  const maxX = Math.max(...bounds.map((b) => b.x + b.w));
  const maxY = Math.max(...bounds.map((b) => b.y + b.h));
  return { count: bounds.length, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function buildSceneReadback(
  nodes: readonly Node[],
  edges: readonly Edge[],
  options: SceneReadbackOptions,
): SceneReadback {
  const maxDetailed = options.maxDetailed ?? DEFAULT_MAX_DETAILED;
  const shapeNodes = nodes.filter((n) => n.type === "shape");
  const frameNodes = nodes.filter((n) => n.type === "frame");
  const otherNodes = nodes.length - shapeNodes.length - frameNodes.length;

  const frames: SceneFrame[] = frameNodes.map((f) => {
    const data = (f.data ?? {}) as Record<string, unknown>;
    return {
      id: f.id,
      title: str(data.title) ?? "",
      ...(str(data.colorId) ? { colorId: str(data.colorId) } : {}),
      bounds: nodeBounds(f),
      members: nodes
        .filter((n) => n.type !== "frame" && str((n.data as Record<string, unknown> | undefined)?.frameId) === f.id)
        .map((n) => ({ id: n.id, type: n.type ?? "unknown" })),
    };
  });

  // Tier 1: viewport filter (if given). In-view shapes are candidates for detail.
  const detailedNodes: Node[] = [];
  const overflowBounds: SceneBounds[] = [];
  for (const node of shapeNodes) {
    const bounds = nodeBounds(node);
    const inView = !options.viewport || intersects(bounds, options.viewport);
    if (inView && detailedNodes.length < maxDetailed) detailedNodes.push(node);
    else overflowBounds.push(bounds);
  }

  const shapes: SceneShape[] = detailedNodes.map((node) => {
    const data = (node.data ?? {}) as Record<string, unknown>;
    return {
      id: node.id,
      shape: str(data.shape) ?? "rectangle",
      bounds: nodeBounds(node),
      ...(str(data.text) ? { text: str(data.text) } : {}),
      ...(str(data.areaLabel) ? { areaLabel: str(data.areaLabel) } : {}),
      ...(str(data.frameId) ? { frameId: str(data.frameId) } : {}),
    };
  });

  // Connectors are only useful when the agent can reference both endpoints, so keep those whose
  // ends are both detailed shapes.
  const detailedIds = new Set(shapes.map((s) => s.id));
  const connectors: SceneConnector[] = [];
  for (const edge of edges) {
    if (!detailedIds.has(edge.source) || !detailedIds.has(edge.target)) continue;
    const data = (edge.data ?? {}) as Record<string, unknown>;
    const label = str(data.customLabel) ?? (typeof edge.label === "string" ? str(edge.label) : undefined);
    connectors.push({ source: edge.source, target: edge.target, ...(label ? { label } : {}) });
  }

  // Count ALL shape-to-shape connectors (not just the detailed ones) so counts stay consistent with
  // counts.shapes (a total); otherwise an agent under-reads edges on a large/off-viewport board.
  const allShapeIds = new Set(shapeNodes.map((n) => n.id));
  const totalConnectors = edges.reduce((n, e) => (allShapeIds.has(e.source) && allShapeIds.has(e.target) ? n + 1 : n), 0);

  const cluster = clusterOf(overflowBounds);
  return {
    frames,
    shapes,
    connectors,
    clusters: cluster ? [cluster] : [],
    counts: { shapes: shapeNodes.length, connectors: totalConnectors, otherNodes, frames: frames.length },
  };
}
