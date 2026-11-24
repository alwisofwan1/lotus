"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "@/contexts/ThemeContext";

// Lumbon, the Banyumasan batik taro leaf, as pixels: a heart-shaped leaf, tip down, with a blank
// midrib. Dither only — no solid edge — in the same 1 px Bayer grain as the mode thumb, so it reads
// as batik texture rather than an icon. It fills in from the tip once, then holds still.
// Design: https://claude.ai/artifact/DGMbT4qGhXk78Cqfedg1zz (option A)

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const FILL_MS = 300;

/** Density 0..1 inside the leaf, 0 outside and on the midrib. u, v in [-1, 1], v grows down. */
function leaf(u: number, v: number): number {
  const x = u * 1.18;
  const y = -v * 1.12 + 0.12;
  if ((x * x + y * y - 1) ** 3 - x * x * y ** 3 > 0) return 0;
  if (Math.abs(u) < 0.1 && v > -0.75 && v < 0.4) return 0;
  return 0.3 + 0.55 * Math.min(1, (v + 1) / 1.7);
}

/** Which of the n×n cells are lit; `fill` 0..1 reveals rows from the tip up. Exported for the test. */
export function lumbonCells(n: number, fill = 1): boolean[] {
  const c = (n - 1) / 2;
  const cells: boolean[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const shown = (n - y) / n <= fill + 0.001;
      const density = leaf(((x - c) / c) * 0.98, ((y - c) / c) * 0.98) * 1.25;
      cells.push(shown && density > (BAYER[(x % 4) + (y % 4) * 4] + 0.5) / 16);
    }
  }
  return cells;
}

function draw(canvas: HTMLCanvasElement, n: number, size: number, fill: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const px = Math.round(size * (window.devicePixelRatio || 1));
  if (canvas.width !== px) canvas.width = canvas.height = px;
  const cell = px / n;
  ctx.clearRect(0, 0, px, px);
  ctx.fillStyle = getComputedStyle(canvas).color;
  lumbonCells(n, fill).forEach((on, i) => {
    if (!on) return;
    const x0 = Math.round((i % n) * cell);
    const y0 = Math.round(Math.floor(i / n) * cell);
    ctx.fillRect(x0, y0, Math.round(((i % n) + 1) * cell) - x0, Math.round((Math.floor(i / n) + 1) * cell) - y0);
  });
}

/** `tone` only repaints: the colour comes from CSS (ready vs waiting), and a canvas does not follow it on its own. */
export function LumbonMark({ size = 9, cells = 9, tone }: { size?: number; cells?: number; tone?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const filled = useRef(false);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (filled.current || still) {
      filled.current = true;
      draw(canvas, cells, size, 1);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FILL_MS);
      draw(canvas, cells, size, 1 - (1 - t) ** 3);
      if (t < 1) frame = requestAnimationFrame(step);
      else filled.current = true;
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [cells, size, tone]);
  // A theme switch changes the colour under a finished leaf. The provider writes its CSS variables
  // in its own effect, which runs after this one, so repaint on the next frame.
  const { themeId } = useTheme();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !filled.current) return;
    const frame = requestAnimationFrame(() => draw(canvas, cells, size, 1));
    return () => cancelAnimationFrame(frame);
  }, [themeId, cells, size]);
  return <canvas ref={ref} className="ws-lumbon" style={{ width: size, height: size }} aria-hidden />;
}
