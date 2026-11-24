import { describe, expect, it } from "vitest";
import { SHAPE_DEFAULTS, SHAPE_STROKE_WIDTHS, STROKE_COLORS, contrastInk, colorName, normalizeShapeStrokeWidth } from "../shape-defaults";

describe("colorName", () => {
  it("names every palette swatch for accessible labels", () => {
    expect(colorName("#f1f3f5")).toBe("white");
    expect(colorName("#e8663d")).toBe("coral");
    expect(colorName("#4dabf7")).toBe("blue");
  });

  it("falls back to the hex for a custom (non-palette) color", () => {
    expect(colorName("#123456")).toBe("#123456");
  });
});

describe("contrastInk", () => {
  it("returns dark ink on light swatches and light ink on dark swatches", () => {
    expect(contrastInk("#ffffff")).toBe("#1a1a1a");
    expect(contrastInk("#000000")).toBe("#ffffff");
    expect(contrastInk("#ffd43b")).toBe("#1a1a1a"); // bright yellow → dark check
  });

  it("falls back to dark ink for an unparseable color", () => {
    expect(contrastInk("not-a-color")).toBe("#1a1a1a");
  });
});
import { buildShapeRoughPaths } from "../../components/nodes/ShapeNode";

/**
 * Locks the panel↔render contract: a fresh shape (no style) must render with exactly the
 * defaults the Inspector marks as active, so the pressed-state never lies about the output.
 */
describe("SHAPE_DEFAULTS", () => {
  it("renders a styleless shape at the default stroke width (no panel↔render drift)", () => {
    const [path] = buildShapeRoughPaths("rectangle", 200, 140, 7);
    expect(path.strokeWidth).toBe(SHAPE_DEFAULTS.strokeWidth);
    expect(SHAPE_STROKE_WIDTHS[0][1]).toBe(SHAPE_DEFAULTS.strokeWidth);
  });

  it("offers a visibly assertive bold tier and clamps unsafe persisted stroke widths", () => {
    expect(SHAPE_STROKE_WIDTHS.at(-1)?.[1]).toBeGreaterThanOrEqual(7);
    expect(normalizeShapeStrokeWidth(999)).toBeLessThanOrEqual(12);
    expect(normalizeShapeStrokeWidth(0)).toBe(SHAPE_DEFAULTS.strokeWidth);
  });

  it("renders a styleless shape with the default (first-swatch) stroke color", () => {
    const [path] = buildShapeRoughPaths("rectangle", 200, 140, 7);
    expect(path.stroke).toBe(SHAPE_DEFAULTS.strokeColor);
    expect(STROKE_COLORS[0]).toBe(SHAPE_DEFAULTS.strokeColor);
  });
});
