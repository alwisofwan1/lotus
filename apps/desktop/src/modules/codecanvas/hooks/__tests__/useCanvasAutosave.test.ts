import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import type { Edge, Node } from "@xyflow/react";
import { useCanvasAutosave, type CanvasAutosaveState } from "../useCanvasAutosave";

const nodes: Node[] = [{ id: "n1", type: "note", position: { x: 0, y: 0 }, data: {} }];
const edges: Edge[] = [];

function harness(save: (nodes: Node[], edges: Edge[]) => void | Promise<void>, delayMs = 20) {
  return renderHook(() => {
    const saveFnRef = useRef(save);
    return useCanvasAutosave(saveFnRef, delayMs);
  });
}

describe("useCanvasAutosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports dirty, saving, then saved around a successful debounced save", async () => {
    let resolveSave: () => void = () => {};
    const save = vi.fn(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const { result } = harness(save);

    act(() => result.current.schedule(nodes, edges));
    expect(result.current.state).toEqual<CanvasAutosaveState>({ status: "dirty", error: null });

    act(() => vi.advanceTimersByTime(20));
    expect(save).toHaveBeenCalledWith(nodes, edges);
    expect(result.current.state.status).toBe("saving");

    await act(async () => { resolveSave(); await Promise.resolve(); });
    expect(result.current.state).toEqual<CanvasAutosaveState>({ status: "saved", error: null });
  });

  it("reports failed when the save function rejects", async () => {
    const save = vi.fn(async () => { throw new Error("disk full"); });
    const { result } = harness(save);

    act(() => result.current.schedule(nodes, edges));
    await act(async () => {
      vi.advanceTimersByTime(20);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.state.status).toBe("failed");
    expect(result.current.state.error).toBe("disk full");
  });
});
