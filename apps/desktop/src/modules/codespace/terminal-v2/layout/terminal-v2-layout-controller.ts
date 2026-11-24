import {
  closeTerminalV2LayoutPane,
  focusTerminalV2LayoutPane,
  getTerminalV2LayoutPaneIds,
  splitTerminalV2LayoutPane,
  type TerminalV2LayoutDirection,
  type TerminalV2LayoutNode,
  type TerminalV2LayoutTree,
} from "./terminal-v2-layout-tree";

export type TerminalV2FocusDirection = "left" | "right" | "up" | "down";

export type TerminalV2SplitActivePaneResult = {
  layout: TerminalV2LayoutTree;
  changed: boolean;
  targetPaneId: string | null;
};

export type TerminalV2CloseActivePaneResult = {
  layout: TerminalV2LayoutTree;
  changed: boolean;
  closedPaneId: string | null;
};

type PaneRect = {
  paneId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export function splitTerminalV2ActivePane({
  layout,
  direction,
  newPaneId,
}: {
  layout: TerminalV2LayoutTree;
  direction: TerminalV2LayoutDirection;
  newPaneId: string;
}): TerminalV2SplitActivePaneResult {
  const targetPaneId = resolveActivePaneId(layout);
  if (!targetPaneId) return { layout, changed: false, targetPaneId: null };

  const next = splitTerminalV2LayoutPane(layout, targetPaneId, newPaneId, direction);
  return {
    layout: next,
    changed: next !== layout,
    targetPaneId,
  };
}

export function closeTerminalV2ActivePane(layout: TerminalV2LayoutTree): TerminalV2CloseActivePaneResult {
  const closedPaneId = resolveActivePaneId(layout);
  if (!closedPaneId) return { layout, changed: false, closedPaneId: null };

  const next = closeTerminalV2LayoutPane(layout, closedPaneId);
  return {
    layout: next,
    changed: next !== layout,
    closedPaneId,
  };
}

export function focusTerminalV2PaneByCycle(
  layout: TerminalV2LayoutTree,
  direction: "next" | "previous",
): TerminalV2LayoutTree {
  const paneIds = getVisualTerminalV2LayoutPaneIds(layout.root);
  if (paneIds.length <= 1) return layout;
  const activePaneId = resolveActivePaneId(layout);
  const activeIndex = activePaneId ? paneIds.indexOf(activePaneId) : -1;
  const baseIndex = activeIndex >= 0 ? activeIndex : 0;
  const offset = direction === "next" ? 1 : -1;
  const nextPaneId = paneIds[(baseIndex + offset + paneIds.length) % paneIds.length];
  return nextPaneId ? focusTerminalV2LayoutPane(layout, nextPaneId) : layout;
}

export function focusTerminalV2PaneByDirection(
  layout: TerminalV2LayoutTree,
  direction: TerminalV2FocusDirection,
): TerminalV2LayoutTree {
  const activePaneId = resolveActivePaneId(layout);
  if (!layout.root || !activePaneId) return layout;

  const rects = collectPaneRects(layout.root, { left: 0, top: 0, right: 100, bottom: 100 });
  const activeRect = rects.find((rect) => rect.paneId === activePaneId);
  if (!activeRect) return layout;

  const candidate = rects
    .filter((rect) => rect.paneId !== activePaneId && isInDirection(activeRect, rect, direction))
    .sort((a, b) => compareDirectionalCandidates(activeRect, a, b, direction))[0];

  return candidate ? focusTerminalV2LayoutPane(layout, candidate.paneId) : layout;
}

/**
 * Pane ids in the order the EYE reads them — left to right, top to bottom.
 *
 * Exported because the workspace shell numbers its panes with it (⌘1..⌘9). Both surfaces must
 * agree on "the third pane", and the only honest definition of that is where it is drawn.
 */
export function getVisualTerminalV2LayoutPaneIds(root: TerminalV2LayoutNode | null): string[] {
  if (!root) return [];
  return collectPaneRects(root, { left: 0, top: 0, right: 100, bottom: 100 })
    .sort(compareVisualOrder)
    .map((rect) => rect.paneId);
}

function resolveActivePaneId(layout: TerminalV2LayoutTree): string | null {
  const paneIds = getTerminalV2LayoutPaneIds(layout.root);
  if (layout.activePaneId && paneIds.includes(layout.activePaneId)) return layout.activePaneId;
  return paneIds[0] ?? null;
}

function collectPaneRects(node: TerminalV2LayoutNode, rect: Omit<PaneRect, "paneId">): PaneRect[] {
  if (node.kind === "leaf") return [{ paneId: node.paneId, ...rect }];

  let cursor = node.direction === "horizontal" ? rect.left : rect.top;
  return node.children.flatMap((child, index) => {
    const fraction = (node.sizes[index] ?? 100 / node.children.length) / 100;
    if (node.direction === "horizontal") {
      const width = (rect.right - rect.left) * fraction;
      const childRect = { left: cursor, right: cursor + width, top: rect.top, bottom: rect.bottom };
      cursor += width;
      return collectPaneRects(child, childRect);
    }

    const height = (rect.bottom - rect.top) * fraction;
    const childRect = { left: rect.left, right: rect.right, top: cursor, bottom: cursor + height };
    cursor += height;
    return collectPaneRects(child, childRect);
  });
}

function isInDirection(from: PaneRect, to: PaneRect, direction: TerminalV2FocusDirection): boolean {
  if (direction === "left") return to.right <= from.left;
  if (direction === "right") return to.left >= from.right;
  if (direction === "up") return to.bottom <= from.top;
  return to.top >= from.bottom;
}

function compareDirectionalCandidates(
  from: PaneRect,
  a: PaneRect,
  b: PaneRect,
  direction: TerminalV2FocusDirection,
): number {
  const aScore = scoreDirectionalCandidate(from, a, direction);
  const bScore = scoreDirectionalCandidate(from, b, direction);
  return compareNumbers(aScore.overlapPenalty, bScore.overlapPenalty)
    || compareNumbers(aScore.primaryDistance, bScore.primaryDistance)
    || compareNumbers(aScore.secondaryDistance, bScore.secondaryDistance)
    || compareNumbers(bScore.overlapAmount, aScore.overlapAmount)
    || compareVisualOrder(a, b);
}

function scoreDirectionalCandidate(from: PaneRect, to: PaneRect, direction: TerminalV2FocusDirection): {
  overlapPenalty: number;
  primaryDistance: number;
  secondaryDistance: number;
  overlapAmount: number;
} {
  const fromCenterX = (from.left + from.right) / 2;
  const fromCenterY = (from.top + from.bottom) / 2;
  const toCenterX = (to.left + to.right) / 2;
  const toCenterY = (to.top + to.bottom) / 2;
  const horizontal = direction === "left" || direction === "right";
  const primaryDistance = direction === "left"
    ? from.left - to.right
    : direction === "right"
      ? to.left - from.right
      : direction === "up"
        ? from.top - to.bottom
        : to.top - from.bottom;
  const secondaryDistance = horizontal
    ? Math.abs(fromCenterY - toCenterY)
    : Math.abs(fromCenterX - toCenterX);
  const overlapAmount = horizontal
    ? axisOverlap(from.top, from.bottom, to.top, to.bottom)
    : axisOverlap(from.left, from.right, to.left, to.right);

  return {
    overlapPenalty: overlapAmount > 0 ? 0 : 1,
    primaryDistance,
    secondaryDistance,
    overlapAmount,
  };
}

function compareVisualOrder(a: PaneRect, b: PaneRect): number {
  return compareNumbers(a.top, b.top)
    || compareNumbers(a.left, b.left)
    || compareNumbers(a.bottom, b.bottom)
    || compareNumbers(a.right, b.right)
    || a.paneId.localeCompare(b.paneId);
}

function axisOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function compareNumbers(a: number, b: number): number {
  const diff = a - b;
  return Math.abs(diff) < 0.001 ? 0 : diff;
}
