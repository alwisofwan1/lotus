/**
 * Split sizing — the arithmetic behind every draggable seam in the unified workspace shell.
 *
 * Kept pure and separate from the React handle on purpose: a resize that feels right is a
 * question of clamping and rounding, and those are cheap to test here and expensive to test
 * through a pointer event.
 *
 * One size is stored per seam — the size of the pane BEFORE the handle. The pane after it
 * always fills what is left, so a window resize never has to reconcile two stored numbers.
 */

export interface SplitConstraints {
  /** Smallest the leading pane may become, in px. */
  min: number;
  /** Largest the leading pane may become, in px. */
  max: number;
}

/**
 * The seam's thickness in the layout — the channel between two panes, in px.
 *
 * Kept in sync with `--ws-seam` in styles/workspace-shell.css: this value is the one the sizing
 * arithmetic subtracts, and the stylesheet is what the eye sees. The POINTER target is wider
 * than both (`.ws-split::before`), so a narrow channel is still comfortable to grab.
 */
export const SPLIT_HANDLE_SIZE = 10;

function isFiniteNumber(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Largest the leading pane may be so the trailing pane keeps at least `trailingMin`.
 * Returns `leadingMin` when the container is too small for both — a collapsed window must
 * still produce a usable number rather than a negative one.
 */
export function computeSplitMax(
  containerSize: number,
  trailingMin: number,
  leadingMin: number,
  handleSize: number = SPLIT_HANDLE_SIZE,
): number {
  if (!isFiniteNumber(containerSize)) return leadingMin;
  return Math.max(leadingMin, containerSize - trailingMin - handleSize);
}

export function clampSplitSize(size: number, constraints: SplitConstraints): number {
  if (!isFiniteNumber(size)) return constraints.min;
  // A max below min means the window is smaller than both panes want: min wins, so the
  // leading pane stays usable and the trailing one is what gets squeezed.
  const max = Math.max(constraints.min, constraints.max);
  return Math.round(Math.min(max, Math.max(constraints.min, size)));
}

/** Where the drag lands: the size the seam had when the pointer went down, plus how far it moved. */
export function resolveDragSize(
  startSize: number,
  delta: number,
  constraints: SplitConstraints,
): number {
  if (!isFiniteNumber(delta)) return clampSplitSize(startSize, constraints);
  return clampSplitSize(startSize + delta, constraints);
}

/** Keyboard resize. The seam is reachable by Tab, so arrows have to move it. */
export function nudgeSplitSize(
  size: number,
  step: number,
  constraints: SplitConstraints,
): number {
  return clampSplitSize(size + step, constraints);
}

/**
 * Snap to the default when the pointer lands close to it, so a seam can be put back by hand
 * without hunting for the exact pixel. Dragging further than the threshold escapes the snap.
 */
export function applySplitSnap(
  size: number,
  defaultSize: number,
  threshold = 12,
): number {
  if (!isFiniteNumber(size) || !isFiniteNumber(defaultSize)) return size;
  return Math.abs(size - defaultSize) <= threshold ? defaultSize : size;
}
