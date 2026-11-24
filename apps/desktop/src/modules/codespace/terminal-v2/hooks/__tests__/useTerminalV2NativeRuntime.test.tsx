import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalV2NativeSearchAddon } from "../../runtime/terminal-v2-native-search";
import { useTerminalV2NativeRuntime } from "../useTerminalV2NativeRuntime";

const sessionStarter = { start: vi.fn() };
const sessionWriter = { write: vi.fn() };
const sessionResizer = { resize: vi.fn() };
const sessionDetacher = { detach: vi.fn() };
const focus = vi.fn();
const rendererDispose = vi.fn();
const rendererEventDispose = vi.fn();
const handlesCleanup = vi.fn();
const fitAddon = { fit: vi.fn(), proposeDimensions: vi.fn(() => ({ cols: 121, rows: 33 })) };
const searchAddon = {
  findNext: vi.fn<TerminalV2NativeSearchAddon["findNext"]>(() => true),
  findPrevious: vi.fn<TerminalV2NativeSearchAddon["findPrevious"]>(() => false),
  clearDecorations: vi.fn(),
};
const terminal = { cols: 120, rows: 32, focus: vi.fn(), dispose: vi.fn(), options: {} as { theme?: unknown; fontSize?: number } };
let rendererRequest: {
  cwd: string;
  fontSize: number;
  container: HTMLElement;
  onLinkContextMenu: (payload: {
    clientX: number;
    clientY: number;
    link: { kind: "external"; url: string; text: string };
  }) => void;
} | null = null;
const rendererFactory = vi.fn(async (request: typeof rendererRequest) => {
  rendererRequest = request;
  return {
    terminal,
    addons: { fitAddon, searchAddon },
    helperTextarea: document.createElement("textarea"),
    dispose: rendererDispose,
  };
});
let rendererEventRequest: { handlers: { onData(data: string): void; onRender(): void } } | null = null;
const rendererEventAdapter = vi.fn((request: { handlers: { onData(data: string): void; onRender(): void } }) => {
  rendererEventRequest = request;
  return { dispose: rendererEventDispose };
});
const inputEventProcessor = vi.fn((request: { data: string }): {
  nextInput: string;
  suggestionRemainder: string;
  submittedPrompt: string;
  writeRequest: { data: string; metadata: { origin: "human"; intent: "unknown"; submitted: false } } | null;
  cwdProbeCommand: string | null;
} => ({
  nextInput: request.data,
  suggestionRemainder: "",
  submittedPrompt: "",
  writeRequest: {
    data: request.data,
    metadata: { origin: "human", intent: "unknown", submitted: false },
  },
  cwdProbeCommand: null,
}));
const suggestionAdapter = {
  remainderChanged: vi.fn(),
  layoutChanged: vi.fn(),
};
const linkContextAdapter = {
  openContextMenu: vi.fn(),
};
const outputEventProcessor = vi.fn((request: { data: string }): {
  visibleData: string;
  cwdUpdates: unknown[];
  osc133Events: unknown[];
  exitCode: number | null;
  outputRoute: "visible" | "hidden" | "none";
  nextTrustPromptSeen: boolean;
  autoTrustResponse: string | null;
  rememberTrustedCwd: boolean;
  resizeAfterTrust: boolean;
  scheduleSuggestionLayout: boolean;
} => ({
  visibleData: request.data,
  cwdUpdates: [],
  osc133Events: [],
  exitCode: null,
  outputRoute: "visible",
  nextTrustPromptSeen: false,
  autoTrustResponse: null,
  rememberTrustedCwd: false,
  resizeAfterTrust: false,
  scheduleSuggestionLayout: false,
}));
const scheduler = {
  push: vi.fn(),
  flush: vi.fn(),
  dispose: vi.fn(),
  hasPending: vi.fn(() => false),
};
const writeSchedulerFactory = vi.fn(() => scheduler);
const unregisterPaneInputPipeline = vi.fn();
const paneInputPipeline = {
  register: vi.fn((paneId: string, handleInput: (data: string) => void) => {
    void paneId;
    void handleInput;
    return unregisterPaneInputPipeline;
  }),
};
let standbyBacklogActive = false;
const rendererStandbyBacklog = {
  isActive: vi.fn(() => standbyBacklogActive),
  append: vi.fn(),
  clear: vi.fn(),
};
type ResizeDecision =
  | { kind: "fit" }
  | { kind: "skip-fit" }
  | { kind: "ignore"; reason: "inactive" | "live-resize" };
