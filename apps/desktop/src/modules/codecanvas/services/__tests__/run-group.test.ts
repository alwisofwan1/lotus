import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import { RUN_GROUP_HEADER, RUN_GROUP_PAD, runGroupArrangeMargin, runGroupBox, runGroupDrop, runGroupsOf, type DroppedNode } from "../run-group";

const box = (id: string, type: string, x: number, y: number, data: Record<string, unknown> = {}): Node =>
  ({ id, type, position: { x, y }, width: 100, height: 50, data });
const run = (id: string, title: string, memberIds: string[], open: boolean): Node =>
  ({ id, type: "run", position: { x: -500, y: -500 }, width: 300, height: 180, data: { title, memberIds, open } });
const at = (node: Node, x: number, y: number): DroppedNode =>
  ({ id: node.id, type: node.type, label: String((node.data as { name?: string }).name ?? node.id), rect: { x, y, w: 100, h: 50 } });

const ren = box("a", "agent", 0, 0, { name: "Ren" });
const kai = box("b", "agent", 200, 0, { name: "Kai" });
const mo = box("c", "agent", 1000, 0, { name: "Mo" });
const note = box("n", "note", 1000, 300);
const idle = () => false;

describe("runGroupBox", () => {
  it("is the members' union, padded, with room for the header on top", () => {
    expect(runGroupBox([{ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 100, w: 100, h: 50 }])).toEqual({
      x: -RUN_GROUP_PAD,
      y: -RUN_GROUP_PAD - RUN_GROUP_HEADER,
      w: 300 + 2 * RUN_GROUP_PAD,
      h: 150 + 2 * RUN_GROUP_PAD + RUN_GROUP_HEADER,
    });
    expect(runGroupBox([])).toBeNull();
  });

  it("only open runs get an outline", () => {
    const groups = runGroupsOf([ren, kai, mo, run("A", "Ship auth", ["a", "b"], true), run("B", "Docs", ["c"], false)]);
    expect(groups.runs.map((r) => r.id)).toEqual(["A", "B"]);
    expect(groups.open.map((g) => g.id)).toEqual(["A"]);
  });
});

describe("runGroupDrop", () => {
  const board = [ren, kai, mo, note, run("A", "Ship auth", ["a", "b"], true)];

  it("ac3 — a member dropped outside leaves; a runnable node dropped inside joins", () => {
    const groups = runGroupsOf(board);
    expect(runGroupDrop(groups, [at(kai, 2000, 2000)], idle)).toEqual({ changes: [{ runId: "A", memberIds: ["a"] }], notice: null });
    expect(runGroupDrop(groups, [at(mo, 100, 20)], idle)).toEqual({ changes: [{ runId: "A", memberIds: ["a", "b", "c"] }], notice: null });
  });

  it("a member moved inside its own outline changes nothing", () => {
    expect(runGroupDrop(runGroupsOf(board), [at(kai, 150, 10)], idle)).toEqual({ changes: [], notice: null });
  });

  it("judges the drop against the box frozen at drag start, not the stretched one", () => {
    const frozen = runGroupsOf(board);
    // The live box would include Kai at its new place; the frozen one does not.
    const moved = board.map((n) => (n.id === "b" ? { ...n, position: { x: 700, y: 0 } } : n));
    expect(runGroupsOf(moved).open[0].box.w).toBeGreaterThan(frozen.open[0].box.w);
    expect(runGroupDrop(frozen, [at(kai, 700, 0)], idle).changes).toEqual([{ runId: "A", memberIds: ["a"] }]);
  });

  it("ac4 — a node of another run is refused with its run's name, and that run keeps it", () => {
    const groups = runGroupsOf([...board, run("B", "Docs", ["c"], false)]);
    expect(runGroupDrop(groups, [at(mo, 100, 20)], idle)).toEqual({ changes: [], notice: "Mo is already in Docs." });
  });

  it("ac5 — a note or terminal dropped inside is ignored without a notice", () => {
    const term = box("t", "terminal", 1000, 600);
    const groups = runGroupsOf([...board, term]);
    expect(runGroupDrop(groups, [at(note, 100, 20), at(term, 120, 20)], idle)).toEqual({ changes: [], notice: null });
  });

  it("ac6 — the only member cannot leave", () => {
    const groups = runGroupsOf([ren, run("A", "Ship auth", ["a"], true)]);
    expect(runGroupDrop(groups, [at(ren, 2000, 2000)], idle)).toEqual({ changes: [], notice: "A run needs at least one node." });
  });

  it("ac7 — a live or paused run refuses both ways", () => {
    const groups = runGroupsOf(board);
    const active = (id: string) => id === "A";
    const notice = "Ship auth is running — wait until it ends.";
    expect(runGroupDrop(groups, [at(kai, 2000, 2000)], active)).toEqual({ changes: [], notice });
    expect(runGroupDrop(groups, [at(mo, 100, 20)], active)).toEqual({ changes: [], notice });
  });

  it("a closed run never changes members by dragging", () => {
    const groups = runGroupsOf([ren, kai, mo, run("A", "Ship auth", ["a", "b"], false)]);
    expect(runGroupDrop(groups, [at(kai, 2000, 2000), at(mo, 0, 0)], idle)).toEqual({ changes: [], notice: null });
  });

  it("judges each node of a multi-node drag on its own", () => {
    const groups = runGroupsOf(board);
    expect(runGroupDrop(groups, [at(kai, 2000, 2000), at(mo, 50, 10)], idle).changes).toEqual([
      { runId: "A", memberIds: ["a", "c"] },
    ]);
  });
});

