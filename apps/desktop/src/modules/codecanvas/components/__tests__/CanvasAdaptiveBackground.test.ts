import { describe, expect, it } from "vitest";

import { canvasBackgroundGapForZoom, canvasBackgroundSizeForZoom } from "../CanvasAdaptiveBackground";

describe("CanvasAdaptiveBackground", () => {
  it("keeps the authored grid at readable zoom levels", () => {
    expect(canvasBackgroundGapForZoom(24, 1)).toBe(24);
    expect(canvasBackgroundSizeForZoom(0.8, 0.5)).toBe(0.8);
  });

  it("expands the grid gap at overview zoom to avoid dense visual noise", () => {
    expect(canvasBackgroundGapForZoom(24, 0.25)).toBe(88);
    expect(canvasBackgroundGapForZoom(24, 0.04)).toBe(700);
  });

  it("keeps overview dots or lines visible in screen space", () => {
    expect(canvasBackgroundSizeForZoom(0.8, 0.2)).toBe(4.5);
    expect(canvasBackgroundSizeForZoom(0.8, 0.04)).toBe(28.7);
  });
});