const geometryEventAdapter = {
  resolveInitialGeometryEvent: vi.fn((geometry: unknown) => ({ kind: "start-session" as const, geometry })),
  resolveResizeEvent: vi.fn((): ResizeDecision => ({ kind: "fit" })),
  resolveCommitFitEvent: vi.fn(() => ({ kind: "fit-and-flush" as const })),
};
const onRendererHandlesReady = vi.fn(() => handlesCleanup);
let resizeObserverCallback: ((entries: Array<{ contentRect: { width: number; height: number } }>) => void) | null = null;
const resizeObserverDisconnect = vi.fn();
class MockResizeObserver {
  constructor(callback: typeof resizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe = vi.fn();
  disconnect = resizeObserverDisconnect;
}

vi.mock("../useTerminalV2PaneRuntime", () => ({
  useTerminalV2PaneRuntime: (options: { onSearchReady?: unknown }) => ({
    focus,
    legacyOptions: {
      sessionStarter,
      sessionWriter,
      sessionResizer,
      sessionDetacher,
      rendererFactory,
      rendererEventAdapter,
      inputEventProcessor,
      suggestionAdapter,
      linkContextAdapter,
      outputEventProcessor,
      writeSchedulerFactory,
      rendererStandbyBacklog,
      paneInputPipeline,
      geometryEventAdapter,
      onRendererHandlesReady,
      onSearchReady: options.onSearchReady,
    },
  }),
}));

const baseOptions = {
  workspaceId: "workspace-1",
  paneId: "pane-1",
  cwd: "/repo",
  fontSize: 12,
  history: [],
};

function NativeHarness({
  active = true,
  initialCommand,
  onExit,
  onRuntimeSessionIdChange,
  onRuntimeStatusChange,
  onSearchReady,
  onInlineCommandSubmit,
  onCurrentDirectoryChange,
  agentCommand,
  liveResizeActive = false,
  terminalTheme,
  fontSize,
}: {
  active?: boolean;
  initialCommand?: string;
  agentCommand?: string;
  liveResizeActive?: boolean;
  terminalTheme?: { background: string };
  fontSize?: number;
  onExit?: (code: number) => void;
  onRuntimeSessionIdChange?: (sessionId: string | null) => void;
  onRuntimeStatusChange?: (status: "idle" | "starting" | "live" | "detached" | "exited" | "failed") => void;
  onSearchReady?: (api: { findNext(query: string, mode?: "live" | "navigate"): boolean; findPrevious(query: string): boolean; clearSearch(): void }) => void;
  onInlineCommandSubmit?: (command: string) => void;
  onCurrentDirectoryChange?: (cwd: string) => void;
}) {
  const { containerRef, revealState, fit, focus: runtimeFocus } = useTerminalV2NativeRuntime({
    ...baseOptions,
    active,
    initialCommand,
    agentCommand,
    liveResizeActive,
    terminalTheme: terminalTheme as never,
    ...(fontSize !== undefined ? { fontSize } : {}),
    onExit,
    onRuntimeSessionIdChange,
    onRuntimeStatusChange,
    onSearchReady,
    onInlineCommandSubmit,
    onCurrentDirectoryChange,
  });
  return (
    <>
      <div data-testid="reveal-state">{revealState}</div>
      <div ref={containerRef} data-testid="terminal-host" />
      <button type="button" onClick={fit}>fit</button>
      <button type="button" onClick={runtimeFocus}>focus</button>
    </>
  );
}

describe("useTerminalV2NativeRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rendererEventRequest = null;
    rendererRequest = null;
    resizeObserverCallback = null;
    standbyBacklogActive = false;
    terminal.cols = 120;
    terminal.rows = 32;
    fitAddon.fit.mockReset();
    fitAddon.proposeDimensions.mockReset();
    fitAddon.proposeDimensions.mockImplementation(() => ({ cols: 121, rows: 33 }));
    sessionStarter.start.mockResolvedValue({ kind: "created", sessionId: "session-1" });
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  it("returns the stable InteractiveTerminal runtime shape", () => {
    const { result } = renderHook(() => useTerminalV2NativeRuntime(baseOptions));

    expect(result.current).toMatchObject({
      containerRef: expect.objectContaining({ current: null }),
      helperTextareaRef: expect.objectContaining({ current: null }),
      revealState: "warming",
      write: expect.any(Function),
      focus: expect.any(Function),
      fit: expect.any(Function),
      fitViewport: expect.any(Function),
    });
  });

  it("starts hidden when inactive", () => {
    const { result } = renderHook(() => useTerminalV2NativeRuntime({ ...baseOptions, active: false }));
    expect(result.current.revealState).toBe("hidden");
  });

  it("does not create a native xterm renderer while inactive", async () => {
    render(<NativeHarness active={false} />);

    await Promise.resolve();

    expect(rendererFactory).not.toHaveBeenCalled();
    expect(sessionStarter.start).not.toHaveBeenCalled();
    expect(sessionDetacher.detach).not.toHaveBeenCalled();
  });

  it("creates the native renderer once the pane becomes active", async () => {
    const { rerender } = render(<NativeHarness active={false} />);

    await Promise.resolve();
    expect(rendererFactory).not.toHaveBeenCalled();

    rerender(<NativeHarness active />);

    await waitFor(() => expect(rendererFactory).toHaveBeenCalledOnce());
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalledOnce());
  });

