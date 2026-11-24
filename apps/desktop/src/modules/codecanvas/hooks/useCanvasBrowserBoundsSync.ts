"use client";
import { useCallback, useEffect, useRef } from "react";
import type { RefObject } from "react";
import { syncCanvasBrowserBounds, type CanvasBrowserBounds } from "@/lib/tauri/canvas-browser";
import {
  areCanvasBrowserBoundsEquivalent,
  canvasBrowserBoundsSyncDelayMs,
  canvasVisibleBrowserBoundsFromRects,
  CANVAS_BROWSER_PARKED_BOUNDS,
} from "../services/viewport/canvas-viewport-policy";
import { createParkRetryController, type ParkRetryController } from "../services/viewport/canvas-park-retry";
import { getDockedOccluderRects, subscribeDockedOccluders } from "../services/canvas-occlusion-store";

export interface UseCanvasBrowserBoundsSyncOptions {
  nativeBrowserId: string;
  active: boolean;
  suspendNativeView?: boolean;
  zoomFactor?: number;
}

export interface UseCanvasBrowserBoundsSyncResult {
  containerRef: RefObject<HTMLDivElement | null>;
  measureBounds: () => CanvasBrowserBounds | null;
  markBoundsSynced: (bounds: CanvasBrowserBounds) => void;
  syncBounds: () => void;
  forceResyncBounds: () => void;
}

function viewportClipRect(el: HTMLElement): DOMRect | null {
  return el.closest(".canvas-center")?.getBoundingClientRect() ?? null;
}

function visibleBrowserBounds(el: HTMLElement): CanvasBrowserBounds {
  const rect = el.getBoundingClientRect();
  const windowRect = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  const clipRect = viewportClipRect(el) ?? windowRect;
  // Clip around edge-docked UI (NL bar, focus rail) so the WebView never covers it.
  return canvasVisibleBrowserBoundsFromRects(rect, clipRect, windowRect, getDockedOccluderRects());
}

