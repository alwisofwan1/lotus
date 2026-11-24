import { describe, expect, it, vi } from "vitest";
import { createTerminalV2PaneRuntimeAdapter } from "../terminal-v2-pane-runtime-adapter";

describe("createTerminalV2PaneRuntimeAdapter", () => {
  it("creates a pane runtime with a stable V2 lifecycle port", () => {
    const host = {
      drainHiddenBuffer: vi.fn(),
      writeToTerminal: vi.fn(),
      refreshViewport: vi.fn(),
      disposeTerminal: vi.fn(),
      commitFit: vi.fn(),
    };

    const runtime = createTerminalV2PaneRuntimeAdapter({ host, initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();

    expect(runtime.getSnapshot()).toMatchObject({
      state: "ready_visible",
      renderer: "canvas",
      visibleIntent: true,
      liveResizeActive: false,
    });
  });

  it("preserves hidden-buffer drain and viewport refresh entry actions", () => {
    const host = {
      drainHiddenBuffer: vi.fn((write: (chunk: string) => void) => write("hidden output")),
      writeToTerminal: vi.fn(),
      refreshViewport: vi.fn(),
      disposeTerminal: vi.fn(),
      commitFit: vi.fn(),
    };

    const runtime = createTerminalV2PaneRuntimeAdapter({ host, initiallyVisible: false });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();
    runtime.setVisible(true);

    expect(host.drainHiddenBuffer).toHaveBeenCalled();
    expect(host.writeToTerminal).toHaveBeenCalledWith("hidden output");
    expect(host.refreshViewport).toHaveBeenCalled();
  });

  it("commits one fit when live resize ends in a ready state", () => {
    const host = {
      drainHiddenBuffer: vi.fn(),
      writeToTerminal: vi.fn(),
      refreshViewport: vi.fn(),
      disposeTerminal: vi.fn(),
      commitFit: vi.fn(),
    };

    const runtime = createTerminalV2PaneRuntimeAdapter({ host, initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();
    runtime.notifyLiveResizeStart();
    runtime.notifyLiveResizeEnd();

    expect(host.commitFit).toHaveBeenCalledOnce();
    expect(runtime.isLiveResizing()).toBe(false);
  });
});
