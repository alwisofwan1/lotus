import type {
  TerminalV2LayoutDirection,
  TerminalV2LayoutNode,
  TerminalV2LayoutTree,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";

/**
 * Where a new pane goes, and how to tidy the ones already open.
 *
 * Every path that opened a pane ended up building the same shape: ONE split node holding every
 * pane side by side. Two panes looked deliberate, five were five columns 200px wide, and a
 * terminal that narrow wraps its own prompt. The tree has always supported nesting — nothing
 * ever built a nested one.
 *
 * In this tree `horizontal` divides the WIDTH (children sit side by side) and `vertical` divides
 * the HEIGHT. So a balanced grid is a vertical split of rows, each row a horizontal split of
 * panes — and that is the only shape this file builds.
 */

export interface Box {
  width: number;
  height: number;
}

/**
 * The grid a given number of panes wants: as square as it gets, never taller than it is wide.
 *
 * `ceil(sqrt(n))` columns is the same rule CodeSpace's own `optimalGrid` reaches for, kept here
 * rather than imported because this one must answer for ANY count — the templates that back
 * `optimalGrid` stop at sixteen and fall back to the same arithmetic anyway.
 */
export function gridShape(count: number): { rows: number; cols: number } {
  if (count <= 0) return { rows: 0, cols: 0 };
  const cols = Math.ceil(Math.sqrt(count));
  return { rows: Math.ceil(count / cols), cols };
}

/** Panes per row, earlier rows taking the remainder so the short row is at the bottom. */
export function rowSplit(count: number): number[] {
  const { rows } = gridShape(count);
  if (rows === 0) return [];
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, index) => base + (index < extra ? 1 : 0));
}

const leaf = (paneId: string): TerminalV2LayoutNode => ({ kind: "leaf", paneId });

/** Equal shares, as the percentages the layout tree stores. */
function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}

/**
 * A balanced grid for exactly these panes, in this order.
 *
 * **Every split carries one size per child**, as equal percentages summing to 100 — the same
 * convention `normalizeSizes` in the layout tree uses.
 *
 * This is not decoration. `SplitTree` renders a seam only when `resolveTrackSizes` hands back one
 * track per child, and that function returns `[]` for an empty size list. A tree built with
 * `sizes: []` therefore lays out correctly (the tracks fall back to `flex: 1 1 0`) and has **no
 * draggable seams at all** — which is exactly what shipped here on 2026-09-21 and was reported as
 * "resize stops working past four panes".
 */
export function balancedPaneLayout(
  paneIds: readonly string[],
  activePaneId: string | null,
): TerminalV2LayoutTree {
  const unique = Array.from(new Set(paneIds));
  const active = activePaneId && unique.includes(activePaneId) ? activePaneId : unique[0] ?? null;

  if (unique.length === 0) return { root: null, activePaneId: null };
  if (unique.length === 1) return { root: leaf(unique[0]), activePaneId: active };

  const rows: TerminalV2LayoutNode[] = [];
  let cursor = 0;
  for (const width of rowSplit(unique.length)) {
    const slice = unique.slice(cursor, cursor + width);
    cursor += width;
    rows.push(
      slice.length === 1
        ? leaf(slice[0])
        : { kind: "split", direction: "horizontal", children: slice.map(leaf), sizes: evenSizes(slice.length) },
    );
  }

  // One row is a row, not a grid: no vertical wrapper, or every layout gains a split node that
  // can never be dragged.
  if (rows.length === 1) return { root: rows[0], activePaneId: active };
  return {
    root: { kind: "split", direction: "vertical", children: rows, sizes: evenSizes(rows.length) },
    activePaneId: active,
  };
}

/** Even shares when a split carries no sizes of its own, normalised shares when it does. */
function shares(node: Extract<TerminalV2LayoutNode, { kind: "split" }>): number[] {
  const count = node.children.length;
  const sizes = node.sizes.length === count ? node.sizes : [];
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (sizes.length === 0 || total <= 0) return Array.from({ length: count }, () => 1 / count);
  return sizes.map((size) => size / total);
}

/**
 * How big a pane actually is, from the tree and the box the tree was given.
 *
 * Seam widths are ignored: this exists to answer "is this pane wider than it is tall", and a few
 * pixels of channel cannot change that answer for any pane big enough to split.
 */
export function paneBoxInLayout(
  node: TerminalV2LayoutNode | null,
  paneId: string,
  box: Box,
): Box | null {
  if (!node) return null;
  if (node.kind === "leaf") return node.paneId === paneId ? box : null;

  const fractions = shares(node);
  for (const [index, child] of node.children.entries()) {
    const childBox: Box =
      node.direction === "horizontal"
        ? { width: box.width * fractions[index], height: box.height }
        : { width: box.width, height: box.height * fractions[index] };
    const found = paneBoxInLayout(child, paneId, childBox);
    if (found) return found;
  }
  return null;
}

/**
 * Split the pane along its LONGER axis — the rule every tiling window manager settles on.
 *
 * It is what keeps a workspace from drifting into columns: the first split of a wide window makes
 * two tall panes, and the next split of one of THOSE is a stack, because that pane is now taller
 * than it is wide. Falling back to the whole box when the pane cannot be found keeps a first
 * pane, or a pane added to a tree that has not caught up yet, from defaulting to a column.
 */
export function splitDirectionForPane(
  root: TerminalV2LayoutNode | null,
  paneId: string | null,
  box: Box,
): TerminalV2LayoutDirection {
  const target = (paneId ? paneBoxInLayout(root, paneId, box) : null) ?? box;
  if (target.width <= 0 || target.height <= 0) return "horizontal";
  return target.width >= target.height ? "horizontal" : "vertical";
}

/** Whether tidying would change anything, so the command can say when there is nothing to do. */
export function isBalanced(tree: TerminalV2LayoutTree | null | undefined, paneIds: readonly string[]): boolean {
  if (!tree?.root) return paneIds.length === 0;
  return JSON.stringify(tree.root) === JSON.stringify(balancedPaneLayout(paneIds, tree.activePaneId).root);
}
