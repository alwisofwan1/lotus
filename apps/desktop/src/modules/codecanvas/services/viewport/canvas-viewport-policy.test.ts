import { describe, expect, it } from "vitest";
import {
  canvasBackgroundGapForZoom,
  canvasBackgroundSizeForZoom,
  areCanvasBrowserBoundsEquivalent,
  canvasBrowserBoundsSyncDelayMs,
  canvasParkRetryDelayMs,
  canvasClampZoom,
  canvasLodTierForZoom,
  canvasLodTierWithHysteresis,
  canvasNativeBrowserBoundsFromRects,
  canvasVisibleBrowserBoundsFromRects,
  preferVisibleBrowserBounds,
  canvasViewportZoomBoundsForNodeCount,
  readableCanvasViewport,
  shouldSuspendCanvasNativeOverlay,
  shouldReturnFocusToMainWebview,
  subtractDockedRects,
  dockedOccluderEdgeStrip,
  CANVAS_BROWSER_BOUNDS_SYNC_THROTTLE_MS,
  CANVAS_BROWSER_PARKED_BOUNDS,
} from "./canvas-viewport-policy";

describe("canvas viewport policy", () => {
  it("owns the production zoom envelope", () => {
    expect(canvasViewportZoomBoundsForNodeCount(0)).toEqual({ minZoom: 0.01, maxZoom: 20 });
    expect(canvasClampZoom(0.0001)).toBe(0.01);
    expect(canvasClampZoom(25)).toBe(20);
    expect(readableCanvasViewport({ x: 1, y: 2, zoom: 30 })).toEqual({ x: 1, y: 2, zoom: 20 });
  });

  it("owns LOD thresholds with hysteresis", () => {
    expect(canvasLodTierForZoom(1)).toBe("full");
    expect(canvasLodTierForZoom(0.3)).toBe("glyph");
    expect(canvasLodTierForZoom(0.04)).toBe("overview");
    expect(canvasLodTierWithHysteresis(0.13, "overview")).toBe("overview");
  });

  it("owns overview background density", () => {
    expect(canvasBackgroundGapForZoom(24, 0.25)).toBe(88);
    expect(canvasBackgroundSizeForZoom(0.8, 0.04)).toBe(28.7);
  });

  it("parks native overlays outside full-detail stable geometry", () => {
    expect(shouldSuspendCanvasNativeOverlay({ lodTier: "full" })).toBe(false);
    expect(shouldSuspendCanvasNativeOverlay({ lodTier: "full", dragging: true })).toBe(true);
    expect(shouldSuspendCanvasNativeOverlay({ lodTier: "full", resizing: true })).toBe(true);
    expect(shouldSuspendCanvasNativeOverlay({ lodTier: "glyph" })).toBe(true);
    expect(shouldSuspendCanvasNativeOverlay({ lodTier: "overview" })).toBe(true);
  });

  it("parks the native overlay while a blocking DOM overlay occludes the canvas", () => {
    expect(shouldSuspendCanvasNativeOverlay({ lodTier: "full", overlayBlocked: true })).toBe(true);
    expect(shouldSuspendCanvasNativeOverlay({ lodTier: "full", overlayBlocked: false })).toBe(false);
  });

  it("returns keyboard focus to the main webview only when parking an active browser for an overlay", () => {
    // Overlay opened over a live browser → hand focus back so the modal's Escape/shortcuts work.
    expect(shouldReturnFocusToMainWebview({ overlayBlocked: true, browserActive: true })).toBe(true);
    // A gesture-driven park (drag/resize/LOD) must not steal focus.
    expect(shouldReturnFocusToMainWebview({ overlayBlocked: false, browserActive: true })).toBe(false);
    // No live browser webview holds focus, so nothing to hand off.
    expect(shouldReturnFocusToMainWebview({ overlayBlocked: true, browserActive: false })).toBe(false);
  });

  it("schedules bounded park retries with backoff, then gives up", () => {
    expect(canvasParkRetryDelayMs(0)).toBe(50);
    expect(canvasParkRetryDelayMs(1)).toBe(150);
    expect(canvasParkRetryDelayMs(2)).toBe(400);
    expect(canvasParkRetryDelayMs(3)).toBeNull();
    expect(canvasParkRetryDelayMs(10)).toBeNull();
  });

  describe("canvasVisibleBrowserBoundsFromRects", () => {
    const node = { left: 100, top: 100, right: 900, bottom: 700 };
    const window = { left: 0, top: 0, right: 1000, bottom: 800 };
    const clip = { left: 0, top: 0, right: 1000, bottom: 800 };

    it("matches the plain bounds math when nothing is docked", () => {
      expect(canvasVisibleBrowserBoundsFromRects(node, clip, window, [])).toEqual(
        canvasNativeBrowserBoundsFromRects(node, clip, window),
      );
    });

    it("clips the native bounds above a bottom-docked bar", () => {
      const bar = { left: 0, top: 640, right: 1000, bottom: 800 };
      const withBar = canvasVisibleBrowserBoundsFromRects(node, clip, window, [bar]);
      const withoutBar = canvasVisibleBrowserBoundsFromRects(node, clip, window, []);
      // The bar cuts into the node's lower region, so the parked-free height must shrink.
      expect(withBar.height).toBeLessThan(withoutBar.height);
      expect(withBar.y + withBar.height).toBeLessThanOrEqual(640);
    });

    it("never blacks out a visible node just to avoid a docked occluder", () => {
      // Docked avoidance is cosmetic (don't cover the NL bar). If avoiding the
      // occluder would collapse the bounds to a park while the un-avoided bounds
      // are healthy, the browser must stay visible (occluder overlap is acceptable;
      // a black pane is not). Guards the observed black-pane regression.
      const parkingOccluder = { left: -100000, top: -100000, right: 100000, bottom: 100000 };
      const result = canvasVisibleBrowserBoundsFromRects(node, clip, window, [parkingOccluder]);
      const full = canvasNativeBrowserBoundsFromRects(node, clip, window);
      expect(result).toEqual(full);
      expect(result.width).toBeGreaterThan(8);
      expect(result.height).toBeGreaterThan(8);
    });
  });

  describe("preferVisibleBrowserBounds", () => {
    const full = { x: 43, y: 161, width: 1314, height: 632 };

    it("falls back to the full bounds when docked avoidance would park a healthy node", () => {
      expect(preferVisibleBrowserBounds(full, CANVAS_BROWSER_PARKED_BOUNDS)).toEqual(full);
    });

    it("keeps the avoided bounds when they are still visible", () => {
      const avoided = { x: 43, y: 161, width: 1314, height: 480 };
      expect(preferVisibleBrowserBounds(full, avoided)).toEqual(avoided);
    });

    it("returns the parked bounds when even the full bounds are parked (nothing to show)", () => {
      expect(preferVisibleBrowserBounds(CANVAS_BROWSER_PARKED_BOUNDS, CANVAS_BROWSER_PARKED_BOUNDS))
        .toEqual(CANVAS_BROWSER_PARKED_BOUNDS);
    });
  });

  describe("subtractDockedRects", () => {
    const clip = { left: 0, top: 0, right: 1000, bottom: 800 };

    it("returns the clip unchanged when nothing is docked", () => {
      expect(subtractDockedRects(clip, [])).toEqual(clip);
    });

    it("shrinks the bottom edge for a bottom-docked bar (least-area cut)", () => {
      const bar = { left: 200, top: 740, right: 800, bottom: 800 };
      expect(subtractDockedRects(clip, [bar])).toEqual({ left: 0, top: 0, right: 1000, bottom: 740 });
    });

    it("shrinks the right edge for a right-docked rail", () => {
      const rail = { left: 920, top: 100, right: 1000, bottom: 700 };
      expect(subtractDockedRects(clip, [rail])).toEqual({ left: 0, top: 0, right: 920, bottom: 800 });
    });

    it("ignores a center-floating rect whose least cut would remove >40% of the clip", () => {
      const floating = { left: 400, top: 300, right: 600, bottom: 500 };
      expect(subtractDockedRects(clip, [floating])).toEqual(clip);
    });

    it("still clips a force-marked occluder even when its least cut exceeds the 40% cap", () => {
      // A floating rect whose smallest edge cut removes >40% would normally be
      // ignored — but an edge-anchored dropdown declares force so it is always
      // cleared (the browser stays live but shrinks) rather than covering it.
      const forced = { left: 400, top: 300, right: 600, bottom: 500, force: true };
      // Least-area edge here is the left cut (to x=600); ties with right, left wins.
      expect(subtractDockedRects(clip, [forced])).toEqual({ left: 600, top: 0, right: 1000, bottom: 800 });
    });

    it("force does not change which edge is chosen — still the least-area cut", () => {
      // A narrow right-anchored menu: least cut is the right edge, force or not.
      const menu = { left: 860, top: 200, right: 1000, bottom: 800, force: true };
      expect(subtractDockedRects(clip, [menu])).toEqual({ left: 0, top: 0, right: 860, bottom: 800 });
    });

    it("clips deterministically to the bottom edge for a bottom-anchored menu strip", () => {
      const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
      const menuRect = { left: 700, top: 560, right: 980, bottom: 780 };
      expect(dockedOccluderEdgeStrip(menuRect, "bottom", viewport)).toEqual({
        left: 0,
        top: 560,
        right: 1000,
        bottom: 800,
      });
      const strip = { ...dockedOccluderEdgeStrip(menuRect, "bottom", viewport), force: true };
      expect(subtractDockedRects(clip, [strip])).toEqual({ left: 0, top: 0, right: 1000, bottom: 560 });
    });

    it("is a no-op for a rect that does not intersect the clip", () => {
      const offscreen = { left: 1100, top: 0, right: 1200, bottom: 800 };
      expect(subtractDockedRects(clip, [offscreen])).toEqual(clip);
    });

    it("composes multiple docked rects sequentially", () => {
      const bar = { left: 0, top: 760, right: 1000, bottom: 800 };
      const rail = { left: 940, top: 0, right: 1000, bottom: 800 };
      expect(subtractDockedRects(clip, [bar, rail])).toEqual({ left: 0, top: 0, right: 940, bottom: 760 });
    });
  });

  it("owns native BrowserNode visible bounds math", () => {
    expect(canvasNativeBrowserBoundsFromRects(
      { left: 100, top: 200, right: 740, bottom: 680 },
      { left: 0, top: 0, right: 1200, bottom: 900 },
      { left: 0, top: 0, right: 1200, bottom: 900 },
    )).toEqual({ x: 108, y: 208, width: 624, height: 464 });
  });

  it("parks native BrowserNode bounds when clipped too small", () => {
    expect(canvasNativeBrowserBoundsFromRects(
      { left: 100, top: 200, right: 112, bottom: 212 },
      { left: 0, top: 0, right: 1200, bottom: 900 },
      { left: 0, top: 0, right: 1200, bottom: 900 },
    )).toEqual(CANVAS_BROWSER_PARKED_BOUNDS);
  });

  it("dedupes subpixel native BrowserNode bounds churn", () => {
    expect(areCanvasBrowserBoundsEquivalent(
      { x: 108, y: 208, width: 624, height: 464 },
      { x: 108.1, y: 208.1, width: 624.1, height: 464.1 },
    )).toBe(true);
    expect(areCanvasBrowserBoundsEquivalent(
      { x: 108, y: 208, width: 624, height: 464 },
      { x: 109, y: 208, width: 624, height: 464 },
    )).toBe(false);
  });

  it("throttles native BrowserNode bounds sync cadence", () => {
    expect(canvasBrowserBoundsSyncDelayMs(100, null)).toBe(0);
    expect(canvasBrowserBoundsSyncDelayMs(110, 100)).toBe(CANVAS_BROWSER_BOUNDS_SYNC_THROTTLE_MS - 10);
    expect(canvasBrowserBoundsSyncDelayMs(200, 100)).toBe(0);
  });
});
