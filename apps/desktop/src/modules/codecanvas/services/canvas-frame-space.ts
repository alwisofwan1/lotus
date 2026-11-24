import type { Node } from "@xyflow/react";
import { FRAME_TAB_STRIP, frameBoxAround, frameOccupiedBox, type FrameBox } from "./canvas-frame-geometry";

/**
 * Frame space rules (LOT2-132, decisions 32 and 34). Pure geometry: where Frame chrome shows, and how
 * Frames keep out of each other's way. Frames never overlap; nodes (members) are never moved by it.
 */

/** Camera zoom at and above which Frame chrome (border, tint, title tab) is not drawn at all. */
export const FRAME_CHROME_ZOOM = 0.4;

export interface FrameChromeState {
  zoom: number;
  /** Frame Overview is open. */
  overview?: boolean;
  /** A dragged node would join this Frame. */
  dropTarget?: boolean;
  /** Its title is being typed. */
  editing?: boolean;
  /** Its tab menu is open. */
  menuOpen?: boolean;
}

/** The states that show a Frame's chrome at any zoom: Overview, drop target, renaming, menu open. */
export function frameChromeForced(s: Omit<FrameChromeState, "zoom">): boolean {
  return Boolean(s.overview || s.dropTarget || s.editing || s.menuOpen);
}

/** Decision 32: no chrome while working inside a Frame; chrome when zoomed out, in Overview, or as a drop target. */
export function frameChromeVisible(s: FrameChromeState): boolean {
  return s.zoom < FRAME_CHROME_ZOOM || frameChromeForced(s);
}

/** Boxes that only touch along an edge do not overlap. */
export function boxesOverlap(a: FrameBox, b: FrameBox): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

const dimOf = (n: Node) => ({ w: n.measured?.width ?? n.width ?? 0, h: n.measured?.height ?? n.height ?? 0 });
export const frameBoxOf = (n: Node): FrameBox => ({ x: n.position.x, y: n.position.y, ...dimOf(n) });

const SPACE_GAP = 24;

/**
 * Top-left for a new empty Frame of `size`: centred on `centre` when that is free, else the free spot
 * nearest to it (beside or below an existing Frame, or past all of them as a last resort).
 */
