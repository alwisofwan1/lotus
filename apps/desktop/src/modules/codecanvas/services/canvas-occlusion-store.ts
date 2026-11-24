"use client";
import { useSyncExternalStore } from "react";
import type { CanvasRectLike } from "./viewport/canvas-viewport-policy";

/**
 * Tracks DOM overlays that must occlude Canvas Browser Nodes. The browser page is a native Tauri
 * child WebView that always paints above the main window's DOM, so a modal opening "on top" of the
 * canvas is still painted *under* the webview. The only remedy is to park the webview off-screen
 * while the overlay is up — this store is the single signal that drives that decision.
 *
 * A module-level ref-count (not React state) so any overlay anywhere can acquire it without prop
 * drilling, and BrowserNodes subscribe via useSyncExternalStore.
 */

let blockingCount = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Acquire a blocking occlusion (a modal/dialog that fully covers the canvas). Returns a release
 * function that is idempotent — calling it more than once (double-release, unmount after close)
 * only decrements once, so ref-counting stays correct under React StrictMode double-invocation.
 */
export function acquireCanvasOcclusion(label?: string): () => void {
  void label;
  blockingCount += 1;
  if (blockingCount === 1) notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    blockingCount -= 1;
    if (blockingCount === 0) notify();
  };
}

/** Stable boolean snapshot for useSyncExternalStore — true while any blocking overlay is held. */
export function getCanvasOcclusionBlockedSnapshot(): boolean {
  return blockingCount > 0;
}

export function subscribeCanvasOcclusion(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True while any blocking overlay is open. Drives the native-overlay suspend policy. */
export function useCanvasOcclusionBlocked(): boolean {
  return useSyncExternalStore(
    subscribeCanvasOcclusion,
    getCanvasOcclusionBlockedSnapshot,
    () => false,
  );
}

/**
 * Edge-docked UI (NL command bar, focus rail) that overlaps the canvas viewport. Unlike blocking
 * overlays these do not park the whole WebView — instead the browser node clips its native bounds
 * to avoid them (see subtractDockedRects). Providers are read at measure time so a moved/resized
 * dock is reflected without re-registering.
 */
/** A docked occluder rect; `force` clips it past the area-fraction cap (edge-anchored menus). */
export type CanvasDockedOccluderRect = CanvasRectLike & { force?: boolean };
export type DockedOccluderRectProvider = () => CanvasDockedOccluderRect | null;

const dockedProviders = new Map<string, DockedOccluderRectProvider>();
const dockedListeners = new Set<() => void>();

function notifyDocked(): void {
  for (const listener of dockedListeners) listener();
}

export function registerDockedOccluder(id: string, provider: DockedOccluderRectProvider): () => void {
  dockedProviders.set(id, provider);
  notifyDocked();
  return () => {
    if (dockedProviders.delete(id)) notifyDocked();
  };
}

export function getDockedOccluderRects(): CanvasDockedOccluderRect[] {
  const rects: CanvasDockedOccluderRect[] = [];
  for (const provider of dockedProviders.values()) {
    const rect = provider();
    if (rect) rects.push(rect);
  }
  return rects;
}

export function subscribeDockedOccluders(listener: () => void): () => void {
  dockedListeners.add(listener);
  return () => {
    dockedListeners.delete(listener);
  };
}

/** Signal that a registered dock's geometry changed (resize/animation) so browser nodes re-clip. */
export function notifyDockedOccluders(): void {
  notifyDocked();
}

export function __resetCanvasOcclusionForTests(): void {
  blockingCount = 0;
  listeners.clear();
  dockedProviders.clear();
  dockedListeners.clear();
}
