import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { FRAME_COLORS, frameColorOf, nextFrameColorId } from "../canvas-frame-palette";
import { autoFrameName } from "../canvas-frame-naming";
import { shouldShowFirstFrameHint } from "../canvas-frame-hint";
import { frameBoxFromDrag, FRAME_PAD } from "../canvas-frame-geometry";
import {
  createFrameFromSelection,
  deleteFrameWithContents,
  detachOrphanedMembers,
  fitFrameToContent,
  frameDeletionSummary,
  frameIdOf,
  recolorFrame,
  renameFrame,
} from "../canvas-frames";
import { appendEmptyFrameAt, appendFrameInBox } from "../canvas-frame-switcher";
import { isShapeTool, resolveToolShortcut, toolForShortcut } from "../canvas-tool";

const node = (id: string, type: string, at = { x: 0, y: 0 }, data: Record<string, unknown> = {}): Node => ({
  id, type, position: at, width: 100, height: 60, data,
});
const frame = (id: string, data: Record<string, unknown> = { title: "Frame 1" }, at = { x: 0, y: 0 }): Node => ({
  id, type: "frame", position: at, width: 400, height: 300, data,
});

describe("frame palette", () => {
  it("has the six named colours in mockup order", () => {
    expect(FRAME_COLORS.map((c) => c.name)).toEqual(["Iris", "Moss", "Rose", "Orchid", "Mist", "Stone"]);
  });

  it("auto-assigns the first colour no Frame uses, then the least used", () => {
    expect(nextFrameColorId([])).toBe("iris");
    expect(nextFrameColorId([frame("a", { title: "x", colorId: "iris" })])).toBe("moss");
    const all = FRAME_COLORS.map((c, i) => frame(`f${i}`, { title: "x", colorId: c.id }));
    expect(nextFrameColorId([...all, frame("g", { title: "x", colorId: "iris" })])).toBe("moss");
  });

  it("falls back to the first colour for an unknown id", () => {
    expect(frameColorOf("nope").id).toBe("iris");
    expect(frameColorOf(undefined).id).toBe("iris");
  });
});

describe("autoFrameName", () => {
  const term = (id: string, branch: string | null, path?: string) =>
    node(id, "terminal", undefined, { assignedWorktree: branch, assignedWorktreePath: path });

  it("uses the branch every worktree-bound member shares", () => {
    expect(autoFrameName([term("a", "feat/auth"), term("b", "feat/auth"), node("n", "note")], "Frame 3")).toBe("feat/auth");
  });

  it("does not guess when branches differ", () => {
    expect(autoFrameName([term("a", "feat/auth"), term("b", "fix/x")], "Frame 3")).toBe("Frame 3");
  });

  it("needs at least two members on the shared branch", () => {
    expect(autoFrameName([term("a", "feat/auth"), node("n", "note")], "Frame 3")).toBe("Frame 3");
  });

  it("falls back to the worktree folder when only a path is known", () => {
    expect(autoFrameName([term("a", null, "/r/.worktrees/auth"), term("b", null, "/r/.worktrees/auth")], "Frame 1")).toBe("auth");
  });

  it("uses the title of the single Task in the selection", () => {
    expect(autoFrameName([node("t", "task", undefined, { title: "Fix login" }), node("a", "agent")], "Frame 2")).toBe("Fix login");
  });

  it("does not pick between two Tasks", () => {
    const two = [node("t1", "task", undefined, { title: "A" }), node("t2", "task", undefined, { title: "B" })];
    expect(autoFrameName(two, "Frame 2")).toBe("Frame 2");
  });

  it("falls back for an empty or untitled context", () => {
    expect(autoFrameName([], "Frame 1")).toBe("Frame 1");
    expect(autoFrameName([node("t", "task", undefined, { title: "  " })], "Frame 1")).toBe("Frame 1");
  });
});

describe("creating Frames", () => {
  it("names from context and picks the next colour", () => {
    const t = (id: string) => node(id, "terminal", { x: 10, y: 10 }, { assignedWorktree: "feat/x" });
    const out = createFrameFromSelection([t("a"), t("b")], ["a", "b"], "fr");
    const f = out.find((n) => n.id === "fr")!;
    expect(f.data).toMatchObject({ title: "feat/x", colorId: "iris" });
  });

  it("an empty Frame gets a colour too", () => {
    const out = appendEmptyFrameAt([frame("a", { title: "Frame 1", colorId: "iris" })], "b", { x: 0, y: 0 });
    expect(out[1].data).toMatchObject({ title: "Frame 2", colorId: "moss" });
  });

  it("draws a Frame in a dragged box", () => {
    const out = appendFrameInBox([], "f", { x: 10, y: 20, w: 560, h: 180 });
    expect(out[0].position).toEqual({ x: 10, y: 20 });
    expect(out[0].width).toBe(560);
    expect(out[0].height).toBe(180);
    expect(out[0].data).toMatchObject({ title: "Frame 1", colorId: "iris" });
  });
});

describe("frameBoxFromDrag", () => {
  it("normalises a drag in any direction", () => {
    expect(frameBoxFromDrag({ x: 300, y: 200 }, { x: 100, y: 50 })).toEqual({ x: 100, y: 50, w: 200, h: 150 });
  });
  it("shift makes it square on the longer side", () => {
    expect(frameBoxFromDrag({ x: 0, y: 0 }, { x: 200, y: 100 }, { square: true })).toEqual({ x: 0, y: 0, w: 200, h: 200 });
  });
  it("alt grows from the centre", () => {
    expect(frameBoxFromDrag({ x: 100, y: 100 }, { x: 150, y: 130 }, { fromCentre: true })).toEqual({ x: 50, y: 70, w: 100, h: 60 });
  });
});

