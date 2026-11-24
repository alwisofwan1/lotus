import type { Node, XYPosition } from "@xyflow/react";
import { FRAME_PAD, FRAME_TAB_STRIP } from "./canvas-frame-geometry";
import { frameIdOf, isFrameNode } from "./canvas-frames";

/** Fallback footprint when ReactFlow has not measured a node yet. */
const DEFAULT_NODE_W = 420;
const DEFAULT_NODE_H = 320;

/** Legibility floor for every cell (both modes) — below this a terminal is unusable, so the
 * grid overflows the pane and the camera zooms out instead. The MAX caps apply only to the
 * headless fallback (no fit): fit mode fills the pane edge-to-edge, bounded by
 * {@link CELL_MAX_ASPECT} rather than absolute pixels. */
const CELL_MIN_W = 420;
const CELL_MAX_W = 780;
const CELL_MIN_H = 320;
const CELL_MAX_H = 580;

/** Gap between cells — snug, modern tiling (windows nearly touch, CNVS-style). */
export const GRID_GAP = 16;

/** Fallback grid aspect (landscape) when no viewport is supplied (tests / headless). */
const DEFAULT_ASPECT = 1.6;

/** Node kinds that are not windows: free-form drawings, and Frames (areas that wrap windows). */
const NON_TILED_TYPES = new Set(["shape", "frame"]);

/**
 * Card-sized node kinds that pack two-per-cell (adaptive packing). Classification MUST be
 * by type, not by measured size: one uniform arrange used to resize every node to the cell,
 * so a size-based check would misclass everything on the second arrange. Unknown types
 * default to hero — the safe direction (a full cell of its own).
 */
const SMALL_NODE_TYPES = new Set(["note", "task", "plan", "run", "context", "critic", "human-gate", "team"]);

/** A solo small node keeps a card-like height instead of inflating to the hero cell. */
const SOLO_SMALL_HEIGHT_RATIO = 0.55;

/** A short final row stretches into the slack, but never into fullscreen-wide cells (headless fallback only). */
const LAST_ROW_STRETCH_CAP = 1.5;

/**
 * Widest a fill-grid cell may go relative to its height before it stops stretching
 * (a solo terminal on a 32:9 pane must not become a screen-wide ribbon). When the cap
 * bites, the residue centers — the one place a margin beats an unreadable cell.
 */
const CELL_MAX_ASPECT = 2.8;

/** Duration of the glide-to-grid animation (ms). The viewport reframe runs just after. */
export const ARRANGE_ANIM_MS = 620;

/** easeOutCubic — kept for API compatibility; now a quartic glide for a softer game-camera settle. */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - c, 4);
}

