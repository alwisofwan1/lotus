import type { Node } from "@xyflow/react";

/**
 * Selection elevation policy. ReactFlow's own `elevateNodesOnSelect` bumps EVERY selected node to
 * z≈1000, which breaks the whiteboard's contract that paint order is governed purely by array
 * position (canvas-node-order.ts): a selected rectangle jumps above the text drawn on top of it,
 * so the text visibly "sinks" and its hit area is swallowed. The prop is therefore always false
 * on <ReactFlow>, and this policy reimplements the useful half per node type:
 *
 *   • `shape` nodes NEVER elevate — array order is their only stacking truth.
 *   • Other (windowed) nodes elevate to 1000 while selected, when the setting is on.
 *
 * Pure; preserves object identity for nodes whose zIndex is already correct so the injector's
 * identity-preservation (drag perf) carries through.
 */

const ELEVATED_Z = 1000;

export function applySelectionElevation(nodes: Node[], elevateOnSelect: boolean): Node[] {
  return nodes.map((node) => {
    const wanted = elevateOnSelect && node.selected && node.type !== "shape" ? ELEVATED_Z : 0;
    const current = node.zIndex ?? 0;
    if (current === wanted) return node;
    if (wanted === 0) {
      const rest = { ...node };
      delete rest.zIndex;
      return rest;
    }
    return { ...node, zIndex: wanted };
  });
}
