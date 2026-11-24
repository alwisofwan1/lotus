import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import {
  captureShapes,
  captureShapeSnapshot,
  createShapeHistory,
  restoreShapeEdges,
  restoreShapes,
  shapePlacementsEqual,
  shapeSnapshotsEqual,
} from "../canvas-shape-history";
import { restoreMemberships } from "../canvas-frames";

const shape = (id: string, x = 0): Node => ({ id, type: "shape", position: { x, y: 0 }, data: { shape: "rectangle" } });
const term = (id: string): Node => ({ id, type: "terminal", position: { x: 0, y: 0 }, data: {} });

describe("captureShapes", () => {
  it("captures only shape nodes, with their positions in the full array (paint-order interleave)", () => {
    const nodes = [term("t1"), shape("s1"), term("t2"), shape("s2")];
    expect(captureShapes(nodes)).toEqual([
      { node: nodes[1], index: 1 },
      { node: nodes[3], index: 3 },
    ]);
  });
});

describe("shapePlacementsEqual", () => {
  it("is true for identical node identities at identical indices", () => {
    const nodes = [shape("s1"), shape("s2")];
    expect(shapePlacementsEqual(captureShapes(nodes), captureShapes(nodes))).toBe(true);
  });

  it("is false when a shape moved, changed, appeared, or disappeared", () => {
    const a = [shape("s1")];
    expect(shapePlacementsEqual(captureShapes(a), captureShapes([shape("s1")]))).toBe(false); // new object identity = changed
    expect(shapePlacementsEqual(captureShapes(a), captureShapes([...a, shape("s2")]))).toBe(false);
    expect(shapePlacementsEqual(captureShapes(a), captureShapes([term("t"), ...a]))).toBe(false); // index shifted
  });
});

describe("restoreShapes", () => {
  it("puts recorded shapes back at their recorded indices, keeping current non-shape nodes", () => {
    const s1 = shape("s1");
    const s2 = shape("s2");
    const before = [term("t1"), s1, term("t2"), s2];
    const snapshot = captureShapes(before);
    // later: s1 deleted, s2 mutated & moved to front
    const current = [{ ...s2, position: { x: 99, y: 0 } }, term("t1"), term("t2")];
    const restored = restoreShapes(current, snapshot);
    expect(restored.map((n) => n.id)).toEqual(["t1", "s1", "t2", "s2"]);
    expect(restored.find((n) => n.id === "s2")?.position.x).toBe(0);
  });

  it("clamps a recorded index past the end of the current array", () => {
    const before = [term("t1"), term("t2"), shape("s1")];
    const snapshot = captureShapes(before); // s1 at index 2
    const restored = restoreShapes([term("t1")], snapshot);
    expect(restored.map((n) => n.id)).toEqual(["t1", "s1"]);
  });

  it("restores shapes deselected so undo never resurrects a phantom selection", () => {
    const s1 = { ...shape("s1"), selected: true };
    const snapshot = captureShapes([s1]);
    const restored = restoreShapes([], snapshot);
    expect(restored[0].selected).toBeFalsy();
  });
});

