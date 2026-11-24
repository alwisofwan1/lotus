"use client";
import { useSyncExternalStore } from "react";
import type { FrameOverviewLabel } from "./canvas-frame-overview";

/**
 * Frame Overview state shared with the Frame nodes. Module-level store (same pattern as
 * canvasFrameDropStore) so opening the overview or moving focus re-renders only the Frames, not
 * the whole graph. `labels` carries "01 · 4 nodes" (or "02 · needs you") per Frame id.
 */
interface OverviewState {
  active: boolean;
  focusedId: string | null;
  labels: Readonly<Record<string, FrameOverviewLabel>>;
  /** Decision 44: members show live content (no glyph LOD) while the Overview is open. */
  fullDetail: boolean;
}

let state: OverviewState = { active: false, focusedId: null, labels: {}, fullDetail: false };
const listeners = new Set<() => void>();

function commit(next: OverviewState): void {
  state = next;
  for (const listener of listeners) listener();
}

export const canvasFrameOverviewStore = {
  get: (): OverviewState => state,
  open(labels: Record<string, FrameOverviewLabel>, focusedId: string | null, fullDetail = false): void {
    commit({ active: true, focusedId, labels, fullDetail });
  },
  /** Live while open: nodes added under the Overview can push it over the 16-node live-content budget. */
  setFullDetail(fullDetail: boolean): void {
    if (!state.active || state.fullDetail === fullDetail) return;
    commit({ ...state, fullDetail });
  },
  /** Live refresh while open (decision 42). A no-op when closed or when no label changed. */
  setLabels(labels: Record<string, FrameOverviewLabel>): void {
    if (!state.active) return;
    const prev = state.labels;
    const keys = Object.keys(labels);
    const same =
      keys.length === Object.keys(prev).length &&
      keys.every((k) => prev[k] && prev[k].text === labels[k].text && prev[k].needsYou === labels[k].needsYou);
    if (same) return;
    commit({ ...state, labels });
  },
  close(): void {
    if (!state.active && state.focusedId === null) return;
    commit({ active: false, focusedId: null, labels: {}, fullDetail: false });
  },
  focus(id: string | null): void {
    if (state.focusedId === id) return;
    commit({ ...state, focusedId: id });
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** What one Frame should look like right now: closed, open, or open and keyboard/hover focused. */
export function useFrameOverviewMode(frameId: string): "off" | "on" | "focus" {
  return useSyncExternalStore(
    canvasFrameOverviewStore.subscribe,
    () => (!state.active ? "off" : state.focusedId === frameId ? "focus" : "on"),
    () => "off",
  );
}

export function useFrameOverviewLabel(frameId: string): string | null {
  return useSyncExternalStore(
    canvasFrameOverviewStore.subscribe,
    () => (state.active ? state.labels[frameId]?.text ?? null : null),
    () => null,
  );
}

/** True while the overview is open and an agent inside this Frame is waiting for the user. */
export function useFrameOverviewNeedsYou(frameId: string): boolean {
  return useSyncExternalStore(
    canvasFrameOverviewStore.subscribe,
    () => state.active && state.labels[frameId]?.needsYou === true,
    () => false,
  );
}

/** The Frame lit by hover or the arrow keys while the Overview is open (null otherwise). */
export function useFrameOverviewFocusedId(): string | null {
  return useSyncExternalStore(
    canvasFrameOverviewStore.subscribe,
    () => (state.active ? state.focusedId : null),
    () => null,
  );
}

/** True while the Overview is open and its content stays at full detail (decision 44). */
export function useFrameOverviewFullDetail(): boolean {
  return useSyncExternalStore(
    canvasFrameOverviewStore.subscribe,
    () => state.active && state.fullDetail,
    () => false,
  );
}
