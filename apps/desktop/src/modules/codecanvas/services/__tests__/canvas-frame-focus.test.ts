import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { frameFocusLayout } from "../canvas-frame-focus";
import { FRAME_TAB_STRIP, frameOccupiedBox } from "../canvas-frame-geometry";
import { boxesOverlap } from "../canvas-frame-space";
import { frameBoundsInVisibleArea } from "../viewport/canvas-visible-frame";

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, position: { x: 0, y: 0 }, data: {}, ...extra });
const frame = (id: string, x: number, y: number, w: number, h: number): Node =>
  node(id, { type: "frame", width: w, height: h, position: { x, y }, data: { title: id } });
const member = (id: string, frameId: string, x: number, y: number): Node =>
  node(id, { type: "agent", width: 500, height: 400, position: { x, y }, data: { frameId } });
const asBox = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x, y: b.y, w: b.width, h: b.height });

const AREA = { width: 1600, height: 900 };

describe("frameFocusLayout (decision 35)", () => {
  const nodes = [
    frame("F", 100, 200, 1100, 440),
    member("a", "F", 100, 200),
    member("b", "F", 620, 200),
    node("loose", { type: "terminal", width: 500, height: 400, position: { x: 3000, y: 0 } }),
  ];

  it("resizes two side-by-side members so their bounds match the area aspect", () => {
    const layout = frameFocusLayout(nodes, "F", AREA)!;
    const a = layout.boxes.get("a")!;
    const b = layout.boxes.get("b")!;
    const w = Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x);
    const h = Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y);
    const ratio = w / h / (AREA.width / AREA.height);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it("the Frame box equals the member bounds and keeps its top-left", () => {
    const layout = frameFocusLayout(nodes, "F", AREA)!;
    const f = layout.boxes.get("F")!;
    expect({ x: f.x, y: f.y }).toEqual({ x: 100, y: 200 });
    const members = ["a", "b"].map((id) => layout.boxes.get(id)!);
    expect(f.x).toBe(Math.min(...members.map((m) => m.x)));
    expect(f.y).toBe(Math.min(...members.map((m) => m.y)));
    expect(f.x + f.width).toBe(Math.max(...members.map((m) => m.x + m.width)));
    expect(f.y + f.height).toBe(Math.max(...members.map((m) => m.y + m.height)));
  });

  it("never moves nodes that are not members", () => {
    expect(frameFocusLayout(nodes, "F", AREA)!.boxes.has("loose")).toBe(false);
  });

  it("camera fit is the arrange fit: the box fills the visible area edge to edge, no extra padding", () => {
    const f = frameFocusLayout(nodes, "F", AREA)!.boxes.get("F")!;
    const area = { left: 80, top: 60, ...AREA };
    const vp = frameBoundsInVisibleArea({ minX: f.x, minY: f.y, width: f.width, height: f.height }, area);
    expect(vp.zoom).toBeCloseTo(1, 5);
    expect(f.x * vp.zoom + vp.x).toBeCloseTo(area.left, 5);
    expect(f.y * vp.zoom + vp.y).toBeCloseTo(area.top, 5);
    expect(f.width * vp.zoom).toBeCloseTo(area.width, 5);
    expect(f.height * vp.zoom).toBeCloseTo(area.height, 5);
  });

  it("moves the Frame with its members to free space when the new box would hit another Frame", () => {
    const other = { x: 1750, y: 200, w: 600, h: 400 };
    const board = [...nodes, frame("G", other.x, other.y, other.w, other.h), member("g1", "G", 1750, 200)];
    const layout = frameFocusLayout(board, "F", AREA)!;
    const f = layout.boxes.get("F")!;
    expect(boxesOverlap(frameOccupiedBox(asBox(f)), frameOccupiedBox(other))).toBe(false);
    expect(layout.boxes.has("G")).toBe(false);
    expect(layout.boxes.has("g1")).toBe(false);
    const a = layout.boxes.get("a")!;
    expect({ x: a.x, y: a.y }).toEqual({ x: f.x, y: f.y });
  });

  it("keeps the Frame where it is when the new box clears the neighbour and its tab strip", () => {
    const board = [...nodes, frame("G", 100, 200 + 900 + FRAME_TAB_STRIP, 600, 400)];
    const f = frameFocusLayout(board, "F", AREA)!.boxes.get("F")!;
    expect({ x: f.x, y: f.y }).toEqual({ x: 100, y: 200 });
  });

  it("relocates when only the neighbour's tab strip would be hit", () => {
    const board = [...nodes, frame("G", 100, 200 + 900 + FRAME_TAB_STRIP - 10, 600, 400)];
    const f = frameFocusLayout(board, "F", AREA)!.boxes.get("F")!;
    expect({ x: f.x, y: f.y }).not.toEqual({ x: 100, y: 200 });
  });

  it("returns null for a Frame with no window members, or an unknown Frame", () => {
    expect(frameFocusLayout([frame("E", 0, 0, 400, 300)], "E", AREA)).toBeNull();
    expect(frameFocusLayout(nodes, "nope", AREA)).toBeNull();
  });
});
