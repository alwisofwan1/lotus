import type { GridCell } from "@/modules/codespace/components/types";

/**
 * Laying panes out the way the workspace already says they are laid out.
 *
 * CodeSpace keeps `rows`, `cols`, `rowFractions` and `colFractions` on the workspace, persists
 * them in the snapshot, and already has actions that move those fractions when a seam is
 * dragged. The shell renders that state rather than inventing its own: a second source of pane
 * sizes would drift from the saved one and be lost on restart.
 */

export interface GridRow {
  index: number;
  cells: GridCell[];
}

/** Fractions that always sum to 1 and always have `count` entries. */
export function normalizeFractions(fractions: number[] | undefined, count: number): number[] {
  if (count <= 0) return [];
  const source = fractions && fractions.length === count ? fractions : [];
  const values = source.length === count ? [...source] : Array.from({ length: count }, () => 1 / count);
  const total = values.reduce((sum, value) => sum + (Number.isFinite(value) && value > 0 ? value : 0), 0);
  if (total <= 0) return Array.from({ length: count }, () => 1 / count);
  return values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0) / total);
}

/**
 * Cells in row-major order, which is the order CodeSpace itself assigns them.
 *
 * A trailing row that the cell count does not fill is dropped rather than rendered empty: an
 * empty row would take a share of the height and show nothing.
 */
export function toGridRows(cells: GridCell[], rows: number, cols: number): GridRow[] {
  if (cells.length === 0) return [];
  const safeCols = Math.max(1, cols);
  const safeRows = Math.max(1, rows);
  const result: GridRow[] = [];

  for (let rowIndex = 0; rowIndex < safeRows; rowIndex += 1) {
    const slice = cells.slice(rowIndex * safeCols, rowIndex * safeCols + safeCols);
    if (slice.length === 0) continue;
    result.push({ index: rowIndex, cells: slice });
  }

  // Any cell beyond rows×cols still has to be shown — losing a pane is worse than an odd row.
  const placed = result.reduce((sum, row) => sum + row.cells.length, 0);
  if (placed < cells.length) {
    result.push({ index: result.length, cells: cells.slice(placed) });
  }

  return result;
}

/**
 * Pixel sizes for one axis of the grid.
 *
 * The seams live BETWEEN the tracks, so they come out of the container before the fractions are
 * applied — otherwise every extra pane pushes the row one seam wider than the space it has. That
 * overflow is what pushed the right-hand pane off the edge, put the second row's seam past the
 * bottom of the view where it could not be grabbed, and handed xterm a box wider than the one it
 * was painting into, which is why its text wrapped mid-word.
 */
export function resolveTrackSizes(
  containerSize: number,
  fractions: number[],
  seamSize: number,
  minTrack = 0,
): number[] {
  const count = fractions.length;
  if (count === 0 || containerSize <= 0) return [];

  const content = Math.max(0, containerSize - seamSize * (count - 1));
  const normalized = normalizeFractions(fractions, count);
  const sizes = normalized.map((fraction) => content * fraction);

  // A track below the minimum is raised to it, and the space is taken back from the tracks that
  // have room — never by letting the row overflow, which is the bug this function exists to stop.
  if (minTrack <= 0 || content < minTrack * count) return sizes;

  const deficit = sizes.reduce((sum, size) => sum + Math.max(0, minTrack - size), 0);
  if (deficit === 0) return sizes;

  const donors = sizes.reduce((sum, size) => sum + Math.max(0, size - minTrack), 0);
  return sizes.map((size) => {
    if (size < minTrack) return minTrack;
    if (donors <= 0) return size;
    return size - (size - minTrack) * (deficit / donors);
  });
}

export interface TrackDragInput {
  /** Where the seam is now, in px. */
  currentSize: number;
  /** Where the drag put it. */
  nextSize: number;
  /** The whole axis, seams included — what a ResizeObserver reports. */
  containerSize: number;
  trackCount: number;
  seamSize: number;
}

/**
 * A seam drag, in the terms the workspace engine's resize actions expect.
 *
 * `resizePaneColumn`/`resizePaneRow` turn a pixel delta into fractions by dividing by a container
 * size, so that size has to be the space the TRACKS share — the container minus its seams. Passing
 * the raw container makes every drag come out slightly short, and the error grows with each pane.
 */
export function trackDragDelta({
  currentSize,
  nextSize,
  containerSize,
  trackCount,
  seamSize,
}: TrackDragInput): { deltaPx: number; containerSize: number } {
  const content = Math.max(0, containerSize - seamSize * Math.max(0, trackCount - 1));
  return { deltaPx: nextSize - currentSize, containerSize: content };
}
