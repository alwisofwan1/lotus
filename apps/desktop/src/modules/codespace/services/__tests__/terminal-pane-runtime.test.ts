import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalPaneRuntime,
  type TerminalPaneHost,
  type TerminalPaneSnapshot,
} from "../terminal-pane-runtime";

function makeHost(overrides: Partial<TerminalPaneHost> = {}): TerminalPaneHost {
  return {
    drainHiddenBuffer: vi.fn((write: (chunk: string) => void) => { void write; }),
    writeToTerminal: vi.fn(),
    refreshViewport: vi.fn(),
    disposeTerminal: vi.fn(),
    commitFit: vi.fn(),
    ...overrides,
  };
}

describe("TerminalPaneRuntime — state machine", () => {
  let host: TerminalPaneHost;
  let runtime: TerminalPaneRuntime;

  beforeEach(() => {
    host = makeHost();
    runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
  });

  it("starts in uninitialized with canvas renderer", () => {
    expect(runtime.getSnapshot()).toEqual({
      state: "uninitialized",
      renderer: "canvas",
      visibleIntent: true,
      liveResizeActive: false,
    });
  });

  it("walks the happy path to ready_visible when initially visible", () => {
    runtime.init();
    expect(runtime.getSnapshot().state).toBe("initializing");
    runtime.notifyXtermCreated();
    expect(runtime.getSnapshot().state).toBe("xterm_created");
    runtime.notifyAttached();
    expect(runtime.getSnapshot().state).toBe("ready_visible");
  });

  it("attaches into ready_hidden when not initially visible", () => {
    const hidden = new TerminalPaneRuntime(host, { initiallyVisible: false });
    hidden.init();
    hidden.notifyXtermCreated();
    hidden.notifyAttached();
    expect(hidden.getSnapshot().state).toBe("ready_hidden");
  });

  it("rejects out-of-order events without crashing", () => {
    // notifyAttached before xterm_created — silently ignored
    runtime.notifyAttached();
    expect(runtime.getSnapshot().state).toBe("uninitialized");

    // notifyXtermCreated from uninitialized — ignored
    runtime.notifyXtermCreated();
    expect(runtime.getSnapshot().state).toBe("uninitialized");

    // init twice — no-op on the second call
    runtime.init();
    runtime.init();
    expect(runtime.getSnapshot().state).toBe("initializing");
  });

  it("transitions ready_hidden → ready_visible on setVisible(true)", () => {
    const hidden = new TerminalPaneRuntime(host, { initiallyVisible: false });
    hidden.init();
    hidden.notifyXtermCreated();
    hidden.notifyAttached();
    expect(hidden.getSnapshot().state).toBe("ready_hidden");

    hidden.setVisible(true);
    expect(hidden.getSnapshot().state).toBe("ready_visible");
  });

  it("transitions ready_visible → ready_hidden on setVisible(false)", () => {
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();
    runtime.setVisible(false);
    expect(runtime.getSnapshot().state).toBe("ready_hidden");
  });

  it("queues visibility intent when set before attachment", () => {
    const hidden = new TerminalPaneRuntime(host, { initiallyVisible: false });
    hidden.init();
    hidden.setVisible(true); // intent change while still in initializing
    expect(hidden.getSnapshot().visibleIntent).toBe(true);
    expect(hidden.getSnapshot().state).toBe("initializing");
    hidden.notifyXtermCreated();
    hidden.notifyAttached();
    // Intent should apply on attach
    expect(hidden.getSnapshot().state).toBe("ready_visible");
  });

  it("setVisible to current value is idempotent", () => {
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached(); // ready_visible
    const drainSpy = host.drainHiddenBuffer as ReturnType<typeof vi.fn>;
    drainSpy.mockClear();
    runtime.setVisible(true);
    expect(drainSpy).not.toHaveBeenCalled();
  });
});

describe("TerminalPaneRuntime — entry actions", () => {
  it("drains hidden buffer and refreshes on entering ready_visible", () => {
    const host = makeHost({
      drainHiddenBuffer: vi.fn((write: (chunk: string) => void) => write("buffered chunk")),
    });
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();

    expect(host.drainHiddenBuffer).toHaveBeenCalledOnce();
    expect(host.writeToTerminal).toHaveBeenCalledWith("buffered chunk");
    expect(host.refreshViewport).toHaveBeenCalledOnce();
  });

  it("does not write when hidden buffer is empty", () => {
    const host = makeHost({
      drainHiddenBuffer: vi.fn((write: (chunk: string) => void) => { void write; }),
    });
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();

    expect(host.writeToTerminal).not.toHaveBeenCalled();
    expect(host.refreshViewport).toHaveBeenCalledOnce(); // refresh still fires
  });

  it("re-drains every time we transition into ready_visible", () => {
    const drainImpl = vi.fn(() => "second-batch");
    const host = makeHost({
      drainHiddenBuffer: vi.fn(() => "first-batch").mockImplementationOnce(() => "first-batch").mockImplementation(drainImpl),
    });
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: false });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached(); // ready_hidden (no drain)
    expect(host.drainHiddenBuffer).not.toHaveBeenCalled();

    runtime.setVisible(true); // ready_visible (drain)
    expect(host.drainHiddenBuffer).toHaveBeenCalledTimes(1);

    runtime.setVisible(false); // ready_hidden (no drain)
    runtime.setVisible(true); // ready_visible (drain again)
    expect(host.drainHiddenBuffer).toHaveBeenCalledTimes(2);
  });

  it("calls disposeTerminal exactly once on dispose", () => {
    const host = makeHost();
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();
    runtime.dispose();
    runtime.dispose(); // second call is a no-op
    expect(host.disposeTerminal).toHaveBeenCalledOnce();
  });
});

