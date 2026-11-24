"use client";
import { useSyncExternalStore } from "react";

/**
 * From the nodes a dragged item overlaps, pick the one that can receive a dropped file/image —
 * a terminal or (live/headless) agent. Returns the first such node's id, or null. Notes, shapes,
 * plans etc. are never drop targets, so they never arm the frame.
 */
export function pickIntersectingDropTarget(nodes: ReadonlyArray<{ id: string; type?: string }>): string | null {
  const hit = nodes.find((n) => n.type === "terminal" || n.type === "agent");
  return hit ? hit.id : null;
}

/**
 * The single canvas node currently armed as a drop target (a terminal/agent under an active
 * file/image drag). A module-level store — not node data — so arming a node re-renders only that
 * node's frame, never the whole graph. All three drag sources (OS file-drop, canvas image-shape
 * drag, browser HTML5 drag) funnel here via CanvasPage.armDropTarget.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

export const canvasDropTargetStore = {
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

/** True while `nodeId` is the armed drop target. Drives the node's drop frame. */
export function useCanvasDropTarget(nodeId: string): boolean {
  return useSyncExternalStore(
    canvasDropTargetStore.subscribe,
    () => canvasDropTargetStore.get() === nodeId,
    () => false,
  );
}
