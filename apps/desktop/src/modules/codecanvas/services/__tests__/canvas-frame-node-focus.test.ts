import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { frameNodeFocusLayout } from "../canvas-frame-focus";
import { frameOccupiedBox } from "../canvas-frame-geometry";
import { boxesOverlap } from "../canvas-frame-space";

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, position: { x: 0, y: 0 }, data: {}, ...extra });
const frame = (id: string, x: number, y: number, w: number, h: number): Node =>
  node(id, { type: "frame", width: w, height: h, position: { x, y }, data: { title: id } });
const member = (id: string, frameId: string, x: number, y: number): Node =>
  node(id, { type: "agent", width: 500, height: 400, position: { x, y }, data: { frameId } });
type B = { x: number; y: number; width: number; height: number };
const asBox = (b: B) => ({ x: b.x, y: b.y, w: b.width, h: b.height });
const inside = (f: B, b: B) =>
  b.x >= f.x - 0.001 && b.y >= f.y - 0.001 && b.x + b.width <= f.x + f.width + 0.001 && b.y + b.height <= f.y + f.height + 0.001;

const AREA = { width: 1600, height: 900 };

describe("frameNodeFocusLayout (decision 41)", () => {
  const board = [
    frame("F", 100, 200, 1100, 440),
    member("a", "F", 100, 200),
    member("b", "F", 620, 200),
    member("c", "F", 100, 640),
    frame("G", 5000, 200, 600, 400),
    member("g1", "G", 5000, 200),
    node("loose", { type: "terminal", width: 500, height: 400, position: { x: 3000, y: 0 } }),
  ];

  it("moves only the hero's Frame and its window members", () => {
    const layout = frameNodeFocusLayout(board, "a", AREA)!;
    expect([...layout.boxes.keys()].sort()).toEqual(["F", "a", "b", "c"]);
  });

  it("puts the rail inside the Frame box, which hugs hero + rail and keeps its top-left", () => {
    const { boxes } = frameNodeFocusLayout(board, "a", AREA)!;
    const f = boxes.get("F")!;
    for (const id of ["a", "b", "c"]) expect(inside(f, boxes.get(id)!)).toBe(true);
    expect({ x: f.x, y: f.y }).toEqual({ x: 100, y: 200 });
    const hero = boxes.get("a")!;
    expect(boxes.get("b")!.x).toBeGreaterThan(hero.x + hero.width - 1);
    const right = Math.max(...["a", "b", "c"].map((id) => boxes.get(id)!.x + boxes.get(id)!.width));
    expect(f.x + f.width).toBeCloseTo(right, 5);
  });

  it("does not overlap another Frame", () => {
    const tight = [
      ...board.filter((n) => n.id !== "G" && n.id !== "g1"),
      frame("G", 1750, 200, 600, 400),
      member("g1", "G", 1750, 200),
    ];
    const { boxes } = frameNodeFocusLayout(tight, "a", AREA)!;
    expect(boxesOverlap(frameOccupiedBox(asBox(boxes.get("F")!)), frameOccupiedBox({ x: 1750, y: 200, w: 600, h: 400 }))).toBe(false);
    expect(inside(boxes.get("F")!, boxes.get("b")!)).toBe(true);
  });

  it("is null for a hero outside any Frame, or a Frame itself", () => {
    expect(frameNodeFocusLayout(board, "loose", AREA)).toBeNull();
    expect(frameNodeFocusLayout(board, "F", AREA)).toBeNull();
  });
});
