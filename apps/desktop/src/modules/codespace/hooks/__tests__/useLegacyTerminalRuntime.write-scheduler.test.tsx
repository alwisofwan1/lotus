import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLegacyTerminalRuntime } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import {
  getTerminalWriteMetricsSnapshot,
  resetTerminalWriteMetrics,
} from "@/modules/codespace/services/terminal-write-metrics";

const fitAddonFitMock = vi.hoisted(() => vi.fn());
const loadTerminalAddonsMock = vi.hoisted(() => vi.fn());
const activateWebglRendererMock = vi.hoisted(() => vi.fn());
const attachTerminalSessionMock = vi.hoisted(() => vi.fn());
const createTerminalSessionMock = vi.hoisted(() => vi.fn());
const detachTerminalSessionMock = vi.hoisted(() => vi.fn());
const resizeTerminalSessionMock = vi.hoisted(() => vi.fn());
const subscribeTerminalSessionStatusMock = vi.hoisted(() => vi.fn());

class TestResizeObserver {
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();
  constructor() {}
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

describe("useLegacyTerminalRuntime active output scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalWriteMetrics();
    TerminalMock.instances = [];
    fitAddonFitMock.mockClear();
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
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      width: 900,
      height: 480,
      top: 0,
      left: 0,
      right: 900,
      bottom: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetTerminalWriteMetrics();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not hand xterm a second active-output batch until the first write callback completes", async () => {
    render(<TerminalHarness />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60);
    });

    const terminal = TerminalMock.instances[0];
    const completeWrites: Array<() => void> = [];
    terminal.write.mockImplementation((_data: string, callback?: () => void) => {
      if (callback) completeWrites.push(callback);
    });

    const output = createTerminalSessionMock.mock.calls[0]?.[0]?.onOutput as (data: string) => void;

    act(() => {
      output("first");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenLastCalledWith("first", expect.any(Function));

    act(() => {
      output("second");
      output("third");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(terminal.write).toHaveBeenCalledTimes(1);

    act(() => completeWrites.shift()?.());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(terminal.write).toHaveBeenLastCalledWith("secondthird", expect.any(Function));
    expect(getTerminalWriteMetricsSnapshot().panes[0]).toMatchObject({
      paneId: "pane-1",
      queuedBytes: 16,
      writtenBytes: 16,
      writeCount: 2,
      pendingBytes: 0,
    });
  });
});
