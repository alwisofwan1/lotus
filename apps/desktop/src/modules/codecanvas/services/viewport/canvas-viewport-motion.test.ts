import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginCanvasViewportMotion,
  getCanvasViewportMotionSnapshot,
  resetCanvasViewportMotionForTests,
  resolveCanvasLodTierDuringViewportMotion,
  setCanvasViewportStableLodTier,
  viewportForZoomAroundPoint,
  viewportForZoomAroundRectCenter,
} from "./canvas-viewport-motion";

describe("canvas viewport motion", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetCanvasViewportMotionForTests();
  });
  it("keeps the chosen screen point anchored while zooming", () => {
    const current = { x: 100, y: 50, zoom: 0.5 };
    const point = { x: 500, y: 350 };
    const next = viewportForZoomAroundPoint(current, 1, point);

    const flowXBefore = (point.x - current.x) / current.zoom;
    const flowYBefore = (point.y - current.y) / current.zoom;
    const screenXAfter = flowXBefore * next.zoom + next.x;
    const screenYAfter = flowYBefore * next.zoom + next.y;

    expect(screenXAfter).toBeCloseTo(point.x, 5);
    expect(screenYAfter).toBeCloseTo(point.y, 5);
  });

  it("uses the viewport rect center for button zooms", () => {
    expect(viewportForZoomAroundRectCenter({ x: 0, y: 0, zoom: 1 }, 2, { width: 800, height: 600 })).toEqual({
      x: -400,
      y: -300,
      zoom: 2,
    });
  });

  it("freezes semantic LOD during deliberate viewport motion", () => {
    const active = { active: true, frozenLodTier: "glyph" as const, version: 1 };
    expect(resolveCanvasLodTierDuringViewportMotion(1, "glyph", active)).toBe("glyph");

    const idle = { active: false, frozenLodTier: null, version: 2 };
    expect(resolveCanvasLodTierDuringViewportMotion(1, "glyph", idle)).toBe("full");
  });

  it("opens and closes a viewport motion window with a frozen stable tier", () => {
    vi.useFakeTimers();
    setCanvasViewportStableLodTier("glyph");

    const finish = beginCanvasViewportMotion({ currentZoom: 0.38, durationMs: 360 });
    expect(getCanvasViewportMotionSnapshot()).toMatchObject({ active: true, frozenLodTier: "glyph" });

    vi.advanceTimersByTime(449);
    expect(getCanvasViewportMotionSnapshot().active).toBe(true);
    vi.advanceTimersByTime(1);
    expect(getCanvasViewportMotionSnapshot().active).toBe(false);

    finish();
    expect(getCanvasViewportMotionSnapshot().active).toBe(false);
  });
});
