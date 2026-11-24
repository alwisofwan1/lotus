import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { useCanvasFrameGrid } from "../useCanvasFrameGrid";
import { canvasFrameOverviewStore } from "../../services/canvas-frame-overview-store";

const frame = (id: string): Node => ({ id, type: "frame", position: { x: 0, y: 0 }, width: 400, height: 300, data: { title: id } });

beforeEach(() => {
  const pane = document.createElement("div");
  pane.className = "react-flow";
  pane.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON: () => ({}) });
  document.body.appendChild(pane);
});
afterEach(() => {
  canvasFrameOverviewStore.close();
  document.body.innerHTML = "";
});

function setup(initial: Node[], boardReady = true, extra: Partial<Parameters<typeof useCanvasFrameGrid>[0]> = {}) {
  const applyFrameGrid = vi.fn((_slot: { width: number; height: number }, _swap?: readonly [string, string]) => ({
    minX: 0, minY: 0, width: 10, height: 10,
  }));
  const hook = renderHook(
    (p: { nodes: Node[]; ready: boolean; key: string }) => {
      const ref = { current: p.nodes };
      return useCanvasFrameGrid({ nodes: p.nodes, nodesRef: ref, canvasKey: p.key, boardReady: p.ready, applyFrameGrid, ...extra });
    },
    { initialProps: { nodes: initial, ready: boardReady, key: "c1" } },
  );
  return { applyFrameGrid, ...hook };
}

describe("useCanvasFrameGrid (decision 43)", () => {
  it("never snaps the Frames a canvas opens with", () => {
    const { applyFrameGrid } = setup([frame("a"), frame("b")]);
    expect(applyFrameGrid).not.toHaveBeenCalled();
  });

  it("snaps when a Frame is created or deleted, with the visible area as the slot", () => {
    const { applyFrameGrid, rerender } = setup([frame("a")]);
    rerender({ nodes: [frame("a"), frame("b")], ready: true, key: "c1" });
    expect(applyFrameGrid).toHaveBeenCalledTimes(1);
    expect(applyFrameGrid.mock.calls[0][0]).toEqual({ width: 1400 - 80 - 28, height: 900 - 60 - 92 });
    rerender({ nodes: [frame("b")], ready: true, key: "c1" });
    expect(applyFrameGrid).toHaveBeenCalledTimes(2);
  });

  it("a swap (same Frame set, new order) does not snap again", () => {
    const { applyFrameGrid, rerender } = setup([frame("a"), frame("b")]);
    rerender({ nodes: [frame("b"), frame("a")], ready: true, key: "c1" });
    expect(applyFrameGrid).not.toHaveBeenCalled();
  });

  it("does not snap while the Overview is open (it animates its own nodes)", () => {
    const { applyFrameGrid, rerender } = setup([frame("a")]);
    canvasFrameOverviewStore.open({}, null);
    rerender({ nodes: [frame("a"), frame("b")], ready: true, key: "c1" });
    expect(applyFrameGrid).not.toHaveBeenCalled();
  });

  it("treats a new canvas as a fresh baseline", () => {
    const { applyFrameGrid, rerender } = setup([frame("a")]);
    rerender({ nodes: [frame("x"), frame("y")], ready: true, key: "c2" });
    expect(applyFrameGrid).not.toHaveBeenCalled();
  });

  it("snapFrameGrid forwards a swap and returns the grid bounds", () => {
    const { applyFrameGrid, result } = setup([frame("a"), frame("b")]);
    const snap = result.current.snapFrameGrid(["a", "b"]);
    expect(applyFrameGrid).toHaveBeenCalledWith(expect.any(Object), ["a", "b"]);
    expect(snap?.bounds.width).toBe(10);
  });
});

describe("useCanvasFrameGrid with node focus and the camera", () => {
  const at = (id: string, x: number, y: number): Node => ({ id, type: "frame", position: { x, y }, width: 400, height: 300, data: { title: id } });

  it("REGRESSION: a Frame created during node focus snaps only once focus ends", () => {
    const focusedNodeIdRef = { current: "hero" as string | null };
    const { applyFrameGrid, rerender } = setup([frame("a")], true, { focusedNodeIdRef });
    rerender({ nodes: [frame("a"), frame("b")], ready: true, key: "c1" });
    expect(applyFrameGrid).not.toHaveBeenCalled();
    focusedNodeIdRef.current = null;
    rerender({ nodes: [frame("a"), frame("b")].map((n) => ({ ...n })), ready: true, key: "c1" });
    expect(applyFrameGrid).toHaveBeenCalledTimes(1);
  });

  it("REGRESSION: the camera follows the Frame it was looking at when the snap moves it", () => {
    // Looking at Frame a (viewport centre inside it); the grid will move a from (5000, 5000) to the grid origin.
    let viewport = { x: 700 - 5200, y: 450 - 5150, zoom: 1 };
    const flow = { getViewport: vi.fn(() => viewport), setViewport: vi.fn((v: typeof viewport) => { viewport = v; return Promise.resolve(true); }) };
    const { rerender } = setup([at("b", 0, 0), at("a", 5000, 5000)], true, { flowInstance: flow as never });
    rerender({ nodes: [at("b", 0, 0), at("a", 5000, 5000), at("c", 9000, 0)], ready: true, key: "c1" });
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    const moved = flow.setViewport.mock.calls[0][0];
    expect(moved.zoom).toBe(1);
    expect(moved.x).not.toBe(700 - 5200);
  });

  it("a camera looking at empty canvas stays where it is", () => {
    const viewport = { x: 50000, y: 50000, zoom: 1 };
    const flow = { getViewport: vi.fn(() => viewport), setViewport: vi.fn() };
    const { rerender } = setup([at("a", 0, 0)], true, { flowInstance: flow as never });
    rerender({ nodes: [at("a", 0, 0), at("b", 900, 0)], ready: true, key: "c1" });
    expect(flow.setViewport).not.toHaveBeenCalled();
  });
});
