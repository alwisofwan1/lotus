import type { CanvasShapeKind, CanvasShapeStyle, CanvasStrokeStyle, ShapeNodePatch } from "../types/canvas";
import { normalizeShapeStrokeWidth } from "./shape-defaults";
import { normalizeAngle } from "./canvas-rotation";

/**
 * Validation/repair for whiteboard `shape` node fields. Pure; mirrors the codec helpers
 * so the monolithic snapshot codec stays small. No rough/React dependency.
 */

const SHAPE_KINDS = new Set<CanvasShapeKind>(["rectangle", "diamond", "ellipse", "text", "arrow", "line", "draw", "image"]);
const STROKE_STYLES = new Set<CanvasStrokeStyle>(["solid", "dashed", "dotted"]);
const SLOPPINESS = new Set(["architect", "artist", "cartoonist"]);
const FILL_STYLES = new Set<NonNullable<CanvasShapeStyle["fillStyle"]>>(["solid", "hachure", "cross-hatch"]);
const FONT_FAMILIES = new Set<NonNullable<CanvasShapeStyle["fontFamily"]>>(["hand", "normal", "heading", "code"]);
const FONT_SIZES = new Set<NonNullable<CanvasShapeStyle["fontSize"]>>(["S", "M", "L", "XL"]);
const TEXT_ALIGNS = new Set<NonNullable<CanvasShapeStyle["textAlign"]>>(["left", "center", "right"]);
const VERTICAL_ALIGNS = new Set<NonNullable<CanvasShapeStyle["verticalAlign"]>>(["top", "middle", "bottom"]);
const ARROW_TYPES = new Set<NonNullable<CanvasShapeStyle["arrowType"]>>(["straight", "curved", "elbow"]);
const ARROWHEADS = new Set<NonNullable<CanvasShapeStyle["startArrowhead"]>>(["none", "arrow", "triangle", "dot"]);

