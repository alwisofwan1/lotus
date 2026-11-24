import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import {
  cascadePosition,
  childPositionNear,
  childPositionRightOf,
  findNearestFreePosition,
  getNodeSize,
  isFreePosition,
  DEFAULT_SKILLS_SIZE,
} from "../canvas-node-placement";

function node(id: string, x: number, y: number, w: number, h: number, type = "note"): Node {
  return { id, type, position: { x, y }, width: w, height: h } as Node;
}

describe("cascadePosition", () => {
  it("offsets each new node by 40px from the canvas origin", () => {
    expect(cascadePosition(0)).toEqual({ x: 80, y: 80 });
    expect(cascadePosition(3)).toEqual({ x: 200, y: 200 });
  });
});

describe("getNodeSize", () => {
  it("prefers measured, then width/height, then style, then type fallback", () => {
    const measured = { id: "a", type: "note", position: { x: 0, y: 0 }, measured: { width: 11, height: 22 } } as Node;
    expect(getNodeSize(measured)).toEqual({ w: 11, h: 22 });
    expect(getNodeSize(node("b", 0, 0, 33, 44))).toEqual({ w: 33, h: 44 });
    const styled = { id: "c", type: "note", position: { x: 0, y: 0 }, style: { width: 55, height: 66 } } as Node;
    expect(getNodeSize(styled)).toEqual({ w: 55, h: 66 });
    const bare = { id: "d", type: "terminal", position: { x: 0, y: 0 } } as Node;
    expect(getNodeSize(bare)).toEqual({ w: 760, h: 520 });
  });

  it("falls back a shape node with no measured size to the default shape size", () => {
    const bareShape = { id: "sh", type: "shape", position: { x: 0, y: 0 } } as Node;
    expect(getNodeSize(bareShape)).toEqual({ w: 200, h: 140 });
  });
});

describe("childPositionRightOf", () => {
  it("places the child just past the parent's right edge when free", () => {
    const parent = node("p", 10, 20, 900, 360, "terminal");
    expect(childPositionRightOf(parent, DEFAULT_SKILLS_SIZE, [parent], 0)).toEqual({ x: 934, y: 20 });
  });

  it("falls back to a cascade slot when there is no parent", () => {
    const pos = childPositionRightOf(undefined, DEFAULT_SKILLS_SIZE, [], 2);
    expect(pos).toEqual({ x: 160, y: 160 });
  });

  it("finds a nearby free slot when the default spot is blocked", () => {
    const parent = node("p", 0, 0, 560, 360, "terminal");
    const blocker = node("blocker", 584, 0, 320, 460);
    const pos = childPositionRightOf(parent, DEFAULT_SKILLS_SIZE, [parent, blocker], 0);
    expect(pos).not.toEqual({ x: 584, y: 0 });
    expect(isFreePosition(pos, DEFAULT_SKILLS_SIZE, [parent, blocker])).toBe(true);
  });
});

describe("findNearestFreePosition", () => {
  it("returns the preferred point when nothing overlaps", () => {
    expect(findNearestFreePosition({ x: 5, y: 5 }, { w: 10, h: 10 }, [])).toEqual({ x: 5, y: 5 });
  });
});

describe("childPositionNear", () => {
  const parent = node("p", 0, 0, 760, 520, "terminal");
  const size = { w: 420, h: 520 };

  it("prefers the right-hand slot, like childPositionRightOf did", () => {
    expect(childPositionNear(parent, size, [parent], 0)).toEqual({ x: 784, y: 0 });
  });

  it("drops to the slot below when the right is taken", () => {
    const blocker = node("b", 784, 0, 420, 520);
    expect(childPositionNear(parent, size, [parent, blocker], 0)).toEqual({ x: 0, y: 544 });
  });

  it("tries the left side once right and below are taken", () => {
    const occupied = [parent, node("b", 784, 0, 420, 520), node("c", 0, 544, 420, 520)];
    expect(childPositionNear(parent, size, occupied, 0)).toEqual({ x: -444, y: 0 });
  });

  it("never parks the child further than the drift cap from its parent", () => {
    // Wall the parent in on every side and fill a wide band around it.
    const occupied: Node[] = [parent];
    for (let col = -6; col <= 6; col += 1) {
      for (let row = -6; row <= 6; row += 1) {
        occupied.push(node(`f${col}:${row}`, col * 460, row * 560, 420, 520));
      }
    }
    const placed = childPositionNear(parent, size, occupied, 0);

    expect(Math.abs(placed.x - 784)).toBeLessThanOrEqual(520);
    expect(Math.abs(placed.y - 0)).toBeLessThanOrEqual(520);
  });

  it("falls back to a cascade slot when there is no parent", () => {
    expect(childPositionNear(undefined, DEFAULT_SKILLS_SIZE, [], 2)).toEqual({ x: 160, y: 160 });
  });
});
