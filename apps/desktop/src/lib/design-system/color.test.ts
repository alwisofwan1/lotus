import { describe, expect, it } from "vitest";
import { compositeOver, contrastRatio, oklch } from "@/lib/design-system";

describe("contrastRatio (WCAG 2.x)", () => {
  it("matches the reference extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("matches the published grey that just misses AA", () => {
    // #777777 on white is the classic 4.48:1 example
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("blends a translucent foreground into the surface before measuring", () => {
    // Figures from the PLAN.md §1.3 audit
    expect(contrastRatio("rgba(0,0,0,0.42)", "#ffffff")).toBeCloseTo(3.03, 1);
    expect(contrastRatio("rgba(247,242,234,0.46)", "#151515")).toBeCloseTo(4.32, 1);
  });

  it("refuses a translucent surface, whose colour depends on what is under it", () => {
    expect(() => contrastRatio("#000000", "rgba(255,255,255,0.5)")).toThrow(/opaque/);
  });
});

describe("compositeOver", () => {
  it("flattens a translucent colour onto an opaque backdrop", () => {
    expect(compositeOver("rgba(255,255,255,0.5)", "#000000")).toBe("#808080");
    expect(compositeOver("#123456", "#ffffff")).toBe("#123456");
  });

  it("reads the short and alpha hex forms Monaco and the editor palettes are written in", () => {
    expect(compositeOver("#fff", "#000000")).toBe("#ffffff");
    expect(compositeOver("#ffffff80", "#000000")).toBe("#808080");
    expect(compositeOver("#fff8", "#000")).toBe("#888888");
  });
});

describe("oklch", () => {
  it("lands on the CSS Color 4 reference values", () => {
    expect(oklch(1, 0, 0)).toBe("#ffffff");
    expect(oklch(0, 0, 0)).toBe("#000000");
    // oklch(62.8% 0.2577 29.23) is sRGB red in the CSS Color 4 spec
    expect(oklch(0.628, 0.2577, 29.23)).toBe("#ff0000");
    // An achromatic L is the cube root of linear luminance: 0.52³ = 0.1406 → sRGB 0.411 → 105
    expect(oklch(0.52, 0, 0)).toBe("#696969");
  });

  it("refuses a colour outside sRGB instead of clipping it silently", () => {
    expect(() => oklch(0.9, 0.3, 140)).toThrow(/sRGB/);
  });
});
