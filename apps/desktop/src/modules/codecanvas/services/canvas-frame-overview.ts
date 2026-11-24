import type { Node } from "@xyflow/react";
import { frameOccupiedBox } from "./canvas-frame-geometry";
import { frameIdOf, frameMembers, frameTitleOf, isFrameNode } from "./canvas-frames";
import { buildFrameSwitcher } from "./canvas-frame-switcher";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import type { LayoutBounds, VisibleCanvasArea } from "./viewport/canvas-visible-frame";

/**
 * Frame Overview (ADR-0050, LOT2-125): the live canvas zoomed out to every Frame. Pure geometry,
 * ordering and copy; the camera, keys and overlay live in CanvasPage and the overview layer.
 */

/** Ephemeral session-only nodes (skills browser): not part of what the overview frames. */
const EPHEMERAL = new Set(["skill", "skills"]);

export type OverviewDirection = "left" | "right" | "up" | "down";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectOf(n: Node): Rect {
  return {
    x: n.position.x,
    y: n.position.y,
    w: n.measured?.width ?? n.width ?? 0,
    h: n.measured?.height ?? n.height ?? 0,
  };
}

/** The whole-canvas region the overview frames: every Frame plus loose nodes, else all nodes. */
export function overviewBounds(nodes: readonly Node[]): LayoutBounds | null {
  const real = nodes.filter((n) => !EPHEMERAL.has(n.type ?? ""));
  const frames = real.filter(isFrameNode);
  // Members sit inside their Frame, so only loose nodes add to the union.
  const subjects = frames.length > 0 ? [...frames, ...real.filter((n) => !isFrameNode(n) && frameIdOf(n) === undefined)] : real;
  if (subjects.length === 0) return null;
  // A Frame's title tab sits above its box (decision 35): the overview must frame it too.
  const rects = subjects.map((n) => (isFrameNode(n) ? frameOccupiedBox(rectOf(n)) : rectOf(n)));
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { minX, minY, width: maxX - minX, height: maxY - minY };
}

const centreOf = (n: Node) => {
  const r = rectOf(n);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
};

/** The Frame an arrow key moves focus to: nearest in that direction, cross-axis drift weighs double. */
export function moveFrameFocus(frames: readonly Node[], currentId: string | null, dir: OverviewDirection): string | null {
  if (frames.length === 0) return null;
  const current = currentId ? frames.find((f) => f.id === currentId) : undefined;
  if (!current) return frames[0].id;
  const from = centreOf(current);
  let best: { id: string; cost: number } | null = null;
  for (const frame of frames) {
    if (frame.id === current.id) continue;
    const c = centreOf(frame);
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const along = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    if (along <= 0) continue;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const cost = along + across * 2;
    if (!best || cost < best.cost) best = { id: frame.id, cost };
  }
  return best?.id ?? current.id;
}

/**
 * Scale that keeps a Frame's title tab at its normal on-screen size (1/zoom). The cap is the scale
 * at the lowest zoom the overview can reach (`minZoom`), so a title is never shrunk below readable
 * there: a fixed cap would let it go small exactly where the canvas is most zoomed out.
 */
export function overviewTitleScale(zoom: number, minZoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  const cap = Number.isFinite(minZoom) && minZoom > 0 ? 1 / minZoom : 1 / zoom;
  return Math.min(cap, Math.max(1, 1 / zoom));
}

/**
 * Node ids to quietly dim while one Frame is lit (decision 44): every other Frame, its members and loose
 * nodes. Empty when nothing is lit, so an Overview with no hover looks even.
 */
export function overviewDimmedNodeIds(nodes: readonly Node[], litFrameId: string | null): string[] {
  if (!litFrameId) return [];
  return nodes.filter((n) => n.id !== litFrameId && frameIdOf(n) !== litFrameId).map((n) => n.id);
}

/** The Frame under a flow-space point (the later one wins where Frames overlap), or null. */
export function frameAtPoint(nodes: readonly Node[], point: { x: number; y: number }): string | null {
  let hit: string | null = null;
  for (const frame of nodes.filter(isFrameNode)) {
    const r = rectOf(frame);
    if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h) hit = frame.id;
  }
  return hit;
}

/**
 * "01 · 4 nodes", or "02 · needs you" when an agent inside is waiting (mockup 7). `numbered: false` drops the
 * chip number for an auto-named Frame whose name already says it ("Frame 1", decision 46): "4 nodes".
 */
export function frameOverviewLabel(index: number, memberCount: number, needsYou = false, numbered = true): string {
  const num = String(index + 1);
  const status = needsYou ? "needs you" : `${memberCount} ${memberCount === 1 ? "node" : "nodes"}`;
  return numbered ? `${num} · ${status}` : status;
}

/** True when the Frame's name is the auto name for its own chip number ("Frame 3" on chip 03). */
function titleCarriesNumber(nodes: readonly Node[], frameId: string, chipNumber: number): boolean {
  const frame = nodes.find((n) => n.id === frameId);
  return !!frame && frameTitleOf(frame) === `Frame ${chipNumber}`;
}

export interface FrameOverviewLabel {
  text: string;
  needsYou: boolean;
}

/**
 * The label every Frame wears in the overview. Number and status come from the Frame Switcher's own
 * model (chips plus overflow), so the two surfaces cannot disagree about which Frame is 03 or which
 * one needs you.
 */
export function buildFrameOverviewLabels(
  nodes: readonly Node[],
  snapshots: ReadonlyArray<Pick<AgentStatusSnapshot, "id" | "status">>,
): Record<string, FrameOverviewLabel> {
  const { chips, overflow } = buildFrameSwitcher(nodes, snapshots);
  const labels: Record<string, FrameOverviewLabel> = {};
  for (const chip of [...chips, ...overflow]) {
    labels[chip.frameId] = {
      text: frameOverviewLabel(
        chip.index - 1,
        frameMembers(nodes, chip.frameId).length,
        chip.needsYou,
        !titleCarriesNumber(nodes, chip.frameId, chip.index),
      ),
      needsYou: chip.needsYou,
    };
  }
  return labels;
}

export interface FitOptions {
  minZoom: number;
  maxZoom: number;
  /** Screen px kept clear around the bounds, inside the area. */
  margin: number;
}

/** Viewport that centres `bounds` in `area` at the largest zoom in [minZoom, maxZoom] that fits. */
export function fitBoundsInArea(
  bounds: LayoutBounds,
  area: VisibleCanvasArea,
  { minZoom, maxZoom, margin }: FitOptions,
): { x: number; y: number; zoom: number } {
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);
  const fit = Math.min((area.width - margin * 2) / w, (area.height - margin * 2) / h);
  const zoom = Math.min(maxZoom, Math.max(minZoom, fit));
  return {
    zoom,
    x: area.left + (area.width - bounds.width * zoom) / 2 - bounds.minX * zoom,
    y: area.top + (area.height - bounds.height * zoom) / 2 - bounds.minY * zoom,
  };
}