describe("createShapeHistory", () => {
  it("undoes to the before-state and redoes back to the after-state", () => {
    const h = createShapeHistory();
    const a = captureShapeSnapshot([shape("s1")], []);
    const b = captureShapeSnapshot([shape("s1"), shape("s2")], []);
    h.record(a, b);
    expect(h.undo()).toBe(a);
    expect(h.redo()).toBe(b);
  });

  it("returns null with nothing to undo or redo", () => {
    const h = createShapeHistory();
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it("skips recording a no-op (identical before/after placements)", () => {
    const h = createShapeHistory();
    const a = captureShapeSnapshot([shape("s1")], []);
    h.record(a, a);
    expect(h.undo()).toBeNull();
  });

  it("clears the redo branch when a new mutation is recorded after an undo", () => {
    const h = createShapeHistory();
    const a = captureShapeSnapshot([], []);
    const b = captureShapeSnapshot([shape("s1")], []);
    const c = captureShapeSnapshot([shape("s2")], []);
    h.record(a, b);
    h.undo();
    h.record(a, c);
    expect(h.redo()).toBeNull(); // redo branch was replaced…
    expect(h.undo()).toBe(a); // …by the new entry
  });

  it("walks multiple steps back and forward in order", () => {
    const h = createShapeHistory();
    const s0 = captureShapeSnapshot([], []);
    const s1 = captureShapeSnapshot([shape("s1")], []);
    const s2 = captureShapeSnapshot([shape("s1"), shape("s2")], []);
    h.record(s0, s1);
    h.record(s1, s2);
    expect(h.undo()).toBe(s1);
    expect(h.undo()).toBe(s0);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(s1);
    expect(h.redo()).toBe(s2);
    expect(h.redo()).toBeNull();
  });

  it("drops the oldest entries past the cap", () => {
    const h = createShapeHistory(2);
    const snaps = [0, 1, 2, 3].map((i) => captureShapeSnapshot(i === 0 ? [] : [shape(`s${i}`)], []));
    h.record(snaps[0], snaps[1]);
    h.record(snaps[1], snaps[2]);
    h.record(snaps[2], snaps[3]);
    expect(h.undo()).toBe(snaps[2]);
    expect(h.undo()).toBe(snaps[1]);
    expect(h.undo()).toBeNull(); // oldest entry evicted
  });
});

describe("shapePlacementsEqual — selection is not history", () => {
  it("treats a selection-only flip as equal (clicking a shape must never become an undo step)", () => {
    const base = shape("s1");
    const a = captureShapes([base]);
    const b = captureShapes([{ ...base, selected: true }]);
    expect(shapePlacementsEqual(a, b)).toBe(true);
  });

  it("treats a drag-flag-only flip as equal", () => {
    const base = shape("s1");
    const a = captureShapes([base]);
    const b = captureShapes([{ ...base, dragging: true }]);
    expect(shapePlacementsEqual(a, b)).toBe(true);
  });

  it("still detects a real geometry change on an otherwise identical node", () => {
    const base = shape("s1");
    const a = captureShapes([base]);
    const b = captureShapes([{ ...base, position: { x: 5, y: 0 } }]);
    expect(shapePlacementsEqual(a, b)).toBe(false);
  });

  it("still detects a data change (text/style patch)", () => {
    const base = shape("s1");
    const a = captureShapes([base]);
    const b = captureShapes([{ ...base, data: { ...base.data } }]);
    expect(shapePlacementsEqual(a, b)).toBe(false);
  });

  it("still detects a resize", () => {
    const base = { ...shape("s1"), width: 100, height: 80 };
    const a = captureShapes([base]);
    const b = captureShapes([{ ...base, width: 120 }]);
    expect(shapePlacementsEqual(a, b)).toBe(false);
  });
});

describe("shape snapshots (nodes + connectors)", () => {
  const edge = (id: string, source: string, target: string, extra: Record<string, unknown> = {}) =>
    ({ id, source, target, data: {}, ...extra }) as import("@xyflow/react").Edge;

  it("captures only connectors whose BOTH endpoints are shapes", () => {
    const nodes = [shape("s1"), shape("s2"), term("t1")];
    const edges = [edge("e1", "s1", "s2"), edge("e2", "s1", "t1"), edge("e3", "t1", "s2")];
    const snap = captureShapeSnapshot(nodes, edges);
    expect(snap.edges.map((e) => e.id)).toEqual(["e1"]);
    expect(snap.placements.map((p) => p.node.id)).toEqual(["s1", "s2"]);
  });

  it("treats snapshots as equal when only an edge's selection flipped", () => {
    const nodes = [shape("s1"), shape("s2")];
    const e = edge("e1", "s1", "s2");
    const a = captureShapeSnapshot(nodes, [e]);
    const b = captureShapeSnapshot(nodes, [{ ...e, selected: true }]);
    expect(shapeSnapshotsEqual(a, b)).toBe(true);
  });

  it("detects a connector being added or removed", () => {
    const nodes = [shape("s1"), shape("s2")];
    const a = captureShapeSnapshot(nodes, []);
    const b = captureShapeSnapshot(nodes, [edge("e1", "s1", "s2")]);
    expect(shapeSnapshotsEqual(a, b)).toBe(false);
  });

  it("detects a connector data change (label edit)", () => {
    const nodes = [shape("s1"), shape("s2")];
    const e = edge("e1", "s1", "s2");
    const a = captureShapeSnapshot(nodes, [e]);
    const b = captureShapeSnapshot(nodes, [{ ...e, data: { customLabel: "x" } }]);
    expect(shapeSnapshotsEqual(a, b)).toBe(false);
  });

  it("restoreShapeEdges swaps the shape-connector subset and leaves workflow wires alone", () => {
    const nodes = [shape("s1"), shape("s2"), term("t1")];
    const workflowWire = edge("w1", "s1", "t1");
    const staleConnector = edge("e-new", "s1", "s2");
    const snapEdge = edge("e-old", "s1", "s2");
    const next = restoreShapeEdges([workflowWire, staleConnector], nodes, [snapEdge]);
    expect(next.map((e) => e.id).sort()).toEqual(["e-old", "w1"]);
  });
});

describe("snapshots carry Frame membership (LOT2-122)", () => {
  const member = (frameId?: string): Node => ({ id: "t", type: "terminal", position: { x: 0, y: 0 }, data: { ...(frameId ? { frameId } : {}) } });
  const fr: Node = { id: "f1", type: "frame", position: { x: 0, y: 0 }, data: { title: "F" } };

  it("a membership change of a non-shape node makes snapshots differ", () => {
    const before = captureShapeSnapshot([fr, member()], []);
    expect(shapeSnapshotsEqual(before, captureShapeSnapshot([fr, member("f1")], []))).toBe(false);
    expect(shapeSnapshotsEqual(before, captureShapeSnapshot([fr, member()], []))).toBe(true);
  });

  it("history hands back the earlier membership so undo can restore it", () => {
    const history = createShapeHistory();
    const before = captureShapeSnapshot([fr, member()], []);
    const after = captureShapeSnapshot([fr, member("f1")], []);
    history.record(before, after);
    const undone = history.undo()!;
    expect(restoreMemberships([fr, member("f1")], undone.memberships).find((n) => n.id === "t")!.data).toEqual({});
    const redone = history.redo()!;
    expect(restoreMemberships([fr, member()], redone.memberships).find((n) => n.id === "t")!.data).toEqual({ frameId: "f1" });
  });

  it("spawning a node straight into a Frame is not a history step, and a later undo leaves it a member", () => {
    const base = captureShapeSnapshot([fr], []);
    const spawned = captureShapeSnapshot([fr, { ...member("f1"), id: "spawned" }], []);
    expect(shapeSnapshotsEqual(base, spawned)).toBe(true);
    // An earlier snapshot (taken before the spawn) must not strip the new node's Frame on restore.
    const restored = restoreMemberships([fr, { ...member("f1"), id: "spawned" }], base.memberships);
    expect(restored.find((n) => n.id === "spawned")!.data).toEqual({ frameId: "f1" });
  });

  it("removing a framed node is not a membership step either", () => {
    const withIt = captureShapeSnapshot([fr, member("f1")], []);
    expect(shapeSnapshotsEqual(withIt, captureShapeSnapshot([fr], []))).toBe(true);
  });

  it("restoring ignores a Frame that no longer exists", () => {
    expect(restoreMemberships([member()], { t: "gone" }).find((n) => n.id === "t")!.data).toEqual({});
  });
});

describe("Frames are history nodes (LOT2-123)", () => {
  const fr: Node = { id: "f1", type: "frame", position: { x: 0, y: 0 }, data: { title: "F" } };
  const term: Node = { id: "t", type: "terminal", position: { x: 5, y: 5 }, data: { frameId: "f1" } };

  it("undo of a Frame delete brings the Frame back behind its members, membership included", () => {
    const before = captureShapeSnapshot([fr, term], []);
    const loose: Node = { ...term, data: {} };
    const after = captureShapeSnapshot([loose], []);
    expect(shapeSnapshotsEqual(before, after)).toBe(false);
    const restored = restoreMemberships(restoreShapes([loose], before.placements), before.memberships);
    expect(restored.map((n) => n.id)).toEqual(["f1", "t"]);
    expect(restored[1].data).toEqual({ frameId: "f1" });
  });

  it("renaming or resizing a Frame is a history step", () => {
    const a = captureShapeSnapshot([fr], []);
    expect(shapeSnapshotsEqual(a, captureShapeSnapshot([{ ...fr, data: { title: "G" } }], []))).toBe(false);
    expect(shapeSnapshotsEqual(a, captureShapeSnapshot([{ ...fr, width: 900 }], []))).toBe(false);
  });
});
