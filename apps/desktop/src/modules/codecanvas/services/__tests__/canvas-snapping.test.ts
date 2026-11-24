import { describe, expect, it } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import { snapMovingBox, snapDragChanges, snapGapMovingBox } from "../canvas-snapping";

const box = (x: number, y: number, w = 50, h = 50) => ({ x, y, w, h });

describe("snapMovingBox", () => {
  it("snaps left edge to a peer's left edge within the threshold, with a vertical guide spanning both", () => {
    const { dx, dy, guides } = snapMovingBox(box(103, 0), [box(100, 100)], 6);
    expect(dx).toBe(-3);
    expect(dy).toBe(0);
    expect(guides).toContainEqual({ orientation: "v", at: 100, from: 0, to: 150 });
  });

  it("snaps centers to centers", () => {
    // moving center x = 25; peer center x = 30
    const { dx } = snapMovingBox(box(0, 200), [box(5, 0)], 6);
    expect(dx).toBe(5);
  });

  it("snaps a right edge to a peer's left edge (adjacent alignment)", () => {
    // moving right = 53; peer left = 50
    const { dx } = snapMovingBox(box(3, 200), [box(50, 0)], 6);
    expect(dx).toBe(-3);
  });

  it("does not snap beyond the threshold", () => {
    const { dx, dy, guides } = snapMovingBox(box(110, 210), [box(100, 100)], 6);
    expect(dx).toBe(0);
    expect(dy).toBe(0);
    expect(guides).toEqual([]);
  });

  it("prefers the nearest candidate", () => {
    const { dx } = snapMovingBox(box(104, 0), [box(100, 100), box(102, 200)], 6);
    expect(dx).toBe(-2); // 102 is nearer than 100
  });

  it("snaps both axes independently", () => {
    const { dx, dy, guides } = snapMovingBox(box(103, 204), [box(100, 200)], 6);
    expect(dx).toBe(-3);
    expect(dy).toBe(-4);
    expect(guides.map((g) => g.orientation).sort()).toEqual(["h", "v"]);
  });
});

describe("snapDragChanges", () => {
  const shapeNode = (id: string, x: number, y: number): Node => ({
    id, type: "shape", position: { x, y }, width: 50, height: 50, data: { shape: "rectangle" } });
  const dragChange = (id: string, x: number, y: number, dragging = true): NodeChange => ({
    type: "position", id, position: { x, y }, dragging });

  it("snaps a single dragged shape against its shape peers and reports the guides", () => {
    const nodes = [shapeNode("a", 0, 0), shapeNode("peer", 100, 100)];
    const { changes, guides } = snapDragChanges([dragChange("a", 103, 0)], nodes, 6);
    const c = changes[0] as { position: { x: number; y: number } };
    expect(c.position).toEqual({ x: 100, y: 0 });
    expect(guides.length).toBeGreaterThan(0);
  });

  it("never snaps to non-shape nodes (terminals are not whiteboard peers)", () => {
    const nodes: Node[] = [shapeNode("a", 0, 0), { id: "t", type: "terminal", position: { x: 100, y: 100 }, width: 50, height: 50, data: {} }];
    const { changes, guides } = snapDragChanges([dragChange("a", 103, 0)], nodes, 6);
    expect((changes[0] as { position: { x: number } }).position.x).toBe(103);
    expect(guides).toEqual([]);
  });

  it("leaves multi-selection drags untouched", () => {
    const nodes = [shapeNode("a", 0, 0), shapeNode("b", 0, 100), shapeNode("peer", 100, 200)];
    const input = [dragChange("a", 103, 0), dragChange("b", 103, 100)];
    const { changes, guides } = snapDragChanges(input, nodes, 6);
    expect(changes).toBe(input);
    expect(guides).toEqual([]);
  });

  it("snaps a Frame member like any shape (members move alone), but never a Frame itself", () => {
    const member: Node = { ...shapeNode("a", 0, 0), data: { shape: "rectangle", frameId: "f1" } };
    const frame: Node = { ...shapeNode("f1", 0, 300), type: "frame", data: { title: "Frame 1" } };
    const nodes = [member, frame, shapeNode("peer", 100, 100)];
    const snapped = snapDragChanges([dragChange("a", 103, 0)], nodes, 6);
    expect((snapped.changes[0] as { position: { x: number } }).position.x).toBe(100);
    const untouched = snapDragChanges([dragChange("f1", 103, 300)], nodes, 6);
    expect((untouched.changes[0] as { position: { x: number } }).position.x).toBe(103);
  });

  it("still snaps the drag-stop position (XYDrag's final change carries the raw coords) but clears the guides", () => {
    const nodes = [shapeNode("a", 0, 0), shapeNode("peer", 100, 100)];
    const { changes, guides } = snapDragChanges([dragChange("a", 103, 0, false)], nodes, 6);
    expect((changes[0] as { position: { x: number } }).position.x).toBe(100);
    expect(guides).toEqual([]);
  });

  it("passes non-drag changes through untouched", () => {
    const input: NodeChange[] = [{ type: "select", id: "a", selected: true }];
    const { changes } = snapDragChanges(input, [shapeNode("a", 0, 0)], 6);
    expect(changes).toBe(input);
  });
});

