import { describe, expect, it } from "vitest";
import {
  applySplitDrag,
  applySplitResize,
} from "@/modules/workspace-shell/services/split-tree-sizing";

describe("applySplitDrag", () => {
  it("moves the dragged edge and leaves the other children alone", () => {
    // Three children sharing 900px, 300px each. Dragging the first seam 90px right must give
    // those 90px to the first child and take them from the second — the third is not involved,
    // because a seam belongs to the pair it sits between.
    const next = applySplitDrag({ sizes: [1 / 3, 1 / 3, 1 / 3], index: 0, deltaPx: 90, containerPx: 900, minPx: 100 });
    const px = next.map((size) => size * 900);

    expect(px[0]).toBeCloseTo(390, 6);
    expect(px[1]).toBeCloseTo(210, 6);
    expect(px[2]).toBeCloseTo(300, 6);
    expect(next.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1, 10);
  });
});

describe("applySplitDrag — limits", () => {
  it("stops at the minimum instead of squeezing the neighbour to nothing", () => {
    const next = applySplitDrag({ sizes: [0.5, 0.5], index: 0, deltaPx: 10_000, containerPx: 1000, minPx: 200 });
    const px = next.map((size) => size * 1000);
    expect(px[1]).toBeCloseTo(200, 6);
    expect(px[0]).toBeCloseTo(800, 6);
  });

  it("stops at the minimum on the dragged side too", () => {
    const next = applySplitDrag({ sizes: [0.5, 0.5], index: 0, deltaPx: -10_000, containerPx: 1000, minPx: 200 });
    expect(next[0] * 1000).toBeCloseTo(200, 6);
  });

  it("leaves a pair with no room for two minimums exactly as it was", () => {
    const sizes = [0.5, 0.5];
    expect(applySplitDrag({ sizes, index: 0, deltaPx: 50, containerPx: 300, minPx: 200 })).toEqual(sizes);
  });

  it("ignores a seam index that is not between two children", () => {
    const sizes = [0.5, 0.5];
    expect(applySplitDrag({ sizes, index: 1, deltaPx: 50, containerPx: 1000, minPx: 100 })).toEqual(sizes);
  });
});

describe("applySplitResize", () => {
  it("sets the dragged child to the size the pointer asked for", () => {
    // The handle reports an ABSOLUTE size measured from where the drag began. Converting that to
    // a delta against the size on screen double-counts, because the screen moves as you drag.
    const next = applySplitResize({ sizes: [0.5, 0.5], index: 0, leadingPx: 700, containerPx: 1000, minPx: 100 });
    expect(next[0] * 1000).toBeCloseTo(700, 6);
    expect(next[1] * 1000).toBeCloseTo(300, 6);
  });
});

describe("applySplitResize — the engine's units", () => {
  it("works with sizes stored as percentages, not only as fractions", () => {
    // The workspace layout tree normalises its split sizes to sum to 100. Treating those as
    // fractions makes the pair look a hundred times wider than the node, so every drag lands on
    // the minimum — which is what "dragging jumps to the edge" looked like.
    const next = applySplitResize({ sizes: [50, 50], index: 0, leadingPx: 430, containerPx: 1169, minPx: 180 });
    const total = next.reduce((sum, size) => sum + size, 0);

    expect((next[0] / total) * 1169).toBeCloseTo(430, 6);
    expect((next[1] / total) * 1169).toBeCloseTo(739, 6);
  });
});