  it("routes imperative writes and focus through V2 seams", () => {
    const { result } = renderHook(() => useTerminalV2NativeRuntime(baseOptions));

    result.current.write("ls\r");
    result.current.focus();

    expect(sessionWriter.write).toHaveBeenCalledWith("pane-1", "ls\r");
    expect(focus).toHaveBeenCalledOnce();
  });

  it("creates the renderer, wires events, fits, resizes, and disposes safely", async () => {
    const { unmount } = render(<NativeHarness />);

    await waitFor(() => expect(rendererFactory).toHaveBeenCalled());
    await waitFor(() => expect(onRendererHandlesReady).toHaveBeenCalledWith({ terminal, fitAddon }));

    expect(rendererEventRequest).toBeTruthy();
    act(() => rendererEventRequest?.handlers.onRender());

    await waitFor(() => expect(document.querySelector('[data-testid="reveal-state"]')).toHaveTextContent("settled"));

    expect(rendererRequest).toMatchObject({
      cwd: "/repo",
      fontSize: 12,
      container: expect.any(HTMLDivElement),
    });

    fitAddon.fit.mockClear();
    sessionResizer.resize.mockClear();
    fireEvent.click(document.querySelector("button")!);
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(sessionResizer.resize).toHaveBeenCalledWith("pane-1", 120, 32);

    unmount();

    expect(rendererEventDispose).toHaveBeenCalled();
    expect(handlesCleanup).toHaveBeenCalled();
    expect(rendererDispose).toHaveBeenCalled();
  });

