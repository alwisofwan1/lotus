import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLegacyTerminalRuntime } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";

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

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  emit(width: number, height: number) {
    this.callback(
      [{ contentRect: { width, height } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

class TerminalMock {
  static instances: TerminalMock[] = [];
  cols = 120;
  rows = 32;
  options: Record<string, unknown> = {};
  open = vi.fn();
  attachCustomKeyEventHandler = vi.fn();
  onData = vi.fn();
  write = vi.fn();
  refresh = vi.fn();
  focus = vi.fn();
  dispose = vi.fn();
  constructor(options: Record<string, unknown> = {}) {
    this.options = options;
    TerminalMock.instances.push(this);
  }
}

vi.mock("@xterm/xterm", () => ({ Terminal: TerminalMock }));

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

function TerminalHarness({ active = true }: { active?: boolean }) {
  const { containerRef } = useLegacyTerminalRuntime({
    active,
    workspaceId: "workspace-1",
    paneId: "pane-1",
    cwd: "/tmp/project",
    fontSize: 13,
    history: [],
  });
  return <div ref={containerRef} />;
}

describe("useLegacyTerminalRuntime — WebGL refresh fixes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalRect = { width: 900, height: 480 };
    TestResizeObserver.instances = [];
    TerminalMock.instances = [];
    fitAddonFitMock.mockClear();
    resizeTerminalSessionMock.mockClear();
    activateWebglRendererMock.mockClear();
    attachTerminalSessionMock.mockClear();
    createTerminalSessionMock.mockClear();
    detachTerminalSessionMock.mockClear();
    subscribeTerminalSessionStatusMock.mockClear();
    activateWebglRendererMock.mockResolvedValue(null);
    attachTerminalSessionMock.mockReturnValue(false);
    createTerminalSessionMock.mockReturnValue({ connectPromise: Promise.resolve() });
    subscribeTerminalSessionStatusMock.mockReturnValue(() => {});
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
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          width: terminalRect.width,
          height: terminalRect.height,
          top: 0,
          left: 0,
          right: terminalRect.width,
          bottom: terminalRect.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("Fix 1: refreshes full viewport after WebGL activation completes", async () => {
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

    // Use the proven drain pattern from existing tests:
    // xterm import → loadTerminalAddons → RAF → activateWebglRenderer resolves
    await act(async () => {
      await Promise.resolve(); // xterm dynamic import
      await Promise.resolve(); // loadTerminalAddons resolves
      await vi.advanceTimersByTimeAsync(0); // RAF fires (fit + startRuntimeSession)
      // activateWebglRenderer is awaited after fit — drain its resolved Promise
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60); // resizeTimer + remaining async tails
      await Promise.resolve();
    });

    // At this point webglAddon should be assigned
    expect(addons.webglAddon).toBe(webglDummy);

    // Now fire the post-WebGL RAF that calls refresh(0, rows-1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const terminal = TerminalMock.instances[0];
    expect(terminal.refresh).toHaveBeenCalledWith(0, terminal.rows - 1);
  });

  it("Fix 1: does NOT refresh if terminal deactivated during WebGL load", async () => {
    let resolveWebgl: (v: unknown) => void;
    const webglPromise = new Promise((r) => { resolveWebgl = r; });
    activateWebglRendererMock.mockReturnValue(webglPromise);
    const addons = {
      fitAddon: { fit: fitAddonFitMock },
      webglAddon: null as unknown,
      searchAddon: null,
      dispose: vi.fn(),
    };
    loadTerminalAddonsMock.mockResolvedValue(addons);

    const { rerender } = render(<TerminalHarness active />);

    // Let terminal initialize and start WebGL activation
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60);
    });

    const terminal = TerminalMock.instances[0];
    terminal.refresh.mockClear();

    // Deactivate before WebGL resolves
    await act(async () => {
      rerender(<TerminalHarness active={false} />);
    });

    // Now resolve WebGL
    await act(async () => {
      resolveWebgl!({ dispose: vi.fn() });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });

    // refresh should NOT be called since terminal is no longer active
    expect(terminal.refresh).not.toHaveBeenCalled();
  });

  it("drains hidden output on the ready_hidden → ready_visible transition (state machine, not WebGL-gated)", async () => {
    // Design change: drain is the entry-action of `ready_visible`, fired by
    // the TerminalPaneRuntime state machine when visibility intent flips true.
    // It no longer waits for WebGL — the renderer transitions independently,
    // and a refresh fires on WebGL promotion to re-paint canvas content.
    // This pattern is faster (perceived smoothness) and removes the drain race.
    let resolveWebgl: (v: unknown) => void;
    const webglPromise = new Promise((r) => { resolveWebgl = r; });
    activateWebglRendererMock.mockReturnValue(webglPromise);
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
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(180);
    });

    const terminal = TerminalMock.instances[0];
    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as (data: string) => void;
    expect(output).toBeDefined();

    // Output sent while inactive routes to the hidden buffer.
    act(() => { output("buffered content"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(terminal.write).not.toHaveBeenCalledWith("buffered content", expect.any(Function));
    terminal.write.mockClear();

    // Activating the cell flips runtime visibility intent → ready_visible
    // entry-action drains buffer + refreshes immediately. WebGL is still
    // pending here and must NOT block the drain.
    await act(async () => {
      rerender(<TerminalHarness active />);
      await Promise.resolve();
    });

    expect(terminal.write).toHaveBeenCalledWith("buffered content", expect.any(Function));

    // Renderer can promote later; that fires its own refresh entry-action.
    await act(async () => {
      resolveWebgl!({ dispose: vi.fn() });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("Fix 2: refresh fires AFTER drain completes when becoming active", async () => {
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

    // Initialize terminal
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(180);
    });

    const terminal = TerminalMock.instances[0];
    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as (data: string) => void;
    act(() => { output("some output"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    terminal.write.mockClear();
    terminal.refresh.mockClear();

    // Track call order
    const callOrder: string[] = [];
    terminal.write.mockImplementation((_data: string, cb?: () => void) => {
      callOrder.push("write");
      cb?.();
    });
    terminal.refresh.mockImplementation(() => { callOrder.push("refresh"); });

    // Become active
    await act(async () => {
      rerender(<TerminalHarness active />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0); // active effect RAF
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0); // post-drain RAF refresh
      await vi.advanceTimersByTimeAsync(0);
    });

    // refresh must come AFTER write (drain)
    const writeIdx = callOrder.indexOf("write");
    const refreshIdx = callOrder.lastIndexOf("refresh");
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(refreshIdx).toBeGreaterThan(writeIdx);
  });
});
