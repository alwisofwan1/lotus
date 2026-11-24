import { describe, expect, it, vi } from "vitest";
import type { CellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import type { TerminalV2RuntimeSession } from "../../contracts/terminal-types";
import {
  createLegacyTerminalSessionAdapter,
  mapLegacyStatusToV2,
  mapV2StatusToLegacy,
  type TerminalV2LegacyRuntimePort,
} from "../legacy-terminal-session-adapter";

function fakeRuntime(sessions: TerminalV2RuntimeSession[]): TerminalV2LegacyRuntimePort {
  return {
    attachCellBus: vi.fn(() => vi.fn()),
    createSession: vi.fn(() => ({
      connectPromise: Promise.resolve(),
      close: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      getSessionId: vi.fn(() => "session-created"),
    })),
    closeSession: vi.fn(),
    markSessionExited: vi.fn(),
    closeWorkspaceSessions: vi.fn(),
    closeAllSessions: vi.fn(),
    hasSession: vi.fn((paneId) => sessions.some((session) => session.paneId === paneId)),
    writeSession: vi.fn(),
    writeSessionConfirmed: vi.fn(() => Promise.resolve()),
    resizeSession: vi.fn(),
    getSessionInput: vi.fn(() => ""),
    attachSession: vi.fn(() => true),
    detachSession: vi.fn(),
    getSession: vi.fn((paneId) => sessions.find((session) => session.paneId === paneId) ?? null),
    getAllSessions: vi.fn(() => sessions),
    tapOutput: vi.fn(() => vi.fn()),
    subscribeStatus: vi.fn((_paneId, subscriber) => {
      subscriber("running");
      return vi.fn();
    }),
  };
}

describe("legacy Terminal V2 session adapter", () => {
  it("maps all runtime statuses across the compatibility boundary", () => {
    expect(mapV2StatusToLegacy("cold")).toBe("idle");
    expect(mapV2StatusToLegacy("connecting")).toBe("starting");
    expect(mapV2StatusToLegacy("running")).toBe("live");
    expect(mapV2StatusToLegacy("detached")).toBe("detached");
    expect(mapV2StatusToLegacy("failed")).toBe("failed");
    expect(mapV2StatusToLegacy("exited")).toBe("exited");

    expect(mapLegacyStatusToV2("idle")).toBe("cold");
    expect(mapLegacyStatusToV2("starting")).toBe("connecting");
    expect(mapLegacyStatusToV2("live")).toBe("running");
    expect(mapLegacyStatusToV2("detached")).toBe("detached");
    expect(mapLegacyStatusToV2("failed")).toBe("failed");
    expect(mapLegacyStatusToV2("exited")).toBe("exited");
  });

  it("presents V2 sessions as legacy terminal snapshots", () => {
    const runtime = fakeRuntime([
      {
        paneId: "pane-1",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        status: "running",
        launch: { kind: "local", cwd: "/repo" },
      },
      {
        paneId: "pane-2",
        workspaceId: "workspace-2",
        sessionId: null,
        status: "cold",
        launch: { kind: "local", cwd: "/other" },
      },
    ]);

    const adapter = createLegacyTerminalSessionAdapter(runtime);

    expect(adapter.getAllTerminalSessions()).toEqual([
      {
        paneId: "pane-1",
        workspaceId: "workspace-1",
        cwd: "/repo",
        status: "live",
        sessionId: "session-1",
      },
      {
        paneId: "pane-2",
        workspaceId: "workspace-2",
        cwd: "/other",
        status: "idle",
        sessionId: null,
      },
    ]);
    expect(adapter.getWorkspaceTerminalSessions("workspace-1")).toHaveLength(1);
    expect(adapter.getTerminalRuntimeSessionId("pane-1")).toBe("session-1");
    expect(adapter.hasTerminalSession("pane-2")).toBe(true);
  });

  it("maps subscribed V2 status updates before notifying legacy consumers", () => {
    const adapter = createLegacyTerminalSessionAdapter(fakeRuntime([]));
    const subscriber = vi.fn();

    adapter.subscribeTerminalSessionStatus("pane-1", subscriber);

    expect(subscriber).toHaveBeenCalledWith("live");
  });

  it("delegates bus attachment through the port", () => {
    const runtime = fakeRuntime([]);
    const adapter = createLegacyTerminalSessionAdapter(runtime);
    const bus = {} as CellBus;

    adapter.attachCellBus(bus);

    expect(runtime.attachCellBus).toHaveBeenCalledWith(bus);
  });
});
