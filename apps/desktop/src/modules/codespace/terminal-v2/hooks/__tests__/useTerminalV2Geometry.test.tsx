import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2Geometry } from "../useTerminalV2Geometry";

function createRuntime() {
  return {
    resizePaneSession: vi.fn(),
  };
}

describe("useTerminalV2Geometry", () => {
  it("routes valid geometry commits to the V2 runtime", () => {
    const runtime = createRuntime();

    const { result } = renderHook(() => useTerminalV2Geometry({ runtime: runtime as never }));
    result.current.sessionResizer?.resize("pane-1", 100, 30);

    expect(runtime.resizePaneSession).toHaveBeenCalledWith("pane-1", 100, 30);
  });

  it("skips duplicate geometry commits per pane", () => {
    const runtime = createRuntime();

    const { result } = renderHook(() => useTerminalV2Geometry({ runtime: runtime as never }));
    result.current.sessionResizer?.resize("pane-1", 100, 30);
    result.current.sessionResizer?.resize("pane-1", 100, 30);
    result.current.sessionResizer?.resize("pane-2", 100, 30);

    expect(runtime.resizePaneSession).toHaveBeenCalledTimes(2);
    expect(runtime.resizePaneSession).toHaveBeenNthCalledWith(1, "pane-1", 100, 30);
    expect(runtime.resizePaneSession).toHaveBeenNthCalledWith(2, "pane-2", 100, 30);
  });

  it("rejects invalid geometry", () => {
    const runtime = createRuntime();

    const { result } = renderHook(() => useTerminalV2Geometry({ runtime: runtime as never }));
    result.current.sessionResizer?.resize("pane-1", 0, 30);
    result.current.sessionResizer?.resize("pane-1", 100, -1);
    result.current.sessionResizer?.resize("pane-1", 100.5, 30);

    expect(runtime.resizePaneSession).not.toHaveBeenCalled();
  });

  it("returns no resizer when the V2 runtime is not active", () => {
    const { result } = renderHook(() => useTerminalV2Geometry({ runtime: null }));

    expect(result.current.sessionResizer).toBeUndefined();
  });
});
