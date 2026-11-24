import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { captureShapeSnapshot, restoreMemberGeometry, shapeSnapshotsEqual } from "../canvas-shape-history";

/** HIGH #3: history restored Frames but not their window members, so ⌘Z split a Frame from what it holds. */
const frame = (id: string, x: number): Node => ({ id, type: "frame", position: { x, y: 0 }, width: 400, height: 300, data: { title: id } });
const win = (id: string, x: number, frameId?: string, w = 300): Node => ({
  id, type: "terminal", position: { x, y: 0 }, width: w, height: 200, style: { width: w, height: 200 }, data: frameId ? { frameId } : {},
});

describe("Frame members ride the undo history", () => {
  it("REGRESSION: a Frame drag (Frame and member moved) is a change to history", () => {
    const before = captureShapeSnapshot([frame("f", 0), win("m", 0, "f")], []);
    const after = captureShapeSnapshot([frame("f", 100), win("m", 100, "f")], []);
    expect(shapeSnapshotsEqual(before, after)).toBe(false);
  });
  it("REGRESSION: restoring puts members back with their Frame, size included", () => {
    const before = captureShapeSnapshot([frame("f", 0), win("m", 0, "f")], []);
    const now = [frame("f", 100), win("m", 100, "f", 500)];
    const out = restoreMemberGeometry(now, before.geometry);
    const m = out.find((n) => n.id === "m")!;
    expect(m.position).toEqual({ x: 0, y: 0 });
    expect(m.width).toBe(300);
    expect((m.style as { width?: number }).width).toBe(300);
  });
  it("loose windows and windows created since are not touched", () => {
    const before = captureShapeSnapshot([frame("f", 0), win("loose", 0)], []);
    const now = [frame("f", 0), win("loose", 900), win("new", 50, "f")];
    const out = restoreMemberGeometry(now, before.geometry);
    expect(out.find((n) => n.id === "loose")!.position.x).toBe(900);
    expect(out.find((n) => n.id === "new")!.position.x).toBe(50);
  });
  it("a member that only exists in one snapshot (spawn, close) is not a step", () => {
    const f = frame("f", 0); // one object: history compares Frame data by identity
    const a = captureShapeSnapshot([f, win("m", 0, "f")], []);
    const b = captureShapeSnapshot([f, win("m", 0, "f"), win("n", 400, "f")], []);
    expect(shapeSnapshotsEqual(a, b)).toBe(true);
  });
});
