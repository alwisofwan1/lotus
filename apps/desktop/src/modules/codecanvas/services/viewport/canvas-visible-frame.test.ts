import { describe, it, expect } from "vitest";
import {
  measureVisibleCanvasArea,
  frameBoundsInVisibleArea,
  CANVAS_CHROME_INSETS,
  CANVAS_BARE_EDGE_INSET,
  CANVAS_TITLEBAR_SAFE_TOP,
  CANVAS_DOCK_EDGE,
  CANVAS_DOCK_WIDTH,
  canvasDockInset,
} from "./canvas-visible-frame";

describe("measureVisibleCanvasArea", () => {
  it("subtracts the overlay-chrome insets from the pane", () => {
    const area = measureVisibleCanvasArea({ width: 1440, height: 900 });
    expect(area.left).toBe(CANVAS_CHROME_INSETS.left);
    expect(area.top).toBe(CANVAS_CHROME_INSETS.top);
    expect(area.width).toBe(1440 - CANVAS_CHROME_INSETS.left - CANVAS_CHROME_INSETS.right);
    expect(area.height).toBe(900 - CANVAS_CHROME_INSETS.top - CANVAS_CHROME_INSETS.bottom);
  });

  it("never collapses below the minimum visible size on tiny panes", () => {
    const area = measureVisibleCanvasArea({ width: 200, height: 150 });
    expect(area.width).toBe(360);
    expect(area.height).toBe(280);
  });

  it("reclaims the rail inset when the tool rail is hidden", () => {
    const area = measureVisibleCanvasArea({ width: 1440, height: 900 }, { showToolRail: false });
    expect(area.left).toBe(CANVAS_BARE_EDGE_INSET);
    expect(area.width).toBe(1440 - CANVAS_BARE_EDGE_INSET - CANVAS_CHROME_INSETS.right);
    // Top edge untouched — the pill is still there.
    expect(area.top).toBe(CANVAS_CHROME_INSETS.top);
  });

  it("keeps a titlebar safe-area (not a bare edge) when the top controls dock into the command bar", () => {
    const area = measureVisibleCanvasArea({ width: 1440, height: 900 }, { topControls: "command-bar" });
    // The pill is gone, but the macOS traffic lights are not — reserve room below them.
    expect(area.top).toBe(CANVAS_TITLEBAR_SAFE_TOP);
    expect(area.top).toBeGreaterThan(CANVAS_BARE_EDGE_INSET);
    expect(area.height).toBe(900 - CANVAS_TITLEBAR_SAFE_TOP - CANVAS_CHROME_INSETS.bottom);
    // Left edge untouched — the rail is still there.
    expect(area.left).toBe(CANVAS_CHROME_INSETS.left);
  });

  it("reclaims the left edge but keeps the titlebar safe-area when rail is hidden and controls docked", () => {
    const area = measureVisibleCanvasArea(
      { width: 1440, height: 900 },
      { showToolRail: false, topControls: "command-bar" },
    );
    expect(area.left).toBe(CANVAS_BARE_EDGE_INSET);
    expect(area.top).toBe(CANVAS_TITLEBAR_SAFE_TOP);
    expect(area.width).toBe(1440 - CANVAS_BARE_EDGE_INSET - CANVAS_CHROME_INSETS.right);
    expect(area.height).toBe(900 - CANVAS_TITLEBAR_SAFE_TOP - CANVAS_CHROME_INSETS.bottom);
  });

  it("keeps today's insets for explicit defaults (rail shown, top-bar)", () => {
    const area = measureVisibleCanvasArea(
      { width: 1440, height: 900 },
      { showToolRail: true, topControls: "top-bar" },
    );
    expect(area.left).toBe(CANVAS_CHROME_INSETS.left);
    expect(area.top).toBe(CANVAS_CHROME_INSETS.top);
  });
});

describe("frameBoundsInVisibleArea", () => {
  const area = { left: 80, top: 60, width: 1000, height: 700 };

  it("prefers zoom 1 when the layout fits the visible area", () => {
    const { zoom } = frameBoundsInVisibleArea({ minX: 0, minY: 0, width: 800, height: 500 }, area);
    expect(zoom).toBe(1);
  });

  it("centers the bounds inside the visible area", () => {
    const t = frameBoundsInVisibleArea({ minX: 100, minY: 200, width: 800, height: 500 }, area);
    // Screen-x of bounds' left edge = t.x + minX*zoom = area.left + (area.width - 800)/2.
    expect(t.x + 100 * t.zoom).toBeCloseTo(80 + (1000 - 800) / 2, 5);
    expect(t.y + 200 * t.zoom).toBeCloseTo(60 + (700 - 500) / 2, 5);
  });

  it("zooms out only as far as needed, floored at 0.45", () => {
    const wide = frameBoundsInVisibleArea({ minX: 0, minY: 0, width: 2000, height: 500 }, area);
    expect(wide.zoom).toBeCloseTo(0.5, 5);
    const huge = frameBoundsInVisibleArea({ minX: 0, minY: 0, width: 10000, height: 9000 }, area);
    expect(huge.zoom).toBe(0.45);
  });
});

describe("the open Canvas Dock", () => {
  it("covers nothing while it is closed", () => {
    expect(canvasDockInset({ open: false, wide: true }, 1440)).toBe(0);
  });

  it("covers its width plus its edge gap", () => {
    expect(canvasDockInset({ open: true, wide: false }, 1440)).toBe(CANVAS_DOCK_WIDTH + CANVAS_DOCK_EDGE);
  });

  it("leaves no side to clear when it fills the window: widened, or a window too narrow for it", () => {
    expect(canvasDockInset({ open: true, wide: true }, 1440)).toBe(0);
    // max-width: calc(100% - 32px) — at 480px the 452px Dock already fills the window.
    expect(canvasDockInset({ open: true, wide: false }, 480)).toBe(0);
  });

  it("becomes the right edge of the visible area, with a bare edge's gap", () => {
    const dockInset = canvasDockInset({ open: true, wide: false }, 1440);
    const area = measureVisibleCanvasArea({ width: 1440, height: 900 }, { dockInset });
    expect(area.left + area.width).toBe(1440 - dockInset - CANVAS_BARE_EDGE_INSET);
  });

  it("leaves the area alone when the Dock is closed", () => {
    expect(measureVisibleCanvasArea({ width: 1440, height: 900 }, { dockInset: 0 }))
      .toEqual(measureVisibleCanvasArea({ width: 1440, height: 900 }));
  });
});
