import { describe, it, expect } from "vitest";
import type { Node } from "@xyflow/react";
import { arrangeCanvasNodes } from "../canvas-arrange";

// Frames are blocks (LOT2-126): a Frame and its members move together, members are arranged inside it.

const node = (id: string, extra: Partial<Node> = {}): Node => ({ id, position: { x: 0, y: 0 }, data: {}, ...extra });
const frame = (id: string, x: number, y: number, w = 900, h = 700): Node =>
  node(id, { type: "frame", width: w, height: h, position: { x, y }, data: { title: id } });
const member = (id: string, frameId: string, x: number, y: number, type = "agent"): Node =>
  node(id, { type, width: 500, height: 400, position: { x, y }, data: { frameId } });

type Box = { x: number; y: number; width: number; height: number };
const inside = (b: Box, f: Box) =>
  b.x >= f.x && b.y >= f.y && b.x + b.width <= f.x + f.width && b.y + b.height <= f.y + f.height;
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

describe("arrangeCanvasNodes: Frames as blocks", () => {
  it("boxes the Frame around its arranged members instead of tiling it as a window", () => {
    const boxes = arrangeCanvasNodes([frame("F", 0, 0), member("a", "F", 40, 80), member("b", "F", 600, 80)]);
    expect(boxes.has("F")).toBe(true);
    expect(inside(boxes.get("a")!, boxes.get("F")!)).toBe(true);
    expect(inside(boxes.get("b")!, boxes.get("F")!)).toBe(true);
  });

  it("arranges members inside the Frame without overlap", () => {
    const boxes = arrangeCanvasNodes([
      frame("F", 0, 0), member("a", "F", 40, 80), member("b", "F", 60, 90), member("c", "F", 80, 100),
    ]);
    const [a, b, c] = ["a", "b", "c"].map((id) => boxes.get(id)!);
    expect(overlap(a, b) || overlap(a, c) || overlap(b, c)).toBe(false);
    for (const m of [a, b, c]) expect(inside(m, boxes.get("F")!)).toBe(true);
  });

  it("keeps loose nodes out of every Frame box and Frames apart from each other", () => {
    const boxes = arrangeCanvasNodes([
      frame("F1", 0, 0), member("a", "F1", 40, 80), member("b", "F1", 600, 80),
      frame("F2", 2000, 0), member("c", "F2", 2040, 80),
      node("loose1", { type: "agent", width: 500, height: 400, position: { x: 0, y: 1500 } }),
      node("loose2", { type: "terminal", width: 500, height: 400, position: { x: 600, y: 1500 } }),
    ]);
    for (const l of ["loose1", "loose2"]) {
      for (const f of ["F1", "F2"]) expect(overlap(boxes.get(l)!, boxes.get(f)!)).toBe(false);
    }
    expect(overlap(boxes.get("F1")!, boxes.get("F2")!)).toBe(false);
  });

  it("arranges loose nodes exactly as before when Frames exist", () => {
    const fit = { width: 1892, height: 1018 };
    const loose = Array.from({ length: 4 }, (_, i) =>
      node(`t${i}`, { type: "agent", width: 760, height: 520, position: { x: i * 10, y: 0 } }));
    const alone = arrangeCanvasNodes(loose, { fit });
    const withFrame = arrangeCanvasNodes([...loose, frame("F", 5000, 5000), member("m", "F", 5040, 5080)], { fit });
    for (const l of loose) expect(withFrame.get(l.id)).toEqual(alone.get(l.id));
  });

  it("moves a shape member with its Frame, keeping its offset and size", () => {
    const shape = node("s", { type: "shape", width: 120, height: 60, position: { x: 100, y: 150 }, data: { frameId: "F" } });
    const boxes = arrangeCanvasNodes([frame("F", 50, 50), member("a", "F", 90, 130), shape]);
    const f = boxes.get("F")!;
    const s = boxes.get("s")!;
    expect(s.x - f.x).toBe(50);
    expect(s.y - f.y).toBe(100);
    expect([s.width, s.height]).toEqual([120, 60]);
    expect(inside(s, f)).toBe(true);
  });

  it("moves a Frame holding only shapes as one rigid block", () => {
    const s1 = node("s1", { type: "shape", width: 100, height: 50, position: { x: 20, y: 60 }, data: { frameId: "F" } });
    const s2 = node("s2", { type: "shape", width: 100, height: 50, position: { x: 300, y: 200 }, data: { frameId: "F" } });
    const boxes = arrangeCanvasNodes([frame("F", 10, 10, 500, 400), s1, s2]);
    const f = boxes.get("F")!;
    expect([f.width, f.height]).toEqual([500, 400]);
    expect(boxes.get("s2")!.x - boxes.get("s1")!.x).toBe(280);
    expect(boxes.get("s2")!.y - boxes.get("s1")!.y).toBe(140);
  });

  it("still leaves free-form shapes alone when there are no Frames", () => {
    const boxes = arrangeCanvasNodes([node("s", { type: "shape" }), node("a", { type: "agent" })]);
    expect(boxes.has("s")).toBe(false);
  });

  it("treats a member whose Frame no longer exists as a loose node", () => {
    const boxes = arrangeCanvasNodes([member("a", "ghost", 0, 0), frame("F", 0, 0)]);
    expect(boxes.has("a")).toBe(true);
  });
});
