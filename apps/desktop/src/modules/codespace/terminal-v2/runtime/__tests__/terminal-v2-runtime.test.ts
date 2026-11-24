import { describe, expect, it, vi } from "vitest";
import { TerminalV2Runtime } from "../terminal-v2-runtime";
import { createTerminalV2PooledDomSlotFactory } from "../../rendering/terminal-v2-pooled-dom-slot-factory";
import type { TerminalV2XtermRendererSlot } from "../../rendering/terminal-v2-xterm-renderer-host";
import type { TerminalV2SessionController } from "../terminal-v2-session-manager";

function createController() {
  return {
    connect: vi.fn(() => Promise.resolve()),
    write: vi.fn(),
    resize: vi.fn(),
    abort: vi.fn(),
    getSessionId: vi.fn(() => "runtime-session"),
  } satisfies TerminalV2SessionController;
}

function createRendererSlot(): TerminalV2XtermRendererSlot {
  return {
    attachPane: vi.fn(),
    releasePane: vi.fn(),
    terminal: {
      reset: vi.fn(),
      write: vi.fn(),
      refresh: vi.fn(),
      rows: 24,
    },
    fitAddon: { fit: vi.fn() },
  };
}

describe("TerminalV2Runtime", () => {
  it("registers legacy-created xterm slots with the Terminal V2 renderer coordinator", () => {
    const runtime = new TerminalV2Runtime();
    const slot = createRendererSlot();

    const waiting = runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    const unregister = runtime.registerLegacyRendererSlot("pane-1", slot);
    const reused = runtime.updateRendererPane({ paneId: "pane-1", visible: true, focused: true });
    unregister();

    expect(waiting).toEqual({ kind: "waiting-for-slot", paneId: "pane-1" });
    expect(reused).toEqual({ kind: "reused", paneId: "pane-1", slotId: "renderer-1" });
    expect(slot.attachPane).toHaveBeenCalledWith("pane-1");
    expect(slot.fitAddon.fit).toHaveBeenCalled();
    expect(slot.releasePane).toHaveBeenCalledWith("pane-1", null);
  });

  it("exposes renderer debug snapshots for diagnostics", () => {
    const runtime = new TerminalV2Runtime();

    runtime.updateRendererPane({ paneId: "waiting-pane", visible: true });

    expect(runtime.getRendererDebugSnapshot()).toEqual({
      leases: [],
      registeredSlots: [],
      waitingPanes: ["waiting-pane"],
      fallbackPanes: [],
    });
  });

  it("exposes a redacted runtime diagnostics snapshot with counters and session totals", () => {
    const runtime = new TerminalV2Runtime();

    runtime.updateRendererPane({ paneId: "waiting-pane", visible: true });
    runtime.writeRendererPaneOutput("waiting-pane", "abc");
    runtime.writePooledRendererInput("waiting-pane", "ls\r");
    runtime.resizePaneSession("waiting-pane", 120, 32);

    expect(runtime.getRuntimeDiagnosticsSnapshot()).toMatchObject({
      renderer: {
        leases: [],
        waitingPanes: ["waiting-pane"],
      },
      sessions: {
        total: 0,
        byStatus: {},
        byWorkspace: {},
      },
      counters: {
        rendererVisibilityUpdates: 1,
        rendererOutputBytes: 3,
        paneInputWrites: 1,
        paneResizeRequests: 1,
        pooledInputWrites: 1,
      },
      knownPaneCount: 1,
    });
  });

  it("reports session counts by workspace for operator diagnostics", async () => {
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: createController });

    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-a",
      cwd: "/repo-a",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });
    await runtime.sessionStarter.start({
      paneId: "pane-2",
      workspaceId: "workspace-a",
      cwd: "/repo-a",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });
    await runtime.sessionStarter.start({
      paneId: "pane-3",
      workspaceId: "workspace-b",
      cwd: "/repo-b",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });

    expect(runtime.getRuntimeDiagnosticsSnapshot().sessions.byWorkspace).toEqual({
      "workspace-a": 2,
      "workspace-b": 1,
    });
  });

  it("can bind a visible pane through an explicitly enabled pooled DOM slot factory", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime({
      pooledDomSlotFactory: createTerminalV2PooledDomSlotFactory({
        parkingContainer,
        resolvePaneContainer: (paneId) => paneId === "pane-1" ? paneContainer : null,
        createRenderer: () => ({
          terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose: vi.fn(),
        }),
        policyInput: { environment: "development", storageValue: "1" },
      }),
    });

    const result = runtime.updateRendererPane({ paneId: "pane-1", visible: true, focused: true });

    expect(result).toEqual({ kind: "bound", paneId: "pane-1", slotId: "renderer-1" });
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();
    expect(runtime.getRendererDebugSnapshot()).toMatchObject({
      waitingPanes: [],
      registeredSlots: [],
    });
  });

  it("tells a pane owner when a pooled slot has taken over rendering", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime({
      pooledDomSlotFactory: createTerminalV2PooledDomSlotFactory({
        parkingContainer,
        resolvePaneContainer: () => paneContainer,
        createRenderer: () => ({
          terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose: vi.fn(),
        }),
        policyInput: { environment: "development", storageValue: "1" },
      }),
    });

    expect(runtime.isPaneRendererServedByPooledSlot("pane-1")).toBe(false);

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    expect(runtime.isPaneRendererServedByPooledSlot("pane-1")).toBe(true);

    runtime.updateRendererPane({ paneId: "pane-1", visible: false });
    expect(runtime.isPaneRendererServedByPooledSlot("pane-1")).toBe(false);
  });

  it("routes pooled renderer keystrokes through the pane's input handler", async () => {
    const controller = createController();
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });
    const handleInput = vi.fn();
    const unregister = runtime.registerPaneInputHandler("pane-1", handleInput);

    runtime.writePooledRendererInput("pane-1", "ls\r\n");

    expect(handleInput).toHaveBeenCalledWith("ls\r\n");
    expect(controller.write).not.toHaveBeenCalled();

    unregister();
    runtime.writePooledRendererInput("pane-1", "x");

    expect(handleInput).toHaveBeenCalledTimes(1);
    expect(controller.write).toHaveBeenCalledWith("x");
  });

  it("keeps a pane typable when its input pipeline throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const controller = createController();
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });
    runtime.registerPaneInputHandler("pane-1", () => {
      throw new Error("input pipeline exploded");
    });

    expect(() => runtime.writePooledRendererInput("pane-1", "a")).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it("never replays standby output into a pooled slot that already rendered it live", () => {
    const write = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const runtime = new TerminalV2Runtime({
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: vi.fn(),
      pooledDomSlotFactory: createTerminalV2PooledDomSlotFactory({
        parkingContainer: document.createElement("div"),
        resolvePaneContainer: () => document.createElement("div"),
        createRenderer: () => ({
          terminal: { reset: vi.fn(), write, refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose: vi.fn(),
        }),
        policyInput: { environment: "development", storageValue: "1" },
      }),
    });

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    // The pane's own xterm is on standby, so it parks the same bytes the pooled slot rendered live.
    runtime.appendRendererStandbyBacklog("pane-1", "already-rendered");
    runtime.updateRendererPane({ paneId: "pane-1", visible: false });
    write.mockClear();
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    frames.splice(0).forEach((frame) => frame(0));

    expect(write).not.toHaveBeenCalledWith("already-rendered");
  });

  it("replays standby output into the pane's own renderer when it takes over", () => {
    const pooledWrite = vi.fn();
    const registeredWrite = vi.fn();
    const runtime = new TerminalV2Runtime({
      pooledDomSlotFactory: createTerminalV2PooledDomSlotFactory({
        parkingContainer: document.createElement("div"),
        resolvePaneContainer: () => document.createElement("div"),
        createRenderer: () => ({
          terminal: { reset: vi.fn(), write: pooledWrite, refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose: vi.fn(),
        }),
        policyInput: { environment: "development", storageValue: "1" },
      }),
    });
    runtime.registerLegacyRendererSlot("pane-1", {
      ...createRendererSlot(),
      liveOutputMode: "external",
      terminal: { reset: vi.fn(), write: registeredWrite, refresh: vi.fn(), rows: 24 },
    });

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    runtime.appendRendererStandbyBacklog("pane-1", "parked-while-standby");
    runtime.markPooledRendererPaneUnhealthy("pane-1");

    expect(registeredWrite).toHaveBeenCalledWith("parked-while-standby");
  });

  it("coalesces pooled renderer output into one write per frame", () => {
    const frames: FrameRequestCallback[] = [];
    const write = vi.fn();
    const runtime = new TerminalV2Runtime({
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: vi.fn(),
      pooledDomSlotFactory: createTerminalV2PooledDomSlotFactory({
        parkingContainer: document.createElement("div"),
        resolvePaneContainer: () => document.createElement("div"),
        createRenderer: () => ({
          terminal: { reset: vi.fn(), write, refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose: vi.fn(),
        }),
        policyInput: { environment: "development", storageValue: "1" },
      }),
    });
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    write.mockClear();

    runtime.writeRendererPaneOutput("pane-1", "chunk-a");
    runtime.writeRendererPaneOutput("pane-1", "chunk-b");

    expect(write).not.toHaveBeenCalled();

    frames.splice(0).forEach((frame) => frame(0));

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("chunk-achunk-b");
  });

  it("flushes pending pooled renderer output before the pane loses its renderer", () => {
    const frames: FrameRequestCallback[] = [];
    const write = vi.fn();
    const releasePane = vi.fn();
    const runtime = new TerminalV2Runtime({
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: vi.fn(),
      pooledDomSlotFactory: createTerminalV2PooledDomSlotFactory({
        parkingContainer: document.createElement("div"),
        resolvePaneContainer: () => document.createElement("div"),
        createRenderer: () => ({
          terminal: { reset: vi.fn(), write, refresh: vi.fn(), rows: 24 },
          fitAddon: { fit: vi.fn() },
          dispose: releasePane,
        }),
        policyInput: { environment: "development", storageValue: "1" },
      }),
    });
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    write.mockClear();

    runtime.writeRendererPaneOutput("pane-1", "pending");
    runtime.updateRendererPane({ paneId: "pane-1", visible: false });

    expect(write).toHaveBeenCalledWith("pending");
  });

  it("can install a pooled DOM slot factory after runtime construction", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime();
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => paneId === "pane-1" ? paneContainer : null,
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    });

    const uninstall = runtime.installPooledDomSlotFactory(factory);
    const result = runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    expect(result).toEqual({ kind: "bound", paneId: "pane-1", slotId: "renderer-1" });
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();

    // Uninstalling hands the slot back before its factory disposes it.
    uninstall();
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeNull();
    expect(parkingContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();
    expect(runtime.updateRendererPane({ paneId: "pane-2", visible: true })).toEqual({
      kind: "waiting-for-slot",
      paneId: "pane-2",
    });
  });

  it("binds a pane that became visible before the pooled factory was installed", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);

    expect(runtime.updateRendererPane({ paneId: "pane-1", visible: true })).toEqual({
      kind: "waiting-for-slot",
      paneId: "pane-1",
    });

    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    expect(paneContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();
  });

  it("attaches a visible pooled lease when its pane container registers after the bind", () => {
    const parkingContainer = document.createElement("div");
    const paneContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime();
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true, focused: true });
    expect(runtime.getRendererDebugSnapshot().leases[0]?.health?.attachedPaneId).toBeNull();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);

    expect(paneContainer.querySelector("[data-terminal-v2-slot-id]")).toBeTruthy();
    expect(runtime.getRendererDebugSnapshot().leases[0]?.health?.attachedPaneId).toBe("pane-1");
  });

  it("attaches host-created pooled renderer slots to all registered visible panes", () => {
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime();
    const paneContainers = Array.from({ length: 6 }, (_, index) => {
      const paneId = `pane-${index + 1}`;
      const container = document.createElement("div");
      runtime.registerPooledRendererPaneContainer(paneId, container);
      return { paneId, container };
    });
    const factory = createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    });

    runtime.installPooledDomSlotFactory(factory);
    const results = paneContainers.map(({ paneId }) => runtime.updateRendererPane({ paneId, visible: true }));

    expect(results).toEqual(
      paneContainers.map(({ paneId }, index) => ({
        kind: "bound",
        paneId,
        slotId: `renderer-${index + 1}`,
      })),
    );
    for (const { container } of paneContainers) {
      expect(container.querySelector("[data-terminal-v2-slot-id]")).toBeTruthy();
    }
  });

  it("falls back to the legacy registered slot when pooled rendering does not report a render", () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const paneContainer = document.createElement("div");
      const parkingContainer = document.createElement("div");
      const runtime = new TerminalV2Runtime({ rendererHealthCheckMs: 25 });
      runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
      runtime.registerLegacyRendererSlot("pane-1", createRendererSlot());
      runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
        parkingContainer,
        resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
        createRenderer: () => ({
          terminal: {
            reset: vi.fn(() => events.push("pooled:reset")),
            write: vi.fn((data) => events.push(`pooled:write:${data}`)),
            refresh: vi.fn(() => events.push("pooled:repaint")),
            rows: 24,
          },
          fitAddon: { fit: vi.fn(() => events.push("pooled:fit")) },
          dispose: vi.fn(),
          captureSnapshot: () => "pooled-snapshot",
          onRender: () => ({ dispose: vi.fn() }),
        }),
        policyInput: { environment: "development", storageValue: "1" },
      }));

      runtime.updateRendererPane({ paneId: "pane-1", visible: true });
      vi.advanceTimersByTime(25);

      expect(runtime.getRendererDebugSnapshot().fallbackPanes).toEqual(["pane-1"]);
      expect(runtime.getRendererDebugSnapshot().leases[0]?.health).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores pooled renderer snapshots when a workspace is hidden and shown again", () => {
    const events: string[] = [];
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: {
          reset: vi.fn(() => events.push("reset")),
          write: vi.fn((data) => events.push(`write:${data}`)),
          refresh: vi.fn(() => events.push("repaint")),
          rows: 24,
        },
        fitAddon: { fit: vi.fn(() => events.push("fit")) },
        dispose: vi.fn(),
        captureSnapshot: () => "snapshot:pane-1",
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    runtime.writeRendererPaneOutput("pane-1", "prompt");
    runtime.updateRendererPane({ paneId: "pane-1", visible: false });
    runtime.appendRendererBacklog("pane-1", "hidden-output");
    events.length = 0;

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    expect(events).toEqual([
      "reset",
      "fit",
      "write:snapshot:pane-1",
      "write:hidden-output",
      "repaint",
    ]);
  });

  it("focuses the leased pooled renderer before fallback UI focus", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const focus = vi.fn();
    const runtime = new TerminalV2Runtime();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), focus, rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    expect(runtime.focusPaneRenderer("pane-1")).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("resolves helper textarea from the leased pooled renderer", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const helperTextarea = document.createElement("textarea");
    const runtime = new TerminalV2Runtime();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
        helperTextarea,
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    expect(runtime.getPaneRendererHelperTextarea("pane-1")).toBe(helperTextarea);
  });

  it("routes pane search to the leased pooled renderer before fallback", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const pooledSearch = {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearSearch: vi.fn(),
    };
    const fallbackSearch = {
      findNext: vi.fn(() => false),
      findPrevious: vi.fn(() => false),
      clearSearch: vi.fn(),
    };
    const runtime = new TerminalV2Runtime();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
        search: pooledSearch,
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    const search = runtime.createPaneSearchApi("pane-1", fallbackSearch);

    expect(search.findNext("kebon", "live")).toBe(true);
    expect(pooledSearch.findNext).toHaveBeenCalledWith("kebon", "live");
    expect(fallbackSearch.findNext).not.toHaveBeenCalled();
  });

  it("falls back to the native search API when the leased renderer has no search API", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const fallbackSearch = {
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => false),
      clearSearch: vi.fn(),
    };
    const runtime = new TerminalV2Runtime();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    const search = runtime.createPaneSearchApi("pane-1", fallbackSearch);

    expect(search.findNext("alpha", "navigate")).toBe(true);
    expect(search.findPrevious("alpha")).toBe(false);
    search.clearSearch();
    expect(fallbackSearch.findNext).toHaveBeenCalledWith("alpha", "navigate");
    expect(fallbackSearch.findPrevious).toHaveBeenCalledWith("alpha");
    expect(fallbackSearch.clearSearch).toHaveBeenCalledOnce();
  });

  it("mirrors live PTY output into the leased pooled renderer slot", () => {
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const write = vi.fn();
    const frames: FrameRequestCallback[] = [];
    const runtime = new TerminalV2Runtime({
      requestFrame: (callback) => frames.push(callback),
      cancelFrame: vi.fn(),
    });
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write, refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    runtime.writeRendererPaneOutput("pane-1", "hello");
    frames.splice(0).forEach((frame) => frame(0));

    expect(write).toHaveBeenCalledWith("hello");
  });

  it("syncs PTY geometry after a pooled renderer fits the attached pane", async () => {
    const controller = createController();
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });
    controller.resize.mockClear();
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), cols: 132, rows: 38 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    expect(controller.resize).toHaveBeenCalledWith(132, 38);
  });

  it("does not mirror live output into externally-owned legacy renderer slots", () => {
    const runtime = new TerminalV2Runtime();
    const slot = createRendererSlot();
    slot.liveOutputMode = "external";
    runtime.registerLegacyRendererSlot("pane-1", slot);
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    runtime.writeRendererPaneOutput("pane-1", "prompt");

    expect(slot.terminal.write).not.toHaveBeenCalled();
  });

  it("routes geometry resizes through the app-level session manager", async () => {
    const controller = createController();
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });

    runtime.resizePaneSession("pane-1", 100, 30);

    expect(controller.resize).toHaveBeenCalledWith(100, 30);
  });

  it("routes parsed terminal input through the app-level session manager", async () => {
    const controller = createController();
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });

    runtime.writePaneInput("pane-1", "npm test\r", {
      origin: "human",
      intent: "conversation-prompt",
      submitted: true,
      promptText: "npm test",
    });

    expect(controller.write).toHaveBeenCalledWith("npm test\r");
  });

  it("normalizes single CRLF pooled renderer input to one Enter", async () => {
    const controller = createController();
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });

    runtime.writePooledRendererInput("pane-1", "\r\n");

    expect(controller.write).toHaveBeenCalledWith("\r");
  });

  it("forwards pooled renderer input into the pane session manager", async () => {
    const controller = createController();
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });

    runtime.writePooledRendererInput("pane-1", "ls\r");

    expect(controller.write).toHaveBeenCalledWith("ls\r");
  });

  it("restores released snapshots before draining hidden pane output", () => {
    const events: string[] = [];
    const slot = createRendererSlot();
    slot.terminal.write = vi.fn((data) => events.push(`write:${data}`));
    slot.terminal.reset = vi.fn(() => events.push("reset"));
    slot.fitAddon.fit = vi.fn(() => events.push("fit"));
    slot.terminal.refresh = vi.fn(() => events.push("repaint"));
    const runtime = new TerminalV2Runtime({
      captureRendererSnapshot: (paneId) => `snapshot:${paneId}`,
      restoreRendererSnapshots: true,
    });

    runtime.registerLegacyRendererSlot("pane-1", slot);
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    runtime.updateRendererPane({ paneId: "pane-1", visible: false });
    runtime.appendRendererBacklog("pane-1", "hidden-output");
    events.length = 0;

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    expect(events).toEqual([
      "reset",
      "fit",
      "write:snapshot:pane-1",
      "write:hidden-output",
      "repaint",
    ]);
  });

  it("buffers hidden output and drains it exactly once across repeated hide/show", () => {
    const writes: string[] = [];
    const slot = createRendererSlot();
    slot.terminal.write = vi.fn((data) => writes.push(data));
    const runtime = new TerminalV2Runtime({
      captureRendererSnapshot: (paneId) => `snapshot:${paneId}`,
      restoreRendererSnapshots: true,
    });

    runtime.registerLegacyRendererSlot("pane-1", slot);
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    runtime.updateRendererPane({ paneId: "pane-1", visible: false });
    runtime.writeRendererPaneOutput("pane-1", "agent-output");

    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    runtime.updateRendererPane({ paneId: "pane-1", visible: false });
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    expect(writes.filter((entry) => entry === "agent-output")).toHaveLength(1);
  });

  it("closes a pane session and releases its pooled renderer ownership", async () => {
    const controller = createController();
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => controller });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });
    runtime.appendRendererBacklog("pane-1", "stale-output");

    runtime.closeSession("pane-1");

    expect(controller.abort).toHaveBeenCalledOnce();
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeNull();
    expect(parkingContainer.querySelector("[data-terminal-v2-slot-id='renderer-1']")).toBeTruthy();
    expect(runtime.getRendererDebugSnapshot().leases).toEqual([]);
    expect(runtime.getRendererDebugSnapshot().waitingPanes).toEqual([]);
    expect(runtime.getPooledRendererPaneContainer("pane-1")).toBeNull();
    expect(runtime.writeRendererPaneOutput("pane-1", "after-close")).toBeUndefined();
  });

  it("does not leak renderer leases, waiting panes, or containers after repeated pooled pane closes", async () => {
    const controllers: TerminalV2SessionController[] = [];
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime({
      sessionControllerFactory: () => {
        const controller = createController();
        controllers.push(controller);
        return controller;
      },
    });
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: vi.fn(),
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));

    for (let index = 0; index < 12; index += 1) {
      const paneId = `pane-${index}`;
      runtime.registerPooledRendererPaneContainer(paneId, document.createElement("div"));
      await runtime.sessionStarter.start({
        paneId,
        workspaceId: "workspace-1",
        cwd: "/repo",
        geometry: { cols: 80, rows: 24 },
        onOutput: vi.fn(),
      });
      runtime.updateRendererPane({ paneId, visible: true, focused: index === 11 });
      runtime.appendRendererBacklog(paneId, `stale-${index}`);
    }

    for (let index = 0; index < 12; index += 1) {
      runtime.closeSession(`pane-${index}`);
    }

    expect(controllers).toHaveLength(12);
    expect(controllers.every((controller) => vi.mocked(controller.abort).mock.calls.length === 1)).toBe(true);
    expect(runtime.getRendererDebugSnapshot()).toEqual({
      leases: [],
      registeredSlots: [],
      waitingPanes: [],
      fallbackPanes: [],
    });
    for (let index = 0; index < 12; index += 1) {
      expect(runtime.getPooledRendererPaneContainer(`pane-${index}`)).toBeNull();
      runtime.writeRendererPaneOutput(`pane-${index}`, "after-close");
    }
    expect(runtime.getRendererDebugSnapshot().waitingPanes).toEqual([]);
  });

  it("disposes pooled renderer slots and clears renderer state on runtime shutdown", async () => {
    const disposeRenderer = vi.fn();
    const paneContainer = document.createElement("div");
    const parkingContainer = document.createElement("div");
    const runtime = new TerminalV2Runtime({ sessionControllerFactory: () => createController() });
    await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });
    runtime.registerPooledRendererPaneContainer("pane-1", paneContainer);
    runtime.installPooledDomSlotFactory(createTerminalV2PooledDomSlotFactory({
      parkingContainer,
      resolvePaneContainer: (paneId) => runtime.getPooledRendererPaneContainer(paneId),
      createRenderer: () => ({
        terminal: { reset: vi.fn(), write: vi.fn(), refresh: vi.fn(), rows: 24 },
        fitAddon: { fit: vi.fn() },
        dispose: disposeRenderer,
      }),
      policyInput: { environment: "development", storageValue: "1" },
    }));
    runtime.updateRendererPane({ paneId: "pane-1", visible: true });

    runtime.dispose();

    expect(disposeRenderer).toHaveBeenCalledOnce();
    expect(paneContainer.querySelector("[data-terminal-v2-slot-id]")).toBeNull();
    expect(parkingContainer.querySelector("[data-terminal-v2-slot-id]")).toBeNull();
    expect(runtime.getRendererDebugSnapshot()).toEqual({
      leases: [],
      registeredSlots: [],
      waitingPanes: [],
      fallbackPanes: [],
    });
  });

  it("exposes one session starter backed by its app-level session manager", async () => {
    const runtime = new TerminalV2Runtime({
      sessionControllerFactory: () => createController(),
    });

    const outcome = await runtime.sessionStarter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    });

    expect(outcome).toEqual({ kind: "created", sessionId: "runtime-session" });
    expect(runtime.sessionManager.getSession("pane-1")).toMatchObject({
      paneId: "pane-1",
      sessionId: "runtime-session",
      status: "running",
    });
  });
});
