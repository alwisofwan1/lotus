import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLegacyTerminalRuntime } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";

const fitAddonFitMock = vi.hoisted(() => vi.fn());
const loadTerminalAddonsMock = vi.hoisted(() => vi.fn());
const activateWebglRendererMock = vi.hoisted(() => vi.fn());
const attachTerminalSessionMock = vi.hoisted(() => vi.fn());
const createTerminalSessionMock = vi.hoisted(() => vi.fn());
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
    this.callback([{ contentRect: { width, height } as DOMRectReadOnly } as ResizeObserverEntry], this as unknown as ResizeObserver);
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
  detachTerminalSession: vi.fn(),
  getTerminalRuntimeSessionId: vi.fn(() => "session-1"),
  markTerminalSessionExited: vi.fn(),
  resizeTerminalSession: resizeTerminalSessionMock,
  subscribeTerminalSessionStatus: subscribeTerminalSessionStatusMock,
  writeTerminalSession: vi.fn(),
}));

function TerminalHarness() {
  const { containerRef } = useLegacyTerminalRuntime({
    active: true,
    workspaceId: "workspace-1",
    paneId: "pane-1",
    cwd: "/tmp/project",
    fontSize: 13,
    history: [],
  });

  return <div ref={containerRef} />;
}

describe("useLegacyTerminalRuntime resize jitter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    terminalRect = { width: 900, height: 480 };
    TestResizeObserver.instances = [];
    TerminalMock.instances = [];
    fitAddonFitMock.mockClear();
    resizeTerminalSessionMock.mockClear();
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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
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

  it("ignores sub-pixel ResizeObserver jitter after a handled resize", async () => {
    render(<TerminalHarness />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    fitAddonFitMock.mockClear();
    resizeTerminalSessionMock.mockClear();

    act(() => TestResizeObserver.instances[0]?.emit(900.2, 480.4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    act(() => TestResizeObserver.instances[0]?.emit(900.8, 480.9));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fitAddonFitMock).toHaveBeenCalledOnce();
  });
});
