import type { Options } from "roughjs/bin/core";
import { normalizeShapeStrokeWidth } from "./shape-defaults";

/**
 * Pure mapping from CodeCanvas node styling onto rough.js options. rough.js is a
 * VISUAL enhancement only (PRD §3.4) — it never owns state or geometry. These helpers
 * are framework-free so they unit-test without a DOM or the rough runtime.
 */

export type DrawSloppiness = "architect" | "artist" | "cartoonist";

/** rough.js `roughness` per sloppiness tier — higher = more hand-drawn wobble. */
const ROUGHNESS: Record<DrawSloppiness, number> = {
  architect: 0.6,
  artist: 1.3,
  cartoonist: 2.6,
};

export type DrawStrokeStyle = "solid" | "dashed" | "dotted";

const STROKE_DASH: Record<DrawStrokeStyle, number[] | undefined> = {
  solid: undefined,
  dashed: [8, 8],
  dotted: [2, 6],
};

export interface RoughNodeOptionsInput {
  /** Stable per-node seed so the wobble does not re-randomize on every render. */
  seed: number;
  sloppiness?: DrawSloppiness;
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: DrawStrokeStyle;
  /** When set, the shape is filled with a hachure (hand-drawn) fill. */
  fill?: string;
  fillStyle?: Options["fillStyle"];
}

/**
 * Deterministic non-negative integer seed derived from a node id (FNV-1a-ish), so a
 * node's hand-drawn border looks identical across re-renders and reloads.
 */
export function roughSeedFromId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // rough.js seeds are bounded positive integers.
  return Math.abs(hash) % 2_000_000;
}

/**
 * Stable signature of the style fields that affect hand-drawn geometry (stroke + fill).
 * Deliberately excludes `opacity`, which is applied via CSS on the node, not by rough. The
 * ShapeNode rough `useMemo` keys on this so dragging the opacity slider — a high-frequency
 * continuous input — does not needlessly regenerate the rough paths on every tick.
 */
export function roughStyleSignature(style?: {
  strokeColor?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  sloppiness?: string;
  fill?: string;
  fillStyle?: string;
  arrowType?: string;
  startArrowhead?: string;
  endArrowhead?: string;
  /** Accepted but ignored — opacity is CSS-applied, never part of the rough geometry. */
  opacity?: number;
}): string {
  const st = style ?? {};
  return [st.strokeColor, st.strokeWidth, st.strokeStyle, st.sloppiness, st.fill, st.fillStyle, st.arrowType, st.startArrowhead, st.endArrowhead]
    .map((v) => v ?? "")
    .join("|");
}

/**
 * SVG `stroke-dasharray` for a stroke style, scaled by stroke width — applied to the rendered
 * outline path. rough.js carries the dash only in canvas options and never bakes it into the
 * `toPaths()` output, so the consumer must set the dash array itself or dashed/dotted strokes
 * silently render solid. Returns `undefined` for solid (continuous) strokes.
 */
export function strokeDashArray(strokeStyle: DrawStrokeStyle | undefined, strokeWidth = 2): string | undefined {
  const w = normalizeShapeStrokeWidth(strokeWidth);
  if (strokeStyle === "dashed") return `${w * 4.5} ${w * 4}`;
  if (strokeStyle === "dotted") return `${w * 0.6} ${w * 2.8}`;
  return undefined;
}

export function roughNodeOptions(input: RoughNodeOptionsInput): Options {
  const sloppiness = input.sloppiness ?? "artist";
  const strokeWidth = normalizeShapeStrokeWidth(input.strokeWidth);
  const options: Options = {
    seed: input.seed,
    roughness: ROUGHNESS[sloppiness],
    strokeWidth,
    stroke: input.strokeColor ?? "#2b2733",
  };
  if (input.fill) {
    options.fill = input.fill;
    options.fillStyle = input.fillStyle ?? "solid";
  }
  const dash = input.strokeStyle ? STROKE_DASH[input.strokeStyle] : undefined;
  if (dash) options.strokeLineDash = dash;
  return options;
}
