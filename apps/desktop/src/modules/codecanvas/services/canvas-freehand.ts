/**
 * Freehand trail post-processing. A 120Hz pointer emits thousands of samples per stroke;
 * storing them all bloats the snapshot and makes rough.js re-render the whole cloud on every
 * resize. Ramer–Douglas–Peucker keeps only the points that shape the line: sensor noise below
 * `epsilon` (screen px) collapses, corners and curvature survive. Pure; used at commit time by
 * CanvasDrawCapture, never during the live gesture.
 */

export interface TrailPoint {
  x: number;
  y: number;
}

/** Perpendicular distance from p to the chord a→b (falls back to distance-to-a for a degenerate chord). */
function perpDistance(p: TrailPoint, a: TrailPoint, b: TrailPoint): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(abx * (a.y - p.y) - (a.x - p.x) * aby) / Math.sqrt(lenSq);
}

export function simplifyTrail(trail: TrailPoint[], epsilon: number): TrailPoint[] {
  if (trail.length <= 2) return [...trail];
  // Iterative RDP (explicit stack — a long stroke must not blow the call stack).
  const keep = new Array<boolean>(trail.length).fill(false);
  keep[0] = keep[trail.length - 1] = true;
  const stack: Array<[number, number]> = [[0, trail.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistance(trail[i], trail[start], trail[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxIndex !== -1 && maxDist > epsilon) {
      keep[maxIndex] = true;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  return trail.filter((_, i) => keep[i]);
}
