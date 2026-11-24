import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { frameIdOf, framesInOrder, MAX_FRAMES, tryCreateFrameFromSelection } from "../canvas-frames";
import { boxesOverlap, frameBoxOf } from "../canvas-frame-space";
import { frameOccupiedBox } from "../canvas-frame-geometry";

/**
 * Every canvas always has a Frame (decision 37), so a new Frame is almost always made from nodes that
 * already sit in one. Before 2026-10-15 the overlap check counted the members' own Frame and refused
 * every such create ("Frame bertumpuk dengan Frame 1"): ⌘G, NL "frame these", Frame Suggestion, task Frames.
 */
const win = (id: string, x: number, y: number, frameId?: string): Node => ({
  id, type: "terminal", position: { x, y }, width: 400, height: 300, data: frameId ? { frameId } : {},
});
const frame = (id: string, x: number, y: number, w: number, h: number, title = id): Node => ({
  id, type: "frame", position: { x, y }, width: w, height: h, style: { width: w, height: h }, data: { title },
});
// Frame 1 holds four windows in a 2×2 grid.
const board = (): Node[] => [
  frame("f1", 0, 0, 820, 620, "Frame 1"),
  win("a", 0, 0, "f1"), win("b", 420, 0, "f1"), win("c", 0, 320, "f1"), win("d", 420, 320, "f1"),
];

describe("tryCreateFrameFromSelection from members of another Frame", () => {
  it("REGRESSION: wrapping some members of Frame 1 is no longer refused, and they move to the new Frame", () => {
    const r = tryCreateFrameFromSelection(board(), ["a", "b"], "f2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byId = new Map(r.nodes.map((n) => [n.id, n]));
    expect(frameIdOf(byId.get("a")!)).toBe("f2");
    expect(frameIdOf(byId.get("b")!)).toBe("f2");
    expect(frameIdOf(byId.get("c")!)).toBe("f1");
    expect(framesInOrder(r.nodes).map((f) => f.id).sort()).toEqual(["f1", "f2"]);
  });

  it("the Frame they came from shrinks to the members it keeps", () => {
    const r = tryCreateFrameFromSelection(board(), ["a", "b"], "f2");
    if (!r.ok) throw new Error(r.message);
    const f1 = frameBoxOf(r.nodes.find((n) => n.id === "f1")!);
    expect(f1.y).toBeGreaterThanOrEqual(320);
    expect(f1.h).toBeLessThan(620);
  });

  it("wrapping every member of Frame 1 replaces it: no empty Frame is left on top of the new one", () => {
    const r = tryCreateFrameFromSelection(board(), ["a", "b", "c", "d"], "f2");
    if (!r.ok) throw new Error(r.message);
    expect(framesInOrder(r.nodes).map((f) => f.id)).toEqual(["f2"]);
  });

  it("a Frame it would replace does not count toward the Frame limit", () => {
    const others = Array.from({ length: MAX_FRAMES - 1 }, (_, i) => frame(`o${i}`, 2000 + i * 1000, 0, 400, 300));
    const r = tryCreateFrameFromSelection([...board(), ...others], ["a", "b", "c", "d"], "f2");
    expect(r.ok).toBe(true);
  });

  it("still refuses when the box would land on an unrelated Frame", () => {
    const nodes = [...board(), frame("f3", 300, 100, 300, 200, "Frame 3")];
    const r = tryCreateFrameFromSelection(nodes.filter((n) => n.id !== "f1").map((n) => ({ ...n, data: {} })), ["a", "b"], "f2");
    expect(r).toMatchObject({ ok: false, reason: "overlap" });
  });
});

describe("tryCreateFrameFromSelection with relocate (agent task Frames)", () => {
  it("REGRESSION: loose task cells lying under Frame 1 get a Frame in free space instead of a refusal", () => {
    const nodes = [...board(), win("t1", 80, 40), win("t2", 120, 80)];
    expect(tryCreateFrameFromSelection(nodes, ["t1", "t2"], "task")).toMatchObject({ ok: false, reason: "overlap" });
    const r = tryCreateFrameFromSelection(nodes, ["t1", "t2"], "task", { title: "Task", taskKey: "T-1", relocate: true });
    if (!r.ok) throw new Error(r.message);
    const task = frameOccupiedBox(frameBoxOf(r.nodes.find((n) => n.id === "task")!));
    const f1 = frameOccupiedBox(frameBoxOf(r.nodes.find((n) => n.id === "f1")!));
    expect(boxesOverlap(task, f1)).toBe(false);
    // The cells moved with their Frame, keeping their offset.
    const t1 = r.nodes.find((n) => n.id === "t1")!;
    const t2 = r.nodes.find((n) => n.id === "t2")!;
    expect(t2.position.x - t1.position.x).toBe(40);
    expect(t2.position.y - t1.position.y).toBe(40);
    expect(frameIdOf(t1)).toBe("task");
  });
});