describe("TerminalPaneRuntime — renderer transitions", () => {
  let host: TerminalPaneHost;
  let runtime: TerminalPaneRuntime;

  beforeEach(() => {
    host = makeHost();
    runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();
    (host.refreshViewport as ReturnType<typeof vi.fn>).mockClear();
  });

  it("walks canvas → webgl_pending → webgl with a viewport refresh on success", () => {
    runtime.notifyRendererPromoting();
    expect(runtime.getSnapshot().renderer).toBe("webgl_pending");
    expect(host.refreshViewport).not.toHaveBeenCalled();

    runtime.notifyRendererPromoted();
    expect(runtime.getSnapshot().renderer).toBe("webgl");
    expect(host.refreshViewport).toHaveBeenCalledOnce();
  });

  it("reverts to canvas on promotion failure without firing refresh", () => {
    runtime.notifyRendererPromoting();
    runtime.notifyRendererPromotionFailed();
    expect(runtime.getSnapshot().renderer).toBe("canvas");
    expect(host.refreshViewport).not.toHaveBeenCalled();
  });

  it("ignores promotion events outside ready states", () => {
    const fresh = new TerminalPaneRuntime(makeHost(), { initiallyVisible: true });
    fresh.notifyRendererPromoting();
    expect(fresh.getSnapshot().renderer).toBe("canvas");
  });

  it("does not refresh viewport on renderer promotion when hidden", () => {
    runtime.setVisible(false);
    runtime.notifyRendererPromoting();
    runtime.notifyRendererPromoted();
    // No refresh — we're hidden, save the paint cycle
    expect(host.refreshViewport).not.toHaveBeenCalled();
  });

  it("notifyRendererLost from webgl → canvas refreshes viewport when visible", () => {
    runtime.notifyRendererPromoting();
    runtime.notifyRendererPromoted(); // webgl, visible — fires one refresh
    expect(host.refreshViewport).toHaveBeenCalledOnce();
    runtime.notifyRendererLost();
    expect(runtime.getSnapshot().renderer).toBe("canvas");
    // Loss fires its own refresh so the fallback renderer paints existing content
    expect(host.refreshViewport).toHaveBeenCalledTimes(2);
  });

  it("notifyRendererLost from webgl_pending → canvas without refresh (no content was on webgl yet)", () => {
    runtime.notifyRendererPromoting();
    runtime.notifyRendererLost();
    expect(runtime.getSnapshot().renderer).toBe("canvas");
    // No content was painted on webgl; canvas renderer was already current
    expect(host.refreshViewport).not.toHaveBeenCalled();
  });

  it("notifyRendererDemoted from webgl → canvas refreshes viewport when visible", () => {
    runtime.notifyRendererPromoting();
    runtime.notifyRendererPromoted();
    expect(host.refreshViewport).toHaveBeenCalledOnce();

    runtime.notifyRendererDemoted();

    expect(runtime.getSnapshot().renderer).toBe("canvas");
    expect(host.refreshViewport).toHaveBeenCalledTimes(2);
  });

  it("notifyRendererDemoted from webgl_pending → canvas without refresh", () => {
    runtime.notifyRendererPromoting();

    runtime.notifyRendererDemoted();

    expect(runtime.getSnapshot().renderer).toBe("canvas");
    expect(host.refreshViewport).not.toHaveBeenCalled();
  });

  it("notifyRendererLost when hidden updates state but does not refresh", () => {
    runtime.notifyRendererPromoting();
    runtime.notifyRendererPromoted();
    runtime.setVisible(false);
    (host.refreshViewport as ReturnType<typeof vi.fn>).mockClear();
    runtime.notifyRendererLost();
    expect(runtime.getSnapshot().renderer).toBe("canvas");
    expect(host.refreshViewport).not.toHaveBeenCalled();
  });

  it("notifyRendererLost on canvas is a no-op", () => {
    runtime.notifyRendererLost();
    expect(runtime.getSnapshot().renderer).toBe("canvas");
    expect(host.refreshViewport).not.toHaveBeenCalled();
  });
});

describe("TerminalPaneRuntime — disposed terminal state", () => {
  it("ignores every event after dispose", () => {
    const host = makeHost();
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.dispose();
    runtime.notifyAttached();
    runtime.setVisible(false);
    runtime.notifyRendererPromoting();
    expect(runtime.getSnapshot().state).toBe("disposed");
    expect(host.disposeTerminal).toHaveBeenCalledOnce();
  });
});

