import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2LegacyBridgeFallbackRuntime } from "../useTerminalV2LegacyBridgeFallbackRuntime";

const useTerminalRuntimeMock = vi.fn((options: unknown) => {
  void options;
  return {
  containerRef: { current: null },
  helperTextareaRef: { current: null },
  revealState: "settled",
  write: vi.fn(),
  focus: vi.fn(),
  fit: vi.fn(),
  fitViewport: vi.fn(),
};
});
const registerLegacyRendererSlot = vi.fn((paneId: string, slot: unknown) => {
  void paneId;
  void slot;
  return vi.fn();
});
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
const terminalV2Runtime = {
  registerLegacyRendererSlot,
  sessionStarter,
  updateRendererPane,
  writeRendererPaneOutput,
  resizePaneSession,
  writePaneInput,
  subscribePaneOutput,
};

vi.mock("@/modules/codespace/hooks/useLegacyTerminalRuntime", () => ({
  useLegacyTerminalRuntime: (options: unknown) => useTerminalRuntimeMock(options),
  useTerminalRuntime: (options: unknown) => useTerminalRuntimeMock(options),
}));

vi.mock("../../runtime/TerminalV2RuntimeProvider", () => ({
  useTerminalV2Runtime: () => ({ runtime: terminalV2Runtime }),
}));

