import type { Node, NodeChange } from "@xyflow/react";

/**
 * Excalidraw-style alignment snapping for shape drags. While a single shape is dragged, its
 * edges and center magnetize to the edges/centers of the other shapes within a screen-space
 * threshold, and the alignment is drawn as a guide line. Pure functions — the drag interception
 * lives in useCanvasNodes.handleNodesChange, the guide rendering in CanvasSnapGuides.
 */

export interface SnapBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapGuide {
  orientation: "v" | "h";
  /** The aligned coordinate (x for vertical guides, y for horizontal). */
  at: number;
  /** Extent of the guide along its axis, spanning the moving box and the matched peer. */
  from: number;
  to: number;
}

/** Screen-px magnet radius; divide by zoom for the flow-space threshold. */
export const SNAP_THRESHOLD_PX = 6;

interface AxisSnap {
  delta: number;
  at: number;
  peer: SnapBox;
}

/** Candidate stops along one axis: leading edge, center, trailing edge. */
const stops = (start: number, size: number) => [start, start + size / 2, start + size];

function snapAxis(movingStart: number, movingSize: number, others: SnapBox[], horizontal: boolean, threshold: number): AxisSnap | null {
  let best: AxisSnap | null = null;
  for (const peer of others) {
    const peerStart = horizontal ? peer.x : peer.y;
    const peerSize = horizontal ? peer.w : peer.h;
    for (const m of stops(movingStart, movingSize)) {
      for (const p of stops(peerStart, peerSize)) {
        const delta = p - m;
        if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) {
          best = { delta, at: p, peer };
        }
      }
    }
  }
  return best;
}

export function snapMovingBox(moving: SnapBox, others: SnapBox[], threshold: number): { dx: number; dy: number; guides: SnapGuide[] } {
  const xSnap = snapAxis(moving.x, moving.w, others, true, threshold);
  const ySnap = snapAxis(moving.y, moving.h, others, false, threshold);
  const dx = xSnap?.delta ?? 0;
  const dy = ySnap?.delta ?? 0;
  const snapped: SnapBox = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: SnapGuide[] = [];
  if (xSnap) {
    guides.push({
      orientation: "v",
      at: xSnap.at,
      from: Math.min(snapped.y, xSnap.peer.y),
      to: Math.max(snapped.y + snapped.h, xSnap.peer.y + xSnap.peer.h),
    });
  }
  if (ySnap) {
    guides.push({
      orientation: "h",
      at: ySnap.at,
      from: Math.min(snapped.x, ySnap.peer.x),
      to: Math.max(snapped.x + snapped.w, ySnap.peer.x + ySnap.peer.w),
    });
  }
  return { dx, dy, guides };
}

/** A rendered gap segment: a run of empty space whose length repeats along the axis. */
export interface GapGuide {
  orientation: "h" | "v";
  /** Segment extent along the snap axis. */
  start: number;
  end: number;
  /** Cross-axis coordinate the segment is drawn at (midpoint of the boxes' overlap). */
  cross: number;
}

interface GapSnap {
  delta: number;
  gaps: GapGuide[];
}

/** Midpoint of the cross-axis overlap between two boxes (where the gap segment is drawn). */
function overlapMid(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return (Math.max(aStart, bStart) + Math.min(aEnd, bEnd)) / 2;
}

function snapGapAxis(moving: SnapBox, others: SnapBox[], horizontal: boolean, threshold: number): GapSnap | null {
  const start = (b: SnapBox) => (horizontal ? b.x : b.y);
  const size = (b: SnapBox) => (horizontal ? b.w : b.h);
  const crossStart = (b: SnapBox) => (horizontal ? b.y : b.x);
  const crossSize = (b: SnapBox) => (horizontal ? b.h : b.w);
  const orientation = horizontal ? "h" : "v";
  // Only peers sharing the moving box's row/column take part in spacing.
  const lane = others.filter((p) =>
    Math.min(crossStart(p) + crossSize(p), crossStart(moving) + crossSize(moving)) -
      Math.max(crossStart(p), crossStart(moving)) > 0,
  ).sort((a, b) => start(a) - start(b));
  const movingSize = size(moving);
  const cross = (a: SnapBox, b: SnapBox) =>
    overlapMid(crossStart(a), crossStart(a) + crossSize(a), crossStart(b), crossStart(b) + crossSize(b));
  const seg = (s: number, e: number, c: number): GapGuide => ({ orientation, start: s, end: e, cross: c });

  let best: GapSnap | null = null;
  const consider = (target: number, gaps: (snapped: SnapBox) => GapGuide[]) => {
    const delta = target - start(moving);
    if (Math.abs(delta) > threshold) return;
    if (best && Math.abs(best.delta) <= Math.abs(delta)) return;
    const snapped: SnapBox = horizontal ? { ...moving, x: target } : { ...moving, y: target };
    best = { delta, gaps: gaps(snapped) };
  };

  for (let i = 0; i < lane.length - 1; i++) {
    const a = lane[i];
    const b = lane[i + 1];
    const gap = start(b) - (start(a) + size(a));
    if (gap < 0) continue; // overlapping pair — no spacing to repeat
    // Repeat the A↔B gap after B…
    consider(start(b) + size(b) + gap, (m) => [
      seg(start(a) + size(a), start(b), cross(a, b)),
      seg(start(b) + size(b), start(m), cross(b, m)),
    ]);
    // …or before A…
    consider(start(a) - gap - movingSize, (m) => [
      seg(start(m) + movingSize, start(a), cross(m, a)),
      seg(start(a) + size(a), start(b), cross(a, b)),
    ]);
    // …or center the moving box between A and B so both gaps come out equal.
    if (gap >= movingSize) {
      consider(start(a) + size(a) + (gap - movingSize) / 2, (m) => [
        seg(start(a) + size(a), start(m), cross(a, m)),
        seg(start(m) + movingSize, start(b), cross(m, b)),
      ]);
    }
  }
  return best;
}

