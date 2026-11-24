import { act, renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canvasProjectViewStateStore,
  resetCanvasProjectViewStateStoreForTests,
} from "../services/canvas-project-view-state";
import { useCanvasProjectFocusView } from "./useCanvasProjectFocusView";

const node = (id: string): Node => ({ id, type: "agent", position: { x: 0, y: 0 }, data: {} });

function options(overrides: Partial<Parameters<typeof useCanvasProjectFocusView>[0]> = {}) {
  return {
    activeProjectId: "project-a",
    loading: false,
    ready: true,
    nodes: [node("agent-a")],
    setBeforeBoardSwap: vi.fn(),
    setPrepareNodesForSave: vi.fn(),
    inspectFocus: () => null,
    settleFocus: () => null,
    settleLayoutSnapshot: () => [],
    restoreFocus: vi.fn(),
    ...overrides,
  };
}

describe("useCanvasProjectFocusView", () => {
  beforeEach(() => {
    localStorage.clear();
    resetCanvasProjectViewStateStoreForTests();
  });

  it("registers canonical geometry for every autosave", () => {
    const snapshot = new Map([["agent-a", { x: 10, y: 20, width: 420, height: 320 }]]);
    const setPrepareNodesForSave = vi.fn();
    renderHook(() => useCanvasProjectFocusView(options({
      setPrepareNodesForSave,
      inspectFocus: () => ({ heroId: "agent-a", snapshot }),
    })));

    const prepare = setPrepareNodesForSave.mock.calls.at(-1)?.[0] as (nodes: Node[]) => Node[];
    const canonical = prepare([{ ...node("agent-a"), width: 1400, height: 900 }]);

    expect(canonical[0]).toMatchObject({ position: { x: 10, y: 20 }, width: 420, height: 320 });
  });

  it("captures the outgoing hero and returns its canonical layout before a board swap", () => {
    const setBeforeBoardSwap = vi.fn();
    const canonical = [node("agent-a")];
    const snapshot = new Map([["agent-a", { x: 10, y: 20, width: 400, height: 300 }]]);
    const settleFocus = vi.fn(() => ({ heroId: "agent-a", snapshot }));
    const settleLayoutSnapshot = vi.fn(() => canonical);
    renderHook(() => useCanvasProjectFocusView(options({ setBeforeBoardSwap, settleFocus, settleLayoutSnapshot })));

    const beforeSwap = setBeforeBoardSwap.mock.calls.at(-1)?.[0] as (() => Node[] | null);
    let outgoing: Node[] | null = null;
    act(() => { outgoing = beforeSwap(); });

    expect(canvasProjectViewStateStore.read("project-a")).toMatchObject({ mode: "focus", heroNodeId: "agent-a" });
    expect(settleLayoutSnapshot).toHaveBeenCalledWith(snapshot);
    expect(outgoing).toBe(canonical);
  });

  it("remembers board mode when nothing is focused at the swap", () => {
    canvasProjectViewStateStore.rememberFocus("project-a", "agent-a");
    const setBeforeBoardSwap = vi.fn();
    renderHook(() => useCanvasProjectFocusView(options({ setBeforeBoardSwap, nodes: [] })));

    const beforeSwap = setBeforeBoardSwap.mock.calls.at(-1)?.[0] as (() => Node[] | null);
    act(() => { beforeSwap(); });

    expect(canvasProjectViewStateStore.read("project-a").mode).toBe("board");
  });

  it("falls back to board mode when the remembered hero no longer exists", () => {
    canvasProjectViewStateStore.rememberFocus("project-a", "missing-agent");
    const restoreFocus = vi.fn();
    renderHook(() => useCanvasProjectFocusView(options({ restoreFocus })));

    expect(restoreFocus).not.toHaveBeenCalled();
    expect(canvasProjectViewStateStore.read("project-a").mode).toBe("board");
  });

  it("restores a save from the fleet-rail days as plain focus", () => {
    localStorage.setItem(
      "lotus.codecanvas.view.project-a",
      JSON.stringify({ version: 1, mode: "fleet", heroNodeId: "agent-a", railScrollTop: 72 }),
    );
    const restoreFocus = vi.fn();
    renderHook(() => useCanvasProjectFocusView(options({ restoreFocus })));

    expect(restoreFocus).toHaveBeenCalledWith("agent-a");
  });

  it("restores each project's own hero after switching away and back", () => {
    canvasProjectViewStateStore.rememberFocus("project-a", "agent-a");
    canvasProjectViewStateStore.rememberFocus("project-b", "agent-b");
    const restoreFocus = vi.fn();
    const setBeforeBoardSwap = vi.fn();

    const { rerender } = renderHook(
      ({ projectId, nodes }) => useCanvasProjectFocusView(options({ activeProjectId: projectId, nodes, restoreFocus, setBeforeBoardSwap })),
      { initialProps: { projectId: "project-a", nodes: [node("agent-a")] } },
    );
    expect(restoreFocus).toHaveBeenLastCalledWith("agent-a");

    rerender({ projectId: "project-b", nodes: [node("agent-b")] });
    expect(restoreFocus).toHaveBeenLastCalledWith("agent-b");

    rerender({ projectId: "project-a", nodes: [node("agent-a")] });
    expect(restoreFocus).toHaveBeenLastCalledWith("agent-a");
  });
});
