"use client";

import { useEffect, useRef, type CSSProperties } from "react";

// 8×8 Bayer thresholds (0–63): an ordered dither, as on mockups/lotus-chat.fig page "05 Refresh warm".
export const BAYER = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

interface DitherProps {
  /**
   * Ink density from 0 to 1 at (u, v), both 0–1 across the box; `cols` and `rows` give the grid, for
   * shapes that must not stretch. Keep it a module constant: a new function redraws.
   */
  field: (u: number, v: number, cols: number, rows: number) => number;
  className?: string;
  /** One dither cell, in CSS pixels. */
  cell?: number;
  /** Draw each cell as a dot a quarter of its area, with space around it. */
  gap?: boolean;
}

/** Decorative texture for empty space, drawn in the element's CSS `color`. Never put it behind text. */
export function Dither({ field, className, cell = 2, gap = false }: DitherProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const cols = Math.ceil(width / cell);
      const rows = Math.ceil(height / cell);
      const ctx = cols && rows ? canvas.getContext("2d") : null;
      if (!ctx) return;
      // One canvas pixel per cell (2×2 with a gap); CSS scales it up with `image-rendering: pixelated`.
      const k = gap ? 2 : 1;
      canvas.width = cols * k;
      canvas.height = rows * k;
      ctx.fillStyle = getComputedStyle(canvas).color;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          if (field((x + 0.5) / cols, (y + 0.5) / rows, cols, rows) * 64 > BAYER[y % 8][x % 8]) ctx.fillRect(x * k, y * k, 1, 1);
        }
      }
    };
    draw();
    const resize = new ResizeObserver(draw);
    resize.observe(canvas);
    // theme-bootstrap writes the palette inline on <html>; redraw in the new ink.
    const theme = new MutationObserver(draw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    return () => {
      resize.disconnect();
      theme.disconnect();
    };
  }, [field, cell, gap]);

  return <canvas ref={ref} className={className} aria-hidden />;
}

// 4×4 ordered-dither thresholds for the small glyph tiles.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** An 11px 4×4 dither tile with `lit` of 16 pixels on; they light up in dither order when it mounts. */
export function DitherTile({ lit, ...data }: { lit: number } & Record<`data-${string}`, string>) {
  return (
    <svg key={lit} className="chat-perm-glyph" viewBox="0 0 11 11" aria-hidden {...data}>
      {BAYER4.map((t, i) => (
        <rect key={i} x={(i % 4) * 3} y={Math.floor(i / 4) * 3} width={2} height={2} data-on={t < lit || undefined} style={{ "--i": t } as CSSProperties} />
      ))}
    </svg>
  );
}