/** Interpolate one position from start→target at progress `k` (0..1). */
export function lerpPosition(start: XYPosition, target: XYPosition, k: number): XYPosition {
  return { x: start.x + (target.x - start.x) * k, y: start.y + (target.y - start.y) * k };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function nodeWidth(node: Node): number {
  return node.width ?? node.measured?.width ?? DEFAULT_NODE_W;
}

function nodeHeight(node: Node): number {
  return node.height ?? node.measured?.height ?? DEFAULT_NODE_H;
}

/** A node's target slot after arranging: top-left position + the uniform cell size. */
export interface ArrangeBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArrangeOptions {
  /**
   * Available canvas area in flow coordinates (viewport size ÷ zoom, minus chrome). When given,
   * cells are sized to fill this area so the grid matches the desktop; otherwise the cell is the
   * largest node, clamped.
   */
  fit?: { width: number; height: number };
}

/**
 * Choose the column count that packs `n` cells tightest for a given viewport aspect.
 *
 * Searches a small window around the aspect-ideal `√(n·aspect)` and picks the option with the
 * fewest wasted cells (`cols·rows − n`), tie-breaking toward the ideal. This makes 8→4×2, 6→3×2,
 * 4→2×2 pack perfectly on a wide screen instead of `ceil(√n)`'s square grid (which holes 8 into
 * 3×3). Pure + deterministic. Any remainder is absorbed by the last-row stretch in the packer.
 */
function chooseColumns(n: number, aspect: number): number {
  if (n <= 1) return 1;
  const ideal = Math.sqrt(n * Math.max(0.2, aspect));
  const lo = Math.max(1, Math.round(ideal) - 1);
  const hi = Math.min(n, Math.round(ideal) + 1);
  let best = lo;
  let bestScore = Infinity;
  for (let cols = lo; cols <= hi; cols++) {
    const rows = Math.ceil(n / cols);
    const waste = cols * rows - n;
    // Waste dominates; aspect distance breaks ties between equally-tight options.
    const score = waste * 100 + Math.abs(cols - ideal);
    if (score < bestScore) {
      bestScore = score;
      best = cols;
    }
  }
  return best;
}

function isSmallNode(node: Node): boolean {
  return SMALL_NODE_TYPES.has(node.type ?? "");
}

/**
 * Windowed nodes participate in arrange/focus layouts; free-form shapes never do. Nor does an open
 * Run Node (#74): its outline stands in for the card, whose box is hidden — tiling it left an empty cell.
 */
export function isTiledCanvasNode(node: Node): boolean {
  if (node.type === "run" && (node.data as { open?: unknown } | undefined)?.open === true) return false;
  return !NON_TILED_TYPES.has(node.type ?? "");
}

/**
 * Tidy the canvas into a clean, gap-free grid (the NL bar's "arrange the canvas").
 *
 * Adaptive packing: hero windows (terminals, agents, browsers…) each take a full cell; two
 * consecutive small cards (notes, tasks…) share one cell stacked vertically, and a solo small
 * keeps a card-like height instead of inflating to hero size. With `fit` the cell is the exact
 * division of the visible area (fill grid, tiling-WM style — node natural sizes have no say),
 * floored at legibility and width-capped at {@link CELL_MAX_ASPECT}; without `fit` (headless)
 * the cell is sized from the hero nodes only, clamped. {@link chooseColumns} picks an
 * aspect-aware column count over the resulting SLOTS (fewer slots → tighter grid → less camera
 * zoom-out), and a short final row stretches edge-to-edge (fit) or into capped slack (headless)
 * instead of leaving a hole.
 * Nodes are placed in reading order of their current positions, anchored at the cluster's
 * top-left, to minimise travel; pairing only joins smalls that are consecutive in that order,
 * preserving spatial memory. Free-form shapes are skipped. Pure — the caller applies + animates.
 */
function gridBoxes(tiles: Node[], opts: ArrangeOptions): Map<string, ArrangeBox> {
  if (tiles.length === 0) return new Map();

  const originX = Math.min(...tiles.map((node) => node.position.x));
  const originY = Math.min(...tiles.map((node) => node.position.y));

  // Reading order keeps the visually top-left node top-left in the grid (stable, intentional).
  const ordered = [...tiles].sort((a, b) =>
    a.position.y - b.position.y || a.position.x - b.position.x,
  );

  // Slots: a hero alone, a consecutive small pair sharing, or a solo small.
  const slots: Node[][] = [];
  for (let i = 0; i < ordered.length; i++) {
    if (isSmallNode(ordered[i]) && i + 1 < ordered.length && isSmallNode(ordered[i + 1])) {
      slots.push([ordered[i], ordered[i + 1]]);
      i++;
    } else {
      slots.push([ordered[i]]);
    }
  }
  const slotCount = slots.length;

  const aspect = opts.fit ? opts.fit.width / opts.fit.height : DEFAULT_ASPECT;
  const cols = chooseColumns(slotCount, aspect);
  const rows = Math.ceil(slotCount / cols);

  // Fill grid (fit mode): cells are the exact division of the visible area — tiling-WM
  // style, the only empty space left is the deliberate GRID_GAP. Headless fallback (no
  // fit) keeps the old rule: cell from the hero nodes only (small cards must not inflate
  // the grid they share), clamped.
  const heroes = tiles.filter((node) => !isSmallNode(node));
  const sizing = heroes.length > 0 ? heroes : tiles;
  // The legibility floor wins over a perfect fill on cramped panes: the grid then
  // overflows the area and the camera framing absorbs it by zooming out.
  const cellW = opts.fit
    ? Math.max(CELL_MIN_W, (opts.fit.width - (cols - 1) * GRID_GAP) / cols)
    : clamp(Math.max(...sizing.map(nodeWidth)), CELL_MIN_W, CELL_MAX_W);
  const cellH = opts.fit
    ? Math.max(CELL_MIN_H, (opts.fit.height - (rows - 1) * GRID_GAP) / rows)
    : clamp(Math.max(...sizing.map(nodeHeight)), CELL_MIN_H, CELL_MAX_H);
  const gridW = opts.fit ? opts.fit.width : cellW * cols + (cols - 1) * GRID_GAP;

  const result = new Map<string, ArrangeBox>();
  slots.forEach((slot, i) => {
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    const countInRow = Math.min(cols, slotCount - row * cols);
    let slotW = cellW;
    let rowOffsetX = 0;
    if (opts.fit) {
      // Fill grid: every row splits the full grid width — a short final row stretches
      // edge-to-edge instead of leaving a hole. The readable-aspect cap bites only on
      // extreme panes; its residue centers.
      slotW = Math.min(
        Math.max(CELL_MIN_W, (gridW - (countInRow - 1) * GRID_GAP) / countInRow),
        CELL_MAX_ASPECT * cellH,
      );
      rowOffsetX = (gridW - (slotW * countInRow + (countInRow - 1) * GRID_GAP)) / 2;
    } else if (countInRow < cols) {
      // Headless fallback: short final row stretches into the slack (capped), centered.
      slotW = Math.min(cellW * LAST_ROW_STRETCH_CAP, (gridW - (countInRow - 1) * GRID_GAP) / countInRow);
      rowOffsetX = (gridW - (slotW * countInRow + (countInRow - 1) * GRID_GAP)) / 2;
    }
    const x = originX + rowOffsetX + col * (slotW + GRID_GAP);
    const y = originY + row * (cellH + GRID_GAP);
    if (slot.length === 2) {
      const half = (cellH - GRID_GAP) / 2;
      result.set(slot[0].id, { x, y, width: slotW, height: half });
      result.set(slot[1].id, { x, y: y + half + GRID_GAP, width: slotW, height: half });
    } else if (isSmallNode(slot[0])) {
      result.set(slot[0].id, { x, y, width: slotW, height: Math.round(cellH * SOLO_SMALL_HEIGHT_RATIO) });
    } else {
      result.set(slot[0].id, { x, y, width: slotW, height: cellH });
    }
  });
  return result;
}

/**
 * Tile just `nodes` (windows only; shapes are skipped) with the same adaptive grid and `fit` rule as
 * {@link arrangeCanvasNodes}. Scoped arrange: used to focus a Frame, where only its members move.
 * The grid is anchored at the nodes' own top-left, so the caller translates it where it wants it.
 */
export function arrangeNodeSet(nodes: Node[], opts: ArrangeOptions = {}): Map<string, ArrangeBox> {
  return gridBoxes(nodes.filter(isTiledCanvasNode), opts);
}

/** Gap between top-level blocks (Frames) — wider than the in-grid gap so Frames read as separate areas. */
const BLOCK_GAP = GRID_GAP + FRAME_TAB_STRIP;
/** Row width for Frame blocks when there is neither a loose grid nor a viewport to match. */
const FALLBACK_ROW_WIDTH = 1800;

const memberOf = frameIdOf;

function boundsOf(boxes: Iterable<ArrangeBox>): { x: number; y: number; right: number; bottom: number } | null {
  let b: { x: number; y: number; right: number; bottom: number } | null = null;
  for (const box of boxes) {
    b = b
      ? { x: Math.min(b.x, box.x), y: Math.min(b.y, box.y), right: Math.max(b.right, box.x + box.width), bottom: Math.max(b.bottom, box.y + box.height) }
      : { x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height };
  }
  return b;
}

/** One Frame laid out in its own local space (Frame top-left = 0,0), ready to be placed. */
interface FrameBlock {
  frame: Node;
  size: { width: number; height: number };
  /** Member boxes relative to the Frame's top-left. */
  local: Map<string, ArrangeBox>;
}

/**
 * Lay a Frame out locally. Its window members are tidied into the same adaptive grid the canvas
 * uses, inset by the Frame padding; shape members keep their offset from the Frame's corner and
 * size (they are annotations, never tiled). The Frame grows to cover both. A Frame with no window
 * members is a rigid block: same size, shapes keep their offsets.
 */
function layoutFrameBlock(frame: Node, members: Node[]): FrameBlock {
  const windows = members.filter(isTiledCanvasNode);
  const shapes = members.filter((m) => !isTiledCanvasNode(m));
  const local = new Map<string, ArrangeBox>();
  const insetX = FRAME_PAD;
  const insetY = FRAME_PAD;

  let width = nodeWidth(frame);
  let height = nodeHeight(frame);
  if (windows.length > 0) {
    const grid = gridBoxes(windows, {});
    const gb = boundsOf(grid.values())!;
    for (const [id, b] of grid) local.set(id, { x: b.x - gb.x + insetX, y: b.y - gb.y + insetY, width: b.width, height: b.height });
    width = gb.right - gb.x + insetX + FRAME_PAD;
    height = gb.bottom - gb.y + insetY + FRAME_PAD;
  }
  for (const s of shapes) {
    const box = { x: s.position.x - frame.position.x, y: s.position.y - frame.position.y, width: nodeWidth(s), height: nodeHeight(s) };
    local.set(s.id, box);
    width = Math.max(width, box.x + box.width + FRAME_PAD);
    height = Math.max(height, box.y + box.height + FRAME_PAD);
  }
  return { frame, size: { width, height }, local };
}

/**
 * Tidy the canvas with Frames as blocks (ADR-0050, LOT2-126). Loose windows are arranged exactly
 * as before ({@link gridBoxes}); each Frame is laid out on its own — members arranged inside it —
 * and then placed as ONE rigid block in rows below the loose grid, so Tidy never tears a Frame
 * apart. Shape members ride along with their Frame, keeping their offset. Without Frames this is
 * the plain grid. A member whose Frame no longer exists counts as loose. Pure.
 */
export function arrangeCanvasNodes(nodes: Node[], opts: ArrangeOptions = {}): Map<string, ArrangeBox> {
  const frames = nodes.filter(isFrameNode);
  if (frames.length === 0) return gridBoxes(nodes.filter(isTiledCanvasNode), opts);

  const frameIds = new Set(frames.map((f) => f.id));
  const loose = nodes.filter((n) => isTiledCanvasNode(n) && !frameIds.has(memberOf(n) ?? ""));
  const result = gridBoxes(loose, opts);

  const originX = Math.min(...loose.map((n) => n.position.x), ...frames.map((f) => f.position.x));
  const originY = Math.min(...loose.map((n) => n.position.y), ...frames.map((f) => f.position.y));

  const looseBounds = boundsOf(result.values());
  const rowWidth = looseBounds ? looseBounds.right - looseBounds.x : (opts.fit?.width ?? FALLBACK_ROW_WIDTH);
  let cursorY = looseBounds ? looseBounds.bottom + BLOCK_GAP : originY;

  // Chip order (array order), like the Frame Grid: sorting by position here made the next Grid snap reshuffle them.
  const blocks = frames
    .map((f) => layoutFrameBlock(f, nodes.filter((n) => !isFrameNode(n) && memberOf(n) === f.id)));

  let cursorX = originX;
  let rowHeight = 0;
  for (const block of blocks) {
    if (cursorX > originX && cursorX + block.size.width > originX + rowWidth) {
      cursorX = originX;
      cursorY += rowHeight + BLOCK_GAP;
      rowHeight = 0;
    }
    result.set(block.frame.id, { x: cursorX, y: cursorY, width: block.size.width, height: block.size.height });
    for (const [id, b] of block.local) result.set(id, { ...b, x: cursorX + b.x, y: cursorY + b.y });
    cursorX += block.size.width + BLOCK_GAP;
    rowHeight = Math.max(rowHeight, block.size.height);
  }
  return result;
}
