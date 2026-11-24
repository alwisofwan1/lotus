import type { Node } from "@xyflow/react";
import { arrangeNodeSet, isTiledCanvasNode, type ArrangeBox } from "./canvas-arrange";
import { FRAME_TAB_STRIP } from "./canvas-frame-geometry";
import { frameBoxOf } from "./canvas-frame-space";
import { frameIdOf, frameMembers, framesInOrder } from "./canvas-frames";
import type { LayoutBounds } from "./viewport/canvas-visible-frame";

/**
 * Frame Grid (decisions 43-44, LOT2-142). Frames live in a fixed grid of equal slots ordered like the chips:
 * 1 Frame -> 1 slot, 2 -> side by side, 3-4 -> 2x2, more continue in two columns. A slot is the visible canvas
 * area at zoom 1, the same size a focused Frame fills (decision 35), so focusing never reshapes a Frame. Pure:
 * target boxes only; the hooks own the camera and the glide.
 */

/**
 * Space between columns. Kept tight: a slot has the screen's aspect, so every flow px of gap the grid does not
 * need is screen width the Overview gives back to the Frames' content.
 */
export const FRAME_GRID_GAP_X = FRAME_TAB_STRIP + 32;
/** Space between rows: holds the next row's Overview header card (~36 screen px at the usual ~0.45 zoom). */
export const FRAME_GRID_GAP_Y = FRAME_TAB_STRIP + 64;
/** Room kept above the first row for its Overview header cards. */
export const FRAME_GRID_HEADER_ROOM = FRAME_GRID_GAP_Y;
const GRID_COLUMNS = 2;

/** Decision 44: members show live content in the Overview up to this many window nodes in total. */
export const OVERVIEW_FULL_DETAIL_MAX_NODES = 16;

export function frameGridDims(count: number): { cols: number; rows: number } {
  const cols = count <= 1 ? 1 : GRID_COLUMNS;
  return { cols, rows: Math.max(1, Math.ceil(count / cols)) };
}

export interface FrameGridLayout {
  /** Target boxes: every Frame, its window members (tiled like focus) and its shape members (carried). */
  boxes: Map<string, ArrangeBox>;
  /** The slot rectangles, in chip order. */
  slots: ArrangeBox[];
  /** What the Overview camera frames: all slots plus header room above the first row. */
  bounds: LayoutBounds;
}

const dimOf = (n: Node) => {
  const b = frameBoxOf(n);
  return { width: b.w, height: b.h };
};

/**
 * Plan the grid for every Frame. The grid is anchored at the top-left of the Frames' own bounding corner (so
 * running it again changes nothing). Each Frame box starts at its slot's top-left; window members are tiled
 * with {@link arrangeNodeSet} and the same `fit` rule as focus; shape members keep their offset and size and
 * travel with the Frame; the box covers the lot and an empty Frame fills its slot. Loose nodes stay put, except a
 * loose window a slot would cover, which moves to a row below the grid.
 * Null when there are no Frames.
 */
