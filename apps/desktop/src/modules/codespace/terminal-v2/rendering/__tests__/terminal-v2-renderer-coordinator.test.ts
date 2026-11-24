import { describe, expect, it, vi } from "vitest";
import { TerminalV2RendererCoordinator } from "../terminal-v2-renderer-coordinator";
import { TerminalV2XtermRendererHost, type TerminalV2XtermRendererSlot } from "../terminal-v2-xterm-renderer-host";

function createSlot(
  events: string[],
  name: string,
  options: { snapshot?: string | null } = {},
): TerminalV2XtermRendererSlot {
  return {
    attachPane: vi.fn((paneId) => events.push(`${name}:attach:${paneId}`)),
    releasePane: vi.fn((paneId, snapshot) => events.push(`${name}:release:${paneId}:${snapshot ?? "none"}`)),
    captureSnapshot: options.snapshot === undefined ? undefined : vi.fn(() => options.snapshot ?? null),
    terminal: {
      reset: vi.fn(() => events.push(`${name}:reset`)),
      write: vi.fn((data) => events.push(`${name}:write:${data}`)),
      refresh: vi.fn((start, end) => events.push(`${name}:refresh:${start}-${end}`)),
      rows: 24,
    },
    fitAddon: {
      fit: vi.fn(() => events.push(`${name}:fit`)),
    },
  };
}

function createCoordinator(events: string[], capacity = 2) {
  const host = new TerminalV2XtermRendererHost({
    createSlot: (slotId) => {
      throw new Error(`unexpected lazy slot ${slotId}`);
    },
    drainPaneOutput: (paneId, write) => write(`drain:${paneId}`),
  });
  return new TerminalV2RendererCoordinator({ host, capacity });
}

