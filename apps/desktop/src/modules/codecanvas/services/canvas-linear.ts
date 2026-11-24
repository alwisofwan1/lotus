import type { Options } from "roughjs/bin/core";
import type { RoughGenerator } from "roughjs/bin/generator";
import type { PathInfo } from "roughjs/bin/core";
import type { CanvasArrowhead } from "../types/canvas";

/**
 * Pure geometry + rough.js path construction for linear shapes (arrow / line). Kept out of the
 * ShapeNode component so the routing and arrowhead math unit-test without React. rough.js is a
 * visual layer only — these helpers never own state.
 */

export type Pt = [number, number];

/**
 * Orthogonal "elbow" route through the given points: between each consecutive pair, travel
 * horizontally then vertically, inserting a single bend (skipped when the leg is already axis-
 * aligned). A 2-point input yields an L-shaped connector, matching Excalidraw's elbow arrows.
 */
export function elbowRoute(points: Pt[]): Pt[] {
  if (points.length < 2) return points;
  const out: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const prev = out[out.length - 1];
    const [qx, qy] = points[i];
    if (qx !== prev[0] && qy !== prev[1]) out.push([qx, prev[1]]); // horizontal leg before the vertical drop
    out.push([qx, qy]);
  }
  return out;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Replace the point at `index` (clamped to the 0..1 box); a bad index leaves the path intact. */
export function updatePoint(points: Pt[], index: number, next: Pt): Pt[] {
  if (index < 0 || index >= points.length) return points;
  return points.map((p, i) => (i === index ? [clamp01(next[0]), clamp01(next[1])] : p));
}

/** Squared distance from point p to segment a→b (normalized space). */
function segDistSq(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
}

/** Insert `pt` into the segment nearest to it, so a Cmd+double-click adds a midpoint in place. */
export function insertPointAt(points: Pt[], pt: Pt): Pt[] {
  if (points.length < 2) return [...points, pt];
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const d = segDistSq(pt, points[i], points[i + 1]);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return [...points.slice(0, best + 1), [clamp01(pt[0]), clamp01(pt[1])], ...points.slice(best + 1)];
}

/**
 * Recompute a linear shape's geometry when one of its points is dragged in flow space.
 * The dragged point is placed at `flowPoint`; the node box is refit to the bounding box of all
 * points (so dragging an endpoint lengthens/shortens the arrow and the box follows, Excalidraw-
 * style), and every point is renormalized into the new box. A zero-area drag floors to `minSize`.
 */
export function arrowGeometryFromDrag(
  points: Pt[],
  box: { x: number; y: number; w: number; h: number },
  index: number,
  flowPoint: { x: number; y: number },
  minSize = 2,
): { position: { x: number; y: number }; size: { w: number; h: number }; points: Pt[] } {
  const abs: Pt[] = points.map((p) => [box.x + p[0] * box.w, box.y + p[1] * box.h]);
  if (index >= 0 && index < abs.length) abs[index] = [flowPoint.x, flowPoint.y];
  const xs = abs.map((a) => a[0]);
  const ys = abs.map((a) => a[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(Math.max(...xs) - minX, minSize);
  const h = Math.max(Math.max(...ys) - minY, minSize);
  return {
    position: { x: minX, y: minY },
    size: { w, h },
    points: abs.map((a) => [(a[0] - minX) / w, (a[1] - minY) / h]),
  };
}

function arrowheadPaths(gen: RoughGenerator, tip: Pt, from: Pt, kind: CanvasArrowhead, options: Options): PathInfo[] {
  if (kind === "none") return [];
  if (kind === "dot") {
    return gen.toPaths(gen.circle(tip[0], tip[1], 9, { ...options, fill: options.stroke, fillStyle: "solid" }));
  }
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const len = 13;
  const spread = Math.PI / 7;
  const lx = tip[0] - len * Math.cos(angle - spread);
  const ly = tip[1] - len * Math.sin(angle - spread);
  const rx = tip[0] - len * Math.cos(angle + spread);
  const ry = tip[1] - len * Math.sin(angle + spread);
  if (kind === "triangle") {
    return gen.toPaths(gen.polygon([[tip[0], tip[1]], [lx, ly], [rx, ry]], { ...options, fill: options.stroke, fillStyle: "solid" }));
  }
  // "arrow" — an open V of two short strokes.
  return [
    ...gen.toPaths(gen.line(tip[0], tip[1], lx, ly, options)),
    ...gen.toPaths(gen.line(tip[0], tip[1], rx, ry, options)),
  ];
}

export interface LinearRoughInput {
  width: number;
  height: number;
  /** Normalized 0..1 endpoints within the node box (>= 2 points). */
  points?: Array<[number, number]>;
  arrowType: "straight" | "curved" | "elbow";
  startArrowhead: CanvasArrowhead;
  endArrowhead: CanvasArrowhead;
  options: Options;
}

/** Build the rough paths for a linear shape: body (straight/curved/elbow) + optional heads. */
export function linearRoughPaths(gen: RoughGenerator, input: LinearRoughInput): PathInfo[] {
  const norm = input.points && input.points.length >= 2 ? input.points : [[0, 0], [1, 1]] as Pt[];
  const pts: Pt[] = norm.map(([nx, ny]) => [nx * input.width, ny * input.height]);
  const routed = input.arrowType === "elbow" ? elbowRoute(pts) : pts;
  const body = input.arrowType === "curved" && routed.length >= 2
    ? gen.curve(routed, input.options)
    : gen.linearPath(routed, input.options);
  const paths = gen.toPaths(body);
  const n = routed.length;
  paths.push(...arrowheadPaths(gen, routed[n - 1], routed[n - 2], input.endArrowhead, input.options));
  paths.push(...arrowheadPaths(gen, routed[0], routed[1], input.startArrowhead, input.options));
  return paths;
}
