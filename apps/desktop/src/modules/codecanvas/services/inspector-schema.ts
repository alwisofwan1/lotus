import type { CanvasShapeKind } from "../types/canvas";

/**
 * Declarative schema for the shape Inspector: which property sections render, in order,
 * for a given shape kind (Excalidraw-style adaptive panel). Keeping this pure and separate
 * means the panel iterates a list instead of branching on a pile of `shape === …` ternaries,
 * and the render order is owned in one place.
 *
 */
export type InspectorSection =
  | "label" // area label (container) / text content (text)
  | "stroke"
  | "background" // container only — fill color + fill style
  | "strokeWidth"
  | "strokeStyle"
  | "sloppiness"
  | "font" // shapes that hold text — font family
  | "size" // shapes that hold text — font size + text align
  | "arrowType" // linear shapes — straight / curved / elbow
  | "arrowheads" // arrow only — start + end head
  | "opacity"
  | "arrange";

const CONTAINER: InspectorSection[] = [
  "label", "stroke", "background", "strokeWidth", "strokeStyle", "sloppiness", "font", "size", "opacity", "arrange",
];
const TEXT: InspectorSection[] = ["label", "stroke", "font", "size", "opacity", "arrange"];
const ARROW: InspectorSection[] = ["stroke", "strokeWidth", "strokeStyle", "sloppiness", "arrowType", "arrowheads", "opacity", "arrange"];
const LINE: InspectorSection[] = ["stroke", "strokeWidth", "strokeStyle", "sloppiness", "arrowType", "opacity", "arrange"];
const DRAW: InspectorSection[] = ["stroke", "strokeWidth", "strokeStyle", "sloppiness", "opacity", "arrange"];
// An image is a bitmap — no stroke, fill, or text to style. Only transparency and stacking apply.
const IMAGE: InspectorSection[] = ["opacity", "arrange"];

export function inspectorSectionsFor(shape: CanvasShapeKind): InspectorSection[] {
  if (shape === "text") return TEXT;
  if (shape === "arrow") return ARROW;
  if (shape === "line") return LINE;
  if (shape === "draw") return DRAW;
  if (shape === "image") return IMAGE;
  return CONTAINER;
}
