/**
 * Pure hit-testing for the eraser tool. Container/text/image shapes use bounding-box
 * containment (cheap, predictable). Linear shapes (line/arrow/draw) are stroke-based: a
 * diagonal line's bbox is mostly empty, so bbox-only made the eraser destroy strokes the
 * cursor never touched — instead the cursor must pass within `tolerance` of the polyline.
 */

const LINEAR_SHAPES = new Set(["line", "arrow", "draw"]);

export interface HitTestNode {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  /** Shape kind — linear kinds get stroke-based hit testing. */
  shape?: string;
  /** Polyline points normalized 0..1 within the bbox (linear/freehand shapes). */
  points?: Array<[number, number]>;
}

/** Squared distance from point p to segment ab. */
function distSqToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / lenSq));
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

function nearPolyline(node: HitTestNode, point: { x: number; y: number }, tolerance: number): boolean {
  const pts = node.points!;
  const w = node.width!;
  const h = node.height!;
  const tolSq = tolerance * tolerance;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const d = distSqToSegment(
      point.x, point.y,
      node.position.x + ax * w, node.position.y + ay * h,
      node.position.x + bx * w, node.position.y + by * h,
    );
    if (d <= tolSq) return true;
  }
  return false;
}

/** Ids of nodes the eraser cursor hits at the flow-space point, in input (z-order) order. */
export function shapeHitTest(nodes: HitTestNode[], point: { x: number; y: number }, tolerance = 6): string[] {
  const hits: string[] = [];
  for (const node of nodes) {
    if (!node.width || !node.height) continue;
    const { x, y } = node.position;
    // Pad the bbox gate by the tolerance so a stroke hugging the box edge stays erasable.
    const inBox =
      point.x >= x - tolerance && point.x <= x + node.width + tolerance &&
      point.y >= y - tolerance && point.y <= y + node.height + tolerance;
    if (!inBox) continue;
    if (node.shape && LINEAR_SHAPES.has(node.shape) && node.points && node.points.length >= 2) {
      if (nearPolyline(node, point, tolerance)) hits.push(node.id);
      continue;
    }
    // Non-linear shapes keep strict bbox containment (no tolerance padding needed).
    if (point.x >= x && point.x <= x + node.width && point.y >= y && point.y <= y + node.height) {
      hits.push(node.id);
    }
  }
  return hits;
}
