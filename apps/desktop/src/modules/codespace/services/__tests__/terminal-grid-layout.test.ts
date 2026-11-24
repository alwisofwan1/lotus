import { describe, expect, it } from "vitest";
import {
  buildGridTrackTemplate,
  createEqualFractions,
  getTrackHandleOffsets,
  normalizeFractions,
  resizeTrackFractions,
} from "../terminal-grid-layout";

describe("terminal-grid-layout", () => {
  it("creates equal fractions", () => {
    expect(createEqualFractions(3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("normalizes invalid fractions back to equal layout", () => {
    expect(normalizeFractions([0, -1, Number.NaN], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("builds grid track templates", () => {
    expect(buildGridTrackTemplate([0.5, 0.5])).toBe("50.0000% 50.0000%");
  });

  it("returns handle offsets between tracks", () => {
    expect(getTrackHandleOffsets([0.25, 0.5, 0.25])).toEqual([0.25, 0.75]);
  });

  it("resizes adjacent tracks while preserving total size", () => {
    const resized = resizeTrackFractions([0.5, 0.5], 0, 120, 1000, 160);
    expect(resized[0]).toBeCloseTo(0.62, 2);
    expect(resized[1]).toBeCloseTo(0.38, 2);
    expect(resized[0] + resized[1]).toBeCloseTo(1, 5);
  });

  it("clamps resize to minimum track size", () => {
    const resized = resizeTrackFractions([0.5, 0.5], 0, -400, 1000, 160);
    expect(resized[0]).toBeCloseTo(0.16, 2);
    expect(resized[1]).toBeCloseTo(0.84, 2);
  });
});
