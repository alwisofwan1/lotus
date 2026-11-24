import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { arrangeNodeSet } from "../canvas-arrange";
import { frameOccupiedBox } from "../canvas-frame-geometry";
import {
  FRAME_GRID_GAP_X,
  FRAME_GRID_GAP_Y,
  frameGridDims,
  frameGridLayout,
  overviewFullDetail,
  renumberAutoFrameTitles,
  swapFramesInOrder,
} from "../canvas-frame-grid";
import { boxesOverlap } from "../canvas-frame-space";
import { frameIdOf, framesInOrder } from "../canvas-frames";

const SLOT = { width: 1200, height: 700 };
const frame = (id: string, x = 0, y = 0, w = 400, h = 300): Node => ({
  id, type: "frame", position: { x, y }, width: w, height: h, data: { title: id },
});
const win = (id: string, frameId: string | undefined, x = 0, y = 0): Node => ({
  id, type: "terminal", position: { x, y }, width: 500, height: 400, data: frameId ? { frameId } : {},
});
const shape = (id: string, frameId: string, x: number, y: number): Node => ({
  id, type: "shape", position: { x, y }, width: 80, height: 40, data: { frameId },
});
const boxOf = (l: NonNullable<ReturnType<typeof frameGridLayout>>, id: string) => l.boxes.get(id)!;

describe("frameGridDims (decision 43)", () => {
  it("1 -> 1 col, 2 -> 2 cols x 1 row, 3-4 -> 2x2, more continue in 2 columns", () => {
    expect(frameGridDims(1)).toEqual({ cols: 1, rows: 1 });
    expect(frameGridDims(2)).toEqual({ cols: 2, rows: 1 });
    expect(frameGridDims(3)).toEqual({ cols: 2, rows: 2 });
    expect(frameGridDims(4)).toEqual({ cols: 2, rows: 2 });
    expect(frameGridDims(5)).toEqual({ cols: 2, rows: 3 });
    expect(frameGridDims(7)).toEqual({ cols: 2, rows: 4 });
  });
});

