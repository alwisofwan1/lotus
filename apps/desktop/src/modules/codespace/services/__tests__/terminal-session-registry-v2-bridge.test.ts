import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import {
  attachCellBus,
  attachTerminalSession,
  clearTerminalSessionRegistryForTests,
  closeTerminalSession,
  createTerminalSession,
  detachTerminalSession,
  getAllTerminalSessions,
  getTerminalRuntimeSessionId,
  getTerminalSessionInput,
  getTerminalSessionStatus,
  registerTerminalSession,
  resizeTerminalSession,
  subscribeTerminalSessionStatus,
  getWorkspaceTerminalSessions,
  tapTerminalOutput,
  writeTerminalSession,
  writeTerminalSessionConfirmed,
} from "@/modules/codespace/services/terminal-session-registry";
import {
  createLegacyTerminalSessionAdapter,
  installTerminalV2LegacySessionAdapter,
  TerminalV2SessionManager,
  type TerminalV2SessionController,
} from "@/modules/codespace/terminal-v2";

function createController(): TerminalV2SessionController & {
  emitOutput: (data: string) => void;
  writes: string[];
  resizes: Array<[number, number]>;
  aborted: () => boolean;
} {
  let onOutput: ((data: string) => void) | null = null;
  let sessionId: string | null = "v2-session-1";
  let aborted = false;
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];

  return {
    async connect(_cwd, _cols, _rows, nextOnOutput) {
      onOutput = nextOnOutput;
    },
    async connectToCommand(_cwd, _command, _cols, _rows, nextOnOutput) {
      onOutput = nextOnOutput;
    },
    write(data) {
      writes.push(data);
    },
    async writeConfirmed(data) {
      writes.push(data);
    },
    resize(cols, rows) {
      resizes.push([cols, rows]);
    },
    abort() {
      aborted = true;
      sessionId = null;
    },
    getSessionId() {
      return sessionId;
    },
    emitOutput(data) {
      onOutput?.(data);
    },
    writes,
    resizes,
    aborted: () => aborted,
  };
}

