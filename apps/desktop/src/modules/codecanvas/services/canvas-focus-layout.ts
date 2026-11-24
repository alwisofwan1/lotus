import type { Node } from "@xyflow/react";
import { GRID_GAP, isTiledCanvasNode, type ArrangeBox } from "./canvas-arrange";

/**
 * Focus mode (rail-kanan): the focused node becomes the hero (~75% of the visible area, resized
 * for real so its terminal stays legible) and every other windowed node shrinks into a live
 * thumbnail rail on the right — spotlight, not just a camera zoom. Pure — the caller applies
 * the boxes, animates the glide, and frames the camera; exit restores a snapshot taken on entry.
 */

/** Rail claims ~26% of the visible width, clamped to a readable thumbnail band. A touch wider
 *  than a bare minimum so the live terminal thumbnails stay legible; the hero gives up the slack. */
const RAIL_WIDTH_RATIO = 0.26;
const RAIL_MIN_W = 300;
const RAIL_MAX_W = 420;

/** A thumbnail never squashes below this — past it the rail overflows and the camera zooms out. */
const THUMB_MIN_H = 72;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export interface FocusLayoutOptions {
  /** Visible canvas area in flow coordinates (zoom-1 screen px, matching arrange's fit). */
  fit: { width: number; height: number };
}

/**
 * Boxes for focus mode: hero fills the visible area minus the right rail; the remaining tiled
 * nodes stack down the rail in reading order of their current positions. Anchored at the
 * cluster's current top-left to minimise travel. Returns an empty map when the hero id does not
 * resolve to a tiled node (caller no-ops). With many nodes the rail may run past the fit height —
 * the camera framing (shared with arrange) simply zooms out to keep everything visible.
 */
export function focusCanvasLayout(
  nodes: Node[],
  heroId: string,
  opts: FocusLayoutOptions,
): Map<string, ArrangeBox> {
  const tiles = nodes.filter(isTiledCanvasNode);
  const hero = tiles.find((node) => node.id === heroId);
  if (!hero) return new Map();

  const originX = Math.min(...tiles.map((node) => node.position.x));
  const originY = Math.min(...tiles.map((node) => node.position.y));
  const others = tiles
    .filter((node) => node.id !== heroId)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

  const result = new Map<string, ArrangeBox>();
  const railW = others.length > 0 ? clamp(opts.fit.width * RAIL_WIDTH_RATIO, RAIL_MIN_W, RAIL_MAX_W) : 0;
  const heroW = others.length > 0 ? opts.fit.width - railW - GRID_GAP : opts.fit.width;
  result.set(hero.id, { x: originX, y: originY, width: heroW, height: opts.fit.height });

  if (others.length === 0) return result;
  // Thumbnails evenly divide the FULL visible height so the rail bottom-aligns with the hero —
  // no dead space beneath the last card. Taller thumbnails also surface more live terminal
  // content. Floored at THUMB_MIN_H: once the rail is crowded enough to hit the floor it
  // overflows the fit height and the shared camera framing zooms everything out to fit.
  const thumbH = Math.max(
    THUMB_MIN_H,
    (opts.fit.height - (others.length - 1) * GRID_GAP) / others.length,
  );
  const railX = originX + heroW + GRID_GAP;
  others.forEach((node, i) => {
    result.set(node.id, { x: railX, y: originY + i * (thumbH + GRID_GAP), width: railW, height: thumbH });
  });
  return result;
}

/**
 * Double-clicking a node's chrome enters focus mode — but the canvas is full of surfaces that
 * already own double-click: xterm word-select and editors live in `.canvas-node-body`, the agent
 * rename lives on `.canvas-persona-name` (it does NOT stop propagation), and buttons/handles are
 * their own controls. Only a plain chrome double-click may trigger focus.
 */
const FOCUS_TRIGGER_EXCLUDE =
  'input, textarea, button, [contenteditable="true"], .canvas-node-body, .canvas-persona-name, ' +
  ".canvas-node-resize-handle, .canvas-node-resize-line, .canvas-node-handle";

export function shouldEnterFocusFromDoubleClick(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(FOCUS_TRIGGER_EXCLUDE) === null;
}