describe("frameGridLayout", () => {
  it("is null without Frames", () => {
    expect(frameGridLayout([win("a", undefined)], SLOT)).toBeNull();
  });

  it("puts 01 top-left, 02 top-right, 03 bottom-left, 04 bottom-right in equal slots", () => {
    const nodes = ["a", "b", "c", "d"].map((id, i) => frame(id, i * 50, i * 20));
    const l = frameGridLayout(nodes, SLOT)!;
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => boxOf(l, id));
    expect(b.x - a.x).toBe(SLOT.width + FRAME_GRID_GAP_X);
    expect(b.y).toBe(a.y);
    expect(c.x).toBe(a.x);
    expect(c.y - a.y).toBe(SLOT.height + FRAME_GRID_GAP_Y);
    expect(d).toMatchObject({ x: b.x, y: c.y });
    expect(l.slots).toHaveLength(4);
  });

  it("one Frame uses one slot; two Frames sit side by side", () => {
    const one = frameGridLayout([frame("a")], SLOT)!;
    expect(one.slots).toHaveLength(1);
    const two = frameGridLayout([frame("a"), frame("b")], SLOT)!;
    expect(boxOf(two, "a").y).toBe(boxOf(two, "b").y);
    expect(boxOf(two, "b").x).toBeGreaterThan(boxOf(two, "a").x);
  });

  it("5 Frames continue the grid: 05 starts a third row in column 1", () => {
    const nodes = ["a", "b", "c", "d", "e"].map((id) => frame(id));
    const l = frameGridLayout(nodes, SLOT)!;
    expect(boxOf(l, "e").x).toBe(boxOf(l, "a").x);
    expect(boxOf(l, "e").y - boxOf(l, "a").y).toBe(2 * (SLOT.height + FRAME_GRID_GAP_Y));
  });

  it("anchors at the top-left of the existing Frames and is idempotent", () => {
    const nodes = [frame("a", 300, 500), frame("b", 2000, 900)];
    const l = frameGridLayout(nodes, SLOT)!;
    expect(boxOf(l, "a")).toMatchObject({ x: 300, y: 500 });
    const moved = nodes.map((n) => {
      const b = l.boxes.get(n.id)!;
      return { ...n, position: { x: b.x, y: b.y }, width: b.width, height: b.height };
    });
    const again = frameGridLayout(moved, SLOT)!;
    for (const [id, b] of l.boxes) expect(again.boxes.get(id)).toEqual(b);
  });

  it("tiles members with the SAME rule as focus, so focusing never reshapes", () => {
    const members = [win("m1", "a"), win("m2", "a"), win("m3", "a")];
    const l = frameGridLayout([frame("a", 100, 100), ...members], SLOT)!;
    const expected = arrangeNodeSet(members, { fit: SLOT });
    let gx = Infinity;
    let gy = Infinity;
    for (const b of expected.values()) {
      gx = Math.min(gx, b.x);
      gy = Math.min(gy, b.y);
    }
    for (const [id, b] of expected) {
      expect(boxOf(l, id)).toEqual({ x: b.x - gx + 100, y: b.y - gy + 100, width: b.width, height: b.height });
    }
    expect(boxOf(l, "a")).toMatchObject({ x: 100, y: 100 });
  });

  it("the Frame box covers its members and slots never overlap, header strips included", () => {
    const nodes = [
      frame("a"), win("a1", "a"), win("a2", "a"),
      frame("b"), win("b1", "b"),
      frame("c"), frame("d"), win("d1", "d"), win("d2", "d"), win("d3", "d"), win("d4", "d"),
    ];
    const l = frameGridLayout(nodes, SLOT)!;
    for (const id of ["a1", "a2", "b1", "d1", "d4"]) {
      const m = boxOf(l, id);
      const owner = boxOf(l, frameIdOf(nodes.find((n) => n.id === id)!)!);
      expect(m.x).toBeGreaterThanOrEqual(owner.x);
      expect(m.y).toBeGreaterThanOrEqual(owner.y);
      expect(m.x + m.width).toBeLessThanOrEqual(owner.x + owner.width + 0.001);
      expect(m.y + m.height).toBeLessThanOrEqual(owner.y + owner.height + 0.001);
    }
    const occupied = framesInOrder(nodes).map((f) => {
      const b = boxOf(l, f.id);
      return frameOccupiedBox({ x: b.x, y: b.y, w: b.width, h: b.height });
    });
    for (let i = 0; i < occupied.length; i++) {
      for (let j = i + 1; j < occupied.length; j++) expect(boxesOverlap(occupied[i], occupied[j])).toBe(false);
    }
  });

  it("a Frame with more members than fit the slot widens its slot instead of overlapping a neighbour", () => {
    const many = Array.from({ length: 30 }, (_, i) => win(`m${i}`, "a"));
    const nodes = [frame("a"), ...many, frame("b"), frame("c")];
    const l = frameGridLayout(nodes, SLOT)!;
    const occupied = ["a", "b", "c"].map((id) => {
      const b = boxOf(l, id);
      return frameOccupiedBox({ x: b.x, y: b.y, w: b.width, h: b.height });
    });
    for (let i = 0; i < occupied.length; i++) {
      for (let j = i + 1; j < occupied.length; j++) expect(boxesOverlap(occupied[i], occupied[j])).toBe(false);
    }
  });

  it("an empty Frame fills its slot", () => {
    const l = frameGridLayout([frame("a", 0, 0, 160, 100)], SLOT)!;
    expect(boxOf(l, "a")).toMatchObject({ width: SLOT.width, height: SLOT.height });
  });

  it("shape members travel with their Frame and keep their size; loose nodes are never touched", () => {
    const nodes = [frame("a", 0, 0), frame("b", 600, 0), shape("s", "b", 650, 50), win("loose", undefined, 5000, 5000)];
    const l = frameGridLayout(nodes, SLOT)!;
    const dx = boxOf(l, "b").x - 600;
    const dy = boxOf(l, "b").y - 0;
    expect(boxOf(l, "s")).toEqual({ x: 650 + dx, y: 50 + dy, width: 80, height: 40 });
    expect(l.boxes.has("loose")).toBe(false);
  });

  it("bounds cover every slot plus header room above, for the Overview camera", () => {
    const l = frameGridLayout([frame("a", 0, 0), frame("b"), frame("c")], SLOT)!;
    expect(l.bounds.width).toBe(2 * SLOT.width + FRAME_GRID_GAP_X);
    expect(l.bounds.minY).toBeLessThan(0);
    expect(l.bounds.height).toBeGreaterThan(2 * SLOT.height + FRAME_GRID_GAP_Y);
  });
});

