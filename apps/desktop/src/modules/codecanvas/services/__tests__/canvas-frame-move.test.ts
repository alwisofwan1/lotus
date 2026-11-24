import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { frameIdOf, frameMembers, moveNodesToFrame, membershipChangesForDrop } from "../canvas-frames";

const node = (id: string, at: { x: number; y: number }, frameId?: string, w = 100, h = 60): Node => ({
  id, type: "terminal", position: at, width: w, height: h, data: { ...(frameId ? { frameId } : {}) },
});
const frame = (id: string, at = { x: 0, y: 0 }, w = 400, h = 300): Node => ({
  id, type: "frame", position: at, width: w, height: h, data: { title: id },
});
const inside = (f: Node, n: Node) =>
  n.position.x >= f.position.x && n.position.y >= f.position.y &&
  n.position.x + (n.width ?? 0) <= f.position.x + (f.width ?? 0) && n.position.y + (n.height ?? 0) <= f.position.y + (f.height ?? 0);

describe("moveNodesToFrame (⌥⇧N and NL \"move into Frame\")", () => {
  it("moves loose nodes physically inside the Frame, as members, without overlapping its existing members", () => {
    const nodes = [frame("f", { x: 1000, y: 1000 }), node("m", { x: 1030, y: 1060 }, "f"), node("a", { x: 0, y: 0 }), node("b", { x: 50, y: 50 })];
    const { nodes: out, changes } = moveNodesToFrame(nodes, ["a", "b"], "f");
    const f = out.find((n) => n.id === "f")!;
    for (const id of ["a", "b"]) {
      const n = out.find((x) => x.id === id)!;
      expect(frameIdOf(n)).toBe("f");
      expect(inside(f, n)).toBe(true);
    }
    expect(changes.map((c) => c.nodeId)).toEqual(["a", "b"]);
    // Membership is by position (decision 3): the drop rule agrees with what was just written.
    expect(membershipChangesForDrop(out, frameMembers(out, "f"))).toEqual([]);
    const boxes = frameMembers(out, "f").map((n) => n.position);
    expect(new Set(boxes.map((p) => `${p.x},${p.y}`)).size).toBe(3);
  });

  it("grows the Frame when the nodes do not fit", () => {
    const nodes = [frame("f", { x: 0, y: 0 }, 200, 140), node("a", { x: 900, y: 900 }, undefined, 300, 200), node("b", { x: 900, y: 1200 }, undefined, 300, 200)];
    const { nodes: out } = moveNodesToFrame(nodes, ["a", "b"], "f");
    const f = out.find((n) => n.id === "f")!;
    expect(f.width).toBeGreaterThan(200);
    expect(f.height).toBeGreaterThan(140);
    for (const n of frameMembers(out, "f")) expect(inside(f, n)).toBe(true);
  });

  it("keeps the Frame ahead of its members in array order so it paints behind them", () => {
    const nodes = [node("a", { x: 0, y: 0 }), frame("f", { x: 1000, y: 0 })];
    const { nodes: out } = moveNodesToFrame(nodes, ["a"], "f");
    expect(out.findIndex((n) => n.id === "f")).toBeLessThan(out.findIndex((n) => n.id === "a"));
  });

  it("leaves a node already in that Frame alone", () => {
    const nodes = [frame("f"), node("a", { x: 50, y: 60 }, "f")];
    const { nodes: out, changes } = moveNodesToFrame(nodes, ["a"], "f");
    expect(changes).toEqual([]);
    expect(out.find((n) => n.id === "a")!.position).toEqual({ x: 50, y: 60 });
  });

  it("undo restores positions, membership and the Frame size", () => {
    const nodes = [frame("f", { x: 0, y: 0 }, 200, 140), node("a", { x: 900, y: 900 }, "g", 300, 200), frame("g", { x: 800, y: 800 }, 600, 500)];
    const { nodes: moved, undo } = moveNodesToFrame(nodes, ["a"], "f");
    expect(moved.find((n) => n.id === "a")!.position).not.toEqual({ x: 900, y: 900 });
    const back = undo(moved);
    const a = back.find((n) => n.id === "a")!;
    expect(a.position).toEqual({ x: 900, y: 900 });
    expect(frameIdOf(a)).toBe("g");
    const f = back.find((n) => n.id === "f")!;
    expect([f.width, f.height, f.position]).toEqual([200, 140, { x: 0, y: 0 }]);
    expect((f.style as { width?: number } | undefined)?.width).toBe(nodes[0].style?.width);
  });

  it("takes nodes out (frameId undefined) by membership only, positions untouched", () => {
    const nodes = [frame("f"), node("a", { x: 50, y: 60 }, "f")];
    const { nodes: out, changes, undo } = moveNodesToFrame(nodes, ["a"], undefined);
    expect(frameIdOf(out.find((n) => n.id === "a")!)).toBeUndefined();
    expect(out.find((n) => n.id === "a")!.position).toEqual({ x: 50, y: 60 });
    expect(changes).toEqual([{ nodeId: "a", from: "f", to: undefined }]);
    expect(frameIdOf(undo(out).find((n) => n.id === "a")!)).toBe("f");
  });

  it("never moves Frames or ephemeral nodes", () => {
    const nodes = [frame("f"), frame("g", { x: 900, y: 0 }), { ...node("s", { x: 5, y: 5 }), type: "skills" }];
    expect(moveNodesToFrame(nodes, ["g", "s"], "f").changes).toEqual([]);
  });
});