export function placeFrameInFreeSpace(frames: readonly Node[], size: { w: number; h: number }, centre: { x: number; y: number }): { x: number; y: number } {
  const wanted = { x: centre.x - size.w / 2, y: centre.y - size.h / 2 };
  // Both sides claim their title-tab strip: a Frame placed under another leaves room for its tab.
  const others = frames.map((f) => frameOccupiedBox(frameBoxOf(f)));
  const free = (p: { x: number; y: number }) => !others.some((o) => boxesOverlap(frameOccupiedBox({ ...p, ...size }), o));
  if (free(wanted)) return wanted;

  const candidates: Array<{ x: number; y: number }> = [];
  for (const o of others) {
    const right = o.x + o.w + SPACE_GAP;
    const left = o.x - size.w - SPACE_GAP;
    const below = o.y + o.h + SPACE_GAP + FRAME_TAB_STRIP;
    const above = o.y - size.h - SPACE_GAP;
    candidates.push(
      { x: right, y: wanted.y }, { x: left, y: wanted.y }, { x: wanted.x, y: below }, { x: wanted.x, y: above },
      { x: right, y: o.y }, { x: left, y: o.y }, { x: o.x, y: below }, { x: o.x, y: above },
    );
  }
  const farRight = Math.max(...others.map((o) => o.x + o.w)) + SPACE_GAP;
  candidates.push({ x: farRight, y: wanted.y });

  let best = candidates[candidates.length - 1];
  let bestDist = Infinity;
  for (const c of candidates) {
    if (!free(c)) continue;
    const d = Math.hypot(c.x - wanted.x, c.y - wanted.y);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

export type FitResult = { ok: true; box: FrameBox } | { ok: false; overlapWith: string };

/**
 * The Frame box around `members` that stays clear of `others`. Full padding first; when only the
 * padding reaches another Frame the padding shrinks. When the members themselves lie inside another
 * Frame there is no honest box, so it is refused with that Frame's name.
 */
export function fitBoxAvoidingFrames(members: readonly FrameBox[], others: readonly Node[]): FitResult {
  const box = frameBoxAround(members);
  const hit = others.find((n) => boxesOverlap(frameOccupiedBox(box), frameOccupiedBox(frameBoxOf(n))));
  if (!hit) return { ok: true, box };
  const title = (hit.data as { title?: unknown } | undefined)?.title;
  return { ok: false, overlapWith: typeof title === "string" && title ? title : "Frame" };
}

const spansOverlap = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && a1 > b0;

/**
 * Where a dragged Frame ends up: it stops at another Frame's edge and slides along it, so it never
 * overlaps. A Frame that already overlaps another (older canvases) is not held by that one.
 */
export function clampFrameMove(frame: FrameBox, target: { x: number; y: number }, otherFrames: readonly FrameBox[]): { x: number; y: number } {
  // Works on the occupied boxes (title-tab strip included), then hands back the box's own y.
  const moved = clampOccupiedMove(
    frameOccupiedBox(frame),
    { x: target.x, y: target.y - FRAME_TAB_STRIP },
    otherFrames.map(frameOccupiedBox),
  );
  return { x: moved.x, y: moved.y + FRAME_TAB_STRIP };
}

function clampOccupiedMove(from: FrameBox, to: { x: number; y: number }, others: readonly FrameBox[]): { x: number; y: number } {
  const blockers = others.filter((o) => !boxesOverlap(from, o));
  let x = to.x;
  for (const o of blockers) {
    if (!spansOverlap(from.y, from.y + from.h, o.y, o.y + o.h)) continue;
    if (to.x > from.x && from.x + from.w <= o.x && x + from.w > o.x) x = o.x - from.w;
    else if (to.x < from.x && from.x >= o.x + o.w && x < o.x + o.w) x = o.x + o.w;
  }
  let y = to.y;
  for (const o of blockers) {
    if (!spansOverlap(x, x + from.w, o.x, o.x + o.w)) continue;
    if (to.y > from.y && from.y + from.h <= o.y && y + from.h > o.y) y = o.y - from.h;
    else if (to.y < from.y && from.y >= o.y + o.h && y < o.y + o.h) y = o.y + o.h;
  }
  return { x, y };
}

/** A corner/edge resize that would run into another Frame stops at that Frame's edge. */
export function clampFrameResize(prevFrame: FrameBox, nextFrame: FrameBox, otherFrames: readonly FrameBox[]): FrameBox {
  const r = clampOccupiedResize(frameOccupiedBox(prevFrame), frameOccupiedBox(nextFrame), otherFrames.map(frameOccupiedBox));
  return { x: r.x, y: r.y + FRAME_TAB_STRIP, w: r.w, h: r.h - FRAME_TAB_STRIP };
}

function clampOccupiedResize(prev: FrameBox, next: FrameBox, others: readonly FrameBox[]): FrameBox {
  let l = next.x;
  let r = next.x + next.w;
  let t = next.y;
  let b = next.y + next.h;
  const prevR = prev.x + prev.w;
  const prevB = prev.y + prev.h;
  for (const o of others) {
    if (boxesOverlap(prev, o)) continue;
    if (!boxesOverlap({ x: l, y: t, w: r - l, h: b - t }, o)) continue;
    const vertical = () => spansOverlap(t, b, o.y, o.y + o.h);
    const horizontal = () => spansOverlap(l, r, o.x, o.x + o.w);
    if (r > prevR && o.x >= prevR && vertical()) r = o.x;
    if (l < prev.x && o.x + o.w <= prev.x && vertical()) l = o.x + o.w;
    if (b > prevB && o.y >= prevB && horizontal()) b = o.y;
    if (t < prev.y && o.y + o.h <= prev.y && horizontal()) t = o.y + o.h;
    if (boxesOverlap({ x: l, y: t, w: r - l, h: b - t }, o)) return prev;
  }
  return { x: l, y: t, w: r - l, h: b - t };
}
