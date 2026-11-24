import { describe, expect, it } from "vitest";
import { computeAnnotationScreenshotCropRect } from "../canvas-browser-annotation-crop";
import type { BrowserAnnotation } from "@/lib/tauri/codespace";

function annotation(overrides: Partial<BrowserAnnotation> = {}): BrowserAnnotation {
  return {
    id: "annotation-1",
    agentId: "terminal:term-1",
    url: "https://example.com",
    title: "Example",
    selector: "button.primary",
    breadcrumb: [],
    label: "Deploy",
    text: "Deploy",
    message: "",
    dimensions: { width: 120, height: 32 },
    computedStyles: {},
    reactComponent: "",
    classes: [],
    summary: [],
    outerHTML: "",
    boundingBox: { x: 653, y: 136, width: 373, height: 210 },
    viewport: { width: 1438, height: 785, scrollX: 0, scrollY: 0 },
    createdAt: "2026-05-02T16:00:00.000Z",
    ...overrides,
  };
}

describe("canvas-browser-annotation-crop", () => {
  it("crops tight to the selected element by default (no margin) and converts to viewport-relative coordinates", () => {
    const rect = computeAnnotationScreenshotCropRect(annotation());

    // Default margin is 0 — the crop is exactly the element's box, no surrounding context.
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeCloseTo(653, 1);
    expect(rect!.y).toBeCloseTo(136, 1);
    expect(rect!.width).toBeCloseTo(373, 1);
    expect(rect!.height).toBeCloseTo(210, 1);
  });

  it("still expands by an explicit margin ratio when a caller opts into one", () => {
    const rect = computeAnnotationScreenshotCropRect(annotation(), 0.175);

    expect(rect!.x).toBeCloseTo(653 - 373 * 0.175, 1);
    expect(rect!.width).toBeCloseTo(373 * 1.35, 1);
  });

  it("carries the CSS viewport dimensions so Rust can self-calibrate the crop scale against the captured PNG", () => {
    const rect = computeAnnotationScreenshotCropRect(annotation());

    expect(rect!.viewportWidth).toBe(1438);
    expect(rect!.viewportHeight).toBe(785);
  });

  it("clamps an explicit margin at the viewport's top-left edge instead of going negative", () => {
    const rect = computeAnnotationScreenshotCropRect(annotation({
      // margin = 7px/3.5px; x - margin = -5, y - margin = -2.5 → both must clamp to 0.
      boundingBox: { x: 2, y: 1, width: 40, height: 20 },
      viewport: { width: 1440, height: 900, scrollX: 0, scrollY: 0 },
    }), 0.175);

    expect(rect).toMatchObject({ x: 0, y: 0, width: 49, height: 24.5 });
  });

  it("subtracts the current scroll position to convert to viewport-relative coordinates", () => {
    const rect = computeAnnotationScreenshotCropRect(annotation({
      boundingBox: { x: 653, y: 936, width: 373, height: 210 },
      viewport: { width: 1438, height: 785, scrollX: 0, scrollY: 800 },
    }));

    // Tight crop (no margin): viewport-relative y = pageY - scrollY.
    expect(rect!.y).toBeCloseTo(936 - 800, 1);
  });

  it("returns null for a zero-size bounding box (nothing sensible to crop)", () => {
    const rect = computeAnnotationScreenshotCropRect(annotation({
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
    }));

    expect(rect).toBeNull();
  });

  it("returns null when the viewport dimensions are missing (e.g. a stale annotation)", () => {
    const rect = computeAnnotationScreenshotCropRect(annotation({
      viewport: { width: 0, height: 0, scrollX: 0, scrollY: 0 },
    }));

    expect(rect).toBeNull();
  });
});
