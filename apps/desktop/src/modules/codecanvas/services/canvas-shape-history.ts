import type { Edge, Node } from "@xyflow/react";
import { captureMemberships } from "./canvas-frames";

/**
 * Whiteboard undo/redo model. History is scoped to `shape` nodes on purpose: shapes are pure
 * data, so restoring them has no runtime side effects — unlike terminals/agents, whose creation
 * and removal manage PTY sessions. Each history entry stores the shape subset before and after a
 * mutation as {node, index} placements (index = position in the FULL nodes array, preserving the
 * paint-order interleave with non-shape nodes). Node objects are shared by reference, so entries
 * are cheap. Pure module; the idle-coalescing and keyboard wiring live in useShapeHistory.
 */

/** Pure-data nodes history may restore wholesale: shapes, and Frames (a Frame has no runtime). */
const isHistoryNode = (n: Node): boolean => n.type === "shape" || n.type === "frame";

export interface ShapePlacement {
  node: Node;
  index: number;
}

/** The shape subset of the board, with each shape's position in the full array. */
export function captureShapes(nodes: Node[]): ShapePlacement[] {
  const placements: ShapePlacement[] = [];
  nodes.forEach((node, index) => {
    if (isHistoryNode(node)) placements.push({ node, index });
  });
  return placements;
}

/** What history cares about on a node: its geometry and its data. Selection and drag flags flip
 *  node identity in ReactFlow without meaning anything to undo — clicking a shape must never
 *  spend an undo step. `data` compares by identity: every real mutation replaces it. */
function nodesEquivalent(a: Node, b: Node): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    (a.width ?? null) === (b.width ?? null) &&
    (a.height ?? null) === (b.height ?? null) &&
    a.data === b.data
  );
}

export function shapePlacementsEqual(a: ShapePlacement[], b: ShapePlacement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.index === b[i].index && nodesEquivalent(p.node, b[i].node));
}

/**
 * Rebuild the nodes array with the recorded shape subset: current shapes are dropped, recorded
 * shapes are inserted back at their recorded indices (clamped), non-shape nodes keep their
 * current state and relative order. Restored shapes come back deselected so an undo never
 * resurrects a phantom selection.
 */
export function restoreShapes(nodes: Node[], placements: ShapePlacement[]): Node[] {
  const rest = nodes.filter((n) => !isHistoryNode(n));
  const out: Node[] = [...rest];
  for (const { node, index } of placements) {
    const restored = node.selected ? { ...node, selected: false } : node;
    out.splice(Math.min(index, out.length), 0, restored);
  }
  return out;
}

/** A shape's connectors ride with it: the snapshot pairs the shape subset with every edge whose
 *  BOTH endpoints are shapes, so undoing an erased shape brings its connectors back too. Edges
 *  touching a workflow node are never history-managed (their lifecycles carry runtime meaning). */
export interface ShapeSnapshot {
  placements: ShapePlacement[];
  edges: Edge[];
  /** Frame membership of every non-shape node (ADR-0050): node id -> Frame id, "" when loose. A membership flip
   *  is pure data, so terminals/agents are safe to re-point even though they are not otherwise
   *  history-managed. */
  memberships: Record<string, string>;
  /** Box of every non-history node inside a Frame: a Frame drag moves its members too, so undoing it must put
   *  them back with it, or ⌘Z splits a Frame from what it holds. Loose windows stay out of history. */
  geometry: Record<string, MemberBox>;
}

export interface MemberBox {
  x: number;
  y: number;
  width: number | null;
  height: number | null;
}

function captureMemberGeometry(nodes: Node[]): Record<string, MemberBox> {
  const out: Record<string, MemberBox> = {};
  for (const n of nodes) {
    if (isHistoryNode(n) || !(n.data as { frameId?: unknown } | undefined)?.frameId) continue;
    out[n.id] = { x: n.position.x, y: n.position.y, width: n.width ?? null, height: n.height ?? null };
  }
  return out;
}

