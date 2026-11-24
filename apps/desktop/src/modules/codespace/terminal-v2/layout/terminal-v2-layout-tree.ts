export type TerminalV2LayoutDirection = "horizontal" | "vertical";

export type TerminalV2LayoutLeafNode = {
  kind: "leaf";
  paneId: string;
};

export type TerminalV2LayoutSplitNode = {
  kind: "split";
  direction: TerminalV2LayoutDirection;
  children: TerminalV2LayoutNode[];
  sizes: number[];
};

export type TerminalV2LayoutNode = TerminalV2LayoutLeafNode | TerminalV2LayoutSplitNode;

export type TerminalV2LayoutTree = {
  root: TerminalV2LayoutNode | null;
  activePaneId: string | null;
};

export function createEmptyTerminalV2Layout(): TerminalV2LayoutTree {
  return { root: null, activePaneId: null };
}

export function createTerminalV2LayoutWithPane(paneId: string): TerminalV2LayoutTree {
  return {
    root: createLeaf(paneId),
    activePaneId: paneId,
  };
}

export function createTerminalV2LayoutFromPaneIds(
  paneIds: readonly string[],
  activePaneId: string | null,
): TerminalV2LayoutTree {
  const uniquePaneIds = Array.from(new Set(paneIds));
  if (uniquePaneIds.length === 0) return createEmptyTerminalV2Layout();
  if (uniquePaneIds.length === 1) {
    return { root: createLeaf(uniquePaneIds[0] ?? ""), activePaneId: uniquePaneIds[0] ?? null };
  }

  const resolvedActivePaneId = activePaneId && uniquePaneIds.includes(activePaneId)
    ? activePaneId
    : uniquePaneIds[0] ?? null;

  return {
    root: normalizeSplit({
      kind: "split",
      direction: "horizontal",
      children: uniquePaneIds.map(createLeaf),
      sizes: [],
    }),
    activePaneId: resolvedActivePaneId,
  };
}

export function getTerminalV2LayoutPaneIds(node: TerminalV2LayoutNode | null): string[] {
  if (!node) return [];
  if (node.kind === "leaf") return [node.paneId];
  return node.children.flatMap(getTerminalV2LayoutPaneIds);
}

export function hasTerminalV2LayoutPane(node: TerminalV2LayoutNode | null, paneId: string): boolean {
  return getTerminalV2LayoutPaneIds(node).includes(paneId);
}

export function sanitizeTerminalV2LayoutTree(
  layout: unknown,
  validPaneIds: readonly string[],
  preferredActivePaneId: string | null = null,
): TerminalV2LayoutTree | null {
  const validPaneIdSet = new Set(validPaneIds);
  const rawLayout = isRecord(layout) ? layout : null;
  if (!rawLayout) return null;

  const root = sanitizeNode(rawLayout.root, validPaneIdSet);
  if (!root) return createEmptyTerminalV2Layout();

  const paneIds = getTerminalV2LayoutPaneIds(root);
  const rawActivePaneId = typeof rawLayout.activePaneId === "string" ? rawLayout.activePaneId : null;
  const activePaneId = rawActivePaneId && paneIds.includes(rawActivePaneId)
    ? rawActivePaneId
    : preferredActivePaneId && paneIds.includes(preferredActivePaneId)
      ? preferredActivePaneId
      : paneIds[0] ?? null;

  return { root, activePaneId };
}

export function focusTerminalV2LayoutPane(
  layout: TerminalV2LayoutTree,
  paneId: string,
): TerminalV2LayoutTree {
  if (!hasTerminalV2LayoutPane(layout.root, paneId)) return layout;
  if (layout.activePaneId === paneId) return layout;
  return { ...layout, activePaneId: paneId };
}

export function splitTerminalV2LayoutPane(
  layout: TerminalV2LayoutTree,
  targetPaneId: string,
  newPaneId: string,
  direction: TerminalV2LayoutDirection,
): TerminalV2LayoutTree {
  if (!layout.root) return createTerminalV2LayoutWithPane(newPaneId);
  if (!hasTerminalV2LayoutPane(layout.root, targetPaneId)) return layout;
  if (hasTerminalV2LayoutPane(layout.root, newPaneId)) return layout;

  return {
    root: splitNode(layout.root, targetPaneId, createLeaf(newPaneId), direction),
    activePaneId: newPaneId,
  };
}

/** Two panes trade places; every split keeps its shape and sizes. */
export function swapTerminalV2LayoutPanes(layout: TerminalV2LayoutTree, a: string, b: string): TerminalV2LayoutTree {
  if (a === b || !hasTerminalV2LayoutPane(layout.root, a) || !hasTerminalV2LayoutPane(layout.root, b)) return layout;
  const swap = (node: TerminalV2LayoutNode): TerminalV2LayoutNode =>
    node.kind === "leaf"
      ? createLeaf(node.paneId === a ? b : node.paneId === b ? a : node.paneId)
      : { ...node, children: node.children.map(swap) };
  return { ...layout, root: layout.root && swap(layout.root) };
}

export function resizeTerminalV2LayoutSplit(
  layout: TerminalV2LayoutTree,
  splitPath: readonly number[],
  sizes: readonly number[],
): TerminalV2LayoutTree {
  if (!layout.root) return layout;
  const root = resizeSplitNode(layout.root, splitPath, sizes);
  return root === layout.root ? layout : { ...layout, root };
}

