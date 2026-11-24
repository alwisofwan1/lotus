import type { Node } from "@xyflow/react";

export type ArrangeDirection = "front" | "back";

/**
 * Reorder a node within the array to change paint order — later in the array paints on
 * top (ReactFlow renders in order). "front" moves it last, "back" moves it first.
 * Pure: returns a new array; unchanged (copied) when the id is absent.
 */
export function reorderNodes(nodes: Node[], id: string, direction: ArrangeDirection): Node[] {
  const index = nodes.findIndex((node) => node.id === id);
  if (index === -1) return [...nodes];
  const rest = [...nodes.slice(0, index), ...nodes.slice(index + 1)];
  const node = nodes[index];
  return direction === "front" ? [...rest, node] : [node, ...rest];
}

/**
 * Reorder several nodes as one contiguous block, preserving their relative order. "front" moves
 * the block to the end of the array (paints on top); "back" moves it to the start. Used for
 * multi-select and grouped arrange so members stay together and keep their stacking among
 * themselves. Pure: returns a new array; ids absent from `nodes` are ignored.
 */
export function reorderNodesMany(nodes: Node[], ids: string[], direction: ArrangeDirection): Node[] {
  const idSet = new Set(ids);
  // Preserve the block's relative order by reading it off the current array, not the ids arg.
  const block = nodes.filter((node) => idSet.has(node.id));
  if (block.length === 0) return [...nodes];
  const rest = nodes.filter((node) => !idSet.has(node.id));
  return direction === "front" ? [...rest, ...block] : [...block, ...rest];
}
