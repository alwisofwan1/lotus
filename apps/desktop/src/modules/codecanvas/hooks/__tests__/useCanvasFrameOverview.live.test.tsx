import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { useCanvasFrameOverview } from "../useCanvasFrameOverview";
import { canvasFrameOverviewStore } from "../../services/canvas-frame-overview-store";

const frame = (id: string, x = 0): Node => ({ id, type: "frame", position: { x, y: 0 }, width: 800, height: 600, data: { title: id } });
const win = (id: string, frameId: string): Node => ({ id, type: "terminal", position: { x: 0, y: 0 }, width: 300, height: 200, data: { frameId } });

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

describe("useCanvasFrameOverview live labels (decision 42)", () => {
  it("recomputes the labels while Overview is open when nodes change", () => {
    const flow = { getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })), setViewport: vi.fn(async () => true) };
    const base = [frame("a"), frame("b", 2000), win("m1", "a")];
    const { result, rerender } = renderHook(
      (p: { nodes: Node[] }) =>
        useCanvasFrameOverview({
          flowInstance: flow as never,
          nodes: p.nodes,
          statuses: [],
          zoomBounds: { minZoom: 0.1, maxZoom: 2 },
          canvasKey: "c",
          focusFrame: vi.fn(),
        }),
      { initialProps: { nodes: base } },
    );
    act(() => result.current.toggle());
    expect(canvasFrameOverviewStore.get().labels.a.text).toBe("1 · 1 node");
    rerender({ nodes: [...base, win("m2", "a"), win("m3", "b")] });
    expect(canvasFrameOverviewStore.get().labels.a.text).toBe("1 · 2 nodes");
    expect(canvasFrameOverviewStore.get().labels.b.text).toBe("2 · 1 node");
  });
});
