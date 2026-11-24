import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2PaneRuntime } from "../useTerminalV2PaneRuntime";

const registerLegacyRendererSlot = vi.fn(() => vi.fn());
const sessionStarter = { start: vi.fn() };
const updateRendererPane = vi.fn();
const writeRendererPaneOutput = vi.fn();
const resizePaneSession = vi.fn();
const writePaneInput = vi.fn();
const subscribePaneOutput = vi.fn((paneId: string, listener: (data: string) => void) => {
  void paneId;
  void listener;
  return vi.fn();
});

vi.mock("../../runtime/TerminalV2RuntimeProvider", () => ({
  useTerminalV2Runtime: () => ({
    runtime: {
      registerLegacyRendererSlot,
      sessionStarter,
      updateRendererPane,
      writeRendererPaneOutput,
      resizePaneSession,
      writePaneInput,
      subscribePaneOutput,
    },
  }),
}));

describe("useTerminalV2PaneRuntime", () => {
  it("composes all V2 migration adapters behind one hook", () => {
    const { result } = renderHook(() => useTerminalV2PaneRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
    }));

    expect(result.current.legacyOptions).toMatchObject({
      hiddenOutputBufferFactory: expect.any(Function),
      onRendererHandlesReady: expect.any(Function),
      onSearchReady: expect.any(Function),
      sessionStarter,
      sessionResizer: expect.objectContaining({ resize: expect.any(Function) }),
      sessionWriter: expect.objectContaining({ write: expect.any(Function) }),
      revealPolicy: expect.objectContaining({ resolve: expect.any(Function) }),
      suggestionAdapter: expect.objectContaining({ remainderChanged: expect.any(Function) }),
      linkContextAdapter: expect.objectContaining({ openContextMenu: expect.any(Function) }),
      rendererFactory: expect.any(Function),
      rendererEventAdapter: expect.any(Function),
      inputEventProcessor: expect.any(Function),
      outputEventProcessor: expect.any(Function),
      geometryEventAdapter: expect.objectContaining({
        resolveResizeEvent: expect.any(Function),
        resolveInitialGeometryEvent: expect.any(Function),
        resolveCommitFitEvent: expect.any(Function),
      }),
      paneRuntimeFactory: expect.any(Function),
      writeSchedulerFactory: expect.any(Function),
    });
  });

  it("routes session resize and writes through the V2 runtime", () => {
    const { result } = renderHook(() => useTerminalV2PaneRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
    }));

    result.current.legacyOptions.sessionResizer?.resize("pane-1", 120, 40);
    result.current.legacyOptions.sessionWriter?.write("pane-1", "ls\r", { origin: "human" });

    expect(resizePaneSession).toHaveBeenCalledWith("pane-1", 120, 40);
    expect(writePaneInput).toHaveBeenCalledWith("pane-1", "ls\r", { origin: "human" });
  });

  it("preserves renderer handle callback and focus seam", () => {
    const callerCleanup = vi.fn();
    const onRendererHandlesReady = vi.fn(() => callerCleanup);
    const terminal = {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      focus: vi.fn(),
      rows: 24,
    };
    const fitAddon = { fit: vi.fn() };
    const { result } = renderHook(() => useTerminalV2PaneRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
      onRendererHandlesReady,
    }));

    const cleanup = result.current.legacyOptions.onRendererHandlesReady?.({ terminal, fitAddon });
    result.current.focus();
    cleanup?.();

    expect(onRendererHandlesReady).toHaveBeenCalledWith({ terminal, fitAddon });
    expect(registerLegacyRendererSlot).toHaveBeenCalledWith("pane-1", expect.any(Object));
    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(callerCleanup).toHaveBeenCalledOnce();
  });
});