describe("swapFramesInOrder (decision 43: chip numbers follow)", () => {
  const board = [frame("a"), win("a1", "a"), frame("b"), win("b1", "b"), frame("c"), win("c1", "c"), shape("sh", "b", 0, 0)];
  const order = (ns: Node[]) => framesInOrder(ns).map((f) => f.id);

  it("exchanges two Frames' numbers, adjacent or not", () => {
    expect(order(swapFramesInOrder(board, "a", "b"))).toEqual(["b", "a", "c"]);
    expect(order(swapFramesInOrder(board, "a", "c"))).toEqual(["c", "b", "a"]);
  });

  it("keeps every Frame before its members and loses no node", () => {
    for (const [x, y] of [["a", "b"], ["a", "c"], ["b", "c"]]) {
      const next = swapFramesInOrder(board, x, y);
      expect(next.map((n) => n.id).sort()).toEqual(board.map((n) => n.id).sort());
      for (const n of next) {
        const fid = frameIdOf(n);
        if (fid) expect(next.findIndex((m) => m.id === fid)).toBeLessThan(next.indexOf(n));
      }
    }
  });

  it("is a no-op for an unknown id or the same Frame", () => {
    expect(swapFramesInOrder(board, "a", "a")).toBe(board);
    expect(swapFramesInOrder(board, "a", "zzz")).toBe(board);
  });
});

describe("overviewFullDetail (decision 44)", () => {
  const frames = [frame("a")];
  it("full detail up to 16 window nodes in total", () => {
    const ws = (n: number) => Array.from({ length: n }, (_, i) => win(`w${i}`, "a"));
    expect(overviewFullDetail([...frames, ...ws(16)])).toBe(true);
    expect(overviewFullDetail([...frames, ...ws(17)])).toBe(false);
  });
  it("shapes and Frames do not count", () => {
    const shapes = Array.from({ length: 30 }, (_, i) => shape(`s${i}`, "a", 0, 0));
    expect(overviewFullDetail([...frames, ...shapes])).toBe(true);
  });
});

describe("renumberAutoFrameTitles (decision 46)", () => {
  const titled = (id: string, title: string): Node => ({ ...frame(id), data: { title } });
  it("auto-named Frames follow their chip number", () => {
    const out = renumberAutoFrameTitles([titled("a", "Frame 2"), titled("b", "Frame 1")]);
    expect(out.map((n) => n.data.title)).toEqual(["Frame 1", "Frame 2"]);
  });
  it("never touches a title the user typed", () => {
    const out = renumberAutoFrameTitles([titled("a", "Auth"), titled("b", "Frame 1")]);
    expect(out.map((n) => n.data.title)).toEqual(["Auth", "Frame 2"]);
  });
  it("returns the same array when nothing changes", () => {
    const nodes = [titled("a", "Frame 1"), titled("b", "Bugs")];
    expect(renumberAutoFrameTitles(nodes)).toBe(nodes);
  });
});