describe("arrange with an open run (#74 app test)", () => {
  it("an open Run Node takes no cell; a closed one still does", async () => {
    const { arrangeCanvasNodes } = await import("../canvas-arrange");
    const fit = { width: 1500, height: 900 };
    const openBoxes = arrangeCanvasNodes([ren, kai, run("A", "Ship auth", ["a", "b"], true)], { fit });
    expect([...openBoxes.keys()].sort()).toEqual(["a", "b"]);
    const closedBoxes = arrangeCanvasNodes([ren, kai, run("A", "Ship auth", ["a", "b"], false)], { fit });
    expect([...closedBoxes.keys()].sort()).toEqual(["A", "a", "b"]);
  });

  it("keeps room for the outline and header only while a run with a member is open", () => {
    expect(runGroupArrangeMargin([ren, kai, run("A", "Ship auth", ["a", "b"], true)])).toEqual({
      top: RUN_GROUP_PAD + RUN_GROUP_HEADER, right: RUN_GROUP_PAD, bottom: RUN_GROUP_PAD, left: RUN_GROUP_PAD,
    });
    const none = { top: 0, right: 0, bottom: 0, left: 0 };
    expect(runGroupArrangeMargin([ren, kai, run("A", "Ship auth", ["a", "b"], false)])).toEqual(none);
    expect(runGroupArrangeMargin([run("A", "Ship auth", ["gone"], true)])).toEqual(none);
  });
});

describe("room for the outline inside a Frame (#74 app test, Frame arrange)", () => {
  it("counts only open runs with a member in the Frame being arranged", () => {
    const inFrame = { ...ren, data: { ...ren.data, frameId: "f1" } };
    const nodes = [inFrame, kai, run("A", "Ship auth", ["a"], true), run("B", "Docs", ["b"], true)];
    const ofF1 = (n: Node) => (n.data as { frameId?: string }).frameId === "f1";
    expect(runGroupArrangeMargin(nodes, ofF1).top).toBe(RUN_GROUP_PAD + RUN_GROUP_HEADER);
    expect(runGroupArrangeMargin([inFrame, kai, run("B", "Docs", ["b"], true)], ofF1).top).toBe(0);
  });

  it("the grid shrinks by the margin and the framed bounds grow back by it", async () => {
    const { boundsWithRunMargin, fitInsideRunMargin } = await import("../run-group");
    const m = { top: 96, right: 32, bottom: 32, left: 32 };
    expect(fitInsideRunMargin({ width: 1000, height: 800 }, m)).toEqual({ width: 936, height: 672 });
    expect(boundsWithRunMargin({ minX: 0, minY: 0, width: 936, height: 672 }, m)).toEqual({ minX: -32, minY: -96, width: 1000, height: 800 });
  });
});
