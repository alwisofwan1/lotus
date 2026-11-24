import type { CanvasNodeSize, CanvasNodePosition } from "../types/canvas";
import type { CanvasCreateNodeKind } from "./commands/canvas-command";
import {
  DEFAULT_CONTEXT_SIZE,
  DEFAULT_CRITIC_SIZE,
  DEFAULT_HUMAN_GATE_SIZE,
  DEFAULT_MUSIC_SIZE,
  DEFAULT_NOTE_SIZE,
  DEFAULT_PLAN_SIZE,
  DEFAULT_TASK_SIZE,
  DEFAULT_TEAM_SIZE,
  DEFAULT_TERMINAL_SIZE,
} from "./canvas-node-placement";

export const AGENT_NODE_SIZE: CanvasNodeSize = { w: 720, h: 520 };

/** Real default footprint per create-node kind, so a centred spawn lands centred — not near-centred. */
const CANVAS_NODE_SPAWN_SIZE: Record<CanvasCreateNodeKind, CanvasNodeSize> = {
  terminal: DEFAULT_TERMINAL_SIZE,
  note: DEFAULT_NOTE_SIZE,
  plan: DEFAULT_PLAN_SIZE,
  task: DEFAULT_TASK_SIZE,
  context: DEFAULT_CONTEXT_SIZE,
  critic: DEFAULT_CRITIC_SIZE,
  "human-gate": DEFAULT_HUMAN_GATE_SIZE,
  team: DEFAULT_TEAM_SIZE,
  music: DEFAULT_MUSIC_SIZE,
};

export function canvasNodeSpawnSize(nodeType: CanvasCreateNodeKind): CanvasNodeSize {
  return CANVAS_NODE_SPAWN_SIZE[nodeType];
}

/** Gap between two nodes of the same centre-spawn burst. */
const CENTER_SPAWN_BURST_GAP = 36;
/** Ring order: centre, then the four sides, then the four diagonals. */
const CENTER_SPAWN_BURST_SLOTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/**
 * Offset for the Nth node of a rapid centre-spawn burst, scaled to that node's own footprint so a
 * batch ("open three terminals") fans out around the viewport centre instead of stacking. Clamps at
 * the last slot rather than marching off into empty canvas — the auto-tidy re-tiles a big batch anyway.
 */
export function centerSpawnBurstOffset(size: CanvasNodeSize, count: number): CanvasNodePosition {
  const slot = CENTER_SPAWN_BURST_SLOTS[Math.min(Math.max(count, 0), CENTER_SPAWN_BURST_SLOTS.length - 1)];
  return { x: slot[0] * (size.w + CENTER_SPAWN_BURST_GAP), y: slot[1] * (size.h + CENTER_SPAWN_BURST_GAP) };
}

interface ScreenPoint {
  x: number;
  y: number;
}

/** Minimal slice of the ReactFlow instance needed to place a node. */
export interface FlowProjector {
  screenToFlowPosition(point: ScreenPoint): ScreenPoint;
}

/**
 * Flow-coordinate top-left so a node of `size` is centred on `screen`. The single
 * seam every "place a node" path shares — a click passes the viewport centre today,
 * a future drag-and-drop passes the drop point, with no other change.
 */
export function centeredSpawnPosition(
  flow: FlowProjector | null,
  size: CanvasNodeSize = AGENT_NODE_SIZE,
  screen: ScreenPoint = { x: typeof window !== "undefined" ? window.innerWidth / 2 : 0, y: typeof window !== "undefined" ? window.innerHeight / 2 : 0 },
): CanvasNodePosition | undefined {
  if (!flow) return undefined;
  const point = flow.screenToFlowPosition(screen);
  return { x: point.x - size.w / 2, y: point.y - size.h / 2 };
}
