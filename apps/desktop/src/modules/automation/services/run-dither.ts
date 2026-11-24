/**
 * The pixels of a running run (`.pen` "Automation Running now round 1", E): an orb whose comet tail
 * breaks into pixels, and the strip's marching comet. Same 4×4 ordered dither as Factory's stage
 * strip (`modules/factory/services/factory-dither.ts`), so both surfaces share one pixel grammar.
 * Pure.
 */

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

/** On when the pixel's Bayer threshold is under `density` (0 → none, 16 → all). */
const lit = (x: number, y: number, density: number) => BAYER[y % 4][x % 4] < density;

export const ORB_SIDE = 8;
export const ORB_FRAMES = 12;

/**
 * Frame `frame` of the orb: a ring of `ORB_SIDE`² pixels with a comet running round it, dense at
 * the head and thinning to nothing at the tail. The head moves a twelfth of a turn per frame.
 * Returns the frame's on-pixels as [column, row].
 */
export function orbFrame(frame: number): [number, number][] {
  const half = ORB_SIDE / 2;
  const head = (frame / ORB_FRAMES) * 2 * Math.PI;
  const on: [number, number][] = [];
  for (let y = 0; y < ORB_SIDE; y++) {
    for (let x = 0; x < ORB_SIDE; x++) {
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const r = Math.hypot(dx, dy);
      if (r > half || r < half - 2.6) continue;
      let behind = (Math.atan2(dy, dx) - head) / (2 * Math.PI);
      behind -= Math.floor(behind);
      if (lit(x, y, (1 - behind) ** 1.6 * 17)) on.push([x, y]);
    }
  }
  return on;
}

/** The orb's track: every other pixel of the ring, so the comet runs over a faint dotted circle. */
export function orbTrack(): [number, number][] {
  const half = ORB_SIDE / 2;
  const on: [number, number][] = [];
  for (let y = 0; y < ORB_SIDE; y++) {
    for (let x = 0; x < ORB_SIDE; x++) {
      const r = Math.hypot(x + 0.5 - half, y + 0.5 - half);
      if (r <= half && r >= 1.4 && (x + y) % 2 === 0) on.push([x, y]);
    }
  }
  return on;
}

/**
 * The strip's comet, `width` × `height` pixels: dense at its head (the right end) and thinning to
 * the left over the whole width. The strip draws it once per half of a double-wide row and slides
 * the row, so it marches with no seam.
 */
export function cometPixels(width: number, height: number): [number, number][] {
  const on: [number, number][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (lit(x, y, (x / (width - 1)) ** 1.3 * 16.5)) on.push([x, y]);
    }
  }
  return on;
}

/** Pixels as one SVG path in pixel units, for a `viewBox` of the grid's size. */
export function pixelPath(on: [number, number][]): string {
  return on.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join("");
}
