import { describe, expect, it } from "vitest";
import type { GridCell } from "@/modules/codespace/components/types";
import {
  normalizeFractions,
  resolveTrackSizes,
  toGridRows,
  trackDragDelta,
} from "@/modules/workspace-shell/services/grid-layout";

function cell(id: string): GridCell {
  return { id, cwd: "/tmp", type: "terminal", runtimeSessionId: null, runtimeStatus: "idle" };
}

describe("normalizeFractions", () => {
  it("returns equal shares when nothing usable is stored", () => {
    expect(normalizeFractions(undefined, 2)).toEqual([0.5, 0.5]);
    expect(normalizeFractions([], 2)).toEqual([0.5, 0.5]);
  });

  it("rescales stored fractions so they always sum to one", () => {
    expect(normalizeFractions([2, 2], 2)).toEqual([0.5, 0.5]);
    const [a, b] = normalizeFractions([0.75, 0.25], 2);
    expect(a).toBeCloseTo(0.75);
    expect(b).toBeCloseTo(0.25);
  });

  it("ignores a stored list that no longer matches the column count", () => {
    expect(normalizeFractions([0.9, 0.1], 3)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("survives a corrupt fraction rather than rendering a zero-width column", () => {
    const result = normalizeFractions([Number.NaN, 1], 2);
    expect(result.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });
});

describe("toGridRows", () => {
  it("fills row-major, the same order CodeSpace assigns", () => {
    const rows = toGridRows([cell("a"), cell("b"), cell("c"), cell("d")], 2, 2);
    expect(rows.map((row) => row.cells.map((c) => c.id))).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("drops a row the cells do not reach instead of rendering it empty", () => {
    const rows = toGridRows([cell("a"), cell("b")], 3, 2);
    expect(rows).toHaveLength(1);
  });

  it("never loses a pane that falls outside rows×cols", () => {
    const rows = toGridRows([cell("a"), cell("b"), cell("c")], 1, 2);
    expect(rows.flatMap((row) => row.cells.map((c) => c.id))).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for a workspace with no panes", () => {
    expect(toGridRows([], 2, 2)).toEqual([]);
  });
});

describe("resolveTrackSizes", () => {
  it("never lets the tracks and their seams exceed the container", () => {
    // Two panes and one 10px seam in a 1000px row: the panes get 990px between them, not 1000.
    const sizes = resolveTrackSizes(1000, [0.5, 0.5], 10);
    expect(sizes).toEqual([495, 495]);
    expect(sizes.reduce((sum, value) => sum + value, 0) + 10).toBe(1000);
  });
});

describe("resolveTrackSizes — minimum", () => {
  it("keeps a track visible when its stored fraction has collapsed", () => {
    // 2% of 1000px is 20px: a pane that thin is a sliver nobody can use or grab.
    const sizes = resolveTrackSizes(1010, [0.98, 0.02], 10, 160);
    expect(sizes[1]).toBe(160);
    // The space has to come from its neighbour, and the row must still add up exactly.
    expect(sizes[0]).toBe(840);
    expect(sizes[0] + sizes[1] + 10).toBe(1010);
  });
});

describe("trackDragDelta", () => {
  it("reports how far the seam moved, measured against the space the tracks actually share", () => {
    // Row is 1010px with one 10px seam, so the tracks share 1000px. Dragging the first track
    // from 500 to 600 is +100 — and the container the engine must divide by is 1000, not 1010.
    expect(trackDragDelta({ currentSize: 500, nextSize: 600, containerSize: 1010, trackCount: 2, seamSize: 10 }))
      .toEqual({ deltaPx: 100, containerSize: 1000 });
  });
});
