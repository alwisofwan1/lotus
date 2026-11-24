import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLegacyTerminalRuntime } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import { emitLegacyTerminalGridLiveResize } from "@/modules/codespace/services/legacy-terminal-grid-resize-events";
import type { TerminalPaneSnapshot } from "@/modules/codespace/services/terminal-pane-runtime";

const fitAddonFitMock = vi.hoisted(() => vi.fn());
const loadTerminalAddonsMock = vi.hoisted(() => vi.fn());
const activateWebglRendererMock = vi.hoisted(() => vi.fn());
const attachTerminalSessionMock = vi.hoisted(() => vi.fn());
const createTerminalSessionMock = vi.hoisted(() => vi.fn());
const detachTerminalSessionMock = vi.hoisted(() => vi.fn());
const resizeTerminalSessionMock = vi.hoisted(() => vi.fn());
const subscribeTerminalSessionStatusMock = vi.hoisted(() => vi.fn());
let terminalRect = { width: 900, height: 480 };

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0];
type RendererEventAdapterRequest = Parameters<NonNullable<Parameters<typeof useLegacyTerminalRuntime>[0]["rendererEventAdapter"]>>[0];

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }

  emit(width: number, height: number) {
    this.callback([
      {
        contentRect: {
          width,
          height,
        } as DOMRectReadOnly,
      } as ResizeObserverEntry,
    ], this as unknown as ResizeObserver);
  }
}

class TerminalMock {
  static instances: TerminalMock[] = [];
  static supportsRenderEvents = true;

  cols = 120;
  rows = 32;
  options: Record<string, unknown> = {};

  private renderListeners = new Set<() => void>();

  open = vi.fn();
  attachCustomKeyEventHandler = vi.fn();
  onData = vi.fn();
  onRender = vi.fn((listener: () => void) => {
    if (!TerminalMock.supportsRenderEvents) return undefined;
    this.renderListeners.add(listener);
    return {
      dispose: vi.fn(() => this.renderListeners.delete(listener)),
    };
  });
  write = vi.fn();
  refresh = vi.fn();
  focus = vi.fn();
  dispose = vi.fn();

  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    TerminalMock.instances.push(this);
  }

  emitRender() {
    for (const listener of this.renderListeners) listener();
  }
}

vi.mock("@xterm/xterm", () => ({
  Terminal: TerminalMock,
}));

vi.mock("@/modules/codespace/services/terminal-addons", () => ({
  loadTerminalAddons: loadTerminalAddonsMock,
  activateWebglRenderer: activateWebglRendererMock,
}));

vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  attachTerminalSession: attachTerminalSessionMock,
  createTerminalSession: createTerminalSessionMock,
  detachTerminalSession: detachTerminalSessionMock,
  getTerminalRuntimeSessionId: vi.fn(() => "session-1"),
  markTerminalSessionExited: vi.fn(),
  resizeTerminalSession: resizeTerminalSessionMock,
  subscribeTerminalSessionStatus: subscribeTerminalSessionStatusMock,
  writeTerminalSession: vi.fn(),
}));

