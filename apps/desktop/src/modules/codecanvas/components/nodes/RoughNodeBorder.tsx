"use client";
import { memo, useMemo } from "react";
import rough from "roughjs";
import { roughNodeOptions, type DrawSloppiness } from "../../services/canvas-rough";

// One generator for the app; rough.js is deterministic per seed, so a single instance
// is safe and avoids per-node allocation.
const generator = rough.generator();

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  return [
    `M${x + rr},${y}`,
    `h${w - 2 * rr}`,
    `a${rr},${rr} 0 0 1 ${rr},${rr}`,
    `v${h - 2 * rr}`,
    `a${rr},${rr} 0 0 1 ${-rr},${rr}`,
    `h${-(w - 2 * rr)}`,
    `a${rr},${rr} 0 0 1 ${-rr},${-rr}`,
    `v${-(h - 2 * rr)}`,
    `a${rr},${rr} 0 0 1 ${rr},${-rr}`,
    "z",
  ].join(" ");
}

export interface RoughNodeBorderProps {
  /** Measured node size in px (from NodeProps); 0/undefined => not yet measured. */
  width?: number;
  height?: number;
  /** Stable per-node seed (see roughSeedFromId) so the wobble never re-randomizes. */
  seed: number;
  radius?: number;
  sloppiness?: DrawSloppiness;
  strokeColor?: string;
  strokeWidth?: number;
  fill?: string;
  className?: string;
}

/**
 * Hand-drawn (rough.js) border for a Canvas node. Visual-only — owns no state and never
 * the geometry source of truth (PRD §3.4). The path is memoized on size + style so it is
 * regenerated only on resize/restyle, not on every render (PRD §13).
 */
export const RoughNodeBorder = memo(function RoughNodeBorder({
  width = 0,
  height = 0,
  seed,
  radius = 14,
  sloppiness,
  strokeColor,
  strokeWidth,
  fill,
  className,
}: RoughNodeBorderProps) {
  const paths = useMemo(() => {
    if (!(width > 0) || !(height > 0)) return [];
    const inset = 1.5;
    const d = roundedRectPath(inset, inset, width - 2 * inset, height - 2 * inset, radius);
    const drawable = generator.path(d, roughNodeOptions({ seed, sloppiness, strokeColor, strokeWidth, fill }));
    return generator.toPaths(drawable);
  }, [width, height, seed, radius, sloppiness, strokeColor, strokeWidth, fill]);

  if (paths.length === 0) return null;

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
    >
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          stroke={p.stroke}
          strokeWidth={p.strokeWidth}
          fill={p.fill ?? "none"}
          fillRule="evenodd"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
});