export interface ShapeFields {
  shape: CanvasShapeKind;
  text?: string;
  /** Rotation in degrees clockwise, wrapped to [0,360); absent means upright (0). */
  angle?: number;
  areaLabel?: string;
  points?: Array<[number, number]>;
  style?: CanvasShapeStyle;
  imageAssetUri?: string;
  imageAlt?: string;
  imageNaturalWidth?: number;
  imageNaturalHeight?: number;
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeStyle(value: unknown): CanvasShapeStyle | undefined {
  const raw = objectOf(value);
  if (!raw) return undefined;
  const style: CanvasShapeStyle = {};
  if (typeof raw.strokeColor === "string") style.strokeColor = raw.strokeColor;
  if (typeof raw.strokeWidth === "number" && Number.isFinite(raw.strokeWidth) && raw.strokeWidth > 0) style.strokeWidth = normalizeShapeStrokeWidth(raw.strokeWidth);
  if (STROKE_STYLES.has(raw.strokeStyle as CanvasStrokeStyle)) style.strokeStyle = raw.strokeStyle as CanvasStrokeStyle;
  if (SLOPPINESS.has(raw.sloppiness as string)) style.sloppiness = raw.sloppiness as CanvasShapeStyle["sloppiness"];
  if (typeof raw.opacity === "number" && raw.opacity >= 0 && raw.opacity <= 100) style.opacity = raw.opacity;
  if (typeof raw.fill === "string") style.fill = raw.fill;
  if (FILL_STYLES.has(raw.fillStyle as NonNullable<CanvasShapeStyle["fillStyle"]>)) style.fillStyle = raw.fillStyle as CanvasShapeStyle["fillStyle"];
  const rawFont = raw.fontFamily === "serif" ? "heading" : raw.fontFamily; // legacy 'serif' → 'heading'
  if (FONT_FAMILIES.has(rawFont as NonNullable<CanvasShapeStyle["fontFamily"]>)) style.fontFamily = rawFont as CanvasShapeStyle["fontFamily"];
  if (FONT_SIZES.has(raw.fontSize as NonNullable<CanvasShapeStyle["fontSize"]>)) style.fontSize = raw.fontSize as CanvasShapeStyle["fontSize"];
  if (TEXT_ALIGNS.has(raw.textAlign as NonNullable<CanvasShapeStyle["textAlign"]>)) style.textAlign = raw.textAlign as CanvasShapeStyle["textAlign"];
  if (VERTICAL_ALIGNS.has(raw.verticalAlign as NonNullable<CanvasShapeStyle["verticalAlign"]>)) style.verticalAlign = raw.verticalAlign as CanvasShapeStyle["verticalAlign"];
  if (typeof raw.fontScale === "number" && Number.isFinite(raw.fontScale) && raw.fontScale > 0) {
    style.fontScale = Math.min(raw.fontScale, 20);
  }
  if (ARROW_TYPES.has(raw.arrowType as NonNullable<CanvasShapeStyle["arrowType"]>)) style.arrowType = raw.arrowType as CanvasShapeStyle["arrowType"];
  if (ARROWHEADS.has(raw.startArrowhead as NonNullable<CanvasShapeStyle["startArrowhead"]>)) style.startArrowhead = raw.startArrowhead as CanvasShapeStyle["startArrowhead"];
  if (ARROWHEADS.has(raw.endArrowhead as NonNullable<CanvasShapeStyle["endArrowhead"]>)) style.endArrowhead = raw.endArrowhead as CanvasShapeStyle["endArrowhead"];
  return style;
}

/**
 * Resolve an Inspector patch against a target shape's own style. The panel emits style
 * *deltas* (only the changed fields) so the same patch can be applied to every shape in a
 * multi-selection without clobbering each shape's other values; here the delta is merged
 * into `current` and any field the delta sets to `undefined` (e.g. clearing the background)
 * is removed. Non-style patches (text / areaLabel) pass straight through.
 */
export function applyShapeStylePatch(current: CanvasShapeStyle | undefined, patch: ShapeNodePatch): Record<string, unknown> {
  if (!patch.style) return { ...patch };
  const merged: CanvasShapeStyle = { ...current, ...patch.style };
  for (const key of Object.keys(merged) as Array<keyof CanvasShapeStyle>) {
    if (merged[key] === undefined) delete merged[key];
  }
  return { style: merged };
}

/**
 * Size a standalone text element's box to its content (Excalidraw auto-sizing): width = widest
 * line, height = line count × line-height. `measure(line)` is injected (the caller supplies an
 * offscreen-canvas measurer with the resolved font) so the layout math stays pure and testable.
 */
export function textBoxSize(
  text: string,
  fontPx: number,
  opts: { measure: (line: string) => number; lineHeight?: number; padX?: number; padY?: number; minW?: number },
): { w: number; h: number } {
  const { measure, lineHeight = 1.25, padX = 12, padY = 8, minW = 24 } = opts;
  const lines = (text.length ? text : " ").split("\n");
  const widest = Math.max(0, ...lines.map((l) => measure(l.length ? l : " ")));
  return {
    w: Math.max(Math.ceil(widest) + padX * 2, minW),
    h: Math.ceil(lines.length * fontPx * lineHeight) + padY * 2,
  };
}

export interface DragPoint { x: number; y: number; }
export interface DraggedRect { position: DragPoint; size: { w: number; h: number }; }

/**
 * Convert a press-drag (start → end, in flow coords) into a positive shape rect.
 * A negligible drag (i.e. a click) yields a default-sized shape at the point, matching
 * Excalidraw's click-to-place behavior.
 */
export function shapeRectFromDrag(
  start: DragPoint,
  end: DragPoint,
  defaultSize: { w: number; h: number },
  clickThreshold = 6,
): DraggedRect {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < clickThreshold && Math.abs(dy) < clickThreshold) {
    return { position: { x: start.x, y: start.y }, size: { ...defaultSize } };
  }
  return {
    position: { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y) },
    size: { w: Math.abs(dx), h: Math.abs(dy) },
  };
}

export interface LinearShape extends DraggedRect { points: Array<[number, number]>; }

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Convert a press-drag into a 2-point linear shape (arrow/line): a positive bounding box
 * plus endpoints normalized to 0..1 within it, preserving the actual drag direction so
 * the head/tail and diagonal are correct. A tiny box dimension is floored to `minSize`.
 */
export function linearShapeFromDrag(start: DragPoint, end: DragPoint, minSize = 2): LinearShape {
  const minX = Math.min(start.x, end.x);
  const minY = Math.min(start.y, end.y);
  const w = Math.max(Math.abs(end.x - start.x), minSize);
  const h = Math.max(Math.abs(end.y - start.y), minSize);
  return {
    position: { x: minX, y: minY },
    size: { w, h },
    points: [
      [clamp01((start.x - minX) / w), clamp01((start.y - minY) / h)],
      [clamp01((end.x - minX) / w), clamp01((end.y - minY) / h)],
    ],
  };
}

