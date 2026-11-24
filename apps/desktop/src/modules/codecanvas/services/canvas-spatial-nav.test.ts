import { describe, expect, it } from "vitest";
import { nearestNodeInDirection, stepInOrder, type SpatialRect } from "./canvas-spatial-nav";

const rects: SpatialRect[] = [
  { id: "a", x: 0, y: 0, width: 100, height: 100 },   // center 50,50
  { id: "b", x: 200, y: 0, width: 100, height: 100 },  // center 250,50 — right of a
  { id: "c", x: 0, y: 200, width: 100, height: 100 },  // center 50,250 — below a
];

describe("nearestNodeInDirection", () => {
  it("finds the neighbor in the requested direction", () => {
    expect(nearestNodeInDirection(rects, "a", "right")).toBe("b");
    expect(nearestNodeInDirection(rects, "a", "down")).toBe("c");
  });

  it("returns null when nothing lies that way, or the source is unknown", () => {
    expect(nearestNodeInDirection(rects, "a", "left")).toBeNull();
    expect(nearestNodeInDirection(rects, "a", "up")).toBeNull();
    expect(nearestNodeInDirection(rects, "missing", "right")).toBeNull();
  });

  it("prefers the node most directly in line over a closer but off-axis one", () => {
    const grid: SpatialRect[] = [
      { id: "src", x: 0, y: 0, width: 40, height: 40 },      // center 20,20
      { id: "inline", x: 300, y: 0, width: 40, height: 40 }, // center 320,20 — dead right
      { id: "diagonal", x: 200, y: 190, width: 40, height: 40 }, // center 220,210 — nearer but 45°+ down
    ];
    expect(nearestNodeInDirection(grid, "src", "right")).toBe("inline");
  });
});

describe("stepInOrder", () => {
  const ids = ["a", "b", "c"];
  it("cycles forward and backward, wrapping around", () => {
    expect(stepInOrder(ids, "a", 1)).toBe("b");
    expect(stepInOrder(ids, "c", 1)).toBe("a");
    expect(stepInOrder(ids, "a", -1)).toBe("c");
  });
  it("starts from the first (fwd) or last (back) when nothing is focused", () => {
    expect(stepInOrder(ids, null, 1)).toBe("a");
    expect(stepInOrder(ids, null, -1)).toBe("c");
    expect(stepInOrder([], null, 1)).toBeNull();
  });
});
