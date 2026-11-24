"use client";

import { useEffect, useRef } from "react";

import { BAYER } from "./Dither";

// Batik kawung, dithered (mockups/chat-markdown.html): four ovals pointing at one centre, tiled so a
// tile's corners meet the next tile's tips. Below ~24 px a dithered fill breaks the ovals apart, so
// the motif is drawn as outlines with a seed dot, and the dither carries only brightness.

const PETALS = [
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
] as const;

/** Ink (0–1) of one tile at (u, v) in 0–1. `lit(i)` dims each oval; petals go 0 NE, 1 SE, 2 SW, 3 NW. */
export function kawung(u: number, v: number, lit: (petal: number) => number = () => 1): number {
  let best = 0;
  PETALS.forEach(([sx, sy], i) => {
    const dx = u - (0.5 + sx * 0.25);
    const dy = v - (0.5 + sy * 0.25);
    const a = (dx * sx + dy * sy) / Math.SQRT2;
    const b = (dx * sy - dy * sx) / Math.SQRT2;
    const r = (a / 0.33) ** 2 + (b / 0.17) ** 2;
    if (r >= 1) return;
    if (r > 0.42 || r < 0.07) best = Math.max(best, lit(i));
  });
  return best;
}

const frac = (x: number) => x - Math.floor(x);

type Ink = { c: string; d: number } | null;

// One canvas pixel per cell; CSS scales it up with `image-rendering: pixelated`.
function paint(canvas: HTMLCanvasElement, cols: number, rows: number, inkAt: (x: number, y: number) => Ink) {
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ink = inkAt(x, y);
      if (ink && ink.d * 64 > BAYER[y % 8][x % 8]) {
        ctx.fillStyle = ink.c;
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
}

const tokenOf = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim() || getComputedStyle(el).color;

// theme-bootstrap writes the palette inline on <html>; redraw in the new ink.
function onThemeChange(draw: () => void): () => void {
  const theme = new MutationObserver(draw);
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
  return () => theme.disconnect();
}

/**
 * The working mark: one kawung tile, four ovals round a centre, in the CSS `color`. Drawn as vectors so
 * it stays sharp at 14 px; while `live`, CSS walks a light round the ovals (no timer, no canvas).
 */
export function KawungMark({ live, className }: { live: boolean; className?: string }) {
  return (
    <svg className={className} data-live={live || undefined} viewBox="-8 -8 16 16" aria-hidden>
      {[45, 135, 225, 315].map((angle) => (
        <ellipse key={angle} cx="4.2" cy="0" rx="3.3" ry="1.7" transform={`rotate(${angle - 90})`} />
      ))}
      <circle r="0.9" />
    </svg>
  );
}

/** Plan progress: four kawung tiles in outline. Done tiles in green, the rest a faint track. */
export function KawungBar({ progress, className }: { progress: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const done = tokenOf(canvas, "--ds-success");
      const track = tokenOf(canvas, "--ds-text-quiet");
      paint(canvas, 40, 10, (x, y) => {
        const k = kawung(frac((x + 0.5) / 10), (y + 0.5) / 10);
        return (x + 0.5) / 40 < progress ? { c: done, d: k * 0.8 } : { c: track, d: k * 0.28 };
      });
    };
    draw();
    return onThemeChange(draw);
  }, [progress]);
  return <canvas ref={ref} className={className} aria-hidden />;
}

let fadeUrl: string | null = null;

/**
 * A 16×22 mask tile for the top of a live reasoning trace: older thought breaks into kawung rather
 * than into blur. Opaque where the text stays. Built once, in the browser.
 */
export function kawungFadeUrl(): string {
  if (fadeUrl) return fadeUrl;
  const canvas = document.createElement("canvas");
  paint(canvas, 16, 22, (x, y) => {
    const v = (y + 0.5) / 22;
    // Kept where the motif is NOT inked: text shows through the cloth, the ovals cut it away first.
    const keep = v * 1.25 - kawung(frac((x + 0.5) / 16), frac((y + 0.5) / 16)) * (1 - v) * 0.9;
    return { c: "black", d: keep };
  });
  fadeUrl = `url(${canvas.toDataURL()})`;
  return fadeUrl;
}
