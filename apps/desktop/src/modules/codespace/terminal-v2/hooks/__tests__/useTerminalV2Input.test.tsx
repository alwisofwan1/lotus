import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2Input } from "../useTerminalV2Input";

function createRuntime() {
  return {
    writePaneInput: vi.fn(),
  };
}

describe("useTerminalV2Input", () => {
  it("routes terminal input writes to the V2 runtime", () => {
    const runtime = createRuntime();

    const { result } = renderHook(() => useTerminalV2Input({ runtime: runtime as never }));
    result.current.sessionWriter?.write("pane-1", "ls\r", {
      origin: "human",
      intent: "unknown",
      submitted: false,
    });

    expect(runtime.writePaneInput).toHaveBeenCalledWith("pane-1", "ls\r", {
      origin: "human",
      intent: "unknown",
      submitted: false,
    });
  });

  it("skips empty input writes", () => {
    const runtime = createRuntime();

    const { result } = renderHook(() => useTerminalV2Input({ runtime: runtime as never }));
    result.current.sessionWriter?.write("pane-1", "");

    expect(runtime.writePaneInput).not.toHaveBeenCalled();
  });

  it("returns no writer when V2 runtime is inactive", () => {
    const { result } = renderHook(() => useTerminalV2Input({ runtime: null }));

    expect(result.current.sessionWriter).toBeUndefined();
  });
});