/**
 * Equal-spacing snapping (Figma gap guides): while dragging, the box magnetizes to positions
 * where its gap to the neighbouring shapes repeats an existing gap in the same row/column —
 * extending a sequence on either end, or centering between two peers. Returns the axis deltas
 * plus the gap segments to render.
 */
export function snapGapMovingBox(moving: SnapBox, others: SnapBox[], threshold: number): { dx: number; dy: number; gaps: GapGuide[] } {
  const xSnap = snapGapAxis(moving, others, true, threshold);
  const movedX: SnapBox = { ...moving, x: moving.x + (xSnap?.delta ?? 0) };
  const ySnap = snapGapAxis(movedX, others, false, threshold);
  return {
    dx: xSnap?.delta ?? 0,
    dy: ySnap?.delta ?? 0,
    gaps: [...(xSnap?.gaps ?? []), ...(ySnap?.gaps ?? [])],
  };
}

/** A rotated shape's axis-aligned bbox no longer matches its visual edges — it neither snaps
 *  nor attracts (Excalidraw does the same). */
const isRotated = (n: Node): boolean => {
  const angle = (n.data as { angle?: number } | undefined)?.angle;
  return typeof angle === "number" && angle !== 0;
};

const shapeBox = (n: Node): SnapBox | null =>
  n.width && n.height ? { x: n.position.x, y: n.position.y, w: n.width, h: n.height } : null;

/**
 * Intercept ReactFlow drag changes: a SINGLE dragged, ungrouped shape gets its position
 * magnetized against the other shapes. Multi-selection and grouped drags pass through — their
 * siblings follow one frame behind, so snapping the leader would tear the formation. Returns the
 * (possibly adjusted) changes plus the guides to render; guides are empty once dragging ends.
 */
export function snapDragChanges(changes: NodeChange[], nodes: Node[], threshold: number): { changes: NodeChange[]; guides: SnapGuide[]; gaps: GapGuide[] } {
  const none = { changes, guides: [] as SnapGuide[], gaps: [] as GapGuide[] };
  const dragChanges = changes.filter((c) => c.type === "position");
  if (dragChanges.length !== 1) return none;
  const change = dragChanges[0] as Extract<NodeChange, { type: "position" }>;
  if (!change.position) return none;
  const node = nodes.find((n) => n.id === change.id);
  if (!node || node.type !== "shape") return none;
  if (isRotated(node)) return none;
  const movingBox = node.width && node.height
    ? { x: change.position.x, y: change.position.y, w: node.width, h: node.height }
    : null;
  if (!movingBox) return none;
  const peers = nodes
    .filter((n) => n.type === "shape" && n.id !== node.id && !isRotated(n))
    .map(shapeBox)
    .filter((b): b is SnapBox => b !== null);
  const edge = snapMovingBox(movingBox, peers, threshold);
  let { dx, dy } = edge;
  // Gap snapping fills whichever axis edge alignment left free — an edge stop is the stronger,
  // more predictable magnet, so it always wins its axis.
  const xEdgeSnapped = edge.guides.some((g) => g.orientation === "v");
  const yEdgeSnapped = edge.guides.some((g) => g.orientation === "h");
  let gaps: GapGuide[] = [];
  if (!xEdgeSnapped || !yEdgeSnapped) {
    const gap = snapGapMovingBox({ ...movingBox, x: movingBox.x + dx, y: movingBox.y + dy }, peers, threshold);
    if (!xEdgeSnapped && gap.dx !== 0) {
      dx += gap.dx;
      gaps = gaps.concat(gap.gaps.filter((g) => g.orientation === "h"));
    }
    if (!yEdgeSnapped && gap.dy !== 0) {
      dy += gap.dy;
      gaps = gaps.concat(gap.gaps.filter((g) => g.orientation === "v"));
    }
  }
  // XYDrag's final change (dragging: false) carries the RAW drag coords, so it must snap too or
  // it overwrites the snapped position on release — but its guides are gone: the drag is over.
  const visibleGuides = change.dragging ? edge.guides : [];
  const visibleGaps = change.dragging ? gaps : [];
  if (dx === 0 && dy === 0) return { changes, guides: visibleGuides, gaps: visibleGaps };
  const snappedChanges = changes.map((c) =>
    c === change ? { ...change, position: { x: movingBox.x + dx, y: movingBox.y + dy } } : c,
  );
  return { changes: snappedChanges, guides: visibleGuides, gaps: visibleGaps };
}
