import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { decideNewNodeFrame, isWindowNode, placeNewWindowNode, wrapLooseWindowsInFrame } from "../canvas-frame-target";
import { frameIdOf, frameMembers, framesInOrder, MAX_FRAMES } from "../canvas-frames";

const frame = (id: string, x = 0, y = 0, w = 1000, h = 700, title = id): Node => ({
  id, type: "frame", position: { x, y }, width: w, height: h, data: { title },
});
const term = (id: string, x = 0, y = 0, frameId?: string): Node => ({
  id, type: "terminal", position: { x, y }, width: 300, height: 200, data: frameId ? { frameId } : {},
});
const shape = (id: string): Node => ({ id, type: "shape", position: { x: 5, y: 5 }, width: 50, height: 50, data: {} });
const skills = (id: string): Node => ({ id, type: "skills", position: { x: 0, y: 0 }, width: 50, height: 50, data: {} });

describe("isWindowNode", () => {
  it("is true for windows, false for shapes, Frames and ephemeral skill nodes", () => {
    expect(isWindowNode(term("t"))).toBe(true);
    expect(isWindowNode(shape("s"))).toBe(false);
    expect(isWindowNode(frame("f"))).toBe(false);
    expect(isWindowNode(skills("k"))).toBe(false);
  });
});

describe("decideNewNodeFrame — the one function that picks a new node's Frame (decision 38)", () => {
  const board = [frame("a"), frame("b", 2000)];

  it("joins the active Frame by default", () => {
    expect(decideNewNodeFrame(board, term("n"), { activeFrameId: "b" })).toEqual({ kind: "join", frameId: "b" });
  });
  it("an explicit Frame wins over the active one", () => {
    expect(decideNewNodeFrame(board, term("n"), { activeFrameId: "b", explicitFrameId: "a" })).toEqual({ kind: "join", frameId: "a" });
  });
  it("a task spawn without an explicit Frame stays loose so the task grouping can decide", () => {
    expect(decideNewNodeFrame(board, term("n"), { activeFrameId: "b", hasTask: true })).toEqual({ kind: "loose" });
  });
  it("an explicit Frame still wins when a task is present", () => {
    expect(decideNewNodeFrame(board, term("n"), { activeFrameId: "b", hasTask: true, explicitFrameId: "a" })).toEqual({ kind: "join", frameId: "a" });
  });
  it("a stale active id falls back to the first Frame", () => {
    expect(decideNewNodeFrame(board, term("n"), { activeFrameId: "deleted" })).toEqual({ kind: "join", frameId: "a" });
    expect(decideNewNodeFrame(board, term("n"), { activeFrameId: null })).toEqual({ kind: "join", frameId: "a" });
  });
  it("an unknown explicit Frame falls back to the active one instead of dropping the node loose", () => {
    expect(decideNewNodeFrame(board, term("n"), { activeFrameId: "b", explicitFrameId: "nope" })).toEqual({ kind: "join", frameId: "b" });
  });
  it("shapes and ephemeral nodes are never placed", () => {
    expect(decideNewNodeFrame(board, shape("s"), { activeFrameId: "a" })).toEqual({ kind: "loose" });
    expect(decideNewNodeFrame(board, skills("k"), { activeFrameId: "a" })).toEqual({ kind: "loose" });
  });
  it("a node that already carries a Frame is left alone", () => {
    expect(decideNewNodeFrame(board, term("n", 0, 0, "b"), { activeFrameId: "a" })).toEqual({ kind: "loose" });
  });
  it("with no Frame at all, a window node asks for Frame 1 around itself (decision 37)", () => {
    expect(decideNewNodeFrame([], term("n"), { activeFrameId: null })).toEqual({ kind: "create" });
  });
  it("with no Frame, a task spawn still stays loose", () => {
    expect(decideNewNodeFrame([], term("n"), { activeFrameId: null, hasTask: true })).toEqual({ kind: "loose" });
  });
  it("with no Frame, a shape stays loose", () => {
    expect(decideNewNodeFrame([], shape("s"), { activeFrameId: null })).toEqual({ kind: "loose" });
  });
});

