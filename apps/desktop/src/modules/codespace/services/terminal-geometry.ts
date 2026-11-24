export interface TerminalGeometry {
  cols: number;
  rows: number;
  width: number;
  height: number;
}

export interface TerminalObservedSize {
  width: number;
  height: number;
}

export interface TerminalGeometryTerm {
  cols: number;
  rows: number;
}

export interface TerminalGeometryFitAddon {
  fit: () => void;
}

export interface MeasureTerminalGeometryOptions {
  container: HTMLElement | null;
  fitAddon: TerminalGeometryFitAddon | null | undefined;
  term: TerminalGeometryTerm | null | undefined;
  minCols?: number;
  minRows?: number;
}

const DEFAULT_MIN_COLS = 20;
const DEFAULT_MIN_ROWS = 8;
const DEFAULT_RESIZE_THRESHOLD_PX = 1;

export function hasTerminalObservedSizeChanged(
  previous: TerminalObservedSize | null,
  next: TerminalObservedSize,
  thresholdPx = DEFAULT_RESIZE_THRESHOLD_PX,
): boolean {
  if (next.width <= 0 || next.height <= 0) return false;
  if (!previous) return true;
  return Math.abs(next.width - previous.width) >= thresholdPx
    || Math.abs(next.height - previous.height) >= thresholdPx;
}

/**
 * Char-cell snap gate for the resize hot path. xterm's `fit()` is expensive
 * (grid recompute + potential WebGL buffer realloc); calling it when the
 * container has moved by less than a full character cell is wasted work.
 *
 * Use with `fitAddon.proposeDimensions()` which is a pure compute that
 * returns the cols/rows a `fit()` would produce — without doing the reflow.
 *
 * Returns true when the caller should skip calling `fit()`. Returns false
 * (do fit) when either dimension differs, OR when the last-fitted values
 * are unknown (first run).
 */
export function shouldSkipFit(
  lastCols: number | null,
  lastRows: number | null,
  proposedCols: number | null | undefined,
  proposedRows: number | null | undefined,
): boolean {
  if (proposedCols == null || proposedRows == null) return false;
  if (!Number.isFinite(proposedCols) || !Number.isFinite(proposedRows)) return false;
  if (lastCols == null || lastRows == null) return false;
  return proposedCols === lastCols && proposedRows === lastRows;
}

export function measureTerminalGeometry({
  container,
  fitAddon,
  term,
  minCols = DEFAULT_MIN_COLS,
  minRows = DEFAULT_MIN_ROWS,
}: MeasureTerminalGeometryOptions): TerminalGeometry | null {
  if (!container || !fitAddon || !term) return null;

  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  fitAddon.fit();

  if (!Number.isFinite(term.cols) || !Number.isFinite(term.rows)) return null;
  if (term.cols < minCols || term.rows < minRows) return null;

  return {
    cols: term.cols,
    rows: term.rows,
    width: rect.width,
    height: rect.height,
  };
}
