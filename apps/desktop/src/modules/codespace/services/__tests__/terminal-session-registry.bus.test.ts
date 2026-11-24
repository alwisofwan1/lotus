import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachCellBus,
  clearTerminalSessionRegistryForTests,
  closeTerminalSession,
  createTerminalSession,
  getAllTerminalSessions,
  getWorkspaceTerminalSessions,
  markTerminalSessionExited,
  registerTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";
import { createCellBus, type CellBusEvents } from "@/modules/codespace/services/bridge/cell-event-bus";

type BusEvent<K extends keyof CellBusEvents> = { name: K; payload: CellBusEvents[K] };

describe("terminal-session-registry · cell-bus integration", () => {
  beforeEach(() => {
    clearTerminalSessionRegistryForTests();
  });

  function recordingBus() {
    const bus = createCellBus();
    const events: BusEvent<keyof CellBusEvents>[] = [];
    bus.on("terminal:spawned", (p) => events.push({ name: "terminal:spawned", payload: p }));
    bus.on("terminal:exited", (p) => events.push({ name: "terminal:exited", payload: p }));
    bus.on("terminal:input", (p) => events.push({ name: "terminal:input", payload: p }));
    bus.on("terminal:status", (p) => events.push({ name: "terminal:status", payload: p }));
    return { bus, events };
  }

  it("emits terminal:spawned and status changes through attached bus", async () => {
    const { bus, events } = recordingBus();
    const detach = attachCellBus(bus);

    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-x"),
    };

    const session = createTerminalSession({
      paneId: "pane-a",
      workspaceId: "ws-1",
      cwd: "/tmp/a",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    await session.connectPromise;
    closeTerminalSession("pane-a");
    detach();

    const spawned = events.find((e) => e.name === "terminal:spawned");
    expect(spawned?.payload).toEqual({
      paneId: "pane-a",
      workspaceId: "ws-1",
      cwd: "/tmp/a",
    });

    const statuses = events.filter((e) => e.name === "terminal:status").map((e) => (e.payload as CellBusEvents["terminal:status"]).status);
    expect(statuses).toEqual(["starting", "live", "exited"]);

    const exited = events.find((e) => e.name === "terminal:exited");
    expect(exited?.payload).toEqual({ paneId: "pane-a", workspaceId: "ws-1" });
  });

  it("detach function stops further bus emission", async () => {
    const { bus, events } = recordingBus();
    const detach = attachCellBus(bus);
    detach();

    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => null),
    };

    const session = createTerminalSession({
      paneId: "pane-a",
      workspaceId: "ws-1",
      cwd: "/tmp",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;

    expect(events.length).toBe(0);
  });

  it("markTerminalSessionExited emits terminal:exited + exited status", async () => {
    const { bus, events } = recordingBus();
    attachCellBus(bus);

    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "rt"),
    };
    const session = createTerminalSession({
      paneId: "pane-b",
      workspaceId: "ws-2",
      cwd: "/tmp/b",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;

    markTerminalSessionExited("pane-b");

    const exitedEvents = events.filter((e) => e.name === "terminal:exited");
    expect(exitedEvents).toHaveLength(1);
    expect(exitedEvents[0].payload).toEqual({ paneId: "pane-b", workspaceId: "ws-2" });
  });

  it("emits terminal:input when writing to a registered session", async () => {
    const { bus, events } = recordingBus();
    attachCellBus(bus);

    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "rt"),
    };
    const session = createTerminalSession({
      paneId: "pane-c",
      workspaceId: "ws-3",
      cwd: "/tmp/c",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;

    const { writeTerminalSession } = await import("@/modules/codespace/services/terminal-session-registry");
    writeTerminalSession("pane-c", "run task\n");

    const inputEvents = events.filter((e) => e.name === "terminal:input");
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0].payload).toEqual({
      paneId: "pane-c",
      workspaceId: "ws-3",
      data: "run task\n",
      origin: "programmatic",
      intent: "unknown",
      submitted: false,
    });
    expect(controller.write).toHaveBeenCalledWith("run task\n");
  });

  it("preserves explicit conversation metadata when writing to a session", async () => {
    const { bus, events } = recordingBus();
    attachCellBus(bus);

    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "rt"),
    };
    const session = createTerminalSession({
      paneId: "pane-d",
      workspaceId: "ws-4",
      cwd: "/tmp/d",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;

    const { writeTerminalSession } = await import(
      "@/modules/codespace/services/terminal-session-registry"
    );
    writeTerminalSession("pane-d", "review this\r", {
      origin: "human",
      intent: "conversation-prompt",
      submitted: true,
      promptText: "review this",
    });

    const inputEvents = events.filter((e) => e.name === "terminal:input");
    expect(inputEvents).toHaveLength(1);
    expect(inputEvents[0].payload).toEqual({
      paneId: "pane-d",
      workspaceId: "ws-4",
      data: "review this\r",
      origin: "human",
      intent: "conversation-prompt",
      submitted: true,
      promptText: "review this",
    });
  });
});

describe("terminal-session-registry · snapshot", () => {
  beforeEach(() => {
    clearTerminalSessionRegistryForTests();
  });

  it("getAllTerminalSessions returns snapshot of all sessions", () => {
    registerTerminalSession("pane-1", {
      workspaceId: "ws-1",
      cwd: "/a",
      status: "live",
      close: () => {},
      getSessionId: () => "s-1",
    });
    registerTerminalSession("pane-2", {
      workspaceId: "ws-2",
      cwd: "/b",
      status: "live",
      close: () => {},
      getSessionId: () => "s-2",
    });

    const snapshot = getAllTerminalSessions();
    expect(snapshot).toEqual([
      { paneId: "pane-1", workspaceId: "ws-1", cwd: "/a", status: "live", sessionId: "s-1" },
      { paneId: "pane-2", workspaceId: "ws-2", cwd: "/b", status: "live", sessionId: "s-2" },
    ]);
  });

  it("getWorkspaceTerminalSessions filters by workspaceId", () => {
    registerTerminalSession("p1", { workspaceId: "w1", cwd: "/a", status: "live", close: () => {} });
    registerTerminalSession("p2", { workspaceId: "w2", cwd: "/b", status: "live", close: () => {} });
    registerTerminalSession("p3", { workspaceId: "w1", cwd: "/c", status: "starting", close: () => {} });

    const ws1 = getWorkspaceTerminalSessions("w1");
    expect(ws1.map((s) => s.paneId).sort()).toEqual(["p1", "p3"]);
  });
});
