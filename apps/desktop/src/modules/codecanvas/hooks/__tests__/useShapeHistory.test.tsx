import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderHook } from "@testing-library/react";
import type { Edge, Node } from "@xyflow/react";
import { useShapeHistory, SHAPE_HISTORY_COMMIT_MS } from "../useShapeHistory";
import { restoreShapes, type ShapeSnapshot } from "../../services/canvas-shape-history";
import { markLayoutBoard } from "../../services/canvas-board-marks";

const shape = (id: string, x = 0): Node => ({ id, type: "shape", position: { x, y: 0 }, data: { shape: "rectangle" } });
const connector = (id: string, source: string, target: string): Edge => ({ id, source, target, data: {} });

interface BoardProps { nodes: Node[]; edges: Edge[]; resetKey: string | null }

function setup(initialNodes: Node[] = [], initialEdges: Edge[] = []) {
  const restore = vi.fn<(snapshot: ShapeSnapshot) => void>();
  const view = renderHook(
    ({ nodes, edges, resetKey }: BoardProps) => useShapeHistory({ nodes, edges, resetKey, restore }),
    { initialProps: { nodes: initialNodes, edges: initialEdges, resetKey: "project-1" } },
  );
  const mutate = (nodes: Node[], edges: Edge[] = [], resetKey = "project-1") => {
    view.rerender({ nodes, edges, resetKey });
    act(() => { vi.advanceTimersByTime(SHAPE_HISTORY_COMMIT_MS + 10); });
  };
  const lastSnapshot = () => restore.mock.calls.at(-1)![0];
  return { ...view, restore, mutate, lastSnapshot };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("useShapeHistory", () => {
  it("undoes the last committed shape mutation and redoes it", () => {
    const s1 = shape("s1");
    const { result, restore, mutate, lastSnapshot } = setup([]);
    mutate([s1]);
    act(() => { result.current.undo(); });
    expect(lastSnapshot().placements).toEqual([]);
    act(() => { result.current.redo(); });
    expect(lastSnapshot().placements).toEqual([{ node: s1, index: 0 }]);
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it("coalesces rapid mutations (a drag) into one undo step", () => {
    const { result, rerender, lastSnapshot } = setup([]);
    rerender({ nodes: [shape("s1", 1)], edges: [], resetKey: "project-1" });
    act(() => { vi.advanceTimersByTime(SHAPE_HISTORY_COMMIT_MS / 2); });
    rerender({ nodes: [shape("s1", 2)], edges: [], resetKey: "project-1" });
    act(() => { vi.advanceTimersByTime(SHAPE_HISTORY_COMMIT_MS / 2); });
    rerender({ nodes: [shape("s1", 3)], edges: [], resetKey: "project-1" });
    act(() => { vi.advanceTimersByTime(SHAPE_HISTORY_COMMIT_MS + 10); });
    act(() => { result.current.undo(); });
    expect(lastSnapshot().placements).toEqual([]); // one step back = before the whole gesture
  });

  it("flushes a pending (not yet idle) mutation before undoing, so nothing is skipped", () => {
    const { result, rerender, lastSnapshot } = setup([]);
    rerender({ nodes: [shape("s1")], edges: [], resetKey: "project-1" });
    act(() => { result.current.undo(); }); // idle window has NOT elapsed
    expect(lastSnapshot().placements).toEqual([]);
  });

  it("does not record the state produced by its own restore (undo then redo stays symmetric)", () => {
    const s1 = shape("s1");
    const { result, mutate, lastSnapshot } = setup([]);
    mutate([s1]);
    act(() => { result.current.undo(); });
    mutate([]); // board applies the restore and re-renders
    act(() => { result.current.redo(); });
    expect(lastSnapshot().placements).toEqual([{ node: s1, index: 0 }]);
  });

  it("ignores non-shape node churn (terminal added → nothing to undo)", () => {
    const { result, restore, mutate } = setup([]);
    mutate([{ id: "term", type: "terminal", position: { x: 0, y: 0 }, data: {} }]);
    act(() => { result.current.undo(); });
    expect(restore).not.toHaveBeenCalled();
  });

  it("clears history when the project changes", () => {
    const { result, restore, mutate } = setup([]);
    mutate([shape("s1")]);
    mutate([], [], "project-2"); // switch project
    act(() => { result.current.undo(); });
    expect(restore).not.toHaveBeenCalled();
  });

  it("binds ⌘Z to undo and ⇧⌘Z to redo", () => {
    const s1 = shape("s1");
    const { mutate, lastSnapshot } = setup([]);
    mutate([s1]);
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(lastSnapshot().placements).toEqual([]);
    mutate([]);
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    expect(lastSnapshot().placements).toEqual([{ node: s1, index: 0 }]);
  });

  it("leaves ⌘Z alone while the user is typing in an editable target", () => {
    const { restore, mutate } = setup([]);
    mutate([shape("s1")]);
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);
    fireEvent.keyDown(textarea, { key: "z", metaKey: true });
    expect(restore).not.toHaveBeenCalled();
    textarea.remove();
  });

  it("does not spend an undo step on a click-select between the mutation and ⌘Z", () => {
    const s1 = shape("s1");
    const { result, mutate, lastSnapshot } = setup([]);
    mutate([s1]);
    mutate([{ ...s1, selected: true }]); // user clicks the shape — xyflow swaps in a new object
    act(() => { result.current.undo(); });
    expect(lastSnapshot().placements).toEqual([]); // straight back to the empty board
  });
});

describe("useShapeHistory connectors", () => {
  it("undoing an erased shape restores its connectors with it", () => {
    const s1 = shape("s1");
    const s2 = shape("s2");
    const e1 = connector("e1", "s1", "s2");
    const { result, mutate, lastSnapshot } = setup([s1, s2], [e1]);
    mutate([s1], []); // erase s2 — its connector goes with it (removeNode drops touching edges)
    act(() => { result.current.undo(); });
    const snap = lastSnapshot();
    expect(snap.placements.map((p) => p.node.id)).toEqual(["s1", "s2"]);
    expect(snap.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("a connector added between shapes is its own undoable step", () => {
    const s1 = shape("s1");
    const s2 = shape("s2");
    const { result, mutate, lastSnapshot } = setup([s1, s2], []);
    mutate([s1, s2], [connector("e1", "s1", "s2")]);
    act(() => { result.current.undo(); });
    expect(lastSnapshot().edges).toEqual([]);
    expect(lastSnapshot().placements.map((p) => p.node.id)).toEqual(["s1", "s2"]);
  });

  it("ignores wires touching workflow nodes (no undo step for them)", () => {
    const s1 = shape("s1");
    const t1: Node = { id: "t1", type: "terminal", position: { x: 0, y: 0 }, data: {} };
    const { result, restore, mutate } = setup([s1, t1], []);
    mutate([s1, t1], [connector("w1", "s1", "t1")]);
    act(() => { result.current.undo(); });
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("useShapeHistory restore rebaselining", () => {
  it("keeps the redo branch when a restored snapshot contained a selected shape (restore rewrites it deselected)", () => {
    const selectedRect = { ...shape("rect"), selected: true };
    const { result, restore, rerender } = setup([selectedRect]);
    const ellipse = shape("ellipse");
    rerender({ nodes: [selectedRect, ellipse], edges: [], resetKey: "project-1" });
    act(() => { vi.advanceTimersByTime(SHAPE_HISTORY_COMMIT_MS + 10); });
    act(() => { result.current.undo(); });
    // the board applies the restore FOR REAL: the selected rect comes back as a NEW deselected object
    const restoredBoard = restoreShapes([selectedRect, ellipse], restore.mock.calls.at(-1)![0].placements);
    rerender({ nodes: restoredBoard, edges: [], resetKey: "project-1" });
    act(() => { vi.advanceTimersByTime(SHAPE_HISTORY_COMMIT_MS + 10); }); // identity drift must rebaseline, not record
    act(() => { result.current.redo(); });
    const redone = restore.mock.calls.at(-1)![0];
    expect(redone.placements.map((p: { node: Node }) => p.node.id)).toEqual(["rect", "ellipse"]);
  });
});

describe("useShapeHistory and automatic layout (Frame focus, re-tile, Grid snap)", () => {
  const frame = (id: string, x: number): Node => ({ id, type: "frame", position: { x, y: 0 }, width: 400, height: 300, data: { title: id } });

  it("REGRESSION: a layout write is adopted as the baseline, never an undo step", () => {
    const { result, restore, mutate } = setup([frame("f", 0)]);
    mutate(markLayoutBoard([frame("f", 500)]));
    act(() => { result.current.undo(); });
    expect(restore).not.toHaveBeenCalled();
  });

  it("a user change still pending when a layout lands is kept as its own step", () => {
    const { result, rerender, mutate, lastSnapshot } = setup([frame("f", 0)]);
    rerender({ nodes: [frame("f", 50)], edges: [], resetKey: "project-1" });
    mutate(markLayoutBoard([frame("f", 500)]));
    act(() => { result.current.undo(); });
    expect(lastSnapshot().placements[0].node.position.x).toBe(0);
  });
});
