import { describe, expect, it } from "vitest";
import type { Node, NodeChange, NodePositionChange } from "@xyflow/react";
import { arrangeCanvasNodes } from "../canvas-arrange";
import { frameOccupiedBox } from "../canvas-frame-geometry";
import { frameGridLayout } from "../canvas-frame-grid";
import { boxesOverlap, frameBoxOf } from "../canvas-frame-space";
import { placeNewWindowNode } from "../canvas-frame-target";
import { clampFrameChanges, frameDragChanges, frameIdOf, framesInOrder, placeInTargetFrame } from "../canvas-frames";

const win = (id: string, x: number, y: number, frameId?: string): Node => ({
  id, type: "terminal", position: { x, y }, width: 400, height: 300, data: frameId ? { frameId } : {},
});
const frame = (id: string, x: number, y: number, w: number, h: number): Node => ({
  id, type: "frame", position: { x, y }, width: w, height: h, style: { width: w, height: h }, data: { title: id },
});
const occ = (n: Node) => frameOccupiedBox(frameBoxOf(n));
const xy = (n: Node) => ({ ...frameBoxOf(n) });
const byId = (nodes: Node[], id: string) => nodes.find((n) => n.id === id)!;

describe("a member joining a Frame never grows it into a neighbour", () => {
  it("REGRESSION: the grown Frame moves to free space, members and the newcomer with it", () => {
    // Frame A is full (two windows side by side), Frame B sits right below it.
    const nodes = [
      frame("A", 0, 0, 820, 300), win("a1", 0, 0, "A"), win("a2", 420, 0, "A"),
      frame("B", 0, 400, 820, 300), win("b1", 0, 400, "B"),
    ];
    const out = placeInTargetFrame(nodes, win("new", 0, 0), "A");
    const A = byId(out, "A");
    expect(boxesOverlap(occ(A), occ(byId(out, "B")))).toBe(false);
    const box = frameBoxOf(A);
    for (const id of ["a1", "a2", "new"]) {
      const m = frameBoxOf(byId(out, id));
      expect(m.x).toBeGreaterThanOrEqual(box.x);
      expect(m.y).toBeGreaterThanOrEqual(box.y);
      expect(m.x + m.w).toBeLessThanOrEqual(box.x + box.w);
      expect(m.y + m.h).toBeLessThanOrEqual(box.y + box.h);
    }
    expect(xy(byId(out, "B"))).toEqual(xy(byId(nodes, "B")));
  });
  it("a Frame that fits its newcomer does not move", () => {
    const nodes = [frame("A", 0, 0, 1300, 300), win("a1", 0, 0, "A"), frame("B", 0, 400, 820, 300)];
    const out = placeInTargetFrame(nodes, win("new", 0, 0), "A");
    expect(byId(out, "A").position).toEqual({ x: 0, y: 0 });
  });
});

describe("the next node after the last Frame was removed", () => {
  it("REGRESSION: wraps the windows left loose together with itself in Frame 1, instead of stranding them", () => {
    const nodes = [win("l1", 0, 0), win("l2", 500, 0)];
    const r = placeNewWindowNode(nodes, win("new", 1000, 0), { activeFrameId: null });
    expect(r.createdFrame).toBe(true);
    for (const id of ["l1", "l2", "new"]) expect(frameIdOf(byId(r.nodes, id))).toBe(r.frameId);
    expect(framesInOrder(r.nodes)).toHaveLength(1);
  });
});

describe("Frame Grid and loose windows", () => {
  it("REGRESSION: a loose window under a slot moves out below the grid instead of being covered", () => {
    const nodes = [frame("A", 0, 0, 400, 300), win("a1", 0, 0, "A"), frame("B", 2000, 0, 400, 300), win("loose", 1300, 100)];
    const layout = frameGridLayout(nodes, { width: 1200, height: 700 })!;
    const loose = layout.boxes.get("loose");
    expect(loose).toBeDefined();
    const looseBox = { x: loose!.x, y: loose!.y, w: loose!.width, h: loose!.height };
    for (const s of layout.slots) expect(boxesOverlap(looseBox, { x: s.x, y: s.y, w: s.width, h: s.height })).toBe(false);
  });
  it("a loose window clear of the grid is not touched", () => {
    const nodes = [frame("A", 0, 0, 400, 300), win("a1", 0, 0, "A"), win("far", 5000, 5000)];
    expect(frameGridLayout(nodes, { width: 1200, height: 700 })!.boxes.has("far")).toBe(false);
  });
});

describe("the agent arrange keeps the chip order", () => {
  it("REGRESSION: Frames are laid out in array (chip) order, not by position, so the next Grid snap does not reshuffle them", () => {
    // Chip 1 = B (first in the array) sits below chip 2 = A.
    const nodes = [frame("B", 0, 900, 400, 300), win("b1", 0, 900, "B"), frame("A", 0, 0, 400, 300), win("a1", 0, 0, "A")];
    const boxes = arrangeCanvasNodes(nodes, { fit: { width: 2000, height: 1000 } });
    const a = boxes.get("A")!;
    const b = boxes.get("B")!;
    expect(b.y < a.y || (b.y === a.y && b.x < a.x)).toBe(true);
  });
});

describe("releasing a Frame drag or resize (xyflow's final change carries the raw pointer)", () => {
  // A at x 0..400, B at x 500..900, same row.
  const board = (): Node[] => [frame("A", 0, 0, 400, 300), win("a1", 0, 0, "A"), frame("B", 500, 0, 400, 300)];
  const release = (x: number, y: number): NodeChange => ({ id: "A", type: "position", position: { x, y }, dragging: false } as NodeChange);

  it("REGRESSION: the release is clamped like the drag, so A never lands on B", () => {
    const [c] = clampFrameChanges(board(), [release(300, 0)]) as NodePositionChange[];
    expect(c.position!.x).toBeLessThanOrEqual(100);
  });
  it("REGRESSION: members follow the release too, by the clamped delta", () => {
    const nodes = board();
    const clamped = clampFrameChanges(nodes, [release(50, 0)]);
    const carried = frameDragChanges(nodes, clamped);
    expect(carried).toEqual([{ id: "a1", type: "position", position: { x: 50, y: 0 } }]);
  });
  it("a programmatic position change (no drag flag) passes through untouched", () => {
    const change = { id: "A", type: "position", position: { x: 300, y: 0 } } as NodeChange;
    expect(clampFrameChanges(board(), [change])).toEqual([change]);
    expect(frameDragChanges(board(), [change])).toEqual([]);
  });
  it("REGRESSION: the end of a resize is clamped too", () => {
    const end = { id: "A", type: "dimensions", dimensions: { width: 800, height: 300 }, resizing: false } as NodeChange;
    const [c] = clampFrameChanges(board(), [end]) as Array<Extract<NodeChange, { type: "dimensions" }>>;
    expect(c.dimensions!.width).toBeLessThanOrEqual(500);
  });
});
