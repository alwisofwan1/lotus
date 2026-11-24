import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTerminalV2Session } from "../useTerminalV2Session";

const sessionStarter = { start: vi.fn() };
const writeRendererPaneOutput = vi.fn();
const detachPaneSession = vi.fn();
const unsubscribeOutput = vi.fn();
const subscribePaneOutput = vi.fn((paneId: string, listener: (data: string) => void) => {
  void paneId;
  void listener;
  return unsubscribeOutput;
});
const runtime = {
  sessionStarter,
  subscribePaneOutput,
  writeRendererPaneOutput,
  detachPaneSession,
};

vi.mock("../../runtime/TerminalV2RuntimeProvider", () => ({
  useTerminalV2Runtime: () => ({ runtime }),
}));

describe("useTerminalV2Session", () => {
  afterEach(() => {
    subscribePaneOutput.mockClear();
    writeRendererPaneOutput.mockClear();
    unsubscribeOutput.mockClear();
    detachPaneSession.mockClear();
  });

  it("exposes the app-level V2 session starter", () => {
    const { result } = renderHook(() => useTerminalV2Session({ paneId: "pane-1" }));

    expect(result.current.runtime).toBe(runtime);
    expect(result.current.sessionStarter).toBe(sessionStarter);
    result.current.sessionDetacher?.detach("pane-1");
    expect(detachPaneSession).toHaveBeenCalledWith("pane-1");
  });

  it("subscribes pane output directly into the V2 renderer pipeline", () => {
    const { unmount } = renderHook(() => useTerminalV2Session({ paneId: "pane-1" }));

    const listener = subscribePaneOutput.mock.calls[0]?.[1];
    if (!listener) throw new Error("expected pane output listener");
    listener("prompt");
    unmount();

    expect(subscribePaneOutput).toHaveBeenCalledWith("pane-1", expect.any(Function));
    expect(writeRendererPaneOutput).toHaveBeenCalledWith("pane-1", "prompt");
    expect(unsubscribeOutput).toHaveBeenCalled();
  });

  it("can opt out of renderer mirroring during fallback experiments", () => {
    renderHook(() => useTerminalV2Session({
      paneId: "pane-1",
      mirrorOutputToRenderer: false,
    }));

    expect(subscribePaneOutput).not.toHaveBeenCalled();
  });
});
