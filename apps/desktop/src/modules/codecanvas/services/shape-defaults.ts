import type { CanvasArrowhead, CanvasShapeStyle } from "../types/canvas";

/**
 * Single source of truth for whiteboard shape styling defaults and the stroke palette.
 *
 * The Inspector panel (pressed-state), the ShapeNode renderer, and the rough.js mapper all
 * read from here so a fresh shape renders exactly what the panel marks as active — no
 * "Thin is highlighted but the line draws at 1.4" drift. Framework-free; unit-testable.
 */

/**
 * Pick a readable ink (near-black or white) for a check mark drawn ON TOP of a swatch color,
 * so the "selected" indicator stays visible on any swatch (including the coral accent itself).
 * Unparseable input falls back to dark ink.
 */
export function contrastInk(hex: string): "#1a1a1a" | "#ffffff" {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "#1a1a1a";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.55 ? "#1a1a1a" : "#ffffff";
}

/** Stroke swatch palette (modern, vivid). The first entry is the default stroke color. */
export const STROKE_COLORS = ["#f1f3f5", "#ffd43b", "#ffa94d", "#69db7c", "#4dabf7", "#e8663d"] as const;

/** Human-readable names for palette swatches (accessible labels); falls back to the hex. */
const COLOR_NAMES: Record<string, string> = {
  "#f1f3f5": "white", "#ffd43b": "yellow", "#ffa94d": "amber", "#69db7c": "green", "#4dabf7": "blue", "#e8663d": "coral",
};
export function colorName(hex: string): string {
  return COLOR_NAMES[hex.toLowerCase()] ?? hex;
}

/** Background fill palette (container shapes) — clean dark tints paired with the stroke hues.
 *  Names back the accessible swatch labels. */
export const FILL_COLORS: Array<readonly [hex: string, name: string]> = [
  ["#3a2f1a", "amber"],
  ["#1e3326", "green"],
  ["#1b2c3a", "blue"],
  ["#3a2622", "coral"],
  ["#2c2733", "violet"],
];

/** Text-shape font families → the CSS custom property that resolves the actual stack. */
export const FONT_FAMILIES: Array<readonly [id: NonNullable<CanvasShapeStyle["fontFamily"]>, cssVar: string]> = [
  ["hand", "var(--canvas-hand)"],
  ["normal", "var(--canvas-normal)"],
  ["heading", "var(--canvas-heading)"],
  ["code", "var(--canvas-code)"],
];

/**
 * Text size tiers as a fraction of the shape box height (container-query `cqh` = 1% of box
 * height), so text scales with the shape when resized ("fit to box"). A px clamp keeps it
 * readable in tiny boxes and sane in huge ones.
 */
export const FONT_SIZE_CQH: Record<NonNullable<CanvasShapeStyle["fontSize"]>, number> = { S: 8, M: 12, L: 18, XL: 26 };
export const FONT_SIZE_CLAMP = { min: 9, max: 240 } as const;
/** Absolute px per tier for standalone text (Excalidraw S/M/L/XL); box hugs the text. */
export const FONT_SIZE_PX: Record<NonNullable<CanvasShapeStyle["fontSize"]>, number> = { S: 16, M: 20, L: 28, XL: 36 };

/** Stroke width tiers shown in the Inspector. Values are canvas px, then rendered as non-scaling SVG strokes so zoom never makes them disappear. */
export const SHAPE_STROKE_WIDTHS: Array<readonly [label: string, value: number]> = [["Thin", 2], ["Bold", 4], ["Extra bold", 8]];
export const SHAPE_STROKE_WIDTH_RANGE = { min: 1, max: 12 } as const;
export function normalizeShapeStrokeWidth(value: unknown, fallback = SHAPE_STROKE_WIDTHS[0][1]): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(SHAPE_STROKE_WIDTH_RANGE.max, Math.max(SHAPE_STROKE_WIDTH_RANGE.min, value));
}

export const TEXT_ALIGNS: Array<NonNullable<CanvasShapeStyle["textAlign"]>> = ["left", "center", "right"];
export const VERTICAL_ALIGNS: Array<NonNullable<CanvasShapeStyle["verticalAlign"]>> = ["top", "middle", "bottom"];

/** Linear-shape option lists. */
export const ARROW_TYPES: Array<NonNullable<CanvasShapeStyle["arrowType"]>> = ["straight", "curved", "elbow"];
export const ARROWHEADS: CanvasArrowhead[] = ["none", "arrow", "triangle", "dot"];

/** Applied when a shape has no explicit value for the field. Must match the panel's pressed-state. */
export const SHAPE_DEFAULTS = {
  strokeColor: STROKE_COLORS[0],
  strokeWidth: SHAPE_STROKE_WIDTHS[0][1],
  strokeStyle: "solid",
  sloppiness: "artist",
  opacity: 100,
  /** Default fill texture applied when a background color is first picked. */
  fillStyle: "hachure",
  fontFamily: "hand",
  fontSize: "M",
  textAlign: "center",
  verticalAlign: "middle",
  arrowType: "straight",
  startArrowhead: "none",
  endArrowhead: "arrow",
} satisfies Required<Pick<CanvasShapeStyle, "strokeColor" | "strokeWidth" | "strokeStyle" | "sloppiness" | "opacity" | "fillStyle" | "fontFamily" | "fontSize" | "textAlign" | "verticalAlign" | "arrowType" | "startArrowhead" | "endArrowhead">>;
