"use client";
import { useSyncExternalStore } from "react";

/**
 * The Frame currently under a dragged node's centre, i.e. the one the node would join on drop.
 * Module-level store (same pattern as canvasDropTargetStore) so lighting a Frame re-renders only
 * that Frame, never the whole graph. Separate from the file-drop store: that one arms
 * terminals/agents for attachments, this one arms Frames for membership.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export const canvasFrameDropStore = {
  get(): string | null {
    return current;
  },
  set(id: string | null): void {
    if (current === id) return;
    current = id;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** True while `frameId` is the Frame a dragged node would join. */
export function useFrameDropTarget(frameId: string): boolean {
  return useSyncExternalStore(
    canvasFrameDropStore.subscribe,
    () => canvasFrameDropStore.get() === frameId,
    () => false,
  );
}
