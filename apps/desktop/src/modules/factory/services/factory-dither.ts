import type { FactoryStageStatus } from "./factory-progress";

/**
 * The pixels of the stage strip (Factory round 5, "Dither steps"). Texture says the step's status, so
 * it reads without colour: grain is done, a dither front is the agent working, hatch waits on you,
 * checker failed, dots not reached. Each texture is one repeating tile of on-pixels; the component
 * draws them as SVG patterns. Pure.
 */

/** The 4×4 ordered-dither (Bayer) matrix: a pixel is on when its threshold is under the density. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

export interface DitherTile {
  /** Tile side, in pixels. */
  size: number;
  /** The tile's on-pixels as [column, row]. */
  on: readonly (readonly [number, number])[];
}

function tile(size: number, isOn: (x: number, y: number) => boolean): DitherTile {
  const on: [number, number][] = [];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (isOn(x, y)) on.push([x, y]);
  return { size, on };
}

/** A tile with `of16` of its 16 pixels on, spread by the Bayer matrix. */
export const bayerTile = (of16: number) => tile(4, (x, y) => BAYER[y][x] < of16);

/**
 * The working front, left to right: dense where the step started, thinning toward the next one.
 * Five bands, each a fifth of the step.
 */
export const DITHER_FRONT: readonly DitherTile[] = [16, 11, 7, 4, 2].map(bayerTile);

/** The texture over each status's flat track; null for one with no texture over it (the front). */
export function ditherTile(status: FactoryStageStatus): DitherTile | null {
  switch (status) {
    case "done":
      return bayerTile(3);
    case "needs-you":
      return tile(4, (x, y) => (x + y) % 4 < 2);
    case "failed":
      return tile(2, (x, y) => (x + y) % 2 === 0);
    case "todo":
      return tile(2, (x, y) => x === 0 && y === 1);
    case "active":
      return null;
  }
}
