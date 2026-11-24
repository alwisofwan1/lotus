import { describe, expect, it } from "vitest";
import {
  isRectRevealed,
  revealViewportForNodes,
  revealViewportForRect,
  unionFlowRects,
  type CanvasFlowRect,
} from "./canvas-reveal-viewport";
import type { VisibleCanvasArea } from "./canvas-visible-frame";

const AREA: VisibleCanvasArea = { left: 80, top: 60, width: 1400, height: 820 };
const IDENTITY = { x: 0, y: 0, zoom: 1 };

function screenRect(rect: CanvasFlowRect, viewport = IDENTITY) {
  return {
    left: rect.x * viewport.zoom + viewport.x,
    top: rect.y * viewport.zoom + viewport.y,
    right: (rect.x + rect.w) * viewport.zoom + viewport.x,
    bottom: (rect.y + rect.h) * viewport.zoom + viewport.y,
  };
}

describe("revealViewportForRect", () => {
  it("does not move the camera when the rect is already on screen", () => {
    const rect: CanvasFlowRect = { x: 200, y: 200, w: 400, h: 300 };
    expect(revealViewportForRect(rect, IDENTITY, AREA)).toBeNull();
  });

  it("pans by exactly the overflow when the rect pokes off the right edge", () => {
    // Right edge at 1600 screen px; the area ends at 1480, margin 24 → 144px overflow.
    const rect: CanvasFlowRect = { x: 1200, y: 200, w: 400, h: 300 };
    const next = revealViewportForRect(rect, IDENTITY, AREA);

    expect(next).not.toBeNull();
    expect(next!.zoom).toBe(1);
    expect(next!.y).toBe(0);
    expect(next!.x).toBeCloseTo(-144, 5);
    expect(isRectRevealed(rect, next!, AREA)).toBe(true);
  });

  it("keeps the untouched axis untouched", () => {
    const rect: CanvasFlowRect = { x: 200, y: 1000, w: 400, h: 300 };
    const next = revealViewportForRect(rect, IDENTITY, AREA);

    expect(next!.x).toBe(0);
    expect(next!.y).toBeLessThan(0);
  });

  it("never zooms in to reveal a small rect", () => {
    const rect: CanvasFlowRect = { x: 4000, y: 4000, w: 100, h: 100 };
    const next = revealViewportForRect(rect, { x: 0, y: 0, zoom: 0.6 }, AREA);

    expect(next!.zoom).toBe(0.6);
  });

  it("zooms out only as far as the rect needs, not to a fixed fit", () => {
    // 2000 wide against a 1400-wide area with 24px margins → fit zoom ≈ 0.676.
    const rect: CanvasFlowRect = { x: 0, y: 0, w: 2000, h: 600 };
    const next = revealViewportForRect(rect, IDENTITY, AREA);

    expect(next!.zoom).toBeCloseTo((1400 - 48) / 2000, 5);
    expect(isRectRevealed(rect, next!, AREA)).toBe(true);
  });

  it("stops at minZoom rather than shrinking the board without limit", () => {
    const rect: CanvasFlowRect = { x: 0, y: 0, w: 20000, h: 600 };
    const next = revealViewportForRect(rect, IDENTITY, AREA, { minZoom: 0.5 });

    expect(next!.zoom).toBe(0.5);
    // Cannot fit — show the rect's leading edge instead of centring on nothing.
    expect(screenRect(rect, next!).left).toBeCloseTo(AREA.left + 24, 5);
  });
});

describe("revealViewportForNodes", () => {
  const skills: CanvasFlowRect = { x: 1000, y: 100, w: 720, h: 520 };
  const terminal: CanvasFlowRect = { x: 200, y: 100, w: 760, h: 520 };

  it("includes the companion node when the union still fits", () => {
    const next = revealViewportForNodes(skills, [terminal], IDENTITY, AREA, { minZoom: 0.5 });

    expect(next).not.toBeNull();
    expect(isRectRevealed(skills, next!, AREA)).toBe(true);
    expect(isRectRevealed(terminal, next!, AREA)).toBe(true);
  });

  it("drops the companion rather than zooming out past minZoom", () => {
    const farTerminal: CanvasFlowRect = { x: -4000, y: 100, w: 760, h: 520 };
    const next = revealViewportForNodes(skills, [farTerminal], IDENTITY, AREA, { minZoom: 0.5 });

    expect(next).not.toBeNull();
    expect(next!.zoom).toBe(1);
    expect(isRectRevealed(skills, next!, AREA)).toBe(true);
    expect(isRectRevealed(farTerminal, next!, AREA)).toBe(false);
  });

  it("still does nothing when both nodes are already visible", () => {
    const nearSkills: CanvasFlowRect = { x: 620, y: 120, w: 400, h: 300 };
    const nearTerminal: CanvasFlowRect = { x: 160, y: 120, w: 400, h: 300 };

    expect(revealViewportForNodes(nearSkills, [nearTerminal], IDENTITY, AREA)).toBeNull();
  });
});

describe("unionFlowRects", () => {
  it("spans every rect", () => {
    expect(unionFlowRects([{ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 100, w: 100, h: 50 }]))
      .toEqual({ x: 0, y: 0, w: 300, h: 150 });
  });
});
