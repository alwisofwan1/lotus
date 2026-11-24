/** Space between a Frame's border and its outermost members. Zero (decision 35): the box hugs its members. */
export const FRAME_PAD = 0;
/**
 * Height reserved ABOVE a Frame's box for its title tab (28px tab + 4px gap). The tab sits outside
 * the box (decision 35), so every overlap rule treats a Frame as its box plus this strip.
 */
export const FRAME_TAB_STRIP = 32;

export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DragPoint {
  x: number;
  y: number;
}

/**
 * The box a Frame-tool drag draws (flow coordinates). Any drag direction works; `square` (Shift)
 * takes the longer side, `fromCentre` (Alt) treats the start as the centre.
 */
export function frameBoxFromDrag(start: DragPoint, end: DragPoint, opts: { square?: boolean; fromCentre?: boolean } = {}): FrameBox {
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  if (opts.square) {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side;
    dy = (dy < 0 ? -1 : 1) * side;
  }
  if (opts.fromCentre) {
    const w = Math.abs(dx) * 2;
    const h = Math.abs(dy) * 2;
    return { x: start.x - w / 2, y: start.y - h / 2, w, h };
  }
  return { x: Math.min(start.x, start.x + dx), y: Math.min(start.y, start.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

/** What a Frame claims on the canvas: its box plus the title-tab strip above it. */
export function frameOccupiedBox(box: FrameBox): FrameBox {
  return { x: box.x, y: box.y - FRAME_TAB_STRIP, w: box.w, h: box.h + FRAME_TAB_STRIP };
}

/** The Frame box that fits `boxes` (plus `pad`, zero by default). Empty input yields a zero box. */
export function frameBoxAround(boxes: readonly FrameBox[], pad: number = FRAME_PAD): FrameBox {
  if (boxes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return {
    x: minX - pad,
    y: minY - pad,
    w: maxX - minX + pad * 2,
    h: maxY - minY + pad * 2,
  };
}
