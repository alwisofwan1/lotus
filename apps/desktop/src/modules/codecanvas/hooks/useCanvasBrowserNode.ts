"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasBrowserState } from "../types/canvas";
import { CANVAS_BROWSER_FALLBACK_BOUNDS } from "../services/viewport/canvas-viewport-policy";
import {
  closeCanvasBrowserSession,
  getCanvasBrowserSessionStatus,
  historyCanvasBrowserSession,
  isBlankCanvasBrowserUrl,
  navigateCanvasBrowserSession,
  normalizeCanvasBrowserInitialState,
  openCanvasBrowserSession,
  reloadCanvasBrowserSession,
} from "../runtime/adapters/canvas-browser-lifecycle-adapter";
import { decideCanvasBrowserRepair } from "../services/canvas-browser-health";
import { getActiveProjectRootDir } from "../services/canvas-active-project";
import { useCanvasBrowserAutoOpen } from "./useCanvasBrowserAutoOpen";
import { useCanvasBrowserBoundsSync } from "./useCanvasBrowserBoundsSync";
import { useCanvasBrowserUrlChanged } from "./useCanvasBrowserUrlChanged";

export interface UseCanvasBrowserNodeOptions {
  /** ReactFlow BrowserNode id, used for persisted canvas state and UI callbacks. */
  nodeId: string;
  /** Stable native WebView identity. Paired browsers use their parent Canvas Terminal ID. */
  nativeBrowserId?: string;
  initialUrl: string;
  initialState: CanvasBrowserState;
  /**
   * Native child WebViews are not part of ReactFlow's transformed DOM tree.
   * Park the WebView during direct geometry gestures so it cannot smear outside
   * the BrowserNode while the DOM shell is moving or resizing.
   */
  suspendNativeView?: boolean;
  zoomFactor?: number;
  /**
   * Called when the WebView navigates to a new top-level URL on its own (link
   * click, redirect, programmatic). Lets the owner persist node.data.url so the
   * address bar stays correct across reloads, like a real browser.
   */
  onUrlCommitted?: (url: string) => void;
}

export interface UseCanvasBrowserNodeResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  browserState: CanvasBrowserState;
  currentUrl: string;
  nativeViewSuspended: boolean;
  nativeErrorReason: string | null;
  openBrowser: (url?: string) => Promise<void>;
  closeBrowser: () => Promise<void>;
  navigateBrowser: (url: string) => Promise<void>;
  reloadBrowser: () => Promise<void>;
  backBrowser: () => Promise<void>;
  forwardBrowser: () => Promise<void>;
  syncBounds: () => void;
}


/**
 * How often an active browser node re-checks that its native WebView is actually
 * visible over the node (not torn down, not parked off-screen). This is the
 * event-independent safety net for the black pane the user stares at without ever
 * triggering focus/visibility — kept low-frequency because the probe is a cheap
 * read-only IPC and the cheap sync gate skips it entirely unless a repair applies.
 */
const CANVAS_BROWSER_RECONCILE_INTERVAL_MS = 2500;

/**
 * Delay before the one-shot settle re-push after a node becomes active. Sits just
 * past the node enter-animation (canvas-node-enter, 260ms) so the re-measure reads
 * the node at its final geometry rather than mid-scale.
 */
const CANVAS_BROWSER_OPEN_SETTLE_MS = 320;

function browserErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Native browser runtime unavailable";
}

