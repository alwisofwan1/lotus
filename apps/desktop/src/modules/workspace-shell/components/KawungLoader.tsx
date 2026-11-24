"use client";

import { useEffect, useRef } from "react";

// Kawung, the four-petal batik motif, as pixels: four petals on the diagonals around a centre dot
// (the isen). One petal fills solid and hands over clockwise; the others fade through a 4x4 Bayer
// dither. Every loader on screen shares one 20 fps loop. Design: plans/chat-command-rail/PLAN.md.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const PETALS = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const; // clockwise from top-left
const FRAME_MS = 50;
const STILL_PHASE = 0.8;

function petalOf(u: number, v: number): number {
  for (let k = 0; k < 4; k++) {
    const [sx, sy] = PETALS[k];
    const px = u - sx * 0.46;
    const py = v - sy * 0.46;
    const along = (px * sx + py * sy) / Math.SQRT2;
    const across = (px * sy - py * sx) / Math.SQRT2;
    if ((along / 0.5) ** 2 + (across / 0.27) ** 2 <= 1) return k;
  }
  return -1;
}

/** Which of the n×n cells are lit at phase t. Exported for the test. */
export function kawungCells(n: number, t: number): boolean[] {
  const c = (n - 1) / 2;
  const level = PETALS.map((_, k) => 0.12 + 0.88 * Math.max(0, Math.cos(t - (k * Math.PI) / 2)) ** 3);
  const cells: boolean[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = ((x - c) / c) * 0.98;
      const v = ((y - c) / c) * 0.98;
      if (u * u + v * v < 0.03) {
        cells.push(true);
        continue;
      }
      const k = petalOf(u, v);
      cells.push(k >= 0 && level[k] > (BAYER[(x % 4) + (y % 4) * 4] + 0.5) / 16);
    }
  }
  return cells;
}

function draw(canvas: HTMLCanvasElement, n: number, size: number, t: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const px = Math.round(size * (window.devicePixelRatio || 1));
  if (canvas.width !== px) canvas.width = canvas.height = px;
  const cell = px / n;
  ctx.clearRect(0, 0, px, px);
  ctx.fillStyle = getComputedStyle(canvas).color;
  kawungCells(n, t).forEach((on, i) => {
    if (!on) return;
    const x = i % n;
    const y = Math.floor(i / n);
    const x0 = Math.round(x * cell);
    const y0 = Math.round(y * cell);
    ctx.fillRect(x0, y0, Math.round((x + 1) * cell) - x0, Math.round((y + 1) * cell) - y0);
  });
}

type Entry = { canvas: HTMLCanvasElement; n: number; size: number };
const live = new Set<Entry>();
let frame = 0;
let last = 0;

function still(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

function tick(now: number) {
  frame = 0;
  if (live.size === 0) return;
  if (now - last >= FRAME_MS) {
    last = now;
    for (const entry of live) draw(entry.canvas, entry.n, entry.size, now / 520);
  }
  frame = requestAnimationFrame(tick);
}

export function KawungLoader({ size = 14, cells = 11, label }: { size?: number; cells?: number; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (still()) {
      draw(canvas, cells, size, STILL_PHASE);
      return;
    }
    const entry = { canvas, n: cells, size };
    live.add(entry);
    draw(canvas, cells, size, performance.now() / 520);
    if (!frame) frame = requestAnimationFrame(tick);
    return () => {
      live.delete(entry);
    };
  }, [cells, size]);
  return (
    <canvas
      ref={ref}
      className="ws-kawung"
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