describe("TerminalPaneRuntime — subscribers", () => {
  it("notifies every subscriber on each transition", () => {
    const host = makeHost();
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    const a = vi.fn();
    const b = vi.fn();
    runtime.subscribe(a);
    runtime.subscribe(b);

    runtime.init();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    runtime.notifyXtermCreated();
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("delivers immutable snapshots", () => {
    const host = makeHost();
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    let lastSnapshot: TerminalPaneSnapshot | null = null;
    runtime.subscribe((snap) => {
      lastSnapshot = snap;
    });
    runtime.init();
    const snapshotAtInit = lastSnapshot as TerminalPaneSnapshot | null;
    runtime.notifyXtermCreated();
    // The original snapshot from init should not have mutated
    expect(snapshotAtInit).toEqual(expect.objectContaining({ state: "initializing" }));
  });

  it("stops calling unsubscribed listeners", () => {
    const host = makeHost();
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    const listener = vi.fn();
    const unsubscribe = runtime.subscribe(listener);
    runtime.init();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    runtime.notifyXtermCreated();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalPaneRuntime — live resize (drag) mode", () => {
  let host: TerminalPaneHost;
  let runtime: TerminalPaneRuntime;

  beforeEach(() => {
    host = makeHost();
    runtime = new TerminalPaneRuntime(host, { initiallyVisible: true });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached();
  });

  it("starts with liveResizeActive=false", () => {
    expect(runtime.isLiveResizing()).toBe(false);
    expect(runtime.getSnapshot().liveResizeActive).toBe(false);
  });

  it("notifyLiveResizeStart flips the flag and emits a snapshot", () => {
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.notifyLiveResizeStart();
    expect(runtime.isLiveResizing()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]?.liveResizeActive).toBe(true);
  });

  it("notifyLiveResizeStart is idempotent", () => {
    const listener = vi.fn();
    runtime.subscribe(listener);
    runtime.notifyLiveResizeStart();
    runtime.notifyLiveResizeStart();
    runtime.notifyLiveResizeStart();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("notifyLiveResizeEnd clears the flag and triggers commitFit exactly once", () => {
    runtime.notifyLiveResizeStart();
    runtime.notifyLiveResizeEnd();
    expect(runtime.isLiveResizing()).toBe(false);
    expect(host.commitFit).toHaveBeenCalledTimes(1);
  });

  it("notifyLiveResizeEnd without a matching Start is a no-op", () => {
    runtime.notifyLiveResizeEnd();
    expect(host.commitFit).not.toHaveBeenCalled();
  });

  it("notifyLiveResizeEnd in ready_hidden still fires commitFit (PTY must learn the new size)", () => {
    runtime.setVisible(false); // ready_hidden
    runtime.notifyLiveResizeStart();
    runtime.notifyLiveResizeEnd();
    expect(host.commitFit).toHaveBeenCalledTimes(1);
  });

  it("notifyLiveResizeStart before attachment records intent but does not fire commitFit later", () => {
    const earlyHost = makeHost();
    const early = new TerminalPaneRuntime(earlyHost, { initiallyVisible: true });
    early.notifyLiveResizeStart();
    expect(early.isLiveResizing()).toBe(true);
    early.notifyLiveResizeEnd();
    // Not yet in ready_* — no commit fit
    expect(earlyHost.commitFit).not.toHaveBeenCalled();
  });

  it("ignores live-resize events after dispose", () => {
    runtime.dispose();
    runtime.notifyLiveResizeStart();
    runtime.notifyLiveResizeEnd();
    expect(runtime.isLiveResizing()).toBe(false);
    expect(host.commitFit).not.toHaveBeenCalled();
  });
});

describe("TerminalPaneRuntime — regression: the drain race", () => {
  it("guarantees drain fires exactly once when output buffered before becoming visible", () => {
    // Simulates the screenshot bug: cell is created hidden, output accumulates,
    // then user switches to make it visible. Drain must fire deterministically
    // on the ready_hidden → ready_visible transition — not earlier (data loss),
    // not later (visual lag).
    const host = makeHost({
      drainHiddenBuffer: vi.fn((write: (chunk: string) => void) => write("Per tasks.md line 120-126: ...")),
    });
    const runtime = new TerminalPaneRuntime(host, { initiallyVisible: false });
    runtime.init();
    runtime.notifyXtermCreated();
    runtime.notifyAttached(); // ready_hidden — drain MUST NOT fire here
    expect(host.drainHiddenBuffer).not.toHaveBeenCalled();
    expect(host.writeToTerminal).not.toHaveBeenCalled();

    runtime.setVisible(true);
    expect(host.drainHiddenBuffer).toHaveBeenCalledTimes(1);
    expect(host.writeToTerminal).toHaveBeenCalledWith("Per tasks.md line 120-126: ...");
    expect(host.refreshViewport).toHaveBeenCalledOnce();
  });
});
