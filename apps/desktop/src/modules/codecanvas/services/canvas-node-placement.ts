import type { Node } from "@xyflow/react";

export const DEFAULT_TERMINAL_SIZE = { w: 760, h: 520 };
/** Room to write (ADR-0046): a page, not a sticky — tall enough for a title, a paragraph and a list. */
export const DEFAULT_NOTE_SIZE     = { w: 440, h: 520 };
export const DEFAULT_PLAN_SIZE     = { w: 440, h: 360 };
/** Run Node closed card (S8): status + title, meta, brief, progress, one action. */
export const DEFAULT_RUN_NODE_SIZE = { w: 320, h: 196 };
export const DEFAULT_SKILL_SIZE    = { w: 560, h: 620 };
/** Master-detail: a list column plus an in-place SKILL.md reader. Wider and SHORTER
 * than the old list-only panel (420x560), which ran taller than most terminals. */
export const DEFAULT_SKILLS_SIZE   = { w: 720, h: 520 };
export const DEFAULT_TASK_SIZE     = { w: 420, h: 320 };
export const DEFAULT_TEAM_SIZE     = { w: 480, h: 320 };
export const DEFAULT_CONTEXT_SIZE  = { w: 420, h: 340 };
export const DEFAULT_CRITIC_SIZE   = { w: 420, h: 320 };
export const DEFAULT_HUMAN_GATE_SIZE = { w: 420, h: 300 };
export const DEFAULT_BROWSER_SIZE  = { w: 820, h: 580 };
export const DEFAULT_SHAPE_SIZE    = { w: 200, h: 140 };
/** Terminal-agent-sized player: landscape split layout with compact playlist fallback. */
export const DEFAULT_MUSIC_SIZE    = { w: 720, h: 520 };
/** A conversation column, not a terminal: narrow enough to read a line of prose, tall enough
 * that a turn plus its tool steps fit without scrolling on first sight. */
export const DEFAULT_HOST_CELL_SIZE = { w: 480, h: 560 };
export const DEFAULT_FACTORY_NODE_SIZE = { w: 340, h: 200 };
export const DEFAULT_FILE_NODE_SIZE = { w: 560, h: 420 };
export const DEFAULT_FRAME_SIZE = { w: 640, h: 420 };
/** Initial caret box for a text element; it auto-sizes to its content once typed. */
export const DEFAULT_TEXT_SIZE     = { w: 120, h: 40 };

const CHILD_NODE_GAP = 24;
const NODE_COLLISION_PADDING = 16;
const NODE_PLACEMENT_STEP = 24;
const NODE_PLACEMENT_MAX_RINGS = 80;

export type CanvasNodeSize = { w: number; h: number };
export type CanvasPoint = { x: number; y: number };
type CanvasRect = CanvasPoint & CanvasNodeSize;
type NodeWithMeasured = Node & { measured?: { width?: number; height?: number } };
type NodeStyleSize = { width?: number | string; height?: number | string };