describe("terminal-session-registry V2 bridge", () => {
  beforeEach(() => {
    clearTerminalSessionRegistryForTests();
  });

  it("keeps legacy-only sessions visible and writable while V2 is installed", async () => {
    const manager = new TerminalV2SessionManager({ controllerFactory: () => createController() });
    const uninstall = installTerminalV2LegacySessionAdapter(
      createLegacyTerminalSessionAdapter(manager),
    );
    const legacyWrite = vi.fn();
    const legacyResize = vi.fn();
    const legacyClose = vi.fn();

    registerTerminalSession("legacy-pane", {
      workspaceId: "workspace-legacy",
      cwd: "/legacy",
      status: "live",
      close: legacyClose,
      write: legacyWrite,
      resize: legacyResize,
      getSessionId: () => "legacy-session",
    });

    writeTerminalSession("legacy-pane", "legacy input");
    resizeTerminalSession("legacy-pane", 90, 20);

    expect(legacyWrite).toHaveBeenCalledWith("legacy input");
    expect(legacyResize).toHaveBeenCalledWith(90, 20);
    expect(getTerminalRuntimeSessionId("legacy-pane")).toBe("legacy-session");
    expect(getTerminalSessionStatus("legacy-pane")).toBe("live");
    expect(getAllTerminalSessions()).toEqual([
      {
        paneId: "legacy-pane",
        workspaceId: "workspace-legacy",
        cwd: "/legacy",
        status: "live",
        sessionId: "legacy-session",
      },
    ]);
    expect(getWorkspaceTerminalSessions("workspace-legacy")).toHaveLength(1);

    closeTerminalSession("legacy-pane");
    expect(legacyClose).toHaveBeenCalledOnce();
    uninstall();
  });

  it("merges legacy and V2 sessions for fleet snapshots", async () => {
    const v2Controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => v2Controller });
    const uninstall = installTerminalV2LegacySessionAdapter(
      createLegacyTerminalSessionAdapter(manager),
    );
    registerTerminalSession("legacy-pane", {
      workspaceId: "workspace-1",
      cwd: "/legacy",
      status: "live",
      close: vi.fn(),
      getSessionId: () => "legacy-session",
    });

    await createTerminalSession({
      paneId: "v2-pane",
      workspaceId: "workspace-1",
      cwd: "/v2",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
    }).connectPromise;

    expect(getWorkspaceTerminalSessions("workspace-1")).toEqual([
      {
        paneId: "legacy-pane",
        workspaceId: "workspace-1",
        cwd: "/legacy",
        status: "live",
        sessionId: "legacy-session",
      },
      {
        paneId: "v2-pane",
        workspaceId: "workspace-1",
        cwd: "/v2",
        status: "live",
        sessionId: "v2-session-1",
      },
    ]);
    uninstall();
  });

  it("keeps only Canvas session creation on legacy while V2 is installed", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const uninstall = installTerminalV2LegacySessionAdapter(
      createLegacyTerminalSessionAdapter(manager),
    );
    const legacyController = {
      connect: vi.fn(() => Promise.resolve()),
      connectToCommand: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "legacy-canvas-session"),
    };

    const sshSession = createTerminalSession({
      paneId: "ssh-pane",
      workspaceId: "workspace-ssh",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      command: ["ssh", "example.com"],
      location: { kind: "ssh", host: "example.com" },
      controller: legacyController,
    });
    await sshSession.connectPromise;

    const canvasSession = createTerminalSession({
      paneId: "canvas-pane",
      workspaceId: "workspace-canvas",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      canvasTerminalId: "canvas-node-1",
      controller: legacyController,
    });
    await canvasSession.connectPromise;

    expect(legacyController.connect).toHaveBeenCalledOnce();
    expect(manager.getAllSessions().map((session) => session.paneId)).toEqual(["ssh-pane"]);
    expect(getAllTerminalSessions().map((session) => session.paneId).sort()).toEqual([
      "canvas-pane",
      "ssh-pane",
    ]);
    uninstall();
  });

  it("preserves confirmed-write receipts through the Terminal V2 compatibility adapter", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const uninstall = installTerminalV2LegacySessionAdapter(
      createLegacyTerminalSessionAdapter(manager),
    );

    await createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
    }).connectPromise;

    await writeTerminalSessionConfirmed("pane-1", "echo v2-confirmed\\r");
    expect(controller.writes).toEqual(["echo v2-confirmed\\r"]);
    uninstall();
  });

  it("routes legacy registry calls through the installed Terminal V2 adapter", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const bus = createCellBus();
    const busEvents: string[] = [];
    const output = vi.fn();
    const tap = vi.fn();
    const status = vi.fn();

    bus.on("terminal:status", (event) => busEvents.push(`status:${event.status}`));
    bus.on("terminal:input", (event) => busEvents.push(`input:${event.data}`));
    const unlistenBus = attachCellBus(bus);
    const uninstall = installTerminalV2LegacySessionAdapter(
      createLegacyTerminalSessionAdapter(manager),
    );
    const unsubscribeStatus = subscribeTerminalSessionStatus("pane-1", status);
    const untap = tapTerminalOutput("pane-1", tap);

    const handle = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: output,
    });
    await handle.connectPromise;

    controller.emitOutput("hello");
    writeTerminalSession("pane-1", "git");
    writeTerminalSession("pane-1", " status");
    resizeTerminalSession("pane-1", 100, 30);

    expect(getTerminalSessionStatus("pane-1")).toBe("live");
    expect(getTerminalRuntimeSessionId("pane-1")).toBe("v2-session-1");
    expect(getTerminalSessionInput("pane-1")).toBe("git status");
    expect(getAllTerminalSessions()).toEqual([
      {
        paneId: "pane-1",
        workspaceId: "workspace-1",
        cwd: "/repo",
        status: "live",
        sessionId: "v2-session-1",
      },
    ]);
    expect(output).toHaveBeenCalledWith("hello");
    expect(tap).toHaveBeenCalledWith("hello");
    expect(controller.writes).toEqual(["git", " status"]);
    expect(controller.resizes).toEqual([[100, 30]]);
    expect(status).toHaveBeenLastCalledWith("live");
    expect(busEvents).toContain("status:live");
    expect(busEvents).toContain("input: status");

    detachTerminalSession("pane-1");
    expect(getTerminalSessionStatus("pane-1")).toBe("detached");
    expect(attachTerminalSession("pane-1", vi.fn(), { workspaceId: "workspace-1", cwd: "/repo" })).toBe(true);

    closeTerminalSession("pane-1");
    expect(controller.aborted()).toBe(true);
    expect(getTerminalSessionInput("pane-1")).toBe("");

    untap();
    unsubscribeStatus();
    unlistenBus();
    uninstall();
  });
});