describe("TerminalV2RendererCoordinator", () => {
  it("exposes a debug snapshot of leases, waiting panes, and registered slots", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 2);

    coordinator.updatePane({ paneId: "waiting-pane", visible: true, focused: true });
    coordinator.registerPaneSlot("bound-pane", createSlot(events, "slot-a"));
    coordinator.updatePane({ paneId: "bound-pane", visible: true, agentActive: true });

    expect(coordinator.getDebugSnapshot()).toEqual({
      leases: [{
        paneId: "bound-pane",
        slotId: "renderer-1",
        signals: {
          visible: true,
          focused: false,
          agentActive: true,
          busy: false,
          altScreen: false,
          liveResizeActive: false,
        },
        health: null,
      }],
      registeredSlots: ["bound-pane"],
      waitingPanes: ["waiting-pane"],
      fallbackPanes: [],
    });
  });

  it("waits for a pane slot before applying a visible bind plan", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events);

    expect(coordinator.updatePane({ paneId: "pane-1", visible: true })).toEqual({
      kind: "waiting-for-slot",
      paneId: "pane-1",
    });

    const unregister = coordinator.registerPaneSlot("pane-1", createSlot(events, "slot-a"));

    expect(events).toEqual([
      "slot-a:attach:pane-1",
      "slot-a:reset",
      "slot-a:fit",
      "slot-a:write:drain:pane-1",
      "slot-a:refresh:0-23",
    ]);

    unregister();
    expect(events.at(-1)).toBe("slot-a:release:pane-1:none");
  });

  it("keeps an existing renderer attached when a new pane takes focus", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events);
    coordinator.registerPaneSlot("pane-1", createSlot(events, "existing"));
    coordinator.updatePane({ paneId: "pane-1", visible: true, focused: true });
    events.length = 0;

    coordinator.updatePane({ paneId: "pane-1", visible: true, focused: false });

    expect(events).toEqual([]);
    expect(coordinator.getDebugSnapshot().leases[0].signals.focused).toBe(false);
  });

  it("does not reattach a pooled DOM slot when focus changes", () => {
    const events: string[] = [];
    const host = new TerminalV2XtermRendererHost({
      createSlot: () => createSlot(events, "pooled"),
      drainPaneOutput: () => {},
    });
    const coordinator = new TerminalV2RendererCoordinator({ host, capacity: 2, allowHostCreatedSlots: true });
    coordinator.updatePane({ paneId: "pane-1", visible: true, focused: true });
    events.length = 0;

    coordinator.updatePane({ paneId: "pane-1", visible: true, focused: false });

    expect(events).toEqual([]);
  });

  it("releases a pane when it becomes hidden", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events);

    coordinator.registerPaneSlot("pane-1", createSlot(events, "slot-a"));
    coordinator.updatePane({ paneId: "pane-1", visible: true });
    const result = coordinator.updatePane({ paneId: "pane-1", visible: false });

    expect(result).toMatchObject({ kind: "released", paneId: "pane-1", slotId: "renderer-1" });
    expect(events.at(-1)).toBe("slot-a:release:pane-1:none");
  });

  it("evicts the lowest-priority visible pane when capacity is exceeded", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 1);

    coordinator.registerPaneSlot("pane-1", createSlot(events, "slot-a"));
    coordinator.registerPaneSlot("pane-2", createSlot(events, "slot-b"));
    coordinator.updatePane({ paneId: "pane-1", visible: true });
    const result = coordinator.updatePane({ paneId: "pane-2", visible: true, focused: true });

    expect(result).toMatchObject({ kind: "bound", paneId: "pane-2", slotId: "renderer-1" });
    expect(events).toContain("slot-a:release:pane-1:none");
    expect(events.slice(-5)).toEqual([
      "slot-b:attach:pane-2",
      "slot-b:reset",
      "slot-b:fit",
      "slot-b:write:drain:pane-2",
      "slot-b:refresh:0-23",
    ]);
  });

  it("falls back to a registered pane slot when host-created rendering is unhealthy", () => {
    const events: string[] = [];
    const host = new TerminalV2XtermRendererHost({
      createSlot: () => createSlot(events, "pooled", { snapshot: "pooled-snapshot" }),
      drainPaneOutput: (paneId, write) => write(`drain:${paneId}`),
    });
    const coordinator = new TerminalV2RendererCoordinator({
      host,
      capacity: 1,
      allowHostCreatedSlots: true,
    });
    coordinator.registerPaneSlot("pane-1", createSlot(events, "legacy"));

    coordinator.updatePane({ paneId: "pane-1", visible: true });
    events.length = 0;
    const result = coordinator.fallbackPaneToRegisteredSlot("pane-1");

    expect(result).toEqual({ kind: "bound", paneId: "pane-1", slotId: "renderer-1" });
    expect(events).toEqual([
      "pooled:release:pane-1:pooled-snapshot",
      "legacy:attach:pane-1",
      "legacy:reset",
      "legacy:fit",
      "legacy:write:pooled-snapshot",
      "legacy:write:drain:pane-1",
      "legacy:refresh:0-23",
    ]);
    expect(coordinator.getDebugSnapshot().fallbackPanes).toEqual(["pane-1"]);
  });

  it("reports which panes a host-created slot is currently rendering", () => {
    const events: string[] = [];
    const host = new TerminalV2XtermRendererHost({
      createSlot: () => createSlot(events, "pooled"),
      drainPaneOutput: (paneId, write) => write(`drain:${paneId}`),
    });
    const coordinator = new TerminalV2RendererCoordinator({
      host,
      capacity: 1,
      allowHostCreatedSlots: true,
    });
    coordinator.registerPaneSlot("pane-1", createSlot(events, "legacy"));

    expect(coordinator.isPaneServedByHostCreatedSlot("pane-1")).toBe(false);

    coordinator.updatePane({ paneId: "pane-1", visible: true });
    expect(coordinator.isPaneServedByHostCreatedSlot("pane-1")).toBe(true);

    coordinator.fallbackPaneToRegisteredSlot("pane-1");
    expect(coordinator.isPaneServedByHostCreatedSlot("pane-1")).toBe(false);

    coordinator.updatePane({ paneId: "pane-1", visible: false });
    expect(coordinator.isPaneServedByHostCreatedSlot("pane-1")).toBe(false);
  });

  it("replays the pane backlog into a registered slot that owns its own live output on fallback", () => {
    const events: string[] = [];
    const host = new TerminalV2XtermRendererHost({
      createSlot: () => createSlot(events, "pooled"),
      drainPaneOutput: (paneId, write) => write(`drain:${paneId}`),
    });
    const coordinator = new TerminalV2RendererCoordinator({
      host,
      capacity: 1,
      allowHostCreatedSlots: true,
    });
    coordinator.registerPaneSlot("pane-1", {
      ...createSlot(events, "legacy"),
      liveOutputMode: "external",
    });

    coordinator.updatePane({ paneId: "pane-1", visible: true });
    events.length = 0;
    coordinator.fallbackPaneToRegisteredSlot("pane-1");

    expect(events).toContain("legacy:write:drain:pane-1");
  });

  it("suppresses pooled renderer fit while a pane is live-resizing and commits one fit afterward", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 1);

    coordinator.registerPaneSlot("pane-1", {
      ...createSlot(events, "slot-a"),
      setLiveResizeActive: (active) => { if (!active) events.push("slot-a:commit-fit"); },
    });
    coordinator.updatePane({ paneId: "pane-1", visible: true, liveResizeActive: true });
    expect(events).toEqual([
      "slot-a:attach:pane-1",
      "slot-a:reset",
      "slot-a:write:drain:pane-1",
      "slot-a:refresh:0-23",
    ]);

    events.length = 0;
    coordinator.updatePane({ paneId: "pane-1", visible: true, liveResizeActive: false });
    expect(events).toEqual(["slot-a:commit-fit"]);
  });

  it("captures slot snapshots on hide and restores them before draining output on rebind", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 1);

    coordinator.registerPaneSlot("pane-1", createSlot(events, "slot-a", { snapshot: "serialized:pane-1" }));
    coordinator.updatePane({ paneId: "pane-1", visible: true });
    coordinator.updatePane({ paneId: "pane-1", visible: false });
    events.length = 0;
    coordinator.updatePane({ paneId: "pane-1", visible: true });

    expect(events).toEqual([
      "slot-a:attach:pane-1",
      "slot-a:reset",
      "slot-a:fit",
      "slot-a:write:serialized:pane-1",
      "slot-a:write:drain:pane-1",
      "slot-a:refresh:0-23",
    ]);
  });
});

