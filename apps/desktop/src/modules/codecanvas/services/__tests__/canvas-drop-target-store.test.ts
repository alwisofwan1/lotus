import { describe, expect, it, vi } from "vitest";
import { canvasDropTargetStore, pickIntersectingDropTarget } from "../canvas-drop-target-store";

describe("pickIntersectingDropTarget", () => {
  it("returns the first terminal/agent node id among the intersecting nodes", () => {
    expect(pickIntersectingDropTarget([{ id: "n1", type: "note" }, { id: "a1", type: "agent" }])).toBe("a1");
    expect(pickIntersectingDropTarget([{ id: "t1", type: "terminal" }])).toBe("t1");
  });

  it("ignores non-PTY node types (note, shape, plan) and empty lists", () => {
    expect(pickIntersectingDropTarget([{ id: "s1", type: "shape" }, { id: "n1", type: "note" }])).toBeNull();
    expect(pickIntersectingDropTarget([])).toBeNull();
    expect(pickIntersectingDropTarget([{ id: "x", type: undefined }])).toBeNull();
  });
});

describe("canvasDropTargetStore", () => {
  it("holds the armed node id and notifies subscribers on change", () => {
    canvasDropTargetStore.set(null);
    const seen: (string | null)[] = [];
    const unsub = canvasDropTargetStore.subscribe(() => seen.push(canvasDropTargetStore.get()));

    canvasDropTargetStore.set("agent-1");
    expect(canvasDropTargetStore.get()).toBe("agent-1");
    canvasDropTargetStore.set(null);
    expect(seen).toEqual(["agent-1", null]);
    unsub();
  });

  it("is a no-op (no notification) when set to the same value", () => {
    canvasDropTargetStore.set("term-9");
    const cb = vi.fn();
    const unsub = canvasDropTargetStore.subscribe(cb);
    canvasDropTargetStore.set("term-9");
    expect(cb).not.toHaveBeenCalled();
    unsub();
    canvasDropTargetStore.set(null);
  });

  it("stops notifying after unsubscribe", () => {
    canvasDropTargetStore.set(null);
    const cb = vi.fn();
    const unsub = canvasDropTargetStore.subscribe(cb);
    unsub();
    canvasDropTargetStore.set("x");
    expect(cb).not.toHaveBeenCalled();
    canvasDropTargetStore.set(null);
  });
});
