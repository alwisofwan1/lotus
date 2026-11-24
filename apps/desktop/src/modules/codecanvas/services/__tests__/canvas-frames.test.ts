import { describe, expect, it } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import {
  canCreateFrame,
  canDissolveFrame,
  createFrameFromSelection,
  dissolveFrames,
  frameDragChanges,
  frameAtPoint,
  frameIdOf,
  frameMembers,
  membershipChangesForDrop,
  applyMembershipChanges,
  membershipToastText,
} from "../canvas-frames";

const node = (id: string, type: string, at = { x: 0, y: 0 }, frameId?: string): Node => ({
  id, type, position: at, width: 100, height: 60, data: { ...(frameId ? { frameId } : {}) },
});
const frame = (id: string, title = "Frame 1", at = { x: 0, y: 0 }): Node => ({
  id, type: "frame", position: at, width: 400, height: 300, data: { title },
});
const dragTo = (id: string, x: number, y: number): NodeChange =>
  ({ id, type: "position", position: { x, y }, dragging: true } as NodeChange);

describe("createFrameFromSelection", () => {
  it("wraps nodes of any kind in a new Frame and points them at it", () => {
    const out = createFrameFromSelection(
      [node("t", "terminal", { x: 100, y: 100 }), node("n", "note", { x: 400, y: 200 }), node("x", "agent", { x: 900, y: 900 })],
      ["t", "n"], "fr1",
    );
    expect(frameIdOf(out.find((n) => n.id === "t")!)).toBe("fr1");
    expect(frameIdOf(out.find((n) => n.id === "n")!)).toBe("fr1");
    expect(frameIdOf(out.find((n) => n.id === "x")!)).toBeUndefined();
  });

  it("stamps an optional task key on the new Frame", () => {
    const out = createFrameFromSelection([node("a", "agent"), node("b", "agent")], ["a", "b"], "fr1", { title: "Fix login", taskKey: "task_1" });
    expect(out.find((n) => n.id === "fr1")!.data).toMatchObject({ title: "Fix login", taskKey: "task_1" });
    const plain = createFrameFromSelection([node("a", "agent")], ["a"], "fr2");
    expect(plain.find((n) => n.id === "fr2")!.data).not.toHaveProperty("taskKey");
  });

  it("paints the Frame behind its members: it sits before the first member in array order", () => {
    const out = createFrameFromSelection([node("a", "note"), node("t", "terminal"), node("n", "note")], ["t", "n"], "fr1");
    expect(out.map((n) => n.id)).toEqual(["a", "fr1", "t", "n"]);
  });

  it("hugs the members exactly (padding 0) and never moves a member", () => {
    const out = createFrameFromSelection([node("t", "terminal", { x: 100, y: 100 }), node("n", "note", { x: 400, y: 200 })], ["t", "n"], "fr1");
    const f = out.find((n) => n.id === "fr1")!;
    expect(f.type).toBe("frame");
    expect(f.position).toEqual({ x: 100, y: 100 });
    expect(f.position.x + (f.width ?? 0)).toBe(400 + (out.find((n) => n.id === "n")!.width ?? 0));
    expect(f.position.y + (f.height ?? 0)).toBe(200 + (out.find((n) => n.id === "n")!.height ?? 0));
    expect(out.find((n) => n.id === "t")!.position).toEqual({ x: 100, y: 100 });
  });

  it("names Frames in sequence", () => {
    const first = createFrameFromSelection([node("a", "note"), node("b", "note", { x: 3000, y: 0 })], ["a"], "fr1");
    const second = createFrameFromSelection(first, ["b"], "fr2");
    expect((first.find((n) => n.id === "fr1")!.data as { title: string }).title).toBe("Frame 1");
    expect((second.find((n) => n.id === "fr2")!.data as { title: string }).title).toBe("Frame 2");
  });

  it("moves a node out of its old Frame: one Frame per node", () => {
    const out = createFrameFromSelection([frame("old", "Frame 1", { x: 5000, y: 5000 }), node("a", "note", { x: 10, y: 10 }, "old")], ["a"], "fr1");
    expect(frameIdOf(out.find((n) => n.id === "a")!)).toBe("fr1");
  });

  it("ignores Frames in the selection and does nothing when there is nothing to wrap", () => {
    const nodes = [frame("old"), node("a", "note")];
    expect(createFrameFromSelection(nodes, ["old"], "fr1")).toEqual(nodes);
  });
});