export function useCanvasBrowserNode({
  nodeId,
  nativeBrowserId = nodeId,
  initialUrl,
  initialState,
  suspendNativeView = false,
  zoomFactor = 1,
  onUrlCommitted,
}: UseCanvasBrowserNodeOptions): UseCanvasBrowserNodeResult {
  const initialBrowserState = normalizeCanvasBrowserInitialState(initialUrl, initialState);
  const [browserState, setBrowserState] = useState<CanvasBrowserState>(initialBrowserState);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [nativeErrorReason, setNativeErrorReason] = useState<string | null>(null);

  // The node's URL can change from outside this hook: agent/NL navigation patches
  // node.data.url (and drives the native navigate itself) without going through
  // navigateBrowser. Mirror those external changes into the displayed URL so the
  // address bar never shows a stale or blank value over a page that already moved.
  // A blank/about:blank patch is ignored — that is a lifecycle reset, not a real
  // destination, and would wipe a valid address bar.
  const externalUrlRef = useRef(initialUrl);
  useEffect(() => {
    if (initialUrl === externalUrlRef.current) return;
    externalUrlRef.current = initialUrl;
    if (!isBlankCanvasBrowserUrl(initialUrl)) setCurrentUrl(initialUrl);
  }, [initialUrl]);

  // The WebView can navigate itself (link click, redirect, programmatic). Follow
  // the destination into the address bar immediately, and let the owner persist it
  // (node.data.url) so the URL survives a reload — exactly like a real browser.
  const onUrlCommittedRef = useRef(onUrlCommitted);
  onUrlCommittedRef.current = onUrlCommitted;
  const handleNativeUrlChange = useCallback((nextUrl: string) => {
    externalUrlRef.current = nextUrl;
    setCurrentUrl(nextUrl);
    onUrlCommittedRef.current?.(nextUrl);
  }, []);
  useCanvasBrowserUrlChanged({ nativeBrowserId, onUrlChanged: handleNativeUrlChange });

  const { containerRef, measureBounds, markBoundsSynced, syncBounds, forceResyncBounds } = useCanvasBrowserBoundsSync({
    nativeBrowserId,
    active: browserState === "active",
    suspendNativeView,
    zoomFactor,
  });

  const openBrowser = useCallback(async (url?: string) => {
    const target = url ?? currentUrl;
    const bounds = measureBounds() ?? { ...CANVAS_BROWSER_FALLBACK_BOUNDS, zoomFactor };
    setNativeErrorReason(null);
    setBrowserState("loading");
    try {
      const resolvedUrl = await openCanvasBrowserSession({
        nativeBrowserId,
        targetUrl: target,
        bounds,
        allowedRoot: getActiveProjectRootDir(),
      });
      setCurrentUrl(resolvedUrl);
      markBoundsSynced(bounds);
      setBrowserState("active");
      setNativeErrorReason(null);
    } catch (error) {
      setBrowserState("disconnected");
      setNativeErrorReason(browserErrorMessage(error));
    }
  }, [nativeBrowserId, currentUrl, measureBounds, markBoundsSynced, zoomFactor]);

  const closeBrowser = useCallback(async () => {
    await closeCanvasBrowserSession(nativeBrowserId).catch(() => undefined);
    setNativeErrorReason(null);
    setBrowserState("disconnected");
  }, [nativeBrowserId]);

  const navigateBrowser = useCallback(async (url: string) => {
    try {
      await navigateCanvasBrowserSession(nativeBrowserId, url, getActiveProjectRootDir());
      setCurrentUrl(url);
      setNativeErrorReason(null);
    } catch {
      // The native WebView can be gone while the node still claims "active"
      // (closed by a previous unmount, project switch, or a crash). A dead
      // navigate is recoverable — re-open at the requested URL instead of
      // stranding the user on a black pane. openBrowser owns the error state
      // if the re-open fails too.
      await openBrowser(url);
    }
  }, [nativeBrowserId, openBrowser]);

  const reloadBrowser = useCallback(async () => {
    try {
      await reloadCanvasBrowserSession(nativeBrowserId);
      setNativeErrorReason(null);
    } catch (error) {
      setBrowserState("disconnected");
      setNativeErrorReason(browserErrorMessage(error));
    }
  }, [nativeBrowserId]);

  const stepHistory = useCallback(async (delta: number) => {
    try {
      await historyCanvasBrowserSession(nativeBrowserId, delta);
      setNativeErrorReason(null);
    } catch (error) {
      setBrowserState("disconnected");
      setNativeErrorReason(browserErrorMessage(error));
    }
  }, [nativeBrowserId]);

  const backBrowser = useCallback(() => stepHistory(-1), [stepHistory]);
  const forwardBrowser = useCallback(() => stepHistory(1), [stepHistory]);

  useCanvasBrowserAutoOpen({ nodeId, initialUrl, initialState, browserState, openBrowser });

  // A node can remount believing it is "active" while its native WebView is
  // long gone — unmount closes the WebView (LOD collapse, focus mode, project
  // switch) but the patched "active" in the node record survives in memory.
  // Re-open once per mount so the claim is re-earned instead of trusted;
  // opening over a still-live WebView is a cheap reuse on the Rust side.
  const openBrowserRef = useRef(openBrowser);
  useEffect(() => {
    openBrowserRef.current = openBrowser;
  }, [openBrowser]);
  const mountClaimRef = useRef({ state: initialBrowserState, url: initialUrl });
  useEffect(() => {
    const claim = mountClaimRef.current;
    if (claim.state !== "active" || isBlankCanvasBrowserUrl(claim.url)) return;
    const frame = window.requestAnimationFrame(() => {
      void openBrowserRef.current(claim.url);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // Self-heal a black pane at the natural recovery moments — window focus and tab
  // visibility regain. Two distinct failure classes strand a live "active" claim
  // over a black pane, and the React tree cannot see into the native surface to
  // tell them apart, so we probe out of band:
  //   • WebView absent (torn down by a crash / uncovered teardown) → re-open.
  //   • WebView open but parked off-screen (a lost/failed unpark, a park-at-open
  //     that never re-synced, an external-park desync) → force a fresh bounds
  //     push; re-opening would reload the live page out from under the user.
  // Refs keep the listeners stable so we never resubscribe per render.
  const currentUrlRef = useRef(currentUrl);
  const browserStateRef = useRef(browserState);
  const suspendRef = useRef(suspendNativeView);
  const forceResyncBoundsRef = useRef(forceResyncBounds);
  const recoveringRef = useRef(false);
  useEffect(() => { currentUrlRef.current = currentUrl; }, [currentUrl]);
  useEffect(() => { browserStateRef.current = browserState; }, [browserState]);
  useEffect(() => { suspendRef.current = suspendNativeView; }, [suspendNativeView]);
  useEffect(() => { forceResyncBoundsRef.current = forceResyncBounds; }, [forceResyncBounds]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const maybeRecover = () => {
      if (recoveringRef.current) return;
      // Cheap synchronous gate before the async probe: if no repair could apply
      // even were the WebView absent (loading/disconnected, suspended, or blank),
      // skip the IPC round-trip entirely. The real status is probed below.
      if (
        decideCanvasBrowserRepair({
          browserState: browserStateRef.current,
          suspended: suspendRef.current,
          url: currentUrlRef.current,
          open: false,
          viewportParked: false,
        }) === "none"
      ) {
        return;
      }
      recoveringRef.current = true;
      void getCanvasBrowserSessionStatus(nativeBrowserId)
        .then((status) => {
          const repair = decideCanvasBrowserRepair({
            browserState: browserStateRef.current,
            suspended: suspendRef.current,
            url: currentUrlRef.current,
            open: status.open,
            viewportParked: status.viewportParked,
          });
          if (repair === "reopen") return openBrowserRef.current(currentUrlRef.current);
          if (repair === "resync-bounds") forceResyncBoundsRef.current();
        })
        .catch(() => undefined)
        .finally(() => {
          recoveringRef.current = false;
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") maybeRecover();
    };
    window.addEventListener("focus", maybeRecover);
    document.addEventListener("visibilitychange", onVisibility);
    // The most common black pane never involves a focus/visibility change at all:
    // the WebView opens (or gets stranded) parked while the user is already looking
    // at the focused window. A low-frequency reconcile tick is the safety net that
    // heals it within a couple seconds regardless of any DOM event. The cheap gate
    // inside maybeRecover skips the IPC probe unless a repair could apply, and we
    // only tick while the tab is visible so a backgrounded window stays idle.
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "hidden") maybeRecover();
    }, CANVAS_BROWSER_RECONCILE_INTERVAL_MS);
    return () => {
      window.removeEventListener("focus", maybeRecover);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(interval);
    };
  }, [nativeBrowserId]);

  // One-shot settle re-push after a node becomes active. openBrowser measures the
  // container once, but a node opened mid enter-animation (scaleY 0.58 → 1) measures
  // clipped/parked bounds, and no ResizeObserver fires when a CSS transform finishes.
  // Force a fresh measure past the animation so the pane never sits black waiting for
  // the periodic reconcile. forceResyncBounds drops the dedupe cache so a poisoned
  // parked measurement can't suppress the correct push.
  useEffect(() => {
    if (browserState !== "active") return;
    const raf = window.requestAnimationFrame(() => forceResyncBoundsRef.current());
    const timer = window.setTimeout(() => forceResyncBoundsRef.current(), CANVAS_BROWSER_OPEN_SETTLE_MS);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [browserState]);

  // Close WebView on unmount.
  useEffect(() => {
    return () => {
      void closeCanvasBrowserSession(nativeBrowserId);
    };
  }, [nativeBrowserId]);

  return { containerRef, browserState, currentUrl, nativeViewSuspended: suspendNativeView, nativeErrorReason, openBrowser, closeBrowser, navigateBrowser, reloadBrowser, backBrowser, forwardBrowser, syncBounds };
}