/** Put the recorded box back on each member the snapshot knows; windows opened since keep theirs. */
export function restoreMemberGeometry(nodes: Node[], geometry: Record<string, MemberBox>): Node[] {
  return nodes.map((n) => {
    const box = geometry[n.id];
    if (!box || isHistoryNode(n)) return n;
    if (n.position.x === box.x && n.position.y === box.y && (n.width ?? null) === box.width && (n.height ?? null) === box.height) return n;
    const next: Node = { ...n, position: { x: box.x, y: box.y } };
    if (box.width !== null && box.height !== null) {
      next.width = box.width;
      next.height = box.height;
      next.style = { ...n.style, width: box.width, height: box.height };
    }
    return next;
  });
}

export function captureShapeSnapshot(nodes: Node[], edges: Edge[]): ShapeSnapshot {
  const placements = captureShapes(nodes);
  const shapeIds = new Set(placements.map((p) => p.node.id));
  return {
    placements,
    edges: edges.filter((e) => shapeIds.has(e.source) && shapeIds.has(e.target)),
    memberships: captureMemberships(nodes),
    geometry: captureMemberGeometry(nodes),
  };
}

/** Like nodesEquivalent: endpoints, handles, label and data matter; selection flips don't. */
function edgesEquivalent(a: Edge, b: Edge): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.source === b.source &&
    a.target === b.target &&
    (a.sourceHandle ?? null) === (b.sourceHandle ?? null) &&
    (a.targetHandle ?? null) === (b.targetHandle ?? null) &&
    (a.label ?? null) === (b.label ?? null) &&
    a.data === b.data
  );
}

/** Only nodes present in both snapshots can have changed Frame: arrivals (spawns) and departures are not steps. */
function membershipsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).every((k) => !(k in b) || a[k] === b[k]);
}

/** Same rule as memberships: only a member in both snapshots can have moved. */
function geometryEqual(a: Record<string, MemberBox>, b: Record<string, MemberBox>): boolean {
  return Object.keys(a).every((k) => {
    const p = a[k], q = b[k];
    return !q || (p.x === q.x && p.y === q.y && p.width === q.width && p.height === q.height);
  });
}

export function shapeSnapshotsEqual(a: ShapeSnapshot, b: ShapeSnapshot): boolean {
  if (!shapePlacementsEqual(a.placements, b.placements)) return false;
  if (!membershipsEqual(a.memberships, b.memberships)) return false;
  if (!geometryEqual(a.geometry, b.geometry)) return false;
  if (a.edges.length !== b.edges.length) return false;
  return a.edges.every((e, i) => edgesEquivalent(e, b.edges[i]));
}

/** Swap the shape-connector subset for the snapshot's: current shape↔shape edges are dropped,
 *  the snapshot's come back, and every edge touching a non-shape node is left alone. */
export function restoreShapeEdges(currentEdges: Edge[], currentNodes: Node[], snapshotEdges: Edge[]): Edge[] {
  const shapeIds = new Set(currentNodes.filter((n) => n.type === "shape").map((n) => n.id));
  return [
    ...currentEdges.filter((e) => !(shapeIds.has(e.source) && shapeIds.has(e.target))),
    ...snapshotEdges,
  ];
}

interface ShapeHistoryEntry {
  before: ShapeSnapshot;
  after: ShapeSnapshot;
}

export interface ShapeHistory {
  /** Record one mutation. A no-op (equal before/after) is skipped; recording clears the redo branch. */
  record(before: ShapeSnapshot, after: ShapeSnapshot): void;
  /** Step back: returns the snapshot to restore, or null when at the bottom. */
  undo(): ShapeSnapshot | null;
  /** Step forward: returns the snapshot to restore, or null when at the top. */
  redo(): ShapeSnapshot | null;
}

export function createShapeHistory(cap = 100): ShapeHistory {
  const entries: ShapeHistoryEntry[] = [];
  // Number of entries currently applied; entries[cursor..] is the redo branch.
  let cursor = 0;
  return {
    record(before, after) {
      if (shapeSnapshotsEqual(before, after)) return;
      entries.splice(cursor); // drop the redo branch
      entries.push({ before, after });
      if (entries.length > cap) entries.shift();
      cursor = entries.length;
    },
    undo() {
      if (cursor === 0) return null;
      cursor -= 1;
      return entries[cursor].before;
    },
    redo() {
      if (cursor >= entries.length) return null;
      const entry = entries[cursor];
      cursor += 1;
      return entry.after;
    },
  };
}