describe("canCreateFrame / canDissolveFrame", () => {
  it("create needs at least one non-Frame node", () => {
    expect(canCreateFrame([])).toBe(false);
    expect(canCreateFrame([frame("f")])).toBe(false);
    expect(canCreateFrame([node("a", "terminal")])).toBe(true);
  });

  it("dissolve is available when the selection is a Frame or a member of one", () => {
    expect(canDissolveFrame([node("a", "note")])).toBe(false);
    expect(canDissolveFrame([frame("f")])).toBe(true);
    expect(canDissolveFrame([node("a", "note", { x: 0, y: 0 }, "f")])).toBe(true);
  });
});

describe("dissolveFrames", () => {
  const board = () => [frame("f1"), node("a", "terminal", { x: 5, y: 5 }, "f1"), node("b", "note", { x: 9, y: 9 }, "f1"), frame("f2"), node("c", "note", { x: 1, y: 1 }, "f2")];

  it("removes the Frame of a selected member and frees all its members, leaving positions alone", () => {
    const out = dissolveFrames(board(), ["a"]);
    expect(out.map((n) => n.id)).toEqual(["a", "b", "f2", "c"]);
    expect(frameIdOf(out.find((n) => n.id === "b")!)).toBeUndefined();
    expect(out.find((n) => n.id === "b")!.position).toEqual({ x: 9, y: 9 });
    expect(frameIdOf(out.find((n) => n.id === "c")!)).toBe("f2");
  });

  it("works when the Frame itself is selected", () => {
    const out = dissolveFrames(board(), ["f2"]);
    expect(out.some((n) => n.id === "f2")).toBe(false);
    expect(frameIdOf(out.find((n) => n.id === "c")!)).toBeUndefined();
  });

  it("is a no-op copy when nothing selected belongs to a Frame", () => {
    const nodes = [node("a", "note")];
    expect(dissolveFrames(nodes, ["a"])).toEqual(nodes);
  });
});

