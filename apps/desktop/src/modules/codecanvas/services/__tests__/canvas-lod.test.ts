import { describe, expect, it } from "vitest";
import {
  CANVAS_LOD_GLYPH_BELOW_ZOOM,
  CANVAS_LOD_GLYPH_ENTER_ZOOM,
  CANVAS_LOD_GLYPH_EXIT_ZOOM,
  CANVAS_LOD_OVERVIEW_BELOW_ZOOM,
  CANVAS_LOD_OVERVIEW_ENTER_ZOOM,
  CANVAS_LOD_OVERVIEW_EXIT_ZOOM,
  canvasLodTierForZoom,
  canvasLodTierWithHysteresis,
  canvasLodTierWithOverview,
} from "../canvas-lod";

describe("canvas LOD tier", () => {
  it("renders full detail at and above the glyph threshold", () => {
    expect(canvasLodTierForZoom(1)).toBe("full");
    expect(canvasLodTierForZoom(CANVAS_LOD_GLYPH_BELOW_ZOOM)).toBe("full");
    expect(canvasLodTierForZoom(0.85)).toBe("full");
  });

  it("collapses to a glyph below the glyph threshold", () => {
    expect(canvasLodTierForZoom(CANVAS_LOD_GLYPH_BELOW_ZOOM - 0.01)).toBe("glyph");
    expect(canvasLodTierForZoom(0.3)).toBe("glyph");
  });

  it("enters the overview map tier below the overview threshold", () => {
    expect(canvasLodTierForZoom(CANVAS_LOD_OVERVIEW_BELOW_ZOOM - 0.01)).toBe("overview");
    expect(canvasLodTierForZoom(0.04)).toBe("overview");
  });

  it("falls back to full detail for non-finite zoom", () => {
    expect(canvasLodTierForZoom(Number.NaN)).toBe("full");
    expect(canvasLodTierForZoom(Number.POSITIVE_INFINITY)).toBe("full");
  });
});

describe("canvas LOD tier with hysteresis", () => {
  it("collapses to glyph only below the enter threshold", () => {
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_GLYPH_ENTER_ZOOM - 0.01, "full")).toBe("glyph");
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_GLYPH_ENTER_ZOOM - 0.01, "glyph")).toBe("glyph");
  });

  it("enters and holds overview with a separate hysteresis band", () => {
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_OVERVIEW_ENTER_ZOOM - 0.01, "full")).toBe("overview");
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_OVERVIEW_ENTER_ZOOM - 0.01, "glyph")).toBe("overview");
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_OVERVIEW_EXIT_ZOOM - 0.01, "overview")).toBe("overview");
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_OVERVIEW_EXIT_ZOOM + 0.01, "overview")).toBe("glyph");
  });

  it("expands to full only above the exit threshold", () => {
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_GLYPH_EXIT_ZOOM + 0.01, "glyph")).toBe("full");
    expect(canvasLodTierWithHysteresis(CANVAS_LOD_GLYPH_EXIT_ZOOM + 0.01, "full")).toBe("full");
  });

  it("holds the previous tier inside the dead-band (no flip-flop)", () => {
    const mid = (CANVAS_LOD_GLYPH_ENTER_ZOOM + CANVAS_LOD_GLYPH_EXIT_ZOOM) / 2;
    expect(canvasLodTierWithHysteresis(mid, "glyph")).toBe("glyph");
    expect(canvasLodTierWithHysteresis(mid, "full")).toBe("full");
    expect(canvasLodTierWithHysteresis(0.13, "glyph")).toBe("glyph");
    expect(canvasLodTierWithHysteresis(0.13, "overview")).toBe("overview");
  });

  it("falls back to full detail for non-finite zoom", () => {
    expect(canvasLodTierWithHysteresis(Number.NaN, "glyph")).toBe("full");
  });
});

describe("canvasLodTierWithOverview (decision 44)", () => {
  it("forces full detail while the Overview shows live content, whatever the zoom tier says", () => {
    expect(canvasLodTierWithOverview("glyph", true)).toBe("full");
    expect(canvasLodTierWithOverview("overview", true)).toBe("full");
  });
  it("leaves the zoom tier alone otherwise (closed, or over the 16-node budget)", () => {
    expect(canvasLodTierWithOverview("glyph", false)).toBe("glyph");
    expect(canvasLodTierWithOverview("full", false)).toBe("full");
  });
});
