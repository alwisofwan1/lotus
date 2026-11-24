import { describe, expect, it } from "vitest";
import { parseCssColor, themedShapeStyle, THEMED_FILL_ALPHA } from "../canvas-theme-fill";

describe("parseCssColor", () => {
  it("parses 6- and 3-digit hex", () => {
    expect(parseCssColor("#e8663d")).toEqual({ r: 232, g: 102, b: 61 });
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseCssColor("  #E8663D  ")).toEqual({ r: 232, g: 102, b: 61 });
  });

  it("parses rgb()/rgba() (own alpha ignored — the themed fill sets its own)", () => {
    expect(parseCssColor("rgb(245, 242, 239)")).toEqual({ r: 245, g: 242, b: 239 });
    expect(parseCssColor("rgba(245, 242, 239, 0.28)")).toEqual({ r: 245, g: 242, b: 239 });
    expect(parseCssColor("rgb(10 20 30 / 0.5)")).toEqual({ r: 10, g: 20, b: 30 });
  });

  it("returns null for anything it cannot parse", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("color-mix(in srgb, red, blue)")).toBeNull();
    expect(parseCssColor("var(--nope)")).toBeNull();
  });
});

describe("themedShapeStyle", () => {
  it("gives container shapes a translucent accent fill, solid style", () => {
    for (const kind of ["rectangle", "diamond", "ellipse"] as const) {
      expect(themedShapeStyle(kind, "#e8663d")).toEqual({
        fill: `rgba(232, 102, 61, ${THEMED_FILL_ALPHA})`,
        fillStyle: "solid",
      });
    }
  });

  it("leaves text, linear, freehand and image shapes unfilled", () => {
    for (const kind of ["text", "arrow", "line", "draw", "image"] as const) {
      expect(themedShapeStyle(kind, "#e8663d")).toBeNull();
    }
  });

  it("returns null when the accent cannot be parsed (shape falls back to transparent)", () => {
    expect(themedShapeStyle("rectangle", "color-mix(in srgb, red, blue)")).toBeNull();
    expect(themedShapeStyle("rectangle", "")).toBeNull();
  });
});