describe("frameMembers", () => {
  it("lists every member of any kind", () => {
    const nodes = [frame("f"), node("a", "terminal", { x: 0, y: 0 }, "f"), node("b", "browser", { x: 0, y: 0 }, "f"), node("c", "note")];
    expect(frameMembers(nodes, "f").map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("frameDragChanges", () => {
  const nodes = [
    frame("f", "Frame 1", { x: 0, y: 0 }),
    node("t", "terminal", { x: 50, y: 50 }, "f"),
    node("n", "note", { x: 200, y: 100 }, "f"),
    node("out", "note", { x: 900, y: 900 }),
  ];

  it("dragging a Frame carries every member, of any kind, by the same delta", () => {
    const synthetic = frameDragChanges(nodes, [dragTo("f", 30, 20)]);
    expect(synthetic).toEqual([
      { id: "t", type: "position", position: { x: 80, y: 70 } },
      { id: "n", type: "position", position: { x: 230, y: 120 } },
    ]);
  });

  it("dragging a member moves only itself: Frames do not make a rigid group", () => {
    expect(frameDragChanges(nodes, [dragTo("t", 60, 60)])).toEqual([]);
  });

  it("does not double-move a member ReactFlow already moves", () => {
    const synthetic = frameDragChanges(nodes, [dragTo("f", 10, 0), dragTo("t", 60, 50)]);
    expect(synthetic.map((c) => c.id)).toEqual(["n"]);
  });

  it("ignores non-drag and zero-delta changes", () => {
    expect(frameDragChanges(nodes, [{ id: "f", type: "position", position: { x: 5, y: 5 } } as NodeChange])).toEqual([]);
    expect(frameDragChanges(nodes, [dragTo("f", 0, 0)])).toEqual([]);
  });
});


// Frame box (0,0)-(400,300); `node` helper is 100x60.
describe("frameAtPoint", () => {
  it("finds the Frame whose box contains the point, none outside", () => {
    const nodes = [frame("f1")];
    expect(frameAtPoint(nodes, { x: 200, y: 150 })?.id).toBe("f1");
    expect(frameAtPoint(nodes, { x: 401, y: 150 })).toBeUndefined();
  });
  it("prefers the smallest Frame when boxes overlap", () => {
    const small: Node = { ...frame("small", "S", { x: 50, y: 50 }), width: 100, height: 100 };
    expect(frameAtPoint([frame("big"), small], { x: 100, y: 100 })?.id).toBe("small");
  });
});

describe("membershipChangesForDrop", () => {
  it("joins a loose node of ANY kind whose centre lands inside a Frame", () => {
    for (const kind of ["terminal", "agent", "browser", "note", "shape"]) {
      const dropped = node("d", kind, { x: 100, y: 100 }); // centre (150,130)
      const changes = membershipChangesForDrop([frame("f1"), dropped], [dropped]);
      expect(changes).toEqual([{ nodeId: "d", from: undefined, to: "f1" }]);
    }
  });
  it("counts the CENTRE, not overlap: a node mostly outside with its centre outside stays loose", () => {
    const dropped = node("d", "note", { x: 360, y: 100 }); // centre (410,130) outside, left edge inside
    expect(membershipChangesForDrop([frame("f1"), dropped], [dropped])).toEqual([]);
  });
  it("releases a member whose centre leaves the Frame", () => {
    const dropped = node("d", "note", { x: 600, y: 100 }, "f1");
    expect(membershipChangesForDrop([frame("f1"), dropped], [dropped])).toEqual([{ nodeId: "d", from: "f1", to: undefined }]);
  });
  it("uses the dropped node's fresh position, not the stale one in the list", () => {
    const stale = node("d", "note", { x: 0, y: 0 }, "f1");
    const fresh = { ...stale, position: { x: 900, y: 900 } };
    expect(membershipChangesForDrop([frame("f1"), stale], [fresh])).toEqual([{ nodeId: "d", from: "f1", to: undefined }]);
  });
  it("reports nothing when membership does not change", () => {
    const inside = node("d", "note", { x: 100, y: 100 }, "f1");
    expect(membershipChangesForDrop([frame("f1"), inside], [inside])).toEqual([]);
  });
  it("moves a node between Frames in one change", () => {
    const dropped = node("d", "note", { x: 600, y: 100 }, "f1");
    const out = membershipChangesForDrop([frame("f1"), frame("f2", "F2", { x: 500, y: 0 }), dropped], [dropped]);
    expect(out).toEqual([{ nodeId: "d", from: "f1", to: "f2" }]);
  });
  it("ignores Frames themselves and members carried by a dragged Frame", () => {
    const m = node("m", "note", { x: 100, y: 100 }, "f1");
    const f = frame("f1", "F", { x: 1000, y: 1000 });
    expect(membershipChangesForDrop([f, m], [f, { ...m, position: { x: 1100, y: 1100 } }])).toEqual([]);
    expect(membershipChangesForDrop([f, m], [f])).toEqual([]);
  });
  it("never frames ephemeral skill nodes", () => {
    const s = node("s", "skill", { x: 100, y: 100 });
    expect(membershipChangesForDrop([frame("f1"), s], [s])).toEqual([]);
  });
});

describe("applyMembershipChanges", () => {
  const changes = [{ nodeId: "d", from: undefined, to: "f1" }];
  it("applies forward and reverse", () => {
    const base = [frame("f1"), node("d", "terminal")];
    const joined = applyMembershipChanges(base, changes, "forward");
    expect(frameIdOf(joined.find((n) => n.id === "d")!)).toBe("f1");
    const back = applyMembershipChanges(joined, changes, "reverse");
    expect(frameIdOf(back.find((n) => n.id === "d")!)).toBeUndefined();
  });
});

describe("membershipToastText", () => {
  it("names the Frame joined or left", () => {
    const nodes = [frame("f1", "Backend"), frame("f2", "Docs")];
    expect(membershipToastText(nodes, { nodeId: "d", from: undefined, to: "f1" })).toBe("Masuk ke Backend");
    expect(membershipToastText(nodes, { nodeId: "d", from: "f1", to: undefined })).toBe("Keluar dari Backend");
    expect(membershipToastText(nodes, { nodeId: "d", from: "f1", to: "f2" })).toBe("Masuk ke Docs");
  });
});

