import type { Node } from "@xyflow/react";
import { arrangeNodeSet, isTiledCanvasNode, type ArrangeBox } from "./canvas-arrange";
import { frameOccupiedBox } from "./canvas-frame-geometry";
import { boxesOverlap, frameBoxOf, placeFrameInFreeSpace } from "./canvas-frame-space";
import { focusCanvasLayout } from "./canvas-focus-layout";
import { frameIdOf, frameMembers, framesInOrder, isFrameNode } from "./canvas-frames";

/**
 * Focus a Frame (decision 35). Pure: the target boxes for the Frame and its members, never for any
 * other node.
 *
 * The members are tiled with the same adaptive grid and `fit` rule as "arrange the canvas"
 * ({@link arrangeNodeSet}); the Frame box then hugs them exactly (Frame padding is 0) and keeps its
 * top-left. When that grown box (title-tab strip included) would overlap another Frame, the Frame
 * and its members move together to the nearest free space; other Frames never move. Shape members
 * are annotations: they keep their place and widen the box if they stick out.
 *
 * Null when there is nothing to tile (unknown Frame, no window members): the caller just flies the
 * camera to the Frame.
 */
export function frameFocusLayout(
  nodes: readonly Node[],
  frameId: string,
  fit: { width: number; height: number },
): { boxes: Map<string, ArrangeBox> } | null {
  const frame = framesInOrder(nodes).find((f) => f.id === frameId);
  if (!frame) return null;
  const members = frameMembers(nodes, frameId);
  const windows = members.filter(isTiledCanvasNode);
  if (windows.length === 0) return null;

  const grid = arrangeNodeSet(windows, { fit });
  return { boxes: hugFrame(nodes, frame, grid, []).boxes };
}

/**
 * Anchor `tiles` (target boxes of window members) at the Frame's top-left, add the shape members (which
 * keep their place), and make the Frame box hug the lot (`extras`, e.g. a rail slot that is not a node,
 * count toward the box). When the grown box (tab strip included) would hit another Frame, everything moves
 * together to the nearest free space; other Frames never move. `dx`/`dy` is that move, so the caller can
 * shift its own `extras`.
 */
function hugFrame(
  nodes: readonly Node[],
  frame: Node,
  tiles: Map<string, ArrangeBox>,
  extras: readonly ArrangeBox[],
): { boxes: Map<string, ArrangeBox>; dx: number; dy: number } {
  const frameId = frame.id;
  let gx = Infinity;
  let gy = Infinity;
  for (const b of tiles.values()) {
    gx = Math.min(gx, b.x);
    gy = Math.min(gy, b.y);
  }
  const boxes = new Map<string, ArrangeBox>();
  for (const [id, b] of tiles) boxes.set(id, { ...b, x: b.x - gx + frame.position.x, y: b.y - gy + frame.position.y });
  const shiftedExtras = extras.map((b) => ({ ...b, x: b.x - gx + frame.position.x, y: b.y - gy + frame.position.y }));
  for (const s of frameMembers(nodes, frameId).filter((m) => !isTiledCanvasNode(m))) {
    const { w, h } = frameBoxOf(s);
    boxes.set(s.id, { x: s.position.x, y: s.position.y, width: w, height: h });
  }

  const union = unionOf([...boxes.values(), ...shiftedExtras]);
  const others = framesInOrder(nodes).filter((f) => f.id !== frameId);
  let dx = 0;
  let dy = 0;
  const occupied = frameOccupiedBox({ x: union.x, y: union.y, w: union.width, h: union.height });
  if (others.some((o) => boxesOverlap(occupied, frameOccupiedBox(frameBoxOf(o))))) {
    const spot = placeFrameInFreeSpace(
      others,
      { w: union.width, h: union.height },
      { x: union.x + union.width / 2, y: union.y + union.height / 2 },
    );
    dx = spot.x - union.x;
    dy = spot.y - union.y;
  }
  if (dx !== 0 || dy !== 0) for (const [id, b] of boxes) boxes.set(id, { ...b, x: b.x + dx, y: b.y + dy });
  boxes.set(frameId, { x: union.x + dx, y: union.y + dy, width: union.width, height: union.height });
  return { boxes, dx: dx + frame.position.x - gx, dy: dy + frame.position.y - gy };
}

const heroFrame = (nodes: readonly Node[], heroId: string): { frame: Node; windows: Node[] } | null => {
  const hero = nodes.find((n) => n.id === heroId);
  const frameId = hero && !isFrameNode(hero) ? frameIdOf(hero) : undefined;
  const frame = frameId ? framesInOrder(nodes).find((f) => f.id === frameId) : undefined;
  if (!frame || !hero || !isTiledCanvasNode(hero)) return null;
  return { frame, windows: frameMembers(nodes, frame.id).filter(isTiledCanvasNode) };
};

/**
 * Node focus (hero + thumbnail rail) when the hero is a Frame member (decision 41). The hero and the rail
 * are built from THAT Frame's window members only; other Frames and loose nodes never move; the Frame box
 * hugs hero + rail. Null when the hero is not in a Frame (the caller uses the whole-canvas focus layout).
 */
export function frameNodeFocusLayout(
  nodes: readonly Node[],
  heroId: string,
  fit: { width: number; height: number },
): { boxes: Map<string, ArrangeBox> } | null {
  const scope = heroFrame(nodes, heroId);
  if (!scope) return null;
  const tiles = focusCanvasLayout(scope.windows, heroId, { fit });
  if (tiles.size === 0) return null;
  return { boxes: hugFrame(nodes, scope.frame, tiles, []).boxes };
}

function unionOf(boxes: Iterable<ArrangeBox>): ArrangeBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
