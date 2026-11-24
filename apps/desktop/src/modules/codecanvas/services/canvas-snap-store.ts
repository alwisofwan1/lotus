"use client";
import { useSyncExternalStore } from "react";
import type { GapGuide, SnapGuide } from "./canvas-snapping";

/**
 * Live alignment-guide state for the whiteboard snap system. A module-level store — not React
 * state — because guides update per pointermove during a drag: only the tiny CanvasSnapGuides
 * overlay re-renders, never the board. `config` is written by CanvasPage (viewport zoom from
 * onMove, ⌘/Ctrl bypass from a key listener) and read synchronously by the drag interception in
 * useCanvasNodes.handleNodesChange.
 */

export interface SnapGuideState {
  /** Edge/center alignment lines. */
  lines: SnapGuide[];
  /** Equal-spacing gap segments. */
  gaps: GapGuide[];
}

const EMPTY: SnapGuideState = { lines: [], gaps: [] };
let state: SnapGuideState = EMPTY;
const listeners = new Set<() => void>();

export const canvasSnapStore = {
  /** Mutable snap context: current viewport zoom and the hold-⌘-to-disable flag. */
  config: { zoom: 1, bypass: false },
  getGuides(): SnapGuideState {
    return state;
  },
  setGuides(lines: SnapGuide[], gaps: GapGuide[] = []): void {
    // Guides swap at pointer rate; skip notify when both are empty (the common idle case).
    if (state.lines.length === 0 && state.gaps.length === 0 && lines.length === 0 && gaps.length === 0) return;
    state = lines.length === 0 && gaps.length === 0 ? EMPTY : { lines, gaps };
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useCanvasSnapGuides(): SnapGuideState {
  return useSyncExternalStore(canvasSnapStore.subscribe, canvasSnapStore.getGuides, () => EMPTY);
}
