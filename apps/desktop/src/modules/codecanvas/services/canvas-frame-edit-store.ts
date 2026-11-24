"use client";
import { useSyncExternalStore } from "react";

/**
 * Which Frame's title should open for typing. Cmd+G, F2 and the double-click all ask here; the
 * FrameNode that owns the id picks the request up and clears it. A store rather than node data on
 * purpose: node data feeds undo history and the snapshot, and "please start typing" is neither.
 */
let requested: string | null = null;
const listeners = new Set<() => void>();

export const canvasFrameEditStore = {
  get(): string | null {
    return requested;
  },
  request(frameId: string | null): void {
    if (requested === frameId) return;
    requested = frameId;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** True while a rename was requested for this Frame and not yet picked up. */
export function useFrameEditRequest(frameId: string): boolean {
  return useSyncExternalStore(
    canvasFrameEditStore.subscribe,
    () => canvasFrameEditStore.get() === frameId,
    () => false,
  );
}