export function useCanvasBrowserBoundsSync({
  nativeBrowserId,
  active,
  suspendNativeView = false,
  zoomFactor = 1,
}: UseCanvasBrowserBoundsSyncOptions): UseCanvasBrowserBoundsSyncResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const throttleTimerRef = useRef<number | null>(null);
  const lastSyncAtRef = useRef<number | null>(null);
  const lastBoundsRef = useRef<CanvasBrowserBounds | null>(null);
  const nativeBrowserIdRef = useRef(nativeBrowserId);
  // Guarantees a park (moving the WebView off-screen for an overlay) is delivered even if the IPC
  // fails — while an overlay is open there are no further geometry events to trigger a re-sync.
  const parkRetryRef = useRef<ParkRetryController | null>(null);

  useEffect(() => {
    nativeBrowserIdRef.current = nativeBrowserId;
  }, [nativeBrowserId]);

  useEffect(() => {
    const controller = createParkRetryController({
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (handle) => window.clearTimeout(handle),
      onGiveUp: () => {
        // Observable failure: the WebView may still cover an overlay. Beats a silent dead browser.
        console.warn(
          `[canvas-browser] could not park native WebView "${nativeBrowserIdRef.current}" after retries; it may cover an open overlay`,
        );
      },
    });
    parkRetryRef.current = controller;
    return () => {
      controller.cancel();
      parkRetryRef.current = null;
    };
  }, []);

  const clearScheduledSync = useCallback(() => {
    if (frameRef.current != null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (throttleTimerRef.current != null) {
      window.clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
  }, []);

  const measureBounds = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;
    return { ...visibleBrowserBounds(el), zoomFactor };
  }, [zoomFactor]);

  const markBoundsSynced = useCallback((bounds: CanvasBrowserBounds) => {
    lastBoundsRef.current = bounds;
  }, []);

  useEffect(() => {
    lastBoundsRef.current = null;
    lastSyncAtRef.current = null;
    parkRetryRef.current?.cancel();
  }, [nativeBrowserId]);

  // Held in a ref so the retry closure can re-invoke the latest pushBounds without the callback
  // referencing itself before declaration.
  const pushBoundsRef = useRef<(bounds: CanvasBrowserBounds, isPark: boolean) => void>(() => {});
  const pushBounds = useCallback((bounds: CanvasBrowserBounds, isPark: boolean) => {
    lastBoundsRef.current = bounds;
    lastSyncAtRef.current = performance.now();
    void syncCanvasBrowserBounds(nativeBrowserIdRef.current, bounds)
      .then(() => {
        parkRetryRef.current?.onSuccess();
      })
      .catch(() => {
        // Allow the next geometry tick to retry even when the measured bounds did not change.
        lastBoundsRef.current = null;
        // A park has no follow-up geometry event to lean on, so drive its own retry.
        if (isPark) parkRetryRef.current?.onFailure(() => pushBoundsRef.current(bounds, true));
      });
  }, []);
  useEffect(() => {
    pushBoundsRef.current = pushBounds;
  }, [pushBounds]);

  const syncBounds = useCallback(() => {
    if (!active) return;
    const parkedBounds = { ...CANVAS_BROWSER_PARKED_BOUNDS, zoomFactor };
    const bounds = suspendNativeView ? parkedBounds : (measureBounds() ?? parkedBounds);
    if (areCanvasBrowserBoundsEquivalent(lastBoundsRef.current, bounds)) return;
    const isPark = bounds.x === CANVAS_BROWSER_PARKED_BOUNDS.x && bounds.y === CANVAS_BROWSER_PARKED_BOUNDS.y;
    // A fresh live sync (overlay closed, node moved into view) supersedes any pending park retry.
    if (!isPark) parkRetryRef.current?.cancel();
    pushBounds(bounds, isPark);
  }, [active, measureBounds, suspendNativeView, zoomFactor, pushBounds]);

  // Force a bounds push even when the dedupe cache believes the WebView is
  // already at these bounds. The self-heal path needs this: a WebView parked
  // off-screen while `lastBoundsRef` still holds the last *live* bounds is the
  // exact desync that strands a black pane, and a plain syncBounds() would
  // dedupe it away. Dropping the cache guarantees the next sync actually fires.
  const forceResyncBounds = useCallback(() => {
    lastBoundsRef.current = null;
    syncBounds();
  }, [syncBounds]);

  const scheduleSyncBounds = useCallback(() => {
    if (frameRef.current != null || throttleTimerRef.current != null || typeof window === "undefined") return;
    const delayMs = canvasBrowserBoundsSyncDelayMs(performance.now(), lastSyncAtRef.current);
    const requestSyncFrame = () => {
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        syncBounds();
      });
    };

    if (delayMs <= 0) {
      requestSyncFrame();
      return;
    }

    throttleTimerRef.current = window.setTimeout(() => {
      throttleTimerRef.current = null;
      requestSyncFrame();
    }, delayMs);
  }, [syncBounds]);

  useEffect(() => {
    if (!active) return;
    scheduleSyncBounds();

    const el = containerRef.current;
    const flowRoot = el?.closest(".react-flow");
    const flowViewport = flowRoot?.querySelector(".react-flow__viewport");
    const flowNode = el?.closest(".react-flow__node");
    const canvasCenter = el?.closest(".canvas-center");
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleSyncBounds) : null;
    if (el) resizeObserver?.observe(el);
    if (flowNode instanceof HTMLElement) resizeObserver?.observe(flowNode);
    if (canvasCenter instanceof HTMLElement) resizeObserver?.observe(canvasCenter);

    const mutationObserver = typeof MutationObserver !== "undefined"
      ? new MutationObserver(scheduleSyncBounds)
      : null;
    if (flowViewport) {
      mutationObserver?.observe(flowViewport, { attributes: true, attributeFilter: ["style", "class"] });
    }
    if (flowNode) {
      mutationObserver?.observe(flowNode, { attributes: true, attributeFilter: ["style", "class"] });
    }

    window.addEventListener("resize", scheduleSyncBounds, true);
    window.addEventListener("scroll", scheduleSyncBounds, true);
    // Re-clip when a docked occluder (NL bar, focus rail) mounts, unmounts, or resizes.
    const unsubscribeDocked = subscribeDockedOccluders(scheduleSyncBounds);

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleSyncBounds, true);
      window.removeEventListener("scroll", scheduleSyncBounds, true);
      unsubscribeDocked();
      clearScheduledSync();
    };
  }, [active, scheduleSyncBounds, clearScheduledSync]);

  useEffect(() => {
    return () => {
      clearScheduledSync();
      parkRetryRef.current?.cancel();
    };
  }, [clearScheduledSync]);

  return { containerRef, measureBounds, markBoundsSynced, syncBounds, forceResyncBounds };
}