describe("renaming and recolouring", () => {
  it("renames, trimming; a blank name keeps the old one", () => {
    const nodes = [frame("f", { title: "Old" })];
    expect((renameFrame(nodes, "f", "  New  ")[0].data as { title: string }).title).toBe("New");
    expect((renameFrame(nodes, "f", "   ")[0].data as { title: string }).title).toBe("Old");
  });
  it("recolours only the named Frame", () => {
    const out = recolorFrame([frame("f"), frame("g")], "f", "rose");
    expect((out[0].data as { colorId?: string }).colorId).toBe("rose");
    expect((out[1].data as { colorId?: string }).colorId).toBeUndefined();
  });
});

describe("fitFrameToContent", () => {
  it("hugs its members exactly (padding 0, no title room inside the box)", () => {
    const nodes = [frame("f"), node("a", "note", { x: 500, y: 600 }, { frameId: "f" }), node("b", "note", { x: 700, y: 650 }, { frameId: "f" })];
    const f = fitFrameToContent(nodes, "f").find((n) => n.id === "f")!;
    expect(f.position).toEqual({ x: 500, y: 600 });
    expect(f.width).toBe(300);
    expect(f.height).toBe(110);
  });
  it("leaves an empty Frame alone", () => {
    const nodes = [frame("f")];
    expect(fitFrameToContent(nodes, "f")).toEqual(nodes);
  });
});

describe("delete with contents", () => {
  const nodes = [
    frame("f"), frame("g"),
    node("t", "terminal", undefined, { frameId: "f" }),
    node("a", "agent", undefined, { frameId: "f" }),
    node("n", "note", undefined, { frameId: "f" }),
    node("loose", "terminal"),
    node("other", "terminal", undefined, { frameId: "g" }),
  ];
  const live = (agents: Record<string, string> = {}, terminals: string[] = []) => ({
    agentStatus: (id: string) => agents[id] as never,
    terminalRunning: (id: string) => terminals.includes(id),
  });
  it("counts only sessions that are actually running", () => {
    expect(frameDeletionSummary(nodes, "f", live({ a: "running" }, ["t"]))).toEqual({ nodeCount: 3, terminals: 1, agents: 1, memberIds: ["t", "a", "n"] });
  });
  it("does not count a terminal at rest or an agent with no live session", () => {
    expect(frameDeletionSummary(nodes, "f", live())).toEqual({ nodeCount: 3, terminals: 0, agents: 0, memberIds: ["t", "a", "n"] });
    expect(frameDeletionSummary(nodes, "f", live({ a: "idle" })).agents).toBe(0);
    expect(frameDeletionSummary(nodes, "f", live({ a: "needs-you" })).agents).toBe(1);
  });
  it("removes the Frame and its members only", () => {
    const out = deleteFrameWithContents(nodes, "f");
    expect(out.map((n) => n.id)).toEqual(["g", "loose", "other"]);
  });
  it("is a no-op for an unknown Frame", () => {
    expect(deleteFrameWithContents(nodes, "zzz")).toHaveLength(nodes.length);
    expect(frameIdOf(nodes[2])).toBe("f");
  });
});

describe("first-Frame hint", () => {
  const loose = (n: number) => Array.from({ length: n }, (_, i) => node(`n${i}`, "note"));
  it("shows with 3 loose nodes, no Frame, not yet seen", () => {
    expect(shouldShowFirstFrameHint(loose(3), false)).toBe(true);
  });
  it("needs three nodes", () => {
    expect(shouldShowFirstFrameHint(loose(2), false)).toBe(false);
  });
  it("never shows once any Frame exists", () => {
    expect(shouldShowFirstFrameHint([...loose(3), frame("f")], false)).toBe(false);
  });
  it("never shows again after it was seen", () => {
    expect(shouldShowFirstFrameHint(loose(5), true)).toBe(false);
  });
  it("shapes and session-only skill nodes do not count", () => {
    expect(shouldShowFirstFrameHint([node("s1", "shape"), node("s2", "shape"), node("k", "skill"), ...loose(2)], false)).toBe(false);
  });
});

describe("Frame tool", () => {
  it("is armed by N and is not a shape tool", () => {
    expect(toolForShortcut("n")).toBe("frame");
    expect(isShapeTool("frame")).toBe(false);
  });
  it("is gated by the tool rail like the other drawing tools", () => {
    const ev = { key: "n", metaKey: false, ctrlKey: false, altKey: false };
    expect(resolveToolShortcut(ev, { showToolRail: false, editableTarget: false })).toBeNull();
    expect(resolveToolShortcut(ev, { showToolRail: true, editableTarget: false })).toBe("frame");
  });
});

describe("detachOrphanedMembers", () => {
  it("frees members whose Frame was removed, keeps the rest", () => {
    const nodes = [frame("f"), node("a", "note", undefined, { frameId: "f" }), node("b", "note", undefined, { frameId: "gone" })];
    const out = detachOrphanedMembers(nodes);
    expect(frameIdOf(out[1])).toBe("f");
    expect(frameIdOf(out[2])).toBeUndefined();
  });
  it("returns the same array when nothing is orphaned", () => {
    const nodes = [frame("f"), node("a", "note", undefined, { frameId: "f" })];
    expect(detachOrphanedMembers(nodes)).toBe(nodes);
  });
});
