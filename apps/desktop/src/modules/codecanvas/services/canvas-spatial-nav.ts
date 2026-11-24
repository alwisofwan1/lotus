/**
 * canvas-spatial-nav — pure directional node navigation.
 *
 * Given node rectangles and a source, find the nearest node in a compass direction. Uses a
 * directional gate (the candidate must genuinely lie that way) plus a distance score that
 * penalizes off-axis drift, so "go right" prefers the node most directly to the right.
 */

export interface SpatialRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SpatialDirection = "left" | "right" | "up" | "down";

function centerOf(r: SpatialRect): { x: number; y: number } {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** The id of the nearest node from `fromId` in `direction`, or null if none lies that way. */
export function nearestNodeInDirection(
  rects: readonly SpatialRect[],
  fromId: string,
  direction: SpatialDirection,
): string | null {
  const source = rects.find((r) => r.id === fromId);
  if (!source) return null;
  const from = centerOf(source);

  let best: string | null = null;
  let bestScore = Infinity;
  for (const rect of rects) {
    if (rect.id === fromId) continue;
    const to = centerOf(rect);
    const dx = to.x - from.x;
    const dy = to.y - from.y;

    let along = 0;
    let perp = 0;
    if (direction === "right") { along = dx; perp = Math.abs(dy); }
    else if (direction === "left") { along = -dx; perp = Math.abs(dy); }
    else if (direction === "down") { along = dy; perp = Math.abs(dx); }
    else { along = -dy; perp = Math.abs(dx); }

    // Must lie in the direction, within a ~45° cone (off-axis no larger than on-axis).
    if (along <= 0 || perp > along) continue;

    const score = along + perp * 2;
    if (score < bestScore) {
      bestScore = score;
      best = rect.id;
    }
  }
  return best;
}

/**
 * Step through an ordered id list (slot / reading order) by `delta` (+1 forward, -1 back), wrapping
 * around. With no current id, forward starts at the first entry and backward at the last.
 */
export function stepInOrder(ids: readonly string[], currentId: string | null, delta: number): string | null {
  if (ids.length === 0) return null;
  const idx = currentId ? ids.indexOf(currentId) : -1;
  if (idx < 0) return delta >= 0 ? ids[0] : ids[ids.length - 1];
  const next = (idx + delta + ids.length) % ids.length;
  return ids[next];
}