  it("detaches output and disposes the native renderer when an active pane becomes inactive", async () => {
    const { rerender } = render(<NativeHarness active />);

    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());
    rerender(<NativeHarness active={false} />);

    expect(sessionDetacher.detach).toHaveBeenCalledWith("pane-1");
    expect(rendererEventDispose).toHaveBeenCalled();
    expect(handlesCleanup).toHaveBeenCalled();
    expect(rendererDispose).toHaveBeenCalled();
    expect(sessionStarter.start).toHaveBeenCalledOnce();
  });

  it("restyles the live terminal on a theme change instead of recreating it", async () => {
    const { rerender } = render(<NativeHarness active terminalTheme={{ background: "#000" }} />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    rerender(<NativeHarness active terminalTheme={{ background: "#fff" }} />);

    expect(terminal.options.theme).toEqual({ background: "#fff" });
    expect(rendererDispose).not.toHaveBeenCalled();
    expect(sessionDetacher.detach).not.toHaveBeenCalled();
    expect(rendererFactory).toHaveBeenCalledOnce();
  });

  it("resizes the live terminal's font on a font size change instead of recreating it", async () => {
    const { rerender } = render(<NativeHarness active fontSize={12} />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());
    fitAddon.proposeDimensions.mockClear();

    rerender(<NativeHarness active fontSize={16} />);

    expect(terminal.options.fontSize).toBe(16);
    expect(fitAddon.proposeDimensions).toHaveBeenCalled();
    expect(rendererDispose).not.toHaveBeenCalled();
    expect(sessionDetacher.detach).not.toHaveBeenCalled();
    expect(rendererFactory).toHaveBeenCalledOnce();
  });

  it("resets reveal state to warming for a newly-created renderer after returning active", async () => {
    const { rerender } = render(<NativeHarness active />);

    await waitFor(() => expect(rendererEventRequest).toBeTruthy());
    act(() => rendererEventRequest?.handlers.onRender());
    await waitFor(() => expect(screen.getByTestId("reveal-state")).toHaveTextContent("settled"));

    rerender(<NativeHarness active={false} />);
    expect(screen.getByTestId("reveal-state")).toHaveTextContent("hidden");

    rendererEventRequest = null;
    rerender(<NativeHarness active />);
    expect(screen.getByTestId("reveal-state")).toHaveTextContent("warming");

    await waitFor(() => expect(rendererEventRequest).toBeTruthy());
    act(() => rendererEventRequest?.handlers.onRender());
    await waitFor(() => expect(screen.getByTestId("reveal-state")).toHaveTextContent("settled"));
  });

  it("detaches the native session output on renderer cleanup without closing the PTY", async () => {
    const { unmount } = render(<NativeHarness />);

    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());
    unmount();

    expect(sessionDetacher.detach).toHaveBeenCalledWith("pane-1");
  });

  it("starts a V2 session after renderer readiness and valid geometry", async () => {
    const onRuntimeSessionIdChange = vi.fn();
    render(<NativeHarness onRuntimeSessionIdChange={onRuntimeSessionIdChange} />);

    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 120, rows: 32 },
      onOutput: expect.any(Function),
    })));
    await waitFor(() => expect(onRuntimeSessionIdChange).toHaveBeenCalledWith("session-1"));
  });

  it("performs an initial native fit before starting the session", async () => {
    fitAddon.proposeDimensions.mockReturnValueOnce({ cols: 101, rows: 27 });
    fitAddon.fit.mockImplementationOnce(() => {
      terminal.cols = 101;
      terminal.rows = 27;
    });

    render(<NativeHarness />);

    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalledWith(expect.objectContaining({
      geometry: { cols: 101, rows: 27 },
    })));
    expect(fitAddon.fit).toHaveBeenCalled();
    expect(sessionResizer.resize).not.toHaveBeenCalled();
  });

  it("routes PTY output through the V2 output processor and write scheduler", async () => {
    render(<NativeHarness />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    const onOutput = sessionStarter.start.mock.calls[0]?.[0]?.onOutput as (data: string) => void;
    act(() => onOutput("hello"));

    expect(outputEventProcessor).toHaveBeenCalledWith(expect.objectContaining({ data: "hello" }));
    expect(scheduler.push).toHaveBeenCalledWith("hello");
    expect(scheduler.flush).not.toHaveBeenCalled(); // batched per frame, not per chunk
  });

  it("publishes its input pipeline so another renderer's keystrokes get the same processing", async () => {
    const { unmount } = render(<NativeHarness />);
    await waitFor(() => expect(paneInputPipeline.register).toHaveBeenCalledWith("pane-1", expect.any(Function)));

    const handleInput = paneInputPipeline.register.mock.calls[0]?.[1];
    if (!handleInput) throw new Error("input pipeline was never published");
    act(() => handleInput("ls\r"));

    expect(inputEventProcessor).toHaveBeenCalledWith(expect.objectContaining({ data: "ls\r" }));
    expect(sessionWriter.write).toHaveBeenCalledWith("pane-1", "ls\r", expect.objectContaining({ origin: "human" }));

    unmount();
    expect(unregisterPaneInputPipeline).toHaveBeenCalled();
  });

  it("parks PTY output in the pane backlog instead of its own xterm while a pooled renderer owns the pane", async () => {
    standbyBacklogActive = true;
    render(<NativeHarness />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    const onOutput = sessionStarter.start.mock.calls[0]?.[0]?.onOutput as (data: string) => void;
    act(() => onOutput("hello"));

    expect(rendererStandbyBacklog.append).toHaveBeenCalledWith("pane-1", "hello");
    expect(scheduler.push).not.toHaveBeenCalled();
  });

  it("handles session exit output and clears the runtime session", async () => {
    const onExit = vi.fn();
    const onRuntimeSessionIdChange = vi.fn();
    outputEventProcessor.mockReturnValueOnce({
      visibleData: "",
      cwdUpdates: [],
      osc133Events: [],
      exitCode: 7,
      outputRoute: "none",
          nextTrustPromptSeen: false,
      autoTrustResponse: null,
      rememberTrustedCwd: false,
      resizeAfterTrust: false,
      scheduleSuggestionLayout: false,
    });
    render(<NativeHarness onExit={onExit} onRuntimeSessionIdChange={onRuntimeSessionIdChange} />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    const onOutput = sessionStarter.start.mock.calls[0]?.[0]?.onOutput as (data: string) => void;
    act(() => onOutput("[Session ended:7]"));

    expect(onExit).toHaveBeenCalledWith(7);
    expect(onRuntimeSessionIdChange).toHaveBeenCalledWith(null);
  });

  it("keeps native renderer output visible when a session exits", async () => {
    const onExit = vi.fn();
    const onRuntimeSessionIdChange = vi.fn();
    const onRuntimeStatusChange = vi.fn();
    outputEventProcessor.mockReturnValueOnce({
      visibleData: "\r\nlogout\r\n",
      cwdUpdates: [],
      osc133Events: [],
      exitCode: 0,
      outputRoute: "visible",
          nextTrustPromptSeen: false,
      autoTrustResponse: null,
      rememberTrustedCwd: false,
      resizeAfterTrust: false,
      scheduleSuggestionLayout: false,
    });
    render(
      <NativeHarness
        onExit={onExit}
        onRuntimeSessionIdChange={onRuntimeSessionIdChange}
        onRuntimeStatusChange={onRuntimeStatusChange}
      />,
    );
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    const onOutput = sessionStarter.start.mock.calls[0]?.[0]?.onOutput as (data: string) => void;
    act(() => onOutput("raw exit chunk"));

    expect(scheduler.push).toHaveBeenCalledWith("\r\nlogout\r\n");
    const flushOrder = scheduler.flush.mock.invocationCallOrder.at(-1) ?? 0;
    const exitedStatusCallIndex = onRuntimeStatusChange.mock.calls.findIndex(([status]) => status === "exited");
    const exitedStatusOrder = onRuntimeStatusChange.mock.invocationCallOrder[exitedStatusCallIndex] ?? 0;
    expect(flushOrder).toBeLessThan(exitedStatusOrder);
    expect(onRuntimeSessionIdChange).toHaveBeenCalledWith(null);
    expect(onRuntimeStatusChange).toHaveBeenCalledWith("exited");
    expect(onExit).toHaveBeenCalledWith(0);
    expect(rendererDispose).not.toHaveBeenCalled();
  });

  it("routes native xterm input through the V2 input processor", async () => {
    render(<NativeHarness />);
    await waitFor(() => expect(rendererEventRequest).toBeTruthy());

    act(() => rendererEventRequest?.handlers.onData("a"));

    expect(inputEventProcessor).toHaveBeenCalledWith(expect.objectContaining({
      currentInput: "",
      data: "a",
      history: [],
      cwd: "/repo",
    }));
    expect(sessionWriter.write).toHaveBeenCalledWith(
      "pane-1",
      "a",
      { origin: "human", intent: "unknown", submitted: false },
    );
  });

  it("notifies inline command submit and can suppress writes", async () => {
    const onInlineCommandSubmit = vi.fn();
    inputEventProcessor.mockReturnValueOnce({
      nextInput: "",
      suggestionRemainder: "",
      submittedPrompt: "status",
      writeRequest: null,
      cwdProbeCommand: null,
    });
    render(<NativeHarness onInlineCommandSubmit={onInlineCommandSubmit} />);
    await waitFor(() => expect(rendererEventRequest).toBeTruthy());
    sessionWriter.write.mockClear();

    act(() => rendererEventRequest?.handlers.onData("\r"));

    expect(onInlineCommandSubmit).toHaveBeenCalledWith("status");
    expect(sessionWriter.write).not.toHaveBeenCalled();
  });

  it("forwards suggestion remainder and layout changes through the V2 suggestion adapter", async () => {
    inputEventProcessor.mockReturnValueOnce({
      nextInput: "git s",
      suggestionRemainder: "tatus",
      submittedPrompt: "",
      writeRequest: null,
      cwdProbeCommand: null,
    });
    render(<NativeHarness />);
    await waitFor(() => expect(rendererEventRequest).toBeTruthy());

    act(() => rendererEventRequest?.handlers.onData("s"));

    expect(suggestionAdapter.remainderChanged).toHaveBeenCalledWith("tatus");
    expect(suggestionAdapter.layoutChanged).toHaveBeenCalled();
  });

  it("does not write a cwd probe when input processing requests one", async () => {
    inputEventProcessor.mockReturnValueOnce({
      nextInput: "",
      suggestionRemainder: "",
      submittedPrompt: "cd src",
      writeRequest: null,
      cwdProbeCommand: "printf cwd-probe\r",
    });
    render(<NativeHarness onCurrentDirectoryChange={vi.fn()} />);
    await waitFor(() => expect(rendererEventRequest).toBeTruthy());
    sessionWriter.write.mockClear();
    act(() => rendererEventRequest?.handlers.onData("\r"));

    expect(sessionWriter.write).not.toHaveBeenCalled();
  });

  it("ignores stale native input after unmount", async () => {
    const { unmount } = render(<NativeHarness />);
    await waitFor(() => expect(rendererEventRequest).toBeTruthy());
    const onData = rendererEventRequest!.handlers.onData;
    inputEventProcessor.mockClear();

    unmount();
    act(() => onData("x"));

    expect(inputEventProcessor).not.toHaveBeenCalled();
  });

  it("coalesces changed host geometry before fitting and debouncing PTY resize", async () => {
    render(<NativeHarness />);
    await waitFor(() => expect(resizeObserverCallback).toBeTruthy());
    vi.useFakeTimers();
    fitAddon.fit.mockClear();
    sessionResizer.resize.mockClear();
    terminal.cols = 121;
    terminal.rows = 33;

    act(() => {
      resizeObserverCallback?.([{ contentRect: { width: 900, height: 500 } }]);
      resizeObserverCallback?.([{ contentRect: { width: 902, height: 500 } }]);
      resizeObserverCallback?.([{ contentRect: { width: 904, height: 500 } }]);
    });

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(sessionResizer.resize).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(80));

    expect(geometryEventAdapter.resolveResizeEvent).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      liveResizeActive: false,
      lastFittedCols: 120,
      lastFittedRows: 32,
      proposedCols: 121,
      proposedRows: 33,
    }));
    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(sessionResizer.resize).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(256));

    expect(sessionResizer.resize).toHaveBeenCalledWith("pane-1", 121, 33);
  });

  it("suppresses native resize work during live layout drag and commits one final fit afterward", async () => {
    const { rerender } = render(<NativeHarness agentCommand="claude" liveResizeActive />);
    await waitFor(() => expect(resizeObserverCallback).toBeTruthy());
    vi.useFakeTimers();
    fitAddon.fit.mockClear();
    sessionResizer.resize.mockClear();
    geometryEventAdapter.resolveResizeEvent.mockClear();
    terminal.cols = 122;
    terminal.rows = 34;

    act(() => resizeObserverCallback?.([{ contentRect: { width: 930, height: 520 } }]));
    act(() => vi.advanceTimersByTime(2_000));

    expect(geometryEventAdapter.resolveResizeEvent).not.toHaveBeenCalledWith(expect.objectContaining({ liveResizeActive: true }));
    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(sessionResizer.resize).not.toHaveBeenCalled();
    expect(rendererDispose).not.toHaveBeenCalled();

    terminal.cols = 123;
    terminal.rows = 35;
    rerender(<NativeHarness agentCommand="claude" liveResizeActive={false} />);

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(sessionResizer.resize).toHaveBeenCalledWith("pane-1", 123, 35);
    expect(rendererDispose).not.toHaveBeenCalled();
  });

  it("does not replay a pending live-drag resize timer after commit fit", async () => {
    const { rerender } = render(<NativeHarness agentCommand="claude" liveResizeActive />);
    await waitFor(() => expect(resizeObserverCallback).toBeTruthy());
    vi.useFakeTimers();
    fitAddon.fit.mockClear();
    sessionResizer.resize.mockClear();
    terminal.cols = 122;
    terminal.rows = 34;

    act(() => resizeObserverCallback?.([{ contentRect: { width: 930, height: 520 } }]));

    terminal.cols = 123;
    terminal.rows = 35;
    rerender(<NativeHarness agentCommand="claude" liveResizeActive={false} />);
    act(() => vi.advanceTimersByTime(2_000));

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(sessionResizer.resize).toHaveBeenCalledTimes(1);
    expect(sessionResizer.resize).toHaveBeenCalledWith("pane-1", 123, 35);
  });

  it("uses slower resize settling for native agent panes to avoid TUI redraw storms", async () => {
    render(<NativeHarness agentCommand="claude" />);
    await waitFor(() => expect(resizeObserverCallback).toBeTruthy());
    vi.useFakeTimers();
    fitAddon.fit.mockClear();
    sessionResizer.resize.mockClear();
    terminal.cols = 122;
    terminal.rows = 34;

    act(() => resizeObserverCallback?.([{ contentRect: { width: 930, height: 520 } }]));
    act(() => vi.advanceTimersByTime(319));

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(sessionResizer.resize).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(sessionResizer.resize).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(899));
    expect(sessionResizer.resize).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(sessionResizer.resize).toHaveBeenCalledWith("pane-1", 122, 34);
  });

  it("skips native resize work when the V2 geometry policy rejects it", async () => {
    render(<NativeHarness />);
    await waitFor(() => expect(resizeObserverCallback).toBeTruthy());
    fitAddon.fit.mockClear();
    sessionResizer.resize.mockClear();
    geometryEventAdapter.resolveResizeEvent.mockReturnValueOnce({ kind: "skip-fit" });

    act(() => resizeObserverCallback?.([{ contentRect: { width: 910, height: 510 } }]));

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(sessionResizer.resize).not.toHaveBeenCalled();
  });

  it("flushes pending native resize immediately on commit fit", async () => {
    render(<NativeHarness />);
    await waitFor(() => expect(resizeObserverCallback).toBeTruthy());
    vi.useFakeTimers();
    sessionResizer.resize.mockClear();
    terminal.cols = 121;
    terminal.rows = 33;

    act(() => resizeObserverCallback?.([{ contentRect: { width: 900, height: 500 } }]));
    terminal.cols = 130;
    terminal.rows = 34;
    fireEvent.click(document.querySelector("button")!);

    expect(sessionResizer.resize).toHaveBeenCalledWith("pane-1", 130, 34);
    expect(sessionResizer.resize).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(256));

    expect(sessionResizer.resize).toHaveBeenCalledTimes(1);
  });

  it("sends initial command after a created native session starts", async () => {
    const onRuntimeSessionIdChange = vi.fn();
    render(<NativeHarness initialCommand="pnpm dev" onRuntimeSessionIdChange={onRuntimeSessionIdChange} />);

    await waitFor(() => expect(onRuntimeSessionIdChange).toHaveBeenCalledWith("session-1"));

    expect(sessionWriter.write).toHaveBeenCalledWith(
      "pane-1",
      "pnpm dev\r",
      { origin: "system", intent: "initial-command", submitted: false },
    );
  });

  it("does not send initial command after native session reattach", async () => {
    sessionStarter.start.mockResolvedValueOnce({ kind: "reattached", sessionId: "session-1" });

    render(<NativeHarness initialCommand="pnpm dev" />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    expect(sessionWriter.write).not.toHaveBeenCalledWith(
      "pane-1",
      "pnpm dev\r",
      expect.anything(),
    );
  });

  it("does not duplicate initial command across rerenders", async () => {
    const { rerender } = render(<NativeHarness initialCommand="pnpm dev" />);
    await waitFor(() => expect(sessionWriter.write).toHaveBeenCalledWith(
      "pane-1",
      "pnpm dev\r",
      { origin: "system", intent: "initial-command", submitted: false },
    ));

    rerender(<NativeHarness initialCommand="pnpm dev" />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    expect(sessionWriter.write.mock.calls.filter((call) => call[1] === "pnpm dev\r")).toHaveLength(1);
  });

  it("does not send initial command after unmount before native session start resolves", async () => {
    let resolveStart: (value: { kind: "created"; sessionId: string }) => void = () => {};
    sessionStarter.start.mockReturnValueOnce(new Promise((resolve) => {
      resolveStart = resolve;
    }));
    const { unmount } = render(<NativeHarness initialCommand="pnpm dev" />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    unmount();
    await act(async () => resolveStart({ kind: "created", sessionId: "session-1" }));

    expect(sessionWriter.write).not.toHaveBeenCalledWith(
      "pane-1",
      "pnpm dev\r",
      expect.anything(),
    );
  });

  it("normalizes initial command to a single trailing carriage return", async () => {
    render(<NativeHarness initialCommand={"pnpm dev\r"} />);

    await waitFor(() => expect(sessionWriter.write).toHaveBeenCalledWith(
      "pane-1",
      "pnpm dev\r",
      { origin: "system", intent: "initial-command", submitted: false },
    ));
    expect(sessionWriter.write.mock.calls.filter((call) => call[1] === "pnpm dev\r\r")).toHaveLength(0);
  });

  it("emits starting and live native runtime status around session start", async () => {
    const onRuntimeStatusChange = vi.fn();

    render(<NativeHarness onRuntimeStatusChange={onRuntimeStatusChange} />);

    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());
    expect(onRuntimeStatusChange).toHaveBeenCalledWith("starting");
    await waitFor(() => expect(onRuntimeStatusChange).toHaveBeenCalledWith("live"));
    expect(onRuntimeStatusChange.mock.calls.map((call) => call[0])).toEqual(["starting", "live"]);
  });

  it("emits exited native runtime status when session output exits", async () => {
    const onRuntimeStatusChange = vi.fn();
    outputEventProcessor.mockReturnValueOnce({
      visibleData: "",
      cwdUpdates: [],
      osc133Events: [],
      exitCode: 3,
      outputRoute: "none",
          nextTrustPromptSeen: false,
      autoTrustResponse: null,
      rememberTrustedCwd: false,
      resizeAfterTrust: false,
      scheduleSuggestionLayout: false,
    });
    render(<NativeHarness onRuntimeStatusChange={onRuntimeStatusChange} />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    const onOutput = sessionStarter.start.mock.calls[0]?.[0]?.onOutput as (data: string) => void;
    act(() => onOutput("[Session ended:3]"));

    expect(onRuntimeStatusChange).toHaveBeenCalledWith("exited");
  });

  it("emits failed native runtime status when renderer creation fails", async () => {
    const onRuntimeStatusChange = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    rendererFactory.mockRejectedValueOnce(new Error("renderer boom"));

    render(<NativeHarness onRuntimeStatusChange={onRuntimeStatusChange} />);

    await waitFor(() => expect(onRuntimeStatusChange).toHaveBeenCalledWith("failed"));
    expect(sessionStarter.start).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[terminal-v2] Native renderer failed:", expect.any(Error));
    errorSpy.mockRestore();
  });

  it("emits failed native runtime status on session start failure", async () => {
    const onRuntimeStatusChange = vi.fn();
    sessionStarter.start.mockRejectedValueOnce(new Error("boom"));

    render(<NativeHarness onRuntimeStatusChange={onRuntimeStatusChange} />);

    await waitFor(() => expect(onRuntimeStatusChange).toHaveBeenCalledWith("failed"));
  });

  it("does not emit native runtime status after unmount before start resolves", async () => {
    const onRuntimeStatusChange = vi.fn();
    let resolveStart: (value: { kind: "created"; sessionId: string }) => void = () => {};
    sessionStarter.start.mockReturnValueOnce(new Promise((resolve) => {
      resolveStart = resolve;
    }));
    const { unmount } = render(<NativeHarness onRuntimeStatusChange={onRuntimeStatusChange} />);
    await waitFor(() => expect(onRuntimeStatusChange).toHaveBeenCalledWith("starting"));

    onRuntimeStatusChange.mockClear();
    unmount();
    await act(async () => resolveStart({ kind: "created", sessionId: "session-1" }));

    expect(onRuntimeStatusChange).not.toHaveBeenCalled();
  });

  it("does not recreate native renderer when callback props change identity", async () => {
    const firstStatus = vi.fn();
    const secondStatus = vi.fn();
    const { rerender } = render(<NativeHarness onRuntimeStatusChange={firstStatus} />);
    await waitFor(() => expect(rendererFactory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(firstStatus).toHaveBeenCalledWith("live"));

    rerender(<NativeHarness onRuntimeStatusChange={secondStatus} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rendererFactory).toHaveBeenCalledTimes(1);
    expect(rendererDispose).not.toHaveBeenCalled();
  });

  it("does not duplicate native runtime status across rerenders", async () => {
    const onRuntimeStatusChange = vi.fn();
    const { rerender } = render(<NativeHarness onRuntimeStatusChange={onRuntimeStatusChange} />);
    await waitFor(() => expect(onRuntimeStatusChange).toHaveBeenCalledWith("live"));

    rerender(<NativeHarness onRuntimeStatusChange={onRuntimeStatusChange} />);
    await waitFor(() => expect(sessionStarter.start).toHaveBeenCalled());

    expect(onRuntimeStatusChange.mock.calls.map((call) => call[0])).toEqual(["starting", "live"]);
  });

  it("focuses the native renderer terminal after handles are ready", async () => {
    render(<NativeHarness />);
    await waitFor(() => expect(rendererFactory).toHaveBeenCalled());

    fireEvent.click(document.querySelectorAll("button")[1]!);

    expect(terminal.focus).toHaveBeenCalled();
  });

  it("forwards native link context menus with container-relative coordinates", async () => {
    render(<NativeHarness />);
    await waitFor(() => expect(rendererRequest).toBeTruthy());
    rendererRequest!.container.getBoundingClientRect = vi.fn(() => ({
      left: 40,
      top: 80,
      right: 240,
      bottom: 280,
      width: 200,
      height: 200,
      x: 40,
      y: 80,
      toJSON: () => ({}),
    }));

    act(() => rendererRequest?.onLinkContextMenu({
      clientX: 60,
      clientY: 110,
      link: { kind: "external", url: "https://example.com", text: "example" },
    }));

    expect(linkContextAdapter.openContextMenu).toHaveBeenCalledWith(
      {
        clientX: 60,
        clientY: 110,
        link: { kind: "external", url: "https://example.com", text: "example" },
      },
      expect.objectContaining({ left: 40, top: 80 }),
    );
  });

  it("exposes native search API when renderer search addon is ready", async () => {
    const onSearchReady = vi.fn();
    render(<NativeHarness onSearchReady={onSearchReady} />);

    await waitFor(() => expect(onSearchReady).toHaveBeenCalled());
    const api = onSearchReady.mock.calls[0]?.[0];

    expect(api.findNext("foo")).toBe(true);
    expect(api.findNext("live", "live")).toBe(true);
    expect(api.findPrevious("bar")).toBe(false);
    api.clearSearch();
    const nextOptions = searchAddon.findNext.mock.calls[0]?.[1];
    const liveOptions = searchAddon.findNext.mock.calls[1]?.[1];
    const previousOptions = searchAddon.findPrevious.mock.calls[0]?.[1];
    expect(nextOptions).toEqual(expect.objectContaining({
      decorations: expect.objectContaining({ activeMatchBackground: "#d18616" }),
    }));
    expect(nextOptions).not.toHaveProperty("incremental");
    expect(liveOptions).toEqual(expect.objectContaining({ incremental: true }));
    expect(previousOptions).toEqual(expect.objectContaining({
      decorations: expect.objectContaining({ matchOverviewRuler: "#d18616" }),
    }));
    expect(nextOptions?.decorations).not.toHaveProperty("activeMatchBorder");
    expect(nextOptions?.decorations).not.toHaveProperty("matchBorder");
    expect(searchAddon.clearDecorations).toHaveBeenCalled();
  });

  it("does not expose native search API after unmount before renderer resolves", async () => {
    const onSearchReady = vi.fn();
    type DeferredRenderer = {
      terminal: typeof terminal;
      addons: { fitAddon: typeof fitAddon; searchAddon: typeof searchAddon };
      helperTextarea: HTMLTextAreaElement;
      dispose: typeof rendererDispose;
    };
    let resolveRenderer: (renderer: DeferredRenderer | PromiseLike<DeferredRenderer>) => void = () => {};
    rendererFactory.mockImplementationOnce(async (request) => {
      rendererRequest = request;
      return new Promise((resolve) => {
        resolveRenderer = resolve;
      });
    });
    const { unmount } = render(<NativeHarness onSearchReady={onSearchReady} />);
    await waitFor(() => expect(rendererFactory).toHaveBeenCalled());

    unmount();
    await act(async () => resolveRenderer({
      terminal,
      addons: { fitAddon, searchAddon },
      helperTextarea: document.createElement("textarea"),
      dispose: rendererDispose,
    }));

    expect(onSearchReady).not.toHaveBeenCalled();
  });

  it("does not duplicate native search ready callback across rerenders", async () => {
    const onSearchReady = vi.fn();
    const { rerender } = render(<NativeHarness onSearchReady={onSearchReady} />);
    await waitFor(() => expect(onSearchReady).toHaveBeenCalledOnce());

    rerender(<NativeHarness onSearchReady={onSearchReady} />);
    await waitFor(() => expect(rendererFactory).toHaveBeenCalled());

    expect(onSearchReady).toHaveBeenCalledOnce();
  });
});