export function closeTerminalV2LayoutPane(
  layout: TerminalV2LayoutTree,
  paneId: string,
): TerminalV2LayoutTree {
  if (!layout.root || !hasTerminalV2LayoutPane(layout.root, paneId)) return layout;

  const before = getTerminalV2LayoutPaneIds(layout.root);
  const nextActivePaneId = resolveNextActivePaneId(before, paneId, layout.activePaneId);
  const root = removeNode(layout.root, paneId);
  const remainingIds = getTerminalV2LayoutPaneIds(root);

  return {
    root,
    activePaneId: remainingIds.includes(nextActivePaneId ?? "") ? nextActivePaneId : remainingIds[0] ?? null,
  };
}

function createLeaf(paneId: string): TerminalV2LayoutLeafNode {
  return { kind: "leaf", paneId };
}

function sanitizeNode(rawNode: unknown, validPaneIds: Set<string>): TerminalV2LayoutNode | null {
  if (!isRecord(rawNode)) return null;
  if (rawNode.kind === "leaf") {
    return typeof rawNode.paneId === "string" && validPaneIds.has(rawNode.paneId)
      ? createLeaf(rawNode.paneId)
      : null;
  }
  if (rawNode.kind !== "split") return null;
  if (rawNode.direction !== "horizontal" && rawNode.direction !== "vertical") return null;
  if (!Array.isArray(rawNode.children)) return null;

  const children = rawNode.children
    .map((child) => sanitizeNode(child, validPaneIds))
    .filter((child): child is TerminalV2LayoutNode => Boolean(child));

  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return normalizeSplit({
    kind: "split",
    direction: rawNode.direction,
    children,
    sizes: Array.isArray(rawNode.sizes) ? rawNode.sizes.filter((size): size is number => typeof size === "number") : [],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function splitNode(
  node: TerminalV2LayoutNode,
  targetPaneId: string,
  newLeaf: TerminalV2LayoutLeafNode,
  direction: TerminalV2LayoutDirection,
): TerminalV2LayoutNode {
  if (node.kind === "leaf") {
    if (node.paneId !== targetPaneId) return node;
    return normalizeSplit({
      kind: "split",
      direction,
      children: [node, newLeaf],
      sizes: [50, 50],
    });
  }

  const directIndex = node.children.findIndex(
    (child) => child.kind === "leaf" && child.paneId === targetPaneId,
  );
  if (directIndex >= 0 && node.direction === direction) {
    return normalizeSplit({
      ...node,
      children: insertAfter(node.children, directIndex, newLeaf),
    });
  }

  let changed = false;
  const children = node.children.map((child) => {
    const next = splitNode(child, targetPaneId, newLeaf, direction);
    if (next !== child) changed = true;
    return next;
  });

  return changed ? normalizeSplit({ ...node, children }) : node;
}

function resizeSplitNode(
  node: TerminalV2LayoutNode,
  splitPath: readonly number[],
  sizes: readonly number[],
): TerminalV2LayoutNode {
  if (node.kind === "leaf") return node;
  if (splitPath.length === 0) {
    const nextSizes = normalizeSizes(sizes, node.children.length);
    return sizesEqual(node.sizes, nextSizes) ? node : { ...node, sizes: nextSizes };
  }

  const [childIndex, ...rest] = splitPath;
  if (childIndex === undefined || childIndex < 0 || childIndex >= node.children.length) return node;
  const child = node.children[childIndex];
  if (!child) return node;
  const nextChild = resizeSplitNode(child, rest, sizes);
  if (nextChild === child) return node;
  const children = node.children.map((item, index) => index === childIndex ? nextChild : item);
  return { ...node, children };
}

function removeNode(node: TerminalV2LayoutNode, paneId: string): TerminalV2LayoutNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;

  const children = node.children
    .map((child) => removeNode(child, paneId))
    .filter((child): child is TerminalV2LayoutNode => Boolean(child));

  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return normalizeSplit({ ...node, children });
}

function normalizeSplit(node: TerminalV2LayoutSplitNode): TerminalV2LayoutSplitNode {
  return {
    ...node,
    sizes: normalizeSizes(node.sizes, node.children.length),
  };
}

function normalizeSizes(sizes: readonly number[], count: number): number[] {
  const validSizes = sizes.length === count && sizes.every((size) => Number.isFinite(size) && size > 0)
    ? Array.from(sizes)
    : [];
  if (validSizes.length === 0) return Array.from({ length: count }, () => count > 0 ? 100 / count : 100);

  const total = validSizes.reduce((sum, size) => sum + size, 0);
  if (total <= 0) return Array.from({ length: count }, () => count > 0 ? 100 / count : 100);
  return validSizes.map((size) => (size / total) * 100);
}

function sizesEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => Math.abs(value - (b[index] ?? 0)) < 0.001);
}

function insertAfter<T>(items: T[], index: number, item: T): T[] {
  return [
    ...items.slice(0, index + 1),
    item,
    ...items.slice(index + 1),
  ];
}

function resolveNextActivePaneId(
  ids: string[],
  closedPaneId: string,
  activePaneId: string | null,
): string | null {
  if (activePaneId && activePaneId !== closedPaneId) return activePaneId;
  const index = ids.indexOf(closedPaneId);
  if (index < 0) return activePaneId;
  return ids[index + 1] ?? ids[index - 1] ?? null;
}