function parseSize(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fallbackSizeForNode(node: Node): CanvasNodeSize {
  if (node.type === "terminal") return DEFAULT_TERMINAL_SIZE;
  if (node.type === "note") return DEFAULT_NOTE_SIZE;
  if (node.type === "skill") return DEFAULT_SKILL_SIZE;
  if (node.type === "skills") return DEFAULT_SKILLS_SIZE;
  if (node.type === "agent") return { w: 720, h: 520 };
  if (node.type === "plan") return DEFAULT_PLAN_SIZE;
  if (node.type === "run") return DEFAULT_RUN_NODE_SIZE;
  if (node.type === "task") return DEFAULT_TASK_SIZE;
  if (node.type === "team") return DEFAULT_TEAM_SIZE;
  if (node.type === "context") return DEFAULT_CONTEXT_SIZE;
  if (node.type === "critic") return DEFAULT_CRITIC_SIZE;
  if (node.type === "human-gate") return DEFAULT_HUMAN_GATE_SIZE;
  if (node.type === "browser") return DEFAULT_BROWSER_SIZE;
  if (node.type === "shape") return DEFAULT_SHAPE_SIZE;
  if (node.type === "music") return DEFAULT_MUSIC_SIZE;
  if (node.type === "host-cell") return DEFAULT_HOST_CELL_SIZE;
  if (node.type === "factory") return DEFAULT_FACTORY_NODE_SIZE;
  if (node.type === "file") return DEFAULT_FILE_NODE_SIZE;
  if (node.type === "frame") return DEFAULT_FRAME_SIZE;
  return DEFAULT_NOTE_SIZE;
}

export function getNodeSize(node: Node, fallback = fallbackSizeForNode(node)): CanvasNodeSize {
  const style = node.style as NodeStyleSize | undefined;
  const measured = (node as NodeWithMeasured).measured;
  return {
    w: parseSize(measured?.width) ?? parseSize(node.width) ?? parseSize(style?.width) ?? fallback.w,
    h: parseSize(measured?.height) ?? parseSize(node.height) ?? parseSize(style?.height) ?? fallback.h,
  };
}

function nodeRect(node: Node): CanvasRect {
  const size = getNodeSize(node);
  return { x: node.position.x, y: node.position.y, ...size };
}

function rectsOverlap(a: CanvasRect, b: CanvasRect, padding = NODE_COLLISION_PADDING): boolean {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

export function isFreePosition(position: CanvasPoint, size: CanvasNodeSize, occupiedNodes: readonly Node[]): boolean {
  const candidate = { ...position, ...size };
  return occupiedNodes.every((node) => !rectsOverlap(candidate, nodeRect(node)));
}

function distanceSquared(a: CanvasPoint, b: CanvasPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function findNearestFreePosition(
  preferred: CanvasPoint,
  size: CanvasNodeSize,
  occupiedNodes: readonly Node[],
): CanvasPoint {
  if (isFreePosition(preferred, size, occupiedNodes)) return preferred;

  for (let ring = 1; ring <= NODE_PLACEMENT_MAX_RINGS; ring += 1) {
    const candidates: CanvasPoint[] = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      candidates.push({ x: preferred.x + dx * NODE_PLACEMENT_STEP, y: preferred.y - ring * NODE_PLACEMENT_STEP });
      candidates.push({ x: preferred.x + dx * NODE_PLACEMENT_STEP, y: preferred.y + ring * NODE_PLACEMENT_STEP });
    }
    for (let dy = -ring + 1; dy <= ring - 1; dy += 1) {
      candidates.push({ x: preferred.x - ring * NODE_PLACEMENT_STEP, y: preferred.y + dy * NODE_PLACEMENT_STEP });
      candidates.push({ x: preferred.x + ring * NODE_PLACEMENT_STEP, y: preferred.y + dy * NODE_PLACEMENT_STEP });
    }

    candidates.sort((a, b) =>
      distanceSquared(a, preferred) - distanceSquared(b, preferred) ||
      Math.abs(a.y - preferred.y) - Math.abs(b.y - preferred.y) ||
      a.x - b.x ||
      a.y - b.y,
    );

    const free = candidates.find((candidate) => isFreePosition(candidate, size, occupiedNodes));
    if (free) return free;
  }

  return {
    x: preferred.x + NODE_PLACEMENT_STEP * (occupiedNodes.length + 1),
    y: preferred.y + NODE_PLACEMENT_STEP * (occupiedNodes.length + 1),
  };
}

export function childPositionRightOf(
  parent: Node | undefined,
  childSize: CanvasNodeSize,
  occupiedNodes: readonly Node[],
  fallbackIndex: number,
): CanvasPoint {
  if (!parent) {
    const fallback = { x: 80 + fallbackIndex * 40, y: 80 + fallbackIndex * 40 };
    return findNearestFreePosition(fallback, childSize, occupiedNodes);
  }
  const parentSize = getNodeSize(parent);
  return findNearestFreePosition(
    { x: parent.position.x + parentSize.w + CHILD_NODE_GAP, y: parent.position.y },
    childSize,
    occupiedNodes,
  );
}

/**
 * How far a child may drift from its parent before the placement gives up and
 * overlaps instead. `findNearestFreePosition` sweeps 80 rings — 1920px — which on a
 * busy board parked a Skills node entirely off screen and forced the camera to
 * zoom out to chase it. A child that lands slightly overlapping but beside its
 * parent is strictly better than one the user has to hunt for.
 */
const CHILD_MAX_DRIFT = 520;

/**
 * Place a child beside its parent, trying all four sides before drifting.
 *
 * `childPositionRightOf` only ever proposed the right-hand side, so a taken slot
 * sent it straight into a long ring sweep. Here the sides are tried first (right,
 * below, left, above — reading order for a left-to-right canvas), then a *bounded*
 * sweep, then a small diagonal offset from the preferred slot.
 */
export function childPositionNear(
  parent: Node | undefined,
  childSize: CanvasNodeSize,
  occupiedNodes: readonly Node[],
  fallbackIndex: number,
): CanvasPoint {
  if (!parent) {
    const fallback = cascadePosition(fallbackIndex);
    return findNearestFreePosition(fallback, childSize, occupiedNodes);
  }

  const parentSize = getNodeSize(parent);
  const { x, y } = parent.position;
  const candidates: CanvasPoint[] = [
    { x: x + parentSize.w + CHILD_NODE_GAP, y },
    { x, y: y + parentSize.h + CHILD_NODE_GAP },
    { x: x - childSize.w - CHILD_NODE_GAP, y },
    { x, y: y - childSize.h - CHILD_NODE_GAP },
    // Diagonals: still adjacent, still on screen next to the parent.
    { x: x + parentSize.w + CHILD_NODE_GAP, y: y + parentSize.h + CHILD_NODE_GAP },
    { x: x - childSize.w - CHILD_NODE_GAP, y: y + parentSize.h + CHILD_NODE_GAP },
  ];

  const free = candidates.find((candidate) => isFreePosition(candidate, childSize, occupiedNodes));
  if (free) return free;

  const preferred = candidates[0];
  const swept = findNearestFreePosition(preferred, childSize, occupiedNodes);
  const drift = Math.max(Math.abs(swept.x - preferred.x), Math.abs(swept.y - preferred.y));
  if (drift <= CHILD_MAX_DRIFT) return swept;

  // Everything nearby is taken — sit just off the preferred slot and let the node
  // overlap. Being findable beats being unobstructed.
  return {
    x: preferred.x + NODE_PLACEMENT_STEP,
    y: preferred.y + NODE_PLACEMENT_STEP,
  };
}

/** Cascading placement for a new top-level node, offset by how many nodes already exist. */
export function cascadePosition(count: number): CanvasPoint {
  return { x: 80 + count * 40, y: 80 + count * 40 };
}
