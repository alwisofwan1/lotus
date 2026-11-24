import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalV2RendererCoordinator } from "../terminal-v2-renderer-coordinator";
import { createTerminalV2PooledDomSlot } from "../terminal-v2-pooled-dom-slot";
import { TerminalV2XtermRendererHost } from "../terminal-v2-xterm-renderer-host";

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe = vi.fn((element: Element) => {
    this.observed.push(element);
  });
  disconnect = vi.fn();
}

describe("createTerminalV2PooledDomSlot", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockResizeObserver.instances = [];
  });

  it("can be driven by the renderer coordinator without owning pane state", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
    });
    const host = new TerminalV2XtermRendererHost({
      createSlot: () => slot,
      drainPaneOutput: vi.fn(),
    });
    const coordinator = new TerminalV2RendererCoordinator({ host, capacity: 1, resetOnBind: false });

    coordinator.registerPaneSlot("pane-1", slot);
    coordinator.updatePane({ paneId: "pane-1", visible: true });
    expect(paneContainer.contains(slot.slotElement)).toBe(true);

    coordinator.updatePane({ paneId: "pane-1", visible: false });
    expect(parkingContainer.contains(slot.slotElement)).toBe(true);
  });

  it("marks the active pane while attached and clears the marker when parked", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
    });

    slot.attachPane("pane-1");
    expect(slot.slotElement.dataset.terminalV2PaneId).toBe("pane-1");

    slot.releasePane("pane-1", null);
    expect(slot.slotElement.dataset.terminalV2PaneId).toBeUndefined();
  });

  it("forwards pooled xterm input to the currently attached pane", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const writePaneInput = vi.fn();
    const inputListeners: Array<(data: string) => void> = [];
    const inputDisposable = { dispose: vi.fn(() => { inputListeners.length = 0; }) };

    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      writePaneInput,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
        onData: (listener) => {
          inputListeners.push(listener);
          return inputDisposable;
        },
      }),
    });

    slot.attachPane("pane-1");
    const listener = inputListeners[0];
    if (!listener) throw new Error("expected input listener");
    listener("a");
    slot.releasePane("pane-1", null);

    expect(writePaneInput).toHaveBeenCalledWith("pane-1", "a");
    expect(inputDisposable.dispose).toHaveBeenCalledTimes(1);
    expect(inputListeners).toHaveLength(0);
  });

  it("focuses the pooled renderer terminal while attached", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const focus = vi.fn();
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), focus, rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
    });

    slot.attachPane("pane-1");

    expect(slot.focus?.()).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("blurs the pooled renderer terminal and helper textarea while still attached", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const helperTextarea = document.createElement("textarea");
    const blur = vi.fn();
    helperTextarea.blur = vi.fn();
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), blur, rows: 24 },
        fitAddon: { fit: vi.fn() },
        helperTextarea,
        dispose: vi.fn(),
      }),
    });

    slot.attachPane("pane-1");

    expect(slot.blur?.()).toBe(true);
    expect(blur).toHaveBeenCalledOnce();
    expect(helperTextarea.blur).toHaveBeenCalledOnce();
  });

  it("exposes the pooled renderer helper textarea for cursor-relative overlays", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const helperTextarea = document.createElement("textarea");
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        helperTextarea,
        dispose: vi.fn(),
      }),
    });

    slot.attachPane("pane-1");

    expect(slot.getHelperTextarea?.()).toBe(helperTextarea);
  });

  it("refits an attached pooled renderer when its pane container resizes", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const fitAddon = { fit: vi.fn() };
    const terminal = { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), cols: 80, rows: 24 };
    const onFitGeometry = vi.fn();
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      onFitGeometry,
      createRenderer: () => ({
        terminal,
        fitAddon,
        dispose: vi.fn(),
      }),
    });

    slot.attachPane("pane-1");
    expect(MockResizeObserver.instances.at(-1)?.observed).toContain(paneContainer);

    MockResizeObserver.instances.at(-1)?.callback([
      { contentRect: { width: 400, height: 240 } } as ResizeObserverEntry,
    ], MockResizeObserver.instances.at(-1) as unknown as ResizeObserver);

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onFitGeometry).toHaveBeenCalledWith("pane-1", 80, 24);
  });

  it("suppresses ResizeObserver fit while live resize is active and commits after it ends", () => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const fitAddon = { fit: vi.fn() };
    const terminal = { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), cols: 80, rows: 24 };
    const onFitGeometry = vi.fn();
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      onFitGeometry,
      createRenderer: () => ({ terminal, fitAddon, dispose: vi.fn() }),
    });

    slot.attachPane("pane-1");
    fitAddon.fit.mockClear();
    onFitGeometry.mockClear();
    slot.setLiveResizeActive?.(true);
    MockResizeObserver.instances.at(-1)?.callback([
      { contentRect: { width: 401, height: 240 } } as ResizeObserverEntry,
    ], MockResizeObserver.instances.at(-1) as unknown as ResizeObserver);

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(onFitGeometry).not.toHaveBeenCalled();

    slot.setLiveResizeActive?.(false);

    expect(fitAddon.fit).toHaveBeenCalledOnce();
    expect(onFitGeometry).toHaveBeenCalledWith("pane-1", 80, 24);
  });

  it("reports renderer health from pooled writes and render events", () => {
    vi.useFakeTimers();
    try {
      const paneContainer = document.createElement("div");
      const parkingContainer = document.createElement("div");
      const renderListeners: Array<() => void> = [];
      const slot = createTerminalV2PooledDomSlot({
        slotId: "renderer-1",
        parkingContainer,
        resolvePaneContainer: () => paneContainer,
        createRenderer: () => ({
          terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose: vi.fn(),
          onRender: (listener) => {
            renderListeners.push(listener);
            return { dispose: vi.fn() };
          },
        }),
      });

      vi.setSystemTime(100);
      slot.attachPane("pane-1");
      vi.setSystemTime(120);
      slot.terminal.write("prompt");
      vi.setSystemTime(140);
      renderListeners[0]?.();

      expect(slot.getHealth?.()).toEqual({
        attachedPaneId: "pane-1",
        lastAttachedAt: 100,
        lastWriteAt: 120,
        lastRenderAt: 140,
        renderObserverAttached: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps parked pooled renderer elements non-painting until attached", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
    });

    expect(slot.slotElement.hidden).toBe(true);
    expect(slot.slotElement.style.visibility).toBe("hidden");
    expect(slot.slotElement.style.overflow).toBe("hidden");
    expect(slot.slotElement.style.contain).toContain("paint");
    expect(slot.slotElement.style.position).toBe("absolute");
    expect(slot.slotElement.style.inset).toBe("0px");

    slot.attachPane("pane-1");
    expect(slot.slotElement.hidden).toBe(false);
    expect(slot.slotElement.style.visibility).toBe("visible");

    slot.releasePane("pane-1", null);
    expect(slot.slotElement.hidden).toBe(true);
    expect(slot.slotElement.style.visibility).toBe("hidden");
  });

  it("moves a pooled renderer element into the active pane container and parks it on release", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const terminal = {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    };
    const fitAddon = { fit: vi.fn() };

    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: (paneId) => paneId === "pane-1" ? paneContainer : null,
      createRenderer: vi.fn(() => ({ terminal, fitAddon, dispose: vi.fn() })),
    });

    expect(parkingContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();

    slot.attachPane("pane-1");
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();
    expect(parkingContainer.children).toHaveLength(0);

    slot.releasePane("pane-1", null);
    expect(parkingContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();
  });
  it("announces visibility only after the attach fit, and withdraws it before parking", () => {
    // Order is the point. An accelerated renderer sizes its buffer to the canvas it finds, so it
    // must be told AFTER the fit; and it must be told it is leaving while its canvas is still the
    // one on screen, not after the element has been re-parented.
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));

    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const events: string[] = [];
    const fitAddon = { fit: vi.fn(() => { events.push("fit"); }) };
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), cols: 80, rows: 24 },
        fitAddon,
        dispose: vi.fn(),
        setVisible: (visible: boolean) => {
          events.push(visible ? "visible" : "hidden");
          if (!visible) events.push(paneContainer.contains(slot.slotElement) ? "on-screen" : "parked");
        },
      }),
    });

    slot.attachPane("pane-1");
    expect(events).toEqual([]);

    for (const [id, frame] of frames) {
      frames.delete(id);
      frame(0);
    }
    expect(events).toEqual(["fit", "visible"]);

    slot.releasePane("pane-1", null);
    expect(events).toEqual(["fit", "visible", "hidden", "on-screen"]);
  });

  it("does not announce visibility when the pane is parked before the attach frame runs", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));

    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const setVisible = vi.fn();
    const slot = createTerminalV2PooledDomSlot({
      slotId: "renderer-1",
      parkingContainer,
      resolvePaneContainer: () => paneContainer,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), cols: 80, rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
        setVisible,
      }),
    });

    slot.attachPane("pane-1");
    slot.releasePane("pane-1", null);
    for (const [id, frame] of frames) {
      frames.delete(id);
      frame(0);
    }

    expect(setVisible).toHaveBeenCalledTimes(1);
    expect(setVisible).toHaveBeenCalledWith(false);
  });
});
