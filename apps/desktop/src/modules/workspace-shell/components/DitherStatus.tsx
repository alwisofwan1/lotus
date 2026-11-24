"use client";

// A pane row's status at its right end (mockups/rail-dither-done.html, X): a 12px ring drawn in
// ordered dither while the agent works, which on a turn end fills, collapses to the centre and
// turns from the working hue to the result hue, ending as the "done" dot in the same place.

import { useEffect, useRef } from "react";

export type DitherState = "working" | "done" | "settle";

const SIZE = 12;
const TURN_S = 1.1;
/** Fill the ring, then collapse it to a dot (ms). */
const FILL_MS = 150;
const COLLAPSE_MS = 400;
const END_MS = 700;
/** Pixel art steps anyway; 20fps keeps the loop cheap. */
const FRAME_MS = 50;

// Bayer 4×4: the classic ordered-dither threshold matrix.
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map((row) => row.map((v) => (v + 0.5) / 16));
const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

/**
 * One frame. `t`: seconds on the shared clock (where the head is). `sinceEnd`: ms since the turn
 * ended, or null while working. Pure apart from the context, so the frames are testable.
 */
export function ditherPixels(t: number, sinceEnd: number | null): { x: number; y: number }[] {
  const fill = sinceEnd === null ? 0 : ease(sinceEnd / FILL_MS);
  const shrink = sinceEnd === null ? 0 : ease((sinceEnd - FILL_MS) / COLLAPSE_MS);
  const mid = (SIZE - 1) / 2;
  const outer = 6 - 3.5 * shrink;
  const inner = Math.max(0, 3.6 - 4.7 * shrink);
  // The head stops where it was when the turn ended.
  const head = (((sinceEnd === null ? t : t - sinceEnd / 1000) * 2 * Math.PI) / TURN_S) % (2 * Math.PI);
  const on: { x: number; y: number }[] = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const r = Math.hypot(x - mid, y - mid);
      if (r > outer || r < inner) continue;
      const behind = (((head - Math.atan2(y - mid, x - mid)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI);
      const level = 1 - behind + behind * fill;
      if (level > BAYER[y % 4][x % 4]) on.push({ x, y });
    }
  }
  return on;
}

// One clock and one loop for every ring on screen, so many working rows turn together (C2).
const painters = new Set<(now: number) => void>();
let frame = 0;
let last = 0;
function loop(now: number) {
  frame = painters.size ? requestAnimationFrame(loop) : 0;
  if (now - last < FRAME_MS) return;
  last = now;
  for (const paint of painters) paint(now);
}
function addPainter(paint: (now: number) => void) {
  painters.add(paint);
  if (!frame) frame = requestAnimationFrame(loop);
  return () => {
    painters.delete(paint);
  };
}

const still = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

export function DitherStatus({ state }: { state: DitherState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // When the turn ended; null while working. A pane that mounts already done skips the animation.
  const endedAt = useRef<number | null>(state === "working" ? null : -Infinity);

  useEffect(() => {
    if (state === "working") endedAt.current = null;
    else if (endedAt.current === null) endedAt.current = performance.now();
    const canvas = ref.current;
    const g = canvas?.getContext("2d");
    if (!canvas || !g) return;
    let colours: [string, string] | null = null;
    let coloursAt = 0;
    const paint = (now: number) => {
      // Re-read now and then, so a theme switch reaches a ring that is still turning.
      if (!colours || now - coloursAt > 1000) {
        const style = getComputedStyle(canvas);
        colours = [style.getPropertyValue("--ws-activity-live").trim(), style.getPropertyValue("--ws-activity-result").trim()];
        coloursAt = now;
      }
      const ended = endedAt.current;
      const sinceEnd = ended === null ? null : still() ? END_MS : Math.min(END_MS, now - ended);
      const t = still() ? 0 : now / 1000;
      const pixels = ditherPixels(t, sinceEnd);
      // The hue turns from working to result as the ring collapses: two passes, crossfaded.
      const k = sinceEnd === null ? 0 : ease((sinceEnd - FILL_MS) / COLLAPSE_MS);
      g.clearRect(0, 0, SIZE, SIZE);
      for (const [colour, alpha] of [[colours[0], 1 - k], [colours[1], k]] as const) {
        if (alpha <= 0) continue;
        g.globalAlpha = alpha;
        g.fillStyle = colour;
        for (const { x, y } of pixels) g.fillRect(x, y, 1, 1);
      }
      g.globalAlpha = 1;
      return sinceEnd !== null && sinceEnd >= END_MS;
    };
    paint(performance.now());
    if (still()) return;
    let off = () => {};
    off = addPainter((now) => {
      if (paint(now)) off(); // the dot is drawn: nothing left to animate
    });
    return () => off();
  }, [state]);

  return (
    <canvas
      ref={ref}
      className="ws-rail-dither"
      data-state={state}
      width={SIZE}
      height={SIZE}
      aria-hidden
    />
  );
}
