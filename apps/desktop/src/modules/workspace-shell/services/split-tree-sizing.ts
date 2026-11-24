/**
 * Resizing one seam inside a split tree.
 *
 * The workspace already keeps a binary split tree (`paneLayout.terminalV2Layout`): every split
 * node has its own children and its own sizes, which is what makes each pane individually
 * resizable instead of every pane in a row moving together. This is the arithmetic for one seam
 * of one node; the tree walking lives in `resizeTerminalV2LayoutSplit`, which already exists.
 */

/**
 * Split sizes arrive in whatever scale their owner uses — the workspace layout tree normalises
 * them to sum to 100, other callers think in fractions of 1. Everything below works in fractions,
 * so the scale is removed once, at the door.
 */
function toFractions(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + (Number.isFinite(size) && size > 0 ? size : 0), 0);
  if (total <= 0) return sizes.map(() => (sizes.length > 0 ? 1 / sizes.length : 0));
  return sizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 0) / total);
}

export interface SplitDragInput {
  /** Normalised sizes of a split node's children, summing to 1. */
  sizes: number[];
  /** Which seam moved: the one between child `index` and child `index + 1`. */
  index: number;
  deltaPx: number;
  /** The node's own box along the split axis. */
  containerPx: number;
  minPx: number;
}

export function applySplitDrag({
  sizes,
  index,
  deltaPx,
  containerPx,
  minPx,
}: SplitDragInput): number[] {
  if (index < 0 || index + 1 >= sizes.length || containerPx <= 0) return [...sizes];

  const next = toFractions(sizes);
  const leading = next[index] * containerPx;
  const trailing = next[index + 1] * containerPx;
  const pairPx = leading + trailing;
  // A pair with no room for two minimums cannot be split fairly; leave it untouched rather than
  // collapsing one side to nothing.
  if (pairPx < minPx * 2) return [...sizes];

  const nextLeading = Math.max(minPx, Math.min(pairPx - minPx, leading + deltaPx));
  next[index] = nextLeading / containerPx;
  next[index + 1] = (pairPx - nextLeading) / containerPx;
  return next;
}

export interface SplitResizeInput {
  sizes: number[];
  index: number;
  /** Where the drag wants the leading child's edge, in px from the start of the node. */
  leadingPx: number;
  containerPx: number;
  minPx: number;
}

/**
 * The absolute form, which is what a pointer drag actually produces.
 *
 * `SplitHandle` reports a size measured from where the drag began, not a step. Turning that back
 * into a delta against the size currently on screen double-counts, because the screen has already
 * moved — the drag then creeps a few pixels and stops, which is exactly how it felt.
 */
export function applySplitResize({
  sizes,
  index,
  leadingPx,
  containerPx,
  minPx,
}: SplitResizeInput): number[] {
  if (index < 0 || index + 1 >= sizes.length || containerPx <= 0) return [...sizes];

  const next = toFractions(sizes);
  const pairPx = (next[index] + next[index + 1]) * containerPx;
  if (pairPx < minPx * 2) return [...sizes];

  const leading = Math.max(minPx, Math.min(pairPx - minPx, leadingPx));
  next[index] = leading / containerPx;
  next[index + 1] = (pairPx - leading) / containerPx;
  return next;
}
