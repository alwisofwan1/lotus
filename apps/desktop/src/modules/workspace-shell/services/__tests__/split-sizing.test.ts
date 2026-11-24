import { describe, expect, it } from "vitest";
import {
  applySplitSnap,
  clampSplitSize,
  computeSplitMax,
  nudgeSplitSize,
  resolveDragSize,
  SPLIT_HANDLE_SIZE,
} from "@/modules/workspace-shell/services/split-sizing";

const constraints = { min: 220, max: 420 };

describe("clampSplitSize", () => {
  it("keeps a size that is already in range, rounded to whole pixels", () => {
    expect(clampSplitSize(300.4, constraints)).toBe(300);
  });

  it("clamps to both ends", () => {
    expect(clampSplitSize(10, constraints)).toBe(220);
    expect(clampSplitSize(9000, constraints)).toBe(420);
  });

  it("prefers min when the window is too small for both panes", () => {
    expect(clampSplitSize(300, { min: 220, max: 80 })).toBe(220);
  });

  it("falls back to min for a non-finite size", () => {
    expect(clampSplitSize(Number.NaN, constraints)).toBe(220);
  });
});

describe("computeSplitMax", () => {
  it("leaves room for the trailing pane and the handle", () => {
    expect(computeSplitMax(1000, 320, 220)).toBe(1000 - 320 - SPLIT_HANDLE_SIZE);
  });

  it("never returns less than the leading minimum", () => {
    expect(computeSplitMax(300, 320, 220)).toBe(220);
  });

  it("survives a container measured before layout", () => {
    expect(computeSplitMax(Number.NaN, 320, 220)).toBe(220);
  });
});

describe("resolveDragSize", () => {
  it("adds the pointer delta to the size the drag started from", () => {
    expect(resolveDragSize(300, 45, constraints)).toBe(345);
    expect(resolveDragSize(300, -45, constraints)).toBe(255);
  });

  it("clamps rather than following the pointer past the edge", () => {
    expect(resolveDragSize(300, -400, constraints)).toBe(220);
  });

  it("holds the start size when the delta is unusable", () => {
    expect(resolveDragSize(300, Number.NaN, constraints)).toBe(300);
  });
});

describe("nudgeSplitSize", () => {
  it("steps in both directions and stops at the edge", () => {
    expect(nudgeSplitSize(300, 16, constraints)).toBe(316);
    expect(nudgeSplitSize(224, -16, constraints)).toBe(220);
  });
});

describe("applySplitSnap", () => {
  it("snaps within the threshold and releases outside it", () => {
    expect(applySplitSnap(306, 300)).toBe(300);
    expect(applySplitSnap(340, 300)).toBe(340);
  });
});
