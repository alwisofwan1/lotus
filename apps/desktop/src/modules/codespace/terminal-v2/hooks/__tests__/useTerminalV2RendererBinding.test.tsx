import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalV2XtermRendererSlot } from "../../rendering/terminal-v2-xterm-renderer-host";
import { useTerminalV2RendererBinding } from "../useTerminalV2RendererBinding";

function createRuntime() {
  return {
    updateRendererPane: vi.fn(),
    blurPaneRenderer: vi.fn(),
    registerLegacyRendererSlot: vi.fn((paneId: string, slot: TerminalV2XtermRendererSlot) => {
      void paneId;
      void slot;
      return vi.fn();
    }),
  };
}

function createHandles() {
  return {
    terminal: {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    },
    fitAddon: { fit: vi.fn() },
  };
}

describe("useTerminalV2RendererBinding", () => {
  it("publishes visible pane signals to the runtime renderer coordinator", () => {
    const runtime = createRuntime();

    renderHook(() => useTerminalV2RendererBinding({
      runtime: runtime as never,
      paneId: "pane-1",
      active: true,
      agentCommand: "claude",
    }));

    expect(runtime.updateRendererPane).toHaveBeenCalledWith({
      paneId: "pane-1",
      visible: true,
      focused: true,
      agentActive: true,
      liveResizeActive: false,
    });
  });

  it("publishes live resize state to the runtime renderer coordinator", () => {
    const runtime = createRuntime();

    renderHook(() => useTerminalV2RendererBinding({
      runtime: runtime as never,
      paneId: "pane-1",
      active: true,
      focused: true,
      liveResizeActive: true,
    }));

    expect(runtime.updateRendererPane).toHaveBeenCalledWith({
      paneId: "pane-1",
      visible: true,
      focused: true,
      agentActive: false,
      liveResizeActive: true,
    });
  });

  it("keeps visible unfocused panes out of renderer-focused state", () => {
    const runtime = createRuntime();

    renderHook(() => useTerminalV2RendererBinding({
      runtime: runtime as never,
      paneId: "pane-1",
      active: true,
      focused: false,
    }));

    expect(runtime.updateRendererPane).toHaveBeenCalledWith({
      paneId: "pane-1",
      visible: true,
      focused: false,
      agentActive: false,
      liveResizeActive: false,
    });
    expect(runtime.blurPaneRenderer).toHaveBeenCalledWith("pane-1");
  });

  it("releases the renderer pane on unmount", () => {
    const runtime = createRuntime();

    const { unmount } = renderHook(() => useTerminalV2RendererBinding({
      runtime: runtime as never,
      paneId: "pane-1",
    }));
    runtime.updateRendererPane.mockClear();
    unmount();

    expect(runtime.updateRendererPane).toHaveBeenCalledWith({ paneId: "pane-1", visible: false });
  });

  it("registers legacy-created xterm handles as fallback renderer slots", () => {
    const runtime = createRuntime();
    const callerCleanup = vi.fn();
    const callerReady = vi.fn(() => callerCleanup);
    const handles = createHandles();

    const { result } = renderHook(() => useTerminalV2RendererBinding({
      runtime: runtime as never,
      paneId: "pane-1",
      onRendererHandlesReady: callerReady,
    }));
    const cleanup = result.current.onRendererHandlesReady(handles);
    const slot = runtime.registerLegacyRendererSlot.mock.calls[0]?.[1];
    if (!slot) throw new Error("expected registered slot");

    slot.terminal.write("hello");
    slot.fitAddon.fit();
    cleanup();

    expect(callerReady).toHaveBeenCalledWith(handles);
    expect(runtime.registerLegacyRendererSlot).toHaveBeenCalledWith("pane-1", slot);
    expect(handles.terminal.write).toHaveBeenCalledWith("hello");
    expect(handles.fitAddon.fit).toHaveBeenCalledOnce();
    expect(callerCleanup).toHaveBeenCalledOnce();
  });
});
