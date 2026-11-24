import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { canvasActiveFrameStore, decideUserArrange, nearestFrameId, resolveActiveFrameId } from "../canvas-active-frame";

const frame = (id: string, x = 0, y = 0, w = 400, h = 300): Node => ({
  id, type: "frame", position: { x, y }, width: w, height: h, data: { title: id },
});
const terminal = (id: string): Node => ({ id, type: "terminal", position: { x: 0, y: 0 }, data: {} });

describe("resolveActiveFrameId (decision 36)", () => {
  const nodes = [frame("a", 0), frame("b", 1000), frame("c", 2000)];
  it("keeps a stored id that still names a Frame", () => {
    expect(resolveActiveFrameId(nodes, "b")).toBe("b");
  });
  it("falls back to the first Frame in switcher order when the stored id is missing or unknown", () => {
    expect(resolveActiveFrameId(nodes, null)).toBe("a");
    expect(resolveActiveFrameId(nodes, "gone")).toBe("a");
  });
  it("is null when the canvas has no Frame", () => {
    expect(resolveActiveFrameId([terminal("t")], "a")).toBeNull();
  });
  it("does not treat a non-Frame node id as a Frame", () => {
    expect(resolveActiveFrameId([frame("a"), terminal("t")], "t")).toBe("a");
  });
});

describe("decideUserArrange (decision 40)", () => {
  it("focuses the active Frame when the canvas has Frames", () => {
    const nodes = [frame("a", 0), frame("b", 1000)];
    expect(decideUserArrange(nodes, "b")).toEqual({ kind: "focus-frame", frameId: "b" });
  });
  it("falls back to the first Frame when the stored id is stale", () => {
    expect(decideUserArrange([frame("a"), frame("b", 1000)], "gone")).toEqual({ kind: "focus-frame", frameId: "a" });
  });
  it("arranges the whole canvas when there is no Frame", () => {
    expect(decideUserArrange([terminal("t")], null)).toEqual({ kind: "canvas" });
  });
});

describe("nearestFrameId (deleting the active Frame)", () => {
  it("picks the remaining Frame whose centre is nearest the deleted one", () => {
    const deleted = frame("b", 1000);
    const remaining = [frame("a", 0), frame("c", 1500), frame("d", 5000)];
    expect(nearestFrameId(remaining, deleted)).toBe("c");
  });
  it("is null when nothing remains", () => {
    expect(nearestFrameId([], frame("b"))).toBeNull();
  });
  it("breaks ties by switcher order", () => {
    expect(nearestFrameId([frame("l", 0), frame("r", 2000)], frame("m", 1000))).toBe("l");
  });
});

describe("canvasActiveFrameStore", () => {
  beforeEach(() => {
    canvasActiveFrameStore.reset();
    try { localStorage.clear(); } catch { /* none */ }
  });
  it("keeps one active Frame per canvas", () => {
    canvasActiveFrameStore.set("canvas-1", "a");
    canvasActiveFrameStore.set("canvas-2", "z");
    expect(canvasActiveFrameStore.get("canvas-1")).toBe("a");
    expect(canvasActiveFrameStore.get("canvas-2")).toBe("z");
  });
  it("persists per canvas and restores after the in-memory state is gone", () => {
    canvasActiveFrameStore.set("canvas-1", "a");
    canvasActiveFrameStore.reset({ keepStorage: true });
    expect(canvasActiveFrameStore.get("canvas-1")).toBe("a");
  });
  it("notifies subscribers only on a real change", () => {
    const fn = vi.fn();
    const off = canvasActiveFrameStore.subscribe(fn);
    canvasActiveFrameStore.set("c", "a");
    canvasActiveFrameStore.set("c", "a");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    canvasActiveFrameStore.set("c", "b");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("clears with null", () => {
    canvasActiveFrameStore.set("c", "a");
    canvasActiveFrameStore.set("c", null);
    canvasActiveFrameStore.reset({ keepStorage: true });
    expect(canvasActiveFrameStore.get("c")).toBeNull();
  });
  it("survives a throwing storage", () => {
    const boom = () => { throw new Error("denied"); };
    vi.stubGlobal("localStorage", { getItem: boom, setItem: boom, removeItem: boom });
    try {
      expect(() => canvasActiveFrameStore.set("c", "a")).not.toThrow();
      expect(canvasActiveFrameStore.get("c")).toBe("a");
      canvasActiveFrameStore.reset({ keepStorage: true });
      expect(canvasActiveFrameStore.get("c")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("canvasActiveFrameStore.forget (a closed canvas)", () => {
  it("drops the saved id from memory and storage", () => {
    canvasActiveFrameStore.set("closed", "f1");
    canvasActiveFrameStore.forget("closed");
    expect(canvasActiveFrameStore.get("closed")).toBeNull();
    expect(window.localStorage.getItem("lotus.canvas.activeFrame.v1:closed")).toBeNull();
  });
});
