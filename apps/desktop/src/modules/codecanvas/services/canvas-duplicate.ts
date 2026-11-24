import type { Node } from "@xyflow/react";
import type { CanvasShapeNodeData } from "../types/canvas";
import { frameIdOf } from "./canvas-frames";
import { shapeNode } from "./canvas-node-factory";

/**
 * Duplicate shapes the way Excalidraw does: a faithful copy at a small offset. Rotation, image
 * asset, style and text carry over. Frame membership carries over: a copy of a Frame member stays
 * in that Frame (the copy sits 24px away, still inside it). Diagram identity (`diagramId` & co.) is dropped:
 * edit-in-place must keep targeting the original diagram. Non-shape nodes are ignored. Pure.
 */
export const DUPLICATE_OFFSET = 24;

export function duplicateShapes(
  nodes: Node[],
  opts: { newId: () => string; offset?: number },
): Node[] {
  const offset = opts.offset ?? DUPLICATE_OFFSET;
  return nodes
    .filter((n) => n.type === "shape")
    .map((n) => {
      const d = n.data as CanvasShapeNodeData;
      const frameId = frameIdOf(n);
      const copy = shapeNode({
        id: opts.newId(),
        position: { x: n.position.x + offset, y: n.position.y + offset },
        shape: d.shape,
        ...(d.text !== undefined ? { text: d.text } : {}),
        ...(typeof d.angle === "number" ? { angle: d.angle } : {}),
        ...(d.areaLabel !== undefined ? { areaLabel: d.areaLabel } : {}),
        ...(d.points ? { points: d.points } : {}),
        ...(d.style ? { style: d.style } : {}),
        ...(d.imageAssetUri ? { imageAssetUri: d.imageAssetUri } : {}),
        ...(d.imageAlt !== undefined ? { imageAlt: d.imageAlt } : {}),
        ...(d.imageNaturalWidth !== undefined ? { imageNaturalWidth: d.imageNaturalWidth } : {}),
        ...(d.imageNaturalHeight !== undefined ? { imageNaturalHeight: d.imageNaturalHeight } : {}),
        ...(n.width && n.height ? { size: { w: n.width, h: n.height } } : {}),
      });
      return frameId ? { ...copy, data: { ...copy.data, frameId } } : copy;
    });
}