function TerminalHarness({
  active = true,
  renderAccelerationEligible = false,
  sessionStarter,
  hiddenOutputBufferFactory,
  rendererEventAdapter,
  inputEventProcessor,
  outputEventProcessor,
  geometryEventAdapter,
  paneRuntimeFactory,
  writeSchedulerFactory,
  onRuntimeSessionIdChange,
}: {
  active?: boolean;
  renderAccelerationEligible?: boolean;
  sessionStarter?: Parameters<typeof useLegacyTerminalRuntime>[0]["sessionStarter"];
  hiddenOutputBufferFactory?: Parameters<typeof useLegacyTerminalRuntime>[0]["hiddenOutputBufferFactory"];
  rendererEventAdapter?: Parameters<typeof useLegacyTerminalRuntime>[0]["rendererEventAdapter"];
  inputEventProcessor?: Parameters<typeof useLegacyTerminalRuntime>[0]["inputEventProcessor"];
  outputEventProcessor?: Parameters<typeof useLegacyTerminalRuntime>[0]["outputEventProcessor"];
  geometryEventAdapter?: Parameters<typeof useLegacyTerminalRuntime>[0]["geometryEventAdapter"];
  paneRuntimeFactory?: Parameters<typeof useLegacyTerminalRuntime>[0]["paneRuntimeFactory"];
  writeSchedulerFactory?: Parameters<typeof useLegacyTerminalRuntime>[0]["writeSchedulerFactory"];
  onRuntimeSessionIdChange?: (sessionId: string | null) => void;
}) {
  const { containerRef, revealState } = useLegacyTerminalRuntime({
    active,
    renderAccelerationEligible,
    workspaceId: "workspace-1",
    paneId: "pane-1",
    cwd: "/tmp/project",
    fontSize: 13,
    history: [],
    sessionStarter,
    hiddenOutputBufferFactory,
    rendererEventAdapter,
    inputEventProcessor,
    outputEventProcessor,
    geometryEventAdapter,
    paneRuntimeFactory,
    writeSchedulerFactory,
    onRuntimeSessionIdChange,
  });

  return (
    <>
      <div data-testid="terminal-reveal-state">{revealState}</div>
      <div ref={containerRef} />
    </>
  );
}

