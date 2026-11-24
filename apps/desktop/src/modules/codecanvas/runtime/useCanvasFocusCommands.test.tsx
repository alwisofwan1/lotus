import { renderHook } from "@testing-library/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCanvasFocusCommands } from "./useCanvasFocusCommands";
import { CANVAS_DOCK_EDGE, CANVAS_DOCK_WIDTH } from "../services/viewport/canvas-visible-frame";

function fakeFlow() {
  const fitView = vi.fn(async () => true);
  const flow = {
    fitView,
    getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  } as unknown as ReactFlowInstance<Node, Edge>;
  return { flow, fitView };
}

describe("useCanvasFocusCommands · focusCanvasNode", () => {
  let pane: HTMLDivElement;

  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; });
    pane = document.createElement("div");
    pane.className = "react-flow";
    pane.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 1440, bottom: 900, width: 1440, height: 900, toJSON: () => ({}) });
    document.body.appendChild(pane);
  });

  afterEach(() => {
    pane.remove();
    vi.restoreAllMocks();
  });

  it("centres in the whole pane while the Dock is closed", () => {
    const { flow, fitView } = fakeFlow();
    const { result } = renderHook(() => useCanvasFocusCommands({
      flowInstance: flow,
      focusNode: vi.fn(),
      readDock: () => ({ open: false, wide: false }),
    }));

    result.current.focusCanvasNode("agent-a");

    expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ padding: 0.32 }));
  });

  it("keeps the node clear of an open Dock: the right padding is the Dock plus the usual gap", () => {
    const { flow, fitView } = fakeFlow();
    const { result } = renderHook(() => useCanvasFocusCommands({
      flowInstance: flow,
      focusNode: vi.fn(),
      readDock: () => ({ open: true, wide: false }),
    }));

    result.current.focusCanvasNode("agent-a");

    // xyflow's own px for a 0.32 fraction on a 1440 pane, so the left and right gaps match.
    const gap = Math.floor((1440 - 1440 / 1.32) * 0.5);
    expect(fitView).toHaveBeenCalledWith(expect.objectContaining({
      padding: { top: 0.32, bottom: 0.32, left: 0.32, right: `${CANVAS_DOCK_WIDTH + CANVAS_DOCK_EDGE + gap}px` },
    }));
  });
});