describe("placeNewWindowNode", () => {
  it("puts the node in the active Frame in a free slot, never on top of a sibling", () => {
    const board = [frame("a", 0, 0, 800, 600), term("m1", 0, 0, "a")];
    const r = placeNewWindowNode(board, term("n", 9999, 9999), { activeFrameId: "a" });
    const n = r.nodes.find((x) => x.id === "n")!;
    expect(r.frameId).toBe("a");
    expect(frameIdOf(n)).toBe("a");
    const m1 = r.nodes.find((x) => x.id === "m1")!;
    const overlaps = n.position.x < m1.position.x + 300 && n.position.x + 300 > m1.position.x
      && n.position.y < m1.position.y + 200 && n.position.y + 200 > m1.position.y;
    expect(overlaps).toBe(false);
  });
  it("creates 'Frame 1' fit around a lone node when no Frame exists, with no extra padding", () => {
    const r = placeNewWindowNode([], term("n", 100, 50), { activeFrameId: null });
    const frames = framesInOrder(r.nodes);
    expect(frames).toHaveLength(1);
    expect((frames[0].data as { title: string }).title).toBe("Frame 1");
    expect(frames[0].position).toEqual({ x: 100, y: 50 });
    expect(r.frameId).toBe(frames[0].id);
    expect(frameMembers(r.nodes, frames[0].id).map((m) => m.id)).toEqual(["n"]);
    expect(r.createdFrame).toBe(true);
  });
  it("a batch spawn into an empty canvas makes one Frame, the next nodes join it", () => {
    let nodes: Node[] = [];
    for (const id of ["a", "b", "c"]) nodes = placeNewWindowNode(nodes, term(id, 0, 0), { activeFrameId: null }).nodes;
    const frames = framesInOrder(nodes);
    expect(frames).toHaveLength(1);
    expect(frameMembers(nodes, frames[0].id)).toHaveLength(3);
  });
  it("leaves shapes where they are drawn", () => {
    const r = placeNewWindowNode([frame("a")], shape("s"), { activeFrameId: "a" });
    expect(r.nodes.at(-1)).toMatchObject({ id: "s", position: { x: 5, y: 5 } });
    expect(frameIdOf(r.nodes.at(-1)!)).toBeUndefined();
    expect(r.frameId).toBeUndefined();
  });
  it("appends loose when a task spawn has no explicit Frame", () => {
    const r = placeNewWindowNode([frame("a")], term("n"), { activeFrameId: "a", hasTask: true });
    expect(frameIdOf(r.nodes.at(-1)!)).toBeUndefined();
  });
  it("respects MAX_FRAMES: at the limit it still joins the active Frame rather than creating one", () => {
    const frames = Array.from({ length: MAX_FRAMES }, (_, i) => frame(`f${i}`, i * 2000));
    const r = placeNewWindowNode(frames, term("n"), { activeFrameId: "f1" });
    expect(framesInOrder(r.nodes)).toHaveLength(MAX_FRAMES);
    expect(frameIdOf(r.nodes.find((x) => x.id === "n")!)).toBe("f1");
  });
});

describe("wrapLooseWindowsInFrame (decision 37, on open)", () => {
  it("wraps loose window nodes into 'Frame 1', fit with padding 0, ignoring shapes", () => {
    const nodes = [term("a", 100, 100), term("b", 600, 400), shape("s")];
    const out = wrapLooseWindowsInFrame(nodes);
    const frames = framesInOrder(out);
    expect(frames).toHaveLength(1);
    expect((frames[0].data as { title: string }).title).toBe("Frame 1");
    expect(frames[0].position).toEqual({ x: 100, y: 100 });
    expect(frames[0].width).toBe(800);
    expect(frames[0].height).toBe(500);
    expect(frameIdOf(out.find((n) => n.id === "a")!)).toBe(frames[0].id);
    expect(frameIdOf(out.find((n) => n.id === "s")!)).toBeUndefined();
  });
  it("is a no-op when a Frame already exists", () => {
    const nodes = [frame("f"), term("a")];
    expect(wrapLooseWindowsInFrame(nodes)).toBe(nodes);
  });
  it("is a no-op with only shapes, or an empty canvas", () => {
    const only = [shape("s")];
    expect(wrapLooseWindowsInFrame(only)).toBe(only);
    const empty: Node[] = [];
    expect(wrapLooseWindowsInFrame(empty)).toBe(empty);
  });
  it("is deterministic so a reload produces the same Frame id", () => {
    const a = framesInOrder(wrapLooseWindowsInFrame([term("a")]))[0].id;
    const b = framesInOrder(wrapLooseWindowsInFrame([term("a")]))[0].id;
    expect(a).toBe(b);
  });
});
