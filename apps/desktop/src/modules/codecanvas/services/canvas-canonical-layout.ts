import type { Node } from "@xyflow/react";
import { isTiledCanvasNode, type ArrangeBox } from "./canvas-arrange";
import { isFrameNode } from "./canvas-frames";

const VEIL_CLASS = "canvas-node-veiled";

function withoutFleetVeil(className: string | undefined): string {
  return (className ?? "")
    .split(" ")
    .filter((value) => value && value !== VEIL_CLASS)
    .join(" ");
}

/**
 * Pre-focus geometry of every tiled node AND every Frame box. Node focus inside a Frame resizes the
 * Frame (decision 41), so exit must be able to put the box back too.
 */
export function layoutSnapshotOf(nodes: readonly Node[], fallback: { w: number; h: number }): Map<string, ArrangeBox> {
  const snapshot = new Map<string, ArrangeBox>();
  for (const n of nodes) {
    if (!isTiledCanvasNode(n) && !isFrameNode(n)) continue;
    snapshot.set(n.id, {
      x: n.position.x,
      y: n.position.y,
      width: n.width ?? n.measured?.width ?? fallback.w,
      height: n.height ?? n.measured?.height ?? fallback.h,
    });
  }
  return snapshot;
}

/**
 * Projects runtime Fleet nodes back onto their canonical pre-Fleet geometry for persistence.
 * The live renderer state is never mutated.
 */
export function canonicalCanvasNodes(
  nodes: Node[],
  snapshot: Map<string, ArrangeBox> | null,
): Node[] {
  return nodes.map((node) => {
    const box = snapshot?.get(node.id);
    const className = withoutFleetVeil(node.className);
    if (!box) return node.className === className ? node : { ...node, className };
    return {
      ...node,
      className,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      measured: { width: box.width, height: box.height },
      style: { ...node.style, width: box.width, height: box.height },
    };
  });
}
