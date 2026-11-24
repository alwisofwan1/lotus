import { describe, expect, it } from "vitest";
import { shapeHitTest } from "../canvas-erase";

describe("shapeHitTest", () => {
  const nodes = [
    { id: "a", position: { x: 0, y: 0 }, width: 100, height: 50 },
    { id: "b", position: { x: 200, y: 200 }, width: 80, height: 80 },
  ];

  it("returns ids of shapes whose bounding box contains the point", () => {
    expect(shapeHitTest(nodes, { x: 50, y: 25 })).toEqual(["a"]);
    expect(shapeHitTest(nodes, { x: 240, y: 240 })).toEqual(["b"]);
  });

  it("returns nothing when the point misses every shape", () => {
    expect(shapeHitTest(nodes, { x: 150, y: 150 })).toEqual([]);
  });

  it("returns all overlapping shapes under the point (topmost-last order preserved)", () => {
    const stacked = [
      { id: "lo", position: { x: 0, y: 0 }, width: 100, height: 100 },
      { id: "hi", position: { x: 10, y: 10 }, width: 50, height: 50 },
    ];
    expect(shapeHitTest(stacked, { x: 30, y: 30 })).toEqual(["lo", "hi"]);
  });

  it("skips unmeasured shapes (no width/height yet)", () => {
    expect(shapeHitTest([{ id: "x", position: { x: 0, y: 0 } }], { x: 5, y: 5 })).toEqual([]);
  });
});

describe("shapeHitTest — stroke-based hit for linear shapes", () => {
  // A diagonal line across a 100×100 box: points (0,0) → (1,1).
  const line = {
    id: "line",
    position: { x: 0, y: 0 },
    width: 100,
    height: 100,
    shape: "line" as const,
    points: [[0, 0], [1, 1]] as Array<[number, number]>,
  };

  it("does not erase a diagonal line from empty bbox corners far from the stroke", () => {
    expect(shapeHitTest([line], { x: 90, y: 10 })).toEqual([]);
    expect(shapeHitTest([line], { x: 10, y: 90 })).toEqual([]);
  });

  it("erases a diagonal line when the cursor is on or near the stroke", () => {
    expect(shapeHitTest([line], { x: 50, y: 50 })).toEqual(["line"]);
    expect(shapeHitTest([line], { x: 52, y: 47 })).toEqual(["line"]); // within tolerance
  });

  it("applies the same stroke rule to freehand draw trails", () => {
    const draw = { ...line, id: "draw", shape: "draw" as const, points: [[0, 1], [0.5, 0], [1, 1]] as Array<[number, number]> };
    expect(shapeHitTest([draw], { x: 50, y: 95 })).toEqual([]); // inside bbox, far below the V-stroke... at x=50 stroke y=0
    expect(shapeHitTest([draw], { x: 50, y: 2 })).toEqual(["draw"]);
  });

  it("keeps plain bbox hits for container shapes", () => {
    const rect = { id: "r", position: { x: 0, y: 0 }, width: 100, height: 100, shape: "rectangle" as const };
    expect(shapeHitTest([rect], { x: 90, y: 10 })).toEqual(["r"]);
  });

  it("falls back to bbox when a linear shape has no points", () => {
    const bare = { id: "l2", position: { x: 0, y: 0 }, width: 100, height: 100, shape: "line" as const };
    expect(shapeHitTest([bare], { x: 90, y: 10 })).toEqual(["l2"]);
  });
});
