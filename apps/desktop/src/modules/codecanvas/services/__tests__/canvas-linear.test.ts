import { describe, expect, it } from "vitest";
import { elbowRoute, updatePoint, insertPointAt, arrowGeometryFromDrag, type Pt } from "../canvas-linear";

describe("arrowGeometryFromDrag", () => {
  const box = { x: 10, y: 10, w: 100, h: 60 };

  it("grows the box when an endpoint is dragged beyond it, keeping the other anchored", () => {
    const r = arrowGeometryFromDrag([[0, 0], [1, 1]], box, 1, { x: 210, y: 70 });
    expect(r.position).toEqual({ x: 10, y: 10 });
    expect(r.size).toEqual({ w: 200, h: 60 });
    expect(r.points).toEqual([[0, 0], [1, 1]]);
  });

  it("moves the origin when an endpoint is dragged up/left past the other", () => {
    const r = arrowGeometryFromDrag([[0, 0], [1, 1]], box, 0, { x: 10, y: -30 });
    expect(r.position).toEqual({ x: 10, y: -30 });
    expect(r.size).toEqual({ w: 100, h: 100 });
    expect(r.points).toEqual([[0, 0], [1, 1]]);
  });

  it("bends a 3-point arrow when the middle point is dragged out of the box (box grows up)", () => {
    // straight arrow with a center midpoint; drag midpoint above the box
    const r = arrowGeometryFromDrag([[0, 1], [0.5, 1], [1, 1]], box, 1, { x: 60, y: -10 });
    expect(r.position.y).toBe(-10); // box top rises to the dragged midpoint
    expect(r.points[1][1]).toBe(0); // midpoint now at the very top
  });

  it("floors a degenerate (zero-length) drag to a minimum box without NaNs", () => {
    const r = arrowGeometryFromDrag([[0, 0], [1, 1]], box, 1, { x: 10, y: 10 }, 2);
    expect(r.size.w).toBeGreaterThanOrEqual(2);
    expect(r.size.h).toBeGreaterThanOrEqual(2);
    expect(r.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });
});

describe("updatePoint", () => {
  it("replaces one point, clamping to the 0..1 box", () => {
    expect(updatePoint([[0, 0], [1, 1]], 1, [0.5, 0.5])).toEqual([[0, 0], [0.5, 0.5]]);
    expect(updatePoint([[0, 0], [1, 1]], 0, [-0.4, 1.7])).toEqual([[0, 1], [1, 1]]); // clamped to box edges
  });

  it("leaves the array unchanged for an out-of-range index", () => {
    expect(updatePoint([[0, 0], [1, 1]], 5, [0.5, 0.5])).toEqual([[0, 0], [1, 1]]);
  });
});

describe("insertPointAt", () => {
  it("inserts a point into the nearest segment, preserving order", () => {
    expect(insertPointAt([[0, 0], [1, 0]], [0.5, 0.2])).toEqual([[0, 0], [0.5, 0.2], [1, 0]]);
  });

  it("chooses the closer of multiple segments", () => {
    // closest to the second segment (0.5,0)→(1,0)
    expect(insertPointAt([[0, 0], [0.5, 0], [1, 0]], [0.75, 0.05])).toEqual([[0, 0], [0.5, 0], [0.75, 0.05], [1, 0]]);
  });
});

describe("elbowRoute", () => {
  it("turns a diagonal 2-point connector into an L (horizontal then vertical)", () => {
    expect(elbowRoute([[0, 0], [100, 60]])).toEqual([[0, 0], [100, 0], [100, 60]]);
  });

  it("leaves an axis-aligned segment unbent", () => {
    expect(elbowRoute([[0, 20], [100, 20]])).toEqual([[0, 20], [100, 20]]); // horizontal only
    expect(elbowRoute([[10, 0], [10, 80]])).toEqual([[10, 0], [10, 80]]); // vertical only
  });

  it("routes each leg of a multi-point path orthogonally", () => {
    const route = elbowRoute([[0, 0], [50, 50], [100, 20]] as Pt[]);
    // every consecutive pair shares an x or a y (no diagonals)
    for (let i = 1; i < route.length; i += 1) {
      const a = route[i - 1];
      const b = route[i];
      expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
    }
  });

  it("returns the input unchanged when there are fewer than two points", () => {
    expect(elbowRoute([[5, 5]])).toEqual([[5, 5]]);
  });
});
