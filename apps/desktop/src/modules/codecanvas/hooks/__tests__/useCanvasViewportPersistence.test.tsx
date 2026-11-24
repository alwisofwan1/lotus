import { renderHook, waitFor } from "@testing-library/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveCanvasViewport } from "../../services/canvas-viewport-store";
import { resetCanvasBehaviorStoreForTests } from "../useCanvasBehaviorSettings";
import { useCanvasViewportPersistence } from "../useCanvasViewportPersistence";

function flowInstance(): ReactFlowInstance<Node, Edge> {
  return {
    setViewport: vi.fn(),
  } as unknown as ReactFlowInstance<Node, Edge>;
}

describe("useCanvasViewportPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCanvasBehaviorStoreForTests();
  });

  it("restores the Fleet viewport instead of the board viewport when Fleet is active", async () => {
    const flow = flowInstance();
    saveCanvasViewport("project-1", { x: 42, y: -18, zoom: 0.9 }, undefined, "board");
    saveCanvasViewport("project-1", { x: -80, y: 24, zoom: 1.1 }, undefined, "fleet");

    renderHook(() => useCanvasViewportPersistence("project-1", 3, flow, "fleet"));

    await waitFor(() => expect(flow.setViewport).toHaveBeenCalledOnce());
    expect(flow.setViewport).toHaveBeenCalledWith({ x: -80, y: 24, zoom: 1.1 }, { duration: 0 });
  });

  it("restores a saved project viewport instantly during project switches", async () => {
    const flow = flowInstance();
    saveCanvasViewport("project-1", { x: 42, y: -18, zoom: 0.9 });

    renderHook(() => useCanvasViewportPersistence("project-1", 3, flow));

    await waitFor(() => expect(flow.setViewport).toHaveBeenCalledOnce());
    expect(flow.setViewport).toHaveBeenCalledWith({ x: 42, y: -18, zoom: 0.9 }, { duration: 0 });
  });
});
