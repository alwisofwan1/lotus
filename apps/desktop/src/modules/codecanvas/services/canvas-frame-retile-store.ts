/**
 * "A member was added to / closed in this Frame" (decision 39). The node layer announces the intent
 * here the moment it really mutates the board (one chokepoint per direction), and the Frame focus
 * hook turns the stream into ONE debounced re-tile. Module-level, like the other Frame stores, so
 * the node hook needs no callback plumbing and cannot hold a stale closure of the page.
 *
 * Re-tiling itself never announces anything: it writes layout through `applyLayoutBoxes`, which does
 * not pass through here, so a re-tile cannot trigger another one.
 */
import type { RetileIntent } from "./canvas-frame-retile";

type Listener = (frameId: string, intent?: RetileIntent) => void;

const listeners = new Set<Listener>();

export const canvasFrameRetileStore = {
  /** `intent` says what changed, so the auto-tidy settings can decide (decision 47). */
  request(frameId: string, intent?: RetileIntent): void {
    for (const l of [...listeners]) l(frameId, intent);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