describe("useLegacyTerminalRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalRect = { width: 900, height: 480 };
    TestResizeObserver.instances = [];
    TerminalMock.instances = [];
    TerminalMock.supportsRenderEvents = true;
    fitAddonFitMock.mockClear();
    resizeTerminalSessionMock.mockClear();
    activateWebglRendererMock.mockClear();
    attachTerminalSessionMock.mockClear();
    createTerminalSessionMock.mockClear();
    detachTerminalSessionMock.mockClear();
    subscribeTerminalSessionStatusMock.mockClear();
    activateWebglRendererMock.mockResolvedValue(null);
    attachTerminalSessionMock.mockReturnValue(false);
    createTerminalSessionMock.mockReturnValue({
      connectPromise: Promise.resolve(),
    });
    subscribeTerminalSessionStatusMock.mockReturnValue(() => {});
    window.localStorage.clear();
    loadTerminalAddonsMock.mockResolvedValue({
      fitAddon: { fit: fitAddonFitMock },
      webglAddon: null,
      searchAddon: null,
      dispose: vi.fn(),
    });
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    let nextRafId = 1;
    const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = nextRafId++;
      const timer = setTimeout(() => {
        rafTimers.delete(id);
        callback(performance.now());
      }, 0);
      rafTimers.set(id, timer);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      const timer = rafTimers.get(id);
      if (timer) clearTimeout(timer);
      rafTimers.delete(id);
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width: terminalRect.width,
      height: terminalRect.height,
      top: 0,
      left: 0,
      right: terminalRect.width,
      bottom: terminalRect.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("writes ordinary output containing a literal session-ended marker", async () => {
    render(<TerminalHarness />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });
    const output = createTerminalSessionMock.mock.calls[0][0].onOutput as (data: string) => void;
    const data = "example [Session ended:0]\r\nmore output";
    act(() => output(data));
    await act(async () => { vi.runOnlyPendingTimers(); });
    expect(TerminalMock.instances[0].write).toHaveBeenCalledWith(data, expect.any(Function));
  });

  it("delegates hidden output buffering to an injected buffer", async () => {
    const hiddenBuffer = {
      append: vi.fn(),
      drain: vi.fn((write: (chunk: string) => void) => write("from injected buffer")),
      hasData: vi.fn(() => true),
      clear: vi.fn(),
    };
    const hiddenOutputBufferFactory = vi.fn(() => hiddenBuffer);
    const { rerender } = render(
      <TerminalHarness active={false} hiddenOutputBufferFactory={hiddenOutputBufferFactory} />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as ((data: string) => void) | undefined;
    const terminal = TerminalMock.instances[0];
    terminal.write.mockClear();

    act(() => output?.("background output"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hiddenOutputBufferFactory).toHaveBeenCalledOnce();
    expect(hiddenBuffer.append).toHaveBeenCalledWith("background output");
    expect(terminal.write).not.toHaveBeenCalledWith("background output");

    await act(async () => {
      rerender(<TerminalHarness active hiddenOutputBufferFactory={hiddenOutputBufferFactory} />);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hiddenBuffer.drain).toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledWith("from injected buffer", expect.any(Function));
  });

  it("delegates terminal write scheduler creation to an injected factory", async () => {
    const scheduler = {
      push: vi.fn(),
      flush: vi.fn(),
      dispose: vi.fn(),
      hasPending: vi.fn(() => false),
    };
    const writeSchedulerFactory = vi.fn(() => scheduler);

    render(<TerminalHarness writeSchedulerFactory={writeSchedulerFactory} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(writeSchedulerFactory).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "pane-1",
      write: expect.any(Function),
      refresh: expect.any(Function),
    }));

    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as ((data: string) => void) | undefined;
    act(() => output?.("scheduled output"));

    expect(scheduler.push).toHaveBeenCalledWith("scheduled output");
  });

  it("delegates pane lifecycle runtime creation to an injected factory", async () => {
    const runtime = {
      getSnapshot: vi.fn((): TerminalPaneSnapshot => ({
        state: "ready_visible",
        renderer: "canvas",
        visibleIntent: true,
        liveResizeActive: false,
      })),
      isLiveResizing: vi.fn(() => false),
      init: vi.fn(),
      notifyXtermCreated: vi.fn(),
      notifyAttached: vi.fn(),
      setVisible: vi.fn(),
      notifyRendererPromoting: vi.fn(),
      notifyRendererPromoted: vi.fn(),
      notifyRendererPromotionFailed: vi.fn(),
      notifyRendererDemoted: vi.fn(),
      notifyRendererLost: vi.fn(),
      notifyLiveResizeStart: vi.fn(),
      notifyLiveResizeEnd: vi.fn(),
      dispose: vi.fn(),
    };
    const paneRuntimeFactory = vi.fn(() => runtime);

    render(<TerminalHarness paneRuntimeFactory={paneRuntimeFactory} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(paneRuntimeFactory).toHaveBeenCalledWith(expect.objectContaining({
      host: expect.objectContaining({
        drainHiddenBuffer: expect.any(Function),
        writeToTerminal: expect.any(Function),
        refreshViewport: expect.any(Function),
        disposeTerminal: expect.any(Function),
        commitFit: expect.any(Function),
      }),
      initiallyVisible: true,
    }));
    expect(runtime.init).toHaveBeenCalledOnce();
    expect(runtime.notifyXtermCreated).toHaveBeenCalledOnce();
  });

  it("delegates resize fit decisions to an injected geometry event adapter", async () => {
    const geometryEventAdapter = {
      resolveResizeEvent: vi.fn(() => ({ kind: "skip-fit" as const })),
      resolveInitialGeometryEvent: vi.fn((geometry) => geometry
        ? { kind: "start-session" as const, geometry }
        : { kind: "defer-start" as const }),
      resolveCommitFitEvent: vi.fn(() => ({ kind: "fit-and-flush" as const })),
    };
    render(<TerminalHarness geometryEventAdapter={geometryEventAdapter} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    fitAddonFitMock.mockClear();
    TestResizeObserver.instances[0]?.emit(910, 490);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(geometryEventAdapter.resolveResizeEvent).toHaveBeenCalledWith(expect.objectContaining({
      active: true,
      liveResizeActive: false,
    }));
    expect(fitAddonFitMock).not.toHaveBeenCalled();
  });

  it("delegates runtime output processing to an injected output event processor", async () => {
    const outputEventProcessor = vi.fn(() => ({
      visibleData: "processed output",
      cwdUpdates: [],
      osc133Events: [],
      exitCode: null,
      outputRoute: "visible" as const,
      nextTrustPromptSeen: false,
      autoTrustResponse: null,
      rememberTrustedCwd: false,
      resizeAfterTrust: false,
      scheduleSuggestionLayout: false,
    }));

    render(<TerminalHarness outputEventProcessor={outputEventProcessor} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as ((data: string) => void) | undefined;
    act(() => output?.("raw output"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(outputEventProcessor).toHaveBeenCalledWith(expect.objectContaining({
      data: "raw output",
      paneRuntimeState: "ready_visible",
      cwd: "/tmp/project",
    }));
    expect(TerminalMock.instances[0].write).toHaveBeenCalledWith("processed output", expect.any(Function));
  });

  it("delegates renderer input processing to an injected input event processor", async () => {
    const rendererEventAdapter = vi.fn((request: RendererEventAdapterRequest) => {
      void request;
      return { dispose: vi.fn() };
    });
    const inputEventProcessor = vi.fn(() => ({
      nextInput: "next",
      suggestionRemainder: "mainder",
      submittedPrompt: "git status",
      writeRequest: {
        data: "git status\r",
        metadata: {
          origin: "human" as const,
          intent: "unknown" as const,
          submitted: true,
          promptText: "git status",
        },
      },
      cwdProbeCommand: null,
    }));

    render(
      <TerminalHarness
        rendererEventAdapter={rendererEventAdapter}
        inputEventProcessor={inputEventProcessor}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const eventRequest = rendererEventAdapter.mock.calls[0]?.[0];
    expect(eventRequest).toBeDefined();
    act(() => eventRequest!.handlers.onData("git status\r"));

    expect(inputEventProcessor).toHaveBeenCalledWith({
      currentInput: "",
      data: "git status\r",
      history: [],
      cwd: "/tmp/project",
      agentCommand: undefined,
    });
  });

  it("delegates renderer event wiring to an injected event adapter", async () => {
    const eventDispose = vi.fn();
    const rendererEventAdapter = vi.fn((request: RendererEventAdapterRequest) => {
      void request;
      return { dispose: eventDispose };
    });

    const { unmount } = render(<TerminalHarness rendererEventAdapter={rendererEventAdapter} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const eventRequest = rendererEventAdapter.mock.calls[0]?.[0];
    expect(eventRequest).toBeDefined();
    expect(eventRequest).toMatchObject({
      terminal: TerminalMock.instances[0],
      handlers: {
        onData: expect.any(Function),
        onRender: expect.any(Function),
        onWriteParsed: expect.any(Function),
        onCustomKey: expect.any(Function),
      },
    });

    act(() => eventRequest!.handlers.onData("ls\r"));
    act(() => eventRequest!.handlers.onRender());
    unmount();

    expect(eventDispose).toHaveBeenCalledOnce();
  });

  it("delegates runtime session start to an injected session starter", async () => {
    const onRuntimeSessionIdChange = vi.fn();
    const sessionStarter = {
      start: vi.fn(() => Promise.resolve({ kind: "created" as const, sessionId: "v2-session" })),
    };

    render(<TerminalHarness sessionStarter={sessionStarter} onRuntimeSessionIdChange={onRuntimeSessionIdChange} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(sessionStarter.start).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      geometry: { cols: 120, rows: 32 },
      onOutput: expect.any(Function),
    }));
    expect(attachTerminalSessionMock).not.toHaveBeenCalled();
    expect(createTerminalSessionMock).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.resolve();
    });
    expect(onRuntimeSessionIdChange).toHaveBeenCalledWith("v2-session");
  });

  it("waits for valid terminal geometry before creating the PTY session", async () => {
    terminalRect = { width: 0, height: 480 };
    const { rerender } = render(<TerminalHarness />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(180);
    });

    expect(createTerminalSessionMock).not.toHaveBeenCalled();

    terminalRect = { width: 900, height: 480 };
    TerminalMock.instances[0].cols = 116;
    TerminalMock.instances[0].rows = 30;

    await act(async () => {
      rerender(<TerminalHarness />);
      TestResizeObserver.instances[0]?.emit(900, 480);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(createTerminalSessionMock).toHaveBeenCalledOnce();
    expect(createTerminalSessionMock.mock.calls[0]?.[0]).toMatchObject({
      cols: 116,
      rows: 30,
    });
  });

  it("buffers terminal output while inactive and flushes it when active again", async () => {
    const { rerender } = render(<TerminalHarness active={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as ((data: string) => void) | undefined;
    expect(output).toBeDefined();
    const terminal = TerminalMock.instances[0];
    expect(terminal.options).toMatchObject({
      fontSize: 13,
      lineHeight: 1,
      letterSpacing: 0,
      fontWeight: 400,
      fontWeightBold: 650,
      customGlyphs: true,
    });
    terminal.write.mockClear();

    act(() => {
      output?.("background output");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(terminal.write).not.toHaveBeenCalledWith("background output");

    await act(async () => {
      rerender(<TerminalHarness active />);
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(terminal.write).toHaveBeenCalledWith("background output", expect.any(Function));
  });

  it("drains hidden output into xterm in the background while still inactive", async () => {
    render(<TerminalHarness active={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as ((data: string) => void) | undefined;
    expect(output).toBeDefined();
    const terminal = TerminalMock.instances[0];
    terminal.write.mockClear();

    act(() => {
      output?.("background output");
    });

    // Not yet — the hidden drain runs on a 120ms coarse timer.
    expect(terminal.write).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
      await vi.advanceTimersByTimeAsync(0);
    });

    // Drained into xterm while the pane is STILL hidden, so a later workspace
    // switch reveals current content with no post-reveal pop.
    expect(terminal.write).toHaveBeenCalledWith("background output", expect.any(Function));
  });

  it("fits and repaints immediately when an inactive terminal becomes active", async () => {
    const { rerender } = render(<TerminalHarness active={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const terminal = TerminalMock.instances[0];
    fitAddonFitMock.mockClear();
    resizeTerminalSessionMock.mockClear();
    terminal.refresh.mockClear();

    act(() => {
      rerender(<TerminalHarness active />);
    });

    expect(fitAddonFitMock).toHaveBeenCalledOnce();
    expect(resizeTerminalSessionMock).toHaveBeenCalledWith("pane-1", terminal.cols, terminal.rows);
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it("keeps the terminal reveal mask until xterm renders after activation", async () => {
    const { getByTestId, rerender } = render(<TerminalHarness active={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("hidden");

    act(() => {
      rerender(<TerminalHarness active />);
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("warming");

    act(() => {
      TerminalMock.instances[0].emitRender();
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("settled");
  });

  it("settles the terminal reveal mask via fallback when xterm render events are unavailable", async () => {
    TerminalMock.supportsRenderEvents = false;
    const { getByTestId, rerender } = render(<TerminalHarness active={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    act(() => {
      rerender(<TerminalHarness active />);
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("warming");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("settled");
  });

  it("does not re-mask a terminal that already rendered before workspace reactivation", async () => {
    const { getByTestId, rerender } = render(<TerminalHarness active />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    act(() => {
      TerminalMock.instances[0].emitRender();
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("settled");

    act(() => {
      rerender(<TerminalHarness active={false} />);
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("hidden");

    act(() => {
      rerender(<TerminalHarness active />);
    });

    expect(getByTestId("terminal-reveal-state")).toHaveTextContent("settled");
  });

  // fit() is RAF-debounced to coalesce rapid ResizeObserver events in the same
  // frame, preventing excessive WebGL re-renders during window resize.
  // PTY SIGWINCH is further debounced at 80ms (trailing edge only).
  it("batches fit via RAF and debounces PTY resize until 256ms", async () => {
    render(<TerminalHarness />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(TestResizeObserver.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });

    fitAddonFitMock.mockClear();
    resizeTerminalSessionMock.mockClear();

    // Emit multiple rapid resize events — should coalesce into ONE fit() call
    act(() => {
      TestResizeObserver.instances[0]?.emit(800, 500);
      TestResizeObserver.instances[0]?.emit(810, 505);
      TestResizeObserver.instances[0]?.emit(820, 510);
    });

    // fit() not called yet — pending RAF
    expect(fitAddonFitMock).not.toHaveBeenCalled();
    expect(resizeTerminalSessionMock).not.toHaveBeenCalled();

    TerminalMock.instances[0].cols = 121;

    // Advance one RAF frame (0ms in fake timers) — fit fires once, not three times
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fitAddonFitMock).toHaveBeenCalledOnce();
    expect(resizeTerminalSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(255);
    });
    expect(resizeTerminalSessionMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(resizeTerminalSessionMock).toHaveBeenCalledWith("pane-1", 121, 32);
  });

  it("activates WebGL renderer after the first fit", async () => {
    const webglDummy = { dispose: vi.fn() };
    activateWebglRendererMock.mockResolvedValue(webglDummy);

    const addons = {
      fitAddon: { fit: fitAddonFitMock },
      webglAddon: null as unknown,
      searchAddon: null,
      dispose: vi.fn(),
    };
    loadTerminalAddonsMock.mockResolvedValue(addons);

    render(<TerminalHarness />);

    // Drain: xterm import → loadTerminalAddons → RAF fires → activateWebglRenderer resolves
    await act(async () => {
      await Promise.resolve(); // xterm dynamic import
      await Promise.resolve(); // loadTerminalAddons resolves
      await vi.advanceTimersByTimeAsync(0); // RAF fires (fit)
      // activateWebglRenderer is awaited after fit — drain its resolved Promise
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60); // resizeTimer + any remaining async tails
      await Promise.resolve();
    });

    expect(activateWebglRendererMock).toHaveBeenCalledOnce();
    // webglAddon is set on the addons object returned by loadTerminalAddons
    expect(addons.webglAddon).toBe(webglDummy);
  });

  it("passes active-pane eligibility into WebGL activation", async () => {
    activateWebglRendererMock.mockResolvedValue({ dispose: vi.fn() });
    loadTerminalAddonsMock.mockResolvedValue({
      fitAddon: { fit: fitAddonFitMock },
      webglAddon: null,
      searchAddon: null,
      dispose: vi.fn(),
    });

    render(<TerminalHarness renderAccelerationEligible />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(activateWebglRendererMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ activePaneEligible: true }),
    );
  });

  it("disposes WebGL when smooth-active-pane mode loses active-pane eligibility", async () => {
    window.localStorage.setItem("lotus.terminal.webgl.policy", "smooth-active-pane");
    const webglDummy = { dispose: vi.fn() };
    const addons = {
      fitAddon: { fit: fitAddonFitMock },
      webglAddon: null as unknown,
      searchAddon: null,
      dispose: vi.fn(),
    };
    activateWebglRendererMock.mockResolvedValue(webglDummy);
    loadTerminalAddonsMock.mockResolvedValue(addons);

    const { rerender } = render(<TerminalHarness renderAccelerationEligible />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addons.webglAddon).toBe(webglDummy);

    await act(async () => {
      rerender(<TerminalHarness renderAccelerationEligible={false} />);
    });

    expect(webglDummy.dispose).toHaveBeenCalledOnce();
    expect(addons.webglAddon).toBeNull();
  });

  it("disposes WebGL when live resize starts", async () => {
    const webglDummy = { dispose: vi.fn() };
    const addons = {
      fitAddon: { fit: fitAddonFitMock },
      webglAddon: null as unknown,
      searchAddon: null,
      dispose: vi.fn(),
    };
    activateWebglRendererMock.mockResolvedValue(webglDummy);
    loadTerminalAddonsMock.mockResolvedValue(addons);

    render(<TerminalHarness renderAccelerationEligible />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addons.webglAddon).toBe(webglDummy);

    act(() => {
      emitLegacyTerminalGridLiveResize({ phase: "live" });
    });

    expect(webglDummy.dispose).toHaveBeenCalledOnce();
    expect(addons.webglAddon).toBeNull();
  });

  it("defers WebGL activation until an inactive terminal becomes active", async () => {
    const webglDummy = { dispose: vi.fn() };
    activateWebglRendererMock.mockResolvedValue(webglDummy);
    const addons = {
      fitAddon: { fit: fitAddonFitMock },
      webglAddon: null as unknown,
      searchAddon: null,
      dispose: vi.fn(),
    };
    loadTerminalAddonsMock.mockResolvedValue(addons);

    const { rerender } = render(<TerminalHarness active={false} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    expect(activateWebglRendererMock).not.toHaveBeenCalled();

    await act(async () => {
      rerender(<TerminalHarness active />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(activateWebglRendererMock).toHaveBeenCalledOnce();
    expect(addons.webglAddon).toBe(webglDummy);
  });
});