/**
 * The blank-pane regression, from the native window on 2026-09-21.
 *
 * A pane whose slot unregisters and registers again — React re-creating the xterm handles, or a
 * focus-mode branch remounting the subtree — came back dark and stayed dark: the unregister had
 * deleted the pane's DESIRED state as well as its lease, so `registerPaneSlot` had nothing to
 * bind and the visibility effect never re-ran, because none of its inputs had changed.
 */
describe("a slot that goes away and comes back", () => {
  it("rebinds on its own, because losing the element is not changing your mind", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 2);

    const unregister = coordinator.registerPaneSlot("pane", createSlot(events, "slot-a"));
    coordinator.updatePane({ paneId: "pane", visible: true, focused: true });
    expect(coordinator.getDebugSnapshot().leases.map((lease) => lease.paneId)).toEqual(["pane"]);

    // The element goes away: nothing to draw into, so the lease is right to go…
    unregister();
    expect(coordinator.getDebugSnapshot().leases).toEqual([]);
    // …but the pane still WANTS to be visible, so it is waiting, not forgotten.
    expect(coordinator.getDebugSnapshot().waitingPanes).toEqual(["pane"]);

    // …and when a slot comes back, it binds with nobody having to ask again.
    coordinator.registerPaneSlot("pane", createSlot(events, "slot-b"));
    expect(coordinator.getDebugSnapshot().leases.map((lease) => lease.paneId)).toEqual(["pane"]);
    expect(coordinator.getDebugSnapshot().waitingPanes).toEqual([]);
  });

  it("still forgets a pane that was actually hidden or removed", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 2);

    const unregister = coordinator.registerPaneSlot("pane", createSlot(events, "slot-a"));
    coordinator.updatePane({ paneId: "pane", visible: true });
    coordinator.updatePane({ paneId: "pane", visible: false });
    unregister();

    coordinator.registerPaneSlot("pane", createSlot(events, "slot-b"));
    expect(coordinator.getDebugSnapshot().leases).toEqual([]);
    expect(coordinator.getDebugSnapshot().waitingPanes).toEqual([]);
  });
});

describe("background panes", () => {
  it("prefers a background pane as the eviction victim", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 2);
    coordinator.registerPaneSlot("on-screen", createSlot(events, "slot-a"));
    coordinator.registerPaneSlot("hidden-ws", createSlot(events, "slot-b"));
    coordinator.registerPaneSlot("new-pane", createSlot(events, "slot-c"));

    coordinator.updatePane({ paneId: "on-screen", visible: true });
    coordinator.updatePane({ paneId: "hidden-ws", visible: true });
    coordinator.setBackgroundPanes(["hidden-ws"]);
    coordinator.updatePane({ paneId: "new-pane", visible: true });

    expect(coordinator.getLeases().map((lease) => lease.paneId).sort()).toEqual(["new-pane", "on-screen"]);
  });

  it("rebinds an evicted pane when its workspace comes back to the foreground", () => {
    // Its `visible` never changed, so no visibility effect will re-run for it: the coordinator is
    // the only place that knows it lost its slot, and so the only place that can give it back.
    const events: string[] = [];
    const coordinator = createCoordinator(events, 1);
    coordinator.registerPaneSlot("pane-a", createSlot(events, "slot-a"));
    coordinator.registerPaneSlot("pane-b", createSlot(events, "slot-b"));

    coordinator.updatePane({ paneId: "pane-a", visible: true });
    coordinator.setBackgroundPanes(["pane-a"]);
    coordinator.updatePane({ paneId: "pane-b", visible: true });
    expect(coordinator.getLeases().map((lease) => lease.paneId)).toEqual(["pane-b"]);

    const results = coordinator.setBackgroundPanes(["pane-b"]);

    expect(results.map((result) => [result.paneId, result.kind])).toEqual([["pane-a", "bound"]]);
    expect(coordinator.getLeases().map((lease) => lease.paneId)).toEqual(["pane-a"]);
  });

  it("does not rebind a pane that was hidden on purpose", () => {
    const events: string[] = [];
    const coordinator = createCoordinator(events, 1);
    coordinator.registerPaneSlot("pane-a", createSlot(events, "slot-a"));

    coordinator.updatePane({ paneId: "pane-a", visible: true });
    coordinator.setBackgroundPanes(["pane-a"]);
    coordinator.updatePane({ paneId: "pane-a", visible: false });

    expect(coordinator.setBackgroundPanes([])).toEqual([]);
    expect(coordinator.getLeases()).toEqual([]);
  });
});
