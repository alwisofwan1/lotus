import type { Node } from "@xyflow/react";

/**
 * Tags on a nodes array saying who wrote it, so observers of the board can tell an automatic write from a
 * user's edit without threading flags through React state. The array is the one `useNodesState` holds, so the
 * tag lives exactly as long as that board does.
 *
 * - layout: arrange, Frame re-tile, node focus, Grid snap. Never an undo step (history adopts it as the baseline).
 * - restore: an undo/redo restore. The Frame Grid must not snap over it, or the snap would wipe the redo branch.
 */
const layoutBoards = new WeakSet<readonly Node[]>();
const restoreBoards = new WeakSet<readonly Node[]>();

export function markLayoutBoard<T extends readonly Node[]>(nodes: T): T {
  layoutBoards.add(nodes);
  return nodes;
}

export function isLayoutBoard(nodes: readonly Node[]): boolean {
  return layoutBoards.has(nodes);
}

export function markRestoreBoard<T extends readonly Node[]>(nodes: T): T {
  restoreBoards.add(nodes);
  return nodes;
}

export function isRestoreBoard(nodes: readonly Node[]): boolean {
  return restoreBoards.has(nodes);
}
