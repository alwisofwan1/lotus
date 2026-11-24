"use client";
import { useSyncExternalStore } from "react";
import type { Node } from "@xyflow/react";
import { frameBoxOf } from "./canvas-frame-space";
import { framesInOrder } from "./canvas-frames";

/**
 * The Active Frame (decision 36): when a canvas has at least one Frame, exactly one is active. It is
 * the Frame last focused or last interacted with, saved per canvas, and the home of every new window
 * node (decision 38). Pure rules first, then a tiny per-canvas store (same module-level pattern as
 * the Overview store) so the chips and the spawn path read one value without prop plumbing.
 */

/** The stored id when it still names a Frame, else the first Frame in switcher order, else null. */
export function resolveActiveFrameId(nodes: readonly Node[], storedId: string | null | undefined): string | null {
  const frames = framesInOrder(nodes);
  if (frames.length === 0) return null;
  if (storedId && frames.some((f) => f.id === storedId)) return storedId;
  return frames[0].id;
}

export type UserArrangeDecision = { kind: "focus-frame"; frameId: string } | { kind: "canvas" };

/**
 * What a USER arrange (NL "arrange", buttons, shortcuts, command centre) does (decision 40). With any
 * Frame on the board it focuses the active Frame (its members fill the screen; other Frames do not
 * move). Only a Frame-less canvas gets the whole-canvas arrange. The agent tool `lotus_arrange_canvas`
 * does not come through here: it keeps the Frames-as-blocks tidy.
 */
export function decideUserArrange(nodes: readonly Node[], storedActiveId: string | null | undefined): UserArrangeDecision {
  const frameId = resolveActiveFrameId(nodes, storedActiveId);
  return frameId ? { kind: "focus-frame", frameId } : { kind: "canvas" };
}

const centreOf =(n: Node) => {
  const b = frameBoxOf(n);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};

/**
 * The remaining Frame nearest (centre to centre) to a Frame that went away: it becomes active.
 * `remaining` is in switcher order, which breaks distance ties. Null when nothing remains.
 */
export function nearestFrameId(remaining: readonly Node[], deleted: Node): string | null {
  const from = centreOf(deleted);
  let best: { id: string; d: number } | null = null;
  for (const f of remaining) {
    const c = centreOf(f);
    const d = Math.hypot(c.x - from.x, c.y - from.y);
    if (!best || d < best.d) best = { id: f.id, d };
  }
  return best?.id ?? null;
}

const STORAGE_PREFIX = "lotus.canvas.activeFrame.v1:";

function readStored(canvasKey: string): string | null {
  try {
    const v = window.localStorage.getItem(STORAGE_PREFIX + canvasKey);
    return v ? v : null;
  } catch {
    return null;
  }
}

function writeStored(canvasKey: string, id: string | null): void {
  try {
    if (id) window.localStorage.setItem(STORAGE_PREFIX + canvasKey, id);
    else window.localStorage.removeItem(STORAGE_PREFIX + canvasKey);
  } catch {
    // Storage blocked or full: the in-memory value still serves this session.
  }
}

const memory = new Map<string, string | null>();
const listeners = new Set<() => void>();

/** Canvases that have no project id yet share one key; a real project id never collides with it. */
export const activeFrameCanvasKey = (projectId: string | null | undefined): string => projectId || "__no-project__";

export const canvasActiveFrameStore = {
  get(canvasKey: string): string | null {
    if (!memory.has(canvasKey)) memory.set(canvasKey, readStored(canvasKey));
    return memory.get(canvasKey) ?? null;
  },
  set(canvasKey: string, id: string | null): void {
    if (this.get(canvasKey) === id) return;
    memory.set(canvasKey, id);
    writeStored(canvasKey, id);
    for (const l of listeners) l();
  },
  /** A closed canvas: drop its saved id, in memory and in storage, like the rest of its view state. */
  forget(canvasKey: string): void {
    this.set(canvasKey, null);
    memory.delete(canvasKey);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Test seam: forget the in-memory values (and the stored ones unless `keepStorage`). */
  reset(opts: { keepStorage?: boolean } = {}): void {
    if (!opts.keepStorage) {
      for (const key of memory.keys()) writeStored(key, null);
    }
    memory.clear();
  },
};

/** The canvas's stored active Frame id (the chips mark it). Validate against the nodes before trusting it. */
export function useActiveFrameId(canvasKey: string): string | null {
  return useSyncExternalStore(
    canvasActiveFrameStore.subscribe,
    () => canvasActiveFrameStore.get(canvasKey),
    () => null,
  );
}