/**
 * Convert a freehand pointer trail (flow coords) into a bbox-fitted shape: position + size of
 * the bounding box, and each point normalized 0..1 within it. A flat/degenerate trail floors to
 * `minSize` so the box never collapses (no division by zero).
 */
export function normalizeFreehand(trail: DragPoint[], minSize = 1): DraggedRect & { points: Array<[number, number]> } {
  const xs = trail.map((p) => p.x);
  const ys = trail.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const w = Math.max(Math.max(...xs) - minX, minSize);
  const h = Math.max(Math.max(...ys) - minY, minSize);
  return {
    position: { x: minX, y: minY },
    size: { w, h },
    points: trail.map((p) => [clamp01((p.x - minX) / w), clamp01((p.y - minY) / h)]),
  };
}

/** Shape kinds whose centered `text` the double-click editor (and the text tool) can edit. */
const TEXT_EDITABLE_KINDS = new Set<CanvasShapeKind>(["rectangle", "diamond", "ellipse", "text"]);

interface TextToolCandidate {
  id: string;
  type?: string;
  position: DragPoint;
  width?: number;
  height?: number;
  data?: { shape?: unknown };
}

/**
 * Where a text-tool click should land (Excalidraw): clicking over an editable shape edits THAT
 * shape's text — a container's bound label or an existing text element — instead of stacking a
 * loose text node on top of it (which later hides under the shape on any z change). Topmost hit
 * wins (last in array paints on top). Returns null over empty canvas: place a new text there.
 */
export function textToolEditTarget(point: DragPoint, nodes: TextToolCandidate[]): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.type !== "shape" || !n.width || !n.height) continue;
    if (!TEXT_EDITABLE_KINDS.has(n.data?.shape as CanvasShapeKind)) continue;
    const within =
      point.x >= n.position.x && point.x <= n.position.x + n.width &&
      point.y >= n.position.y && point.y <= n.position.y + n.height;
    if (within) return n.id;
  }
  return null;
}

/**
 * Alt-click "select behind": overlapping shapes are cycled top-down, one deeper per click,
 * wrapping back to the topmost. `hits` is in paint order (bottom → top, as shapeHitTest
 * returns); `currentId` is the currently selected shape, if any.
 */
export function cycleSelectBehind(hits: string[], currentId: string | null): string | null {
  if (hits.length === 0) return null;
  const topDown = [...hits].reverse();
  const i = currentId ? topDown.indexOf(currentId) : -1;
  return topDown[(i + 1) % topDown.length];
}

function normalizePoints(value: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const points: Array<[number, number]> = [];
  for (const pair of value) {
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === "number" && typeof pair[1] === "number") {
      points.push([pair[0], pair[1]]);
    }
  }
  return points.length >= 2 ? points : undefined;
}

export function normalizeShapeFields(raw: Record<string, unknown>): ShapeFields {
  const fields: ShapeFields = {
    shape: SHAPE_KINDS.has(raw.shape as CanvasShapeKind) ? raw.shape as CanvasShapeKind : "rectangle",
  };
  if (typeof raw.text === "string") fields.text = raw.text;
  if (typeof raw.angle === "number" && Number.isFinite(raw.angle)) {
    const angle = normalizeAngle(raw.angle);
    if (angle !== 0) fields.angle = angle;
  }
  if (typeof raw.areaLabel === "string") fields.areaLabel = raw.areaLabel;
  const points = normalizePoints(raw.points);
  if (points) fields.points = points;
  const style = normalizeStyle(raw.style);
  if (style) fields.style = style;
  if (typeof raw.imageAssetUri === "string" && raw.imageAssetUri) fields.imageAssetUri = raw.imageAssetUri;
  if (typeof raw.imageAlt === "string") fields.imageAlt = raw.imageAlt;
  if (typeof raw.imageNaturalWidth === "number" && Number.isFinite(raw.imageNaturalWidth)) fields.imageNaturalWidth = raw.imageNaturalWidth;
  if (typeof raw.imageNaturalHeight === "number" && Number.isFinite(raw.imageNaturalHeight)) fields.imageNaturalHeight = raw.imageNaturalHeight;
  return fields;
}