describe("snapGapMovingBox (equal-spacing / Figma gap snapping)", () => {
  // A and B sit on one row with a 20px gap: A(0..50), B(70..120), all 50×50 at y=0.
  const A = box(0, 0);
  const B = box(70, 0);

  it("extends a sequence to the right: snaps so the next gap repeats the A↔B gap", () => {
    // moving at x=143 → left edge should land at B.right + 20 = 140
    const { dx, dy, gaps } = snapGapMovingBox(box(143, 0), [A, B], 6);
    expect(dx).toBe(-3);
    expect(dy).toBe(0);
    // two gap segments: between A and B, and between B and the snapped moving box
    expect(gaps).toContainEqual({ orientation: "h", start: 50, end: 70, cross: 25 });
    expect(gaps).toContainEqual({ orientation: "h", start: 120, end: 140, cross: 25 });
  });

  it("extends a sequence to the left symmetrically", () => {
    // moving right edge should land at A.left - 20 → x = -70 - 50... A(0..50): target right = -20, x = -70
    const { dx } = snapGapMovingBox(box(-67, 0), [A, B], 6);
    expect(dx).toBe(-3);
  });

  it("centers between two peers so both gaps become equal", () => {
    // A(0..50), C(200..250): free span 50..200 (150 wide), moving w=50 → target x=100 (gaps 50/50)
    const C = box(200, 0);
    const { dx, gaps } = snapGapMovingBox(box(103, 0), [A, C], 6);
    expect(dx).toBe(-3);
    expect(gaps).toContainEqual({ orientation: "h", start: 50, end: 100, cross: 25 });
    expect(gaps).toContainEqual({ orientation: "h", start: 150, end: 200, cross: 25 });
  });

  it("requires the peers to overlap the moving box on the cross axis", () => {
    const farA = box(0, 500);
    const farB = box(70, 500);
    const { dx, gaps } = snapGapMovingBox(box(143, 0), [farA, farB], 6);
    expect(dx).toBe(0);
    expect(gaps).toEqual([]);
  });

  it("does not snap beyond the threshold", () => {
    const { dx, gaps } = snapGapMovingBox(box(160, 0), [A, B], 6);
    expect(dx).toBe(0);
    expect(gaps).toEqual([]);
  });

  it("repeats vertical gaps on the y axis", () => {
    // stacked column: A(0..50), B(70..120) vertically, moving below at y=143 → snap to 140
    const topA = box(0, 0);
    const topB = box(0, 70);
    const { dy, gaps } = snapGapMovingBox(box(0, 143), [topA, topB], 6);
    expect(dy).toBe(-3);
    expect(gaps.every((g) => g.orientation === "v")).toBe(true);
  });
});

describe("snapDragChanges — gap snapping integration", () => {
  const shapeNode = (id: string, x: number, y: number): Node => ({
    id, type: "shape", position: { x, y }, width: 50, height: 50, data: { shape: "rectangle" } });
  const dragChange = (id: string, x: number, y: number, dragging = true): NodeChange => ({
    type: "position", id, position: { x, y }, dragging });

  it("falls back to gap snapping on an axis with no edge alignment", () => {
    // row: A(0,0), B(70,0) — dragging m at x=143 (no edge stop nearby), y=4 (edge-snaps to 0)
    const nodes = [shapeNode("m", 0, 300), shapeNode("A", 0, 0), shapeNode("B", 70, 0)];
    const { changes, gaps } = snapDragChanges([dragChange("m", 143, 4)], nodes, 6);
    const pos = (changes[0] as { position: { x: number; y: number } }).position;
    expect(pos).toEqual({ x: 140, y: 0 }); // x from the repeated 20px gap, y from edge alignment
    expect(gaps.length).toBe(2);
    expect(gaps.every((g) => g.orientation === "h")).toBe(true);
  });

  it("clears gap guides on the drag-stop change while still snapping the position", () => {
    const nodes = [shapeNode("m", 0, 300), shapeNode("A", 0, 0), shapeNode("B", 70, 0)];
    const { changes, gaps } = snapDragChanges([dragChange("m", 143, 0, false)], nodes, 6);
    expect((changes[0] as { position: { x: number } }).position.x).toBe(140);
    expect(gaps).toEqual([]);
  });
});

describe("snapDragChanges — rotated shapes", () => {
  const shapeNode = (id: string, x: number, y: number, angle?: number): Node => ({
    id, type: "shape", position: { x, y }, width: 50, height: 50,
    data: { shape: "rectangle", ...(angle !== undefined ? { angle } : {}) } });
  const dragChange = (id: string, x: number, y: number): NodeChange => ({
    type: "position", id, position: { x, y }, dragging: true });

  it("never snaps a rotated shape (its bbox no longer matches its visual edges)", () => {
    const nodes = [shapeNode("a", 0, 0, 30), shapeNode("peer", 100, 100)];
    const { changes, guides } = snapDragChanges([dragChange("a", 103, 0)], nodes, 6);
    expect((changes[0] as { position: { x: number } }).position.x).toBe(103);
    expect(guides).toEqual([]);
  });

  it("never snaps TO a rotated peer", () => {
    const nodes = [shapeNode("a", 0, 0), shapeNode("peer", 100, 100, 30)];
    const { changes, guides } = snapDragChanges([dragChange("a", 103, 0)], nodes, 6);
    expect((changes[0] as { position: { x: number } }).position.x).toBe(103);
    expect(guides).toEqual([]);
  });
});