export function frameGridLayout(nodes: readonly Node[], slot: { width: number; height: number }): FrameGridLayout | null {
  const frames = framesInOrder(nodes);
  if (frames.length === 0) return null;
  const originX = Math.min(...frames.map((f) => f.position.x));
  const originY = Math.min(...frames.map((f) => f.position.y));
  const { cols } = frameGridDims(frames.length);

  // Pass 1: each Frame laid out locally (top-left = 0,0). Content that cannot shrink to the slot (many members)
  // makes its column/row wider, so slots never overlap.
  const locals = frames.map((frame) => {
    const members = frameMembers(nodes, frame.id);
    const tiles = arrangeNodeSet(members.filter(isTiledCanvasNode), { fit: slot });
    let gx = Infinity;
    let gy = Infinity;
    for (const b of tiles.values()) {
      gx = Math.min(gx, b.x);
      gy = Math.min(gy, b.y);
    }
    const local = new Map<string, ArrangeBox>();
    let right = tiles.size > 0 ? 0 : slot.width;
    let bottom = tiles.size > 0 ? 0 : slot.height;
    for (const [id, b] of tiles) {
      const placed = { ...b, x: b.x - gx, y: b.y - gy };
      local.set(id, placed);
      right = Math.max(right, placed.x + placed.width);
      bottom = Math.max(bottom, placed.y + placed.height);
    }
    for (const s of members.filter((m) => !isTiledCanvasNode(m))) {
      const placed = { x: s.position.x - frame.position.x, y: s.position.y - frame.position.y, ...dimOf(s) };
      local.set(s.id, placed);
      right = Math.max(right, placed.x + placed.width);
      bottom = Math.max(bottom, placed.y + placed.height);
    }
    return { local, width: right, height: bottom };
  });
  const colCount = Math.min(cols, frames.length);
  const rowCount = Math.ceil(frames.length / cols);
  const colW = Array.from({ length: colCount }, (_, c) => Math.max(slot.width, ...locals.filter((_l, i) => i % cols === c).map((l) => l.width)));
  const rowH = Array.from({ length: rowCount }, (_, r) => Math.max(slot.height, ...locals.filter((_l, i) => Math.floor(i / cols) === r).map((l) => l.height)));
  const sum = (xs: number[], n: number, gap: number) => xs.slice(0, n).reduce((acc, v) => acc + v + gap, 0);

  // Pass 2: place each Frame at its slot.
  const boxes = new Map<string, ArrangeBox>();
  const slots: ArrangeBox[] = [];
  frames.forEach((frame, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const rect: ArrangeBox = { x: originX + sum(colW, c, FRAME_GRID_GAP_X), y: originY + sum(rowH, r, FRAME_GRID_GAP_Y), width: colW[c], height: rowH[r] };
    slots.push(rect);
    const { local, width, height } = locals[i];
    for (const [id, b] of local) boxes.set(id, { ...b, x: b.x + rect.x, y: b.y + rect.y });
    boxes.set(frame.id, { x: rect.x, y: rect.y, width, height });
  });

  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of frames) {
    const b = boxes.get(f.id)!;
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  for (const s of slots) {
    maxX = Math.max(maxX, s.x + s.width);
    maxY = Math.max(maxY, s.y + s.height);
  }
  // Loose windows are never tiled, but one a slot would cover (an agent's task cell, a node left after a
  // dissolve) moves out to a row below the grid, keeping its size. Loose windows clear of the grid stay put.
  const frameIds = new Set(frames.map((f) => f.id));
  const covered = nodes.filter((n) => {
    if (!isTiledCanvasNode(n) || frameIds.has(frameIdOf(n) ?? "")) return false;
    const b = frameBoxOf(n);
    return slots.some((r) => b.x < r.x + r.width && b.x + b.w > r.x && b.y < r.y + r.height && b.y + b.h > r.y);
  });
  let cursorX = originX;
  for (const n of covered) {
    const { width, height } = dimOf(n);
    boxes.set(n.id, { x: cursorX, y: maxY + FRAME_GRID_GAP_Y, width, height });
    cursorX += width + FRAME_GRID_GAP_X;
  }
  const minY = originY - FRAME_GRID_HEADER_ROOM;
  return { boxes, slots, bounds: { minX: originX, minY, width: maxX - originX, height: maxY - minY } };
}

/**
 * Exchange two Frames' numbers (decision 43: chip numbers follow). The chip order IS array order, so the two
 * Frames trade places; each Frame then travels with its members as one block, which keeps every Frame painted
 * behind its own members. Nodes outside the blocks keep their order and sit where the first block was.
 * Returns the same array for an unknown id or the same Frame twice.
 */
export function swapFramesInOrder(nodes: readonly Node[], aId: string, bId: string): Node[] {
  const frames = framesInOrder(nodes);
  const ai = frames.findIndex((f) => f.id === aId);
  const bi = frames.findIndex((f) => f.id === bId);
  if (ai < 0 || bi < 0 || ai === bi) return nodes as Node[];
  const order = frames.map((f) => f.id);
  [order[ai], order[bi]] = [order[bi], order[ai]];

  const blockOf = (frameId: string) => nodes.filter((n) => n.id === frameId || frameIdOf(n) === frameId);
  const inBlock = new Set(frames.flatMap((f) => blockOf(f.id).map((n) => n.id)));
  const at = nodes.findIndex((n) => inBlock.has(n.id));
  const out: Node[] = [];
  nodes.forEach((n, i) => {
    if (i === at) for (const id of order) out.push(...blockOf(id));
    if (!inBlock.has(n.id)) out.push(n);
  });
  return out;
}

/** Decision 44: full detail (no glyph LOD) while the Overview is open, up to 16 window nodes in total. */
export function overviewFullDetail(nodes: readonly Node[]): boolean {
  let count = 0;
  for (const n of nodes) if (n.type !== "frame" && isTiledCanvasNode(n)) count += 1;
  return count <= OVERVIEW_FULL_DETAIL_MAX_NODES;
}

const AUTO_TITLE = /^Frame \d+$/;

/**
 * Auto-named Frames ("Frame 3") follow their chip number, so the Overview never reads "Frame 2 · 01". A title
 * the user typed is never touched. Same array back when nothing changes.
 */
export function renumberAutoFrameTitles(nodes: readonly Node[]): Node[] {
  const next = new Map<string, string>();
  framesInOrder(nodes).forEach((f, i) => {
    const title = typeof f.data?.title === "string" ? f.data.title : "";
    const want = `Frame ${i + 1}`;
    if (AUTO_TITLE.test(title) && title !== want) next.set(f.id, want);
  });
  if (next.size === 0) return nodes as Node[];
  return nodes.map((n) => (next.has(n.id) ? { ...n, data: { ...n.data, title: next.get(n.id) } } : n));
}