describe("useTerminalV2LegacyBridgeFallbackRuntime", () => {
  it("subscribes pooled renderer output directly to the V2 session manager", () => {
    subscribePaneOutput.mockClear();
    writeRendererPaneOutput.mockClear();

    renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
    }));

    const listener = subscribePaneOutput.mock.calls[0]?.[1] as (data: string) => void;
    listener("prompt");

    expect(subscribePaneOutput).toHaveBeenCalledWith("pane-1", expect.any(Function));
    expect(writeRendererPaneOutput).toHaveBeenCalledWith("pane-1", "prompt");
    expect(useTerminalRuntimeMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("onRuntimeOutputMirror");
  });

  it("routes legacy geometry commits through the V2 runtime resizer seam", () => {
    resizePaneSession.mockClear();

    renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
    }));

    const options = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      sessionResizer: { resize(paneId: string, cols: number, rows: number): void };
    };
    options.sessionResizer.resize("pane-1", 100, 30);

    expect(resizePaneSession).toHaveBeenCalledWith("pane-1", 100, 30);
  });

  it("injects V2-owned renderer and xterm event factories into the legacy migration wrapper", () => {
    renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
    }));

    const options = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      rendererFactory?: unknown;
      rendererEventAdapter?: unknown;
      inputEventProcessor?: unknown;
      outputEventProcessor?: unknown;
      geometryEventAdapter?: unknown;
      paneRuntimeFactory?: unknown;
      writeSchedulerFactory?: unknown;
    };

    expect(options.rendererFactory).toEqual(expect.any(Function));
    expect(options.rendererEventAdapter).toEqual(expect.any(Function));
    expect(options.inputEventProcessor).toEqual(expect.any(Function));
    expect(options.outputEventProcessor).toEqual(expect.any(Function));
    expect(options.geometryEventAdapter).toMatchObject({
      resolveResizeEvent: expect.any(Function),
      resolveInitialGeometryEvent: expect.any(Function),
      resolveCommitFitEvent: expect.any(Function),
    });
    expect(options.paneRuntimeFactory).toEqual(expect.any(Function));
    expect(options.writeSchedulerFactory).toEqual(expect.any(Function));
  });

  it("injects V2 suggestion and link adapters into the legacy migration wrapper", () => {
    const onSuggestionRemainderChange = vi.fn();
    const onSuggestionLayoutChange = vi.fn();
    const onLinkContextMenu = vi.fn();

    renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
      onSuggestionRemainderChange,
      onSuggestionLayoutChange,
      onLinkContextMenu,
    }));

    const options = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      suggestionAdapter: { remainderChanged(remainder: string): void; layoutChanged(): void };
      linkContextAdapter: { openContextMenu(payload: { clientX: number; clientY: number }, rect: DOMRect | null): void };
    };
    options.suggestionAdapter.remainderChanged("npm test");
    options.suggestionAdapter.layoutChanged();
    options.linkContextAdapter.openContextMenu({ clientX: 120, clientY: 70 }, { left: 20, top: 10 } as DOMRect);

    expect(onSuggestionRemainderChange).toHaveBeenCalledWith("npm test");
    expect(onSuggestionLayoutChange).toHaveBeenCalledOnce();
    expect(onLinkContextMenu).toHaveBeenCalledWith(expect.objectContaining({ clientX: 100, clientY: 60 }));
  });

  it("injects V2 reveal policy into the legacy migration wrapper", () => {
    renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
    }));

    const options = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      revealPolicy: { resolve(input: { active: boolean; hasTerminal: boolean; hasRenderedOnce: boolean; currentGeneration: number }): unknown };
    };

    expect(options.revealPolicy.resolve({
      active: true,
      hasTerminal: true,
      hasRenderedOnce: true,
      currentGeneration: 0,
    })).toMatchObject({ revealState: "settled" });
  });

  it("routes legacy input writes through the V2 runtime writer seam", () => {
    writePaneInput.mockClear();

    renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
    }));

    const options = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      sessionWriter: { write(paneId: string, data: string): void };
    };
    options.sessionWriter.write("pane-1", "ls\r");

    expect(writePaneInput).toHaveBeenCalledWith("pane-1", "ls\r", undefined);
  });

  it("keeps native renderer lifecycle seam callbacks stable across same-input rerenders", () => {
    const options = {
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
      onSearchReady: vi.fn(),
    };

    const { rerender } = renderHook((props: typeof options) => useTerminalV2LegacyBridgeFallbackRuntime(props), {
      initialProps: options,
    });
    const firstRuntimeOptions = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      onRendererHandlesReady: unknown;
      onSearchReady: unknown;
      rendererFactory: unknown;
    };

    rerender(options);

    const secondRuntimeOptions = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      onRendererHandlesReady: unknown;
      onSearchReady: unknown;
      rendererFactory: unknown;
    };
    expect(secondRuntimeOptions.onRendererHandlesReady).toBe(firstRuntimeOptions.onRendererHandlesReady);
    expect(secondRuntimeOptions.onSearchReady).toBe(firstRuntimeOptions.onSearchReady);
    expect(secondRuntimeOptions.rendererFactory).toBe(firstRuntimeOptions.rendererFactory);
  });

  it("routes focus and search through V2 adapter seams", () => {
    const onSearchReady = vi.fn();
    const terminal = {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      focus: vi.fn(),
      rows: 24,
    };
    const fitAddon = { fit: vi.fn() };
    const searchApi = {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => false),
      clearSearch: vi.fn(),
    };

    const { result } = renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
      onSearchReady,
    }));

    const options = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      onRendererHandlesReady: (handles: { terminal: typeof terminal; fitAddon: typeof fitAddon }) => () => void;
      onSearchReady: (api: typeof searchApi) => void;
    };
    options.onRendererHandlesReady({ terminal, fitAddon });
    options.onSearchReady(searchApi);
    result.current.focus();

    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(onSearchReady).toHaveBeenCalledWith(searchApi);
  });

  it("registers legacy-created xterm handles with the Terminal V2 renderer host", () => {
    const callerCleanup = vi.fn();
    const callerReady = vi.fn(() => callerCleanup);
    const terminal = {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      focus: vi.fn(),
      rows: 24,
    };
    const fitAddon = { fit: vi.fn() };

    renderHook(() => useTerminalV2LegacyBridgeFallbackRuntime({
      workspaceId: "workspace-1",
      paneId: "pane-1",
      cwd: "/repo",
      fontSize: 12,
      history: [],
      onRendererHandlesReady: callerReady,
    }));

    const options = useTerminalRuntimeMock.mock.calls.at(-1)?.[0] as unknown as {
      onRendererHandlesReady: (handles: { terminal: typeof terminal; fitAddon: typeof fitAddon }) => () => void;
      sessionStarter: typeof sessionStarter;
    };
    const cleanup = options.onRendererHandlesReady({ terminal, fitAddon });
    const slot = registerLegacyRendererSlot.mock.calls.at(-1)?.[1] as {
      terminal: typeof terminal;
      fitAddon: typeof fitAddon;
    };

    slot.terminal.write("hello");
    slot.fitAddon.fit();
    cleanup();

    expect(options.sessionStarter).toBe(sessionStarter);
    expect(updateRendererPane).toHaveBeenCalledWith({
      paneId: "pane-1",
      visible: true,
      focused: true,
      agentActive: false,
      liveResizeActive: false,
    });
    expect(callerReady).toHaveBeenCalledWith({ terminal, fitAddon });
    expect(registerLegacyRendererSlot).toHaveBeenCalledWith("pane-1", slot);
    expect(terminal.write).toHaveBeenCalledWith("hello");
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(callerCleanup).toHaveBeenCalledOnce();
  });
});
