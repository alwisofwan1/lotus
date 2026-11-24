import type { Node } from "@xyflow/react";

/**
 * What ⏎ on the selected node should open in Code, or null to let it dive into the node as usual.
 * This is the canvas hotkey layer's rule (the `dive-into-node` command), not a listener on the node:
 * a selected node's focus sits on ReactFlow's wrapper, so a key never reaches the node's own DOM.
 * A focused button is left alone because it activates itself on ⏎.
 */
export function pathToOpenOnEnter(node: Pick<Node, "type" | "data"> | undefined, activeElement: Element | null): string | null {
  if (!node || node.type !== "file") return null;
  if (activeElement?.closest("button, a, [role='button']")) return null;
  const path = (node.data as { path?: unknown } | undefined)?.path;
  return typeof path === "string" && path ? path : null;
}
