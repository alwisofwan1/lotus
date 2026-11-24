import { describe, expect, it, vi } from "vitest";
import { createCellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import { createLegacyTerminalSessionAdapter } from "../../compat/legacy-terminal-session-adapter";
import { REDRAW_NUDGE_RESTORE_MS } from "../terminal-v2-session-redraw";
import {
  TerminalV2SessionManager,
  type TerminalV2SessionController,
} from "../terminal-v2-session-manager";

function createController(): TerminalV2SessionController & {
  emitOutput: (data: string) => void;
  writes: string[];
  resizes: Array<[number, number]>;
  aborted: () => boolean;
} {
  let onOutput: ((data: string) => void) | null = null;
  let sessionId: string | null = null;
  let aborted = false;
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];

  return {
    async connect(_cwd, _cols, _rows, nextOnOutput) {
      onOutput = nextOnOutput;
      sessionId = "pty-1";
    },
    async connectToCommand(_cwd, _command, _cols, _rows, nextOnOutput) {
      onOutput = nextOnOutput;
      sessionId = "pty-command-1";
    },
    write(data) {
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

describe("TerminalV2SessionManager", () => {
  it("forgets a session whose process ended, so the pane's next start spawns a fresh one", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const output = vi.fn();
    await manager.createSession({ paneId: "pane-1", workspaceId: "ws", cwd: "/repo", cols: 80, rows: 24, onOutput: output }).connectPromise;

    controller.emitOutput("[Session ended:0]\r\n");

    expect(output).toHaveBeenCalledWith("[Session ended:0]\r\n");
    expect(manager.hasSession("pane-1")).toBe(false);
    expect(manager.attachSession("pane-1", vi.fn())).toBe(false);
  });

  it("owns session lifecycle and emits external bus events", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const bus = createCellBus();
    const events: string[] = [];
    const output = vi.fn();

    manager.attachCellBus(bus);
    bus.on("terminal:spawned", (event) => events.push(`spawned:${event.paneId}`));
    bus.on("terminal:status", (event) => events.push(`status:${event.status}`));
    bus.on("terminal:output", (event) => events.push(`output:${event.data}`));
    bus.on("terminal:input", (event) => events.push(`input:${event.data}`));
    bus.on("terminal:exited", (event) => events.push(`exited:${event.paneId}`));

    const handle = manager.createSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: output,
      provider: "claude",
    });
    await handle.connectPromise;

    expect(manager.getSession("pane-1")).toMatchObject({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      sessionId: "pty-1",
      status: "running",
      launch: { kind: "local", cwd: "/repo" },
    });
    controller.emitOutput("hello");
    manager.writeSession("pane-1", "pwd\n");
    manager.resizeSession("pane-1", 100, 30);
    manager.closeSession("pane-1");

    expect(output).toHaveBeenCalledWith("hello");
    expect(controller.writes).toEqual(["pwd\n"]);
    expect(controller.resizes).toEqual([[100, 30]]);
    expect(controller.aborted()).toBe(true);
    expect(events).toEqual([
      "status:starting",
      "spawned:pane-1",
      "status:live",
      "output:hello",
      "input:pwd\n",
      "status:exited",
      "exited:pane-1",
    ]);
  });

  it("builds the pane's controller on its Claude account (issues/07)", async () => {
    const factory = vi.fn(() => createController());
    const manager = new TerminalV2SessionManager({ controllerFactory: factory });
    const base = { workspaceId: "w", cwd: "/repo", cols: 80, rows: 24, onOutput: vi.fn() };

    await manager.createSession({ ...base, paneId: "a", claudeAccount: "hss" }).connectPromise;
    await manager.createSession({ ...base, paneId: "b" }).connectPromise;

    expect(factory.mock.calls).toEqual([["hss"], [null]]);
  });

  it("forwards every resize to the controller, which owns deduping against the live PTY", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });

    await manager.createSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
    }).connectPromise;

    manager.resizeSession("pane-1", 100, 30);
    manager.resizeSession("pane-1", 100, 30);
    manager.resizeSession("pane-1", 101, 30);

    expect(controller.resizes).toEqual([[100, 30], [100, 30], [101, 30]]);
  });

  describe("resizeSessionAndRedraw", () => {
    async function createLiveSession() {
      const controller = createController();
      const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
      await manager.createSession({
        paneId: "pane-1",
        workspaceId: "workspace-1",
        cwd: "/repo",
        cols: 80,
        rows: 24,
        onOutput: vi.fn(),
      }).connectPromise;
      return { controller, manager };
    }

    it("steps one row away and back when the size is unchanged, so the agent repaints", async () => {
      vi.useFakeTimers();
      try {
        const { controller, manager } = await createLiveSession();

        manager.resizeSessionAndRedraw("pane-1", 80, 24);
        expect(controller.resizes).toEqual([[80, 23]]);

        vi.advanceTimersByTime(REDRAW_NUDGE_RESTORE_MS);
        expect(controller.resizes).toEqual([[80, 23], [80, 24]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("sends one plain resize when the size changed — that already repaints", async () => {
      vi.useFakeTimers();
      try {
        const { controller, manager } = await createLiveSession();

        manager.resizeSessionAndRedraw("pane-1", 100, 30);
        vi.advanceTimersByTime(REDRAW_NUDGE_RESTORE_MS);

        expect(controller.resizes).toEqual([[100, 30]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops the step back when another resize lands in between", async () => {
      vi.useFakeTimers();
      try {
        const { controller, manager } = await createLiveSession();

        manager.resizeSessionAndRedraw("pane-1", 80, 24);
        manager.resizeSession("pane-1", 120, 40);
        vi.advanceTimersByTime(REDRAW_NUDGE_RESTORE_MS);

        expect(controller.resizes).toEqual([[80, 23], [120, 40]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("drops the step back when the session closed meanwhile", async () => {
      vi.useFakeTimers();
      try {
        const { controller, manager } = await createLiveSession();

        manager.resizeSessionAndRedraw("pane-1", 80, 24);
        manager.closeSession("pane-1");
        vi.advanceTimersByTime(REDRAW_NUDGE_RESTORE_MS);

        expect(controller.resizes).toEqual([[80, 23]]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("publishes output subscriptions independently of attached UI output", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const uiOutput = vi.fn();
    const rendererOutput = vi.fn();

    await manager.createSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: uiOutput,
    }).connectPromise;
    const unsubscribe = manager.subscribeOutput("pane-1", rendererOutput);

    manager.detachSession("pane-1");
    controller.emitOutput("hidden");
    unsubscribe();
    controller.emitOutput("after-unsubscribe");

    expect(uiOutput).not.toHaveBeenCalledWith("hidden");
    expect(rendererOutput).toHaveBeenCalledWith("hidden");
    expect(rendererOutput).not.toHaveBeenCalledWith("after-unsubscribe");
  });

  it("keeps a bound renderer's output subscription across a session restart", async () => {
    const first = createController();
    const second = createController();
    const controllers = [first, second];
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controllers.shift()! });
    const base = { paneId: "pane-1", workspaceId: "workspace-1", cwd: "/repo", cols: 80, rows: 24, onOutput: vi.fn() };
    await manager.createSession(base).connectPromise;
    const rendererOutput = vi.fn();
    manager.subscribeOutput("pane-1", rendererOutput);

    await manager.createSession(base).connectPromise;
    second.emitOutput("resumed");

    expect(rendererOutput).toHaveBeenCalledWith("resumed");
  });

  it("detaches and reattaches output without killing the PTY", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const firstOutput = vi.fn();
    const secondOutput = vi.fn();

    await manager.createSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: firstOutput,
    }).connectPromise;

    manager.detachSession("pane-1");
    controller.emitOutput("hidden");
    expect(firstOutput).not.toHaveBeenCalledWith("hidden");
    expect(manager.getSession("pane-1")?.status).toBe("detached");

    expect(manager.attachSession("pane-1", secondOutput)).toBe(true);
    controller.emitOutput("visible");
    expect(secondOutput).toHaveBeenCalledWith("visible");
    expect(controller.aborted()).toBe(false);
  });

  it("reattaches when the cwd has drifted but the workspace still matches", async () => {
    // Regression for the "session reset" bug: the shell reports directory changes and
    // agents cd / switch worktrees, so the pane cwd drifts from the spawn cwd. Reattach
    // must not gate on cwd — otherwise a project switch spawns a fresh PTY.
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const firstOutput = vi.fn();
    const secondOutput = vi.fn();

    await manager.createSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: firstOutput,
    }).connectPromise;

    manager.detachSession("pane-1");
    expect(
      manager.attachSession("pane-1", secondOutput, { workspaceId: "workspace-1", cwd: "/repo/packages/worker" }),
    ).toBe(true);
    controller.emitOutput("after drift");
    expect(secondOutput).toHaveBeenCalledWith("after drift");
    expect(controller.aborted()).toBe(false);
  });

  it("refuses reattach when the workspace owner no longer matches", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });

    await manager.createSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
    }).connectPromise;

    manager.detachSession("pane-1");
    expect(
      manager.attachSession("pane-1", vi.fn(), { workspaceId: "workspace-2", cwd: "/repo" }),
    ).toBe(false);
  });

  it("feeds the legacy compatibility adapter without importing legacy registry state", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const adapter = createLegacyTerminalSessionAdapter(manager);

    await adapter.createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
    }).connectPromise;

    expect(adapter.getTerminalSessionStatus("pane-1")).toBe("live");
    expect(adapter.getTerminalRuntimeSessionId("pane-1")).toBe("pty-1");
    expect(adapter.getAllTerminalSessions()).toEqual([
      {
        paneId: "pane-1",
        workspaceId: "workspace-1",
        cwd: "/repo",
        status: "live",
        sessionId: "pty-1",
      },
    ]);
  });

  it("preserves controller instance binding for command sessions", async () => {
    class BoundController implements TerminalV2SessionController {
      aborted = false;
      sessionId: string | null = null;
      output: ((data: string) => void) | null = null;

      async connect() {
        throw new Error("expected command session");
      }

      async connectToCommand(
        _cwd: string,
        _command: string[],
        _cols: number,
        _rows: number,
        onOutput: (data: string) => void,
      ) {
        if (this.aborted) return;
        this.output = (data) => {
          if (this.aborted) return;
          onOutput(data);
        };
        this.sessionId = "bound-command-session";
      }

      write = vi.fn();
      resize = vi.fn();
      abort = vi.fn(() => { this.aborted = true; });
      getSessionId = vi.fn(() => this.sessionId);
    }

    const controller = new BoundController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const output = vi.fn();

    await manager.createSession({
      paneId: "pane-command",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      command: ["claude"],
      onOutput: output,
    }).connectPromise;
    controller.output?.("ready");

    expect(manager.getSessionId("pane-command")).toBe("bound-command-session");
    expect(output).toHaveBeenCalledWith("ready");
  });
});
