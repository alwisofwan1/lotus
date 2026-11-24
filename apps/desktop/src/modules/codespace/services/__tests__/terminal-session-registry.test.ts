import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachTerminalSession,
  clearTerminalSessionRegistryForTests,
  closeAllTerminalSessions,
  closeTerminalSession,
  closeWorkspaceTerminalSessions,
  createTerminalSession,
  detachTerminalSession,
  getTerminalSessionInput,
  getTerminalSessionStatus,
  peekTerminalTranscript,
  markTerminalSessionExited,
  registerTerminalSession,
  resizeTerminalSession,
  subscribeTerminalSessionStatus,
  writeTerminalSession,
  writeTerminalSessionConfirmed,
} from "@/modules/codespace/services/terminal-session-registry";

describe("terminal-session-registry", () => {
  beforeEach(() => {
    clearTerminalSessionRegistryForTests();
  });

  it("closes and unregisters a terminal pane session", () => {
    const close = vi.fn();

    registerTerminalSession("pane-1", { workspaceId: "workspace-1", status: "live", close });

    closeTerminalSession("pane-1");
    closeTerminalSession("pane-1");

    expect(close).toHaveBeenCalledOnce();
  });

  it("closes all sessions for a workspace without touching other workspaces", () => {
    const closePane1 = vi.fn();
    const closePane2 = vi.fn();
    const closeOtherWorkspacePane = vi.fn();

    registerTerminalSession("pane-1", { workspaceId: "workspace-1", status: "live", close: closePane1 });
    registerTerminalSession("pane-2", { workspaceId: "workspace-1", status: "live", close: closePane2 });
    registerTerminalSession("pane-3", { workspaceId: "workspace-2", status: "live", close: closeOtherWorkspacePane });

    closeWorkspaceTerminalSessions("workspace-1");

    expect(closePane1).toHaveBeenCalledOnce();
    expect(closePane2).toHaveBeenCalledOnce();
    expect(closeOtherWorkspacePane).not.toHaveBeenCalled();
  });

  it("closes every registered terminal session", () => {
    const closePane1 = vi.fn();
    const closePane2 = vi.fn();

    registerTerminalSession("pane-1", { workspaceId: "workspace-1", status: "live", close: closePane1 });
    registerTerminalSession("pane-2", { workspaceId: "workspace-2", status: "live", close: closePane2 });

    closeAllTerminalSessions();
    closeAllTerminalSessions();

    expect(closePane1).toHaveBeenCalledOnce();
    expect(closePane2).toHaveBeenCalledOnce();
    expect(getTerminalSessionStatus("pane-1")).toBe("exited");
    expect(getTerminalSessionStatus("pane-2")).toBe("exited");
  });

  it("does not unregister a newer registration from a stale cleanup", () => {
    const closeOld = vi.fn();
    const closeNew = vi.fn();

    const unregisterOld = registerTerminalSession("pane-1", { workspaceId: "workspace-1", status: "live", close: closeOld });
    registerTerminalSession("pane-1", { workspaceId: "workspace-1", status: "live", close: closeNew });

    unregisterOld();
    closeTerminalSession("pane-1");

    expect(closeOld).not.toHaveBeenCalled();
    expect(closeNew).toHaveBeenCalledOnce();
  });

  it("owns controller connect, write, resize, and close for a pane session", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };
    const onOutput = vi.fn();

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 120,
      rows: 40,
      onOutput,
      controller,
    });

    await session.connectPromise;
    writeTerminalSession("pane-1", "echo hi\r");
    resizeTerminalSession("pane-1", 100, 30);
    closeTerminalSession("pane-1");
    closeTerminalSession("pane-1");

    expect(controller.connect).toHaveBeenCalledWith("/tmp/project", 120, 40, expect.any(Function), "pane-1", undefined, undefined);
    expect(controller.write).toHaveBeenCalledWith("echo hi\r");
    expect(controller.resize).toHaveBeenCalledWith(100, 30);
    expect(controller.abort).toHaveBeenCalledOnce();
  });

  it("resolves a receipt-sensitive write only after native PTY acknowledgement", async () => {
    let acknowledge: () => void = () => {};
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      writeConfirmed: vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve; })),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 120,
      rows: 40,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;

    let settled = false;
    const receipt = writeTerminalSessionConfirmed("pane-1", "echo confirmed\\r").then(() => { settled = true; });
    await Promise.resolve();

    expect(controller.writeConfirmed).toHaveBeenCalledWith("echo confirmed\\r");
    expect(settled).toBe(false);

    acknowledge();
    await receipt;
    expect(settled).toBe(true);
  });

  it("rejects confirmed writes while the terminal is not writable", async () => {
    const writeConfirmed = vi.fn(() => Promise.resolve());
    registerTerminalSession("pane-1", {
      workspaceId: "workspace-1",
      status: "starting",
      close: vi.fn(),
      writeConfirmed,
    });

    await expect(writeTerminalSessionConfirmed("pane-1", "echo unsafe\\r")).rejects.toThrow(
      "Terminal session is not writable.",
    );
    expect(writeConfirmed).not.toHaveBeenCalled();
  });

  it("retains emitted output in a transcript readable via peekTerminalTranscript", async () => {
    let emit: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_cwd: string, _cols: number, _rows: number, onData: (d: string) => void) => {
        emit = onData;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    await session.connectPromise;
    emit("hello ");
    emit("world\r\n");

    expect(peekTerminalTranscript("pane-1")).toBe("hello world\r\n");
  });

  it("retains output that arrives while the pane is detached (project-switch replay)", async () => {
    let emit: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_cwd: string, _cols: number, _rows: number, onData: (d: string) => void) => {
        emit = onData;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;

    emit("before-switch\r\n");
    // Project switch away: the node unmounts, PTY survives, sink is dropped.
    detachTerminalSession("pane-1");
    emit("while-detached\r\n");
    // Switch back: a fresh terminal reattaches and must be able to replay both.
    const nextSink = vi.fn();
    const reattached = attachTerminalSession("pane-1", nextSink, {
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
    });

    expect(reattached).toBe(true);
    expect(peekTerminalTranscript("pane-1")).toBe("before-switch\r\nwhile-detached\r\n");
  });

  it("bounds the transcript to a rolling window, keeping the most recent output", async () => {
    let emit: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_cwd: string, _cols: number, _rows: number, onData: (d: string) => void) => {
        emit = onData;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;

    emit("x".repeat(300_000));
    emit("TAIL");

    const transcript = peekTerminalTranscript("pane-1");
    expect(transcript.length).toBe(256_000);
    expect(transcript.endsWith("TAIL")).toBe(true);
    expect(transcript.startsWith("x")).toBe(true);
  });

  it("clears the transcript when the pane session is closed", async () => {
    let emit: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_cwd: string, _cols: number, _rows: number, onData: (d: string) => void) => {
        emit = onData;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;
    emit("stale output\r\n");

    closeTerminalSession("pane-1");

    expect(peekTerminalTranscript("pane-1")).toBe("");
  });

  it("does not itself replay the transcript into the reattached sink (runtime owns raw replay)", async () => {
    let emit: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_cwd: string, _cols: number, _rows: number, onData: (d: string) => void) => {
        emit = onData;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });
    await session.connectPromise;
    emit("history\r\n");
    detachTerminalSession("pane-1");

    const nextSink = vi.fn();
    attachTerminalSession("pane-1", nextSink, { workspaceId: "workspace-1", cwd: "/tmp/project" });

    // Reattach must not push stale bytes through the semantic sink (would re-fire
    // cwd/OSC133/auto-trust). Replay is the runtime's job, written raw to xterm.
    expect(nextSink).not.toHaveBeenCalled();
    // Live output after reattach still flows through the sink normally.
    emit("fresh\r\n");
    expect(nextSink).toHaveBeenCalledWith("fresh\r\n");
  });

  it("tracks the current terminal input buffer per pane", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    await session.connectPromise;
    writeTerminalSession("pane-1", "git");
    writeTerminalSession("pane-1", " status");
    expect(getTerminalSessionInput("pane-1")).toBe("git status");

    writeTerminalSession("pane-1", "\u007f");
    expect(getTerminalSessionInput("pane-1")).toBe("git statu");

    writeTerminalSession("pane-1", "\r");
    expect(getTerminalSessionInput("pane-1")).toBe("");
  });

  it("clears terminal input when a pane session exits", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    await session.connectPromise;
    writeTerminalSession("pane-1", "pending");
    closeTerminalSession("pane-1");

    expect(getTerminalSessionInput("pane-1")).toBe("");
  });

  it("connects a pane session through an explicit command", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      connectToCommand: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-ssh"),
    };

    const session = createTerminalSession({
      paneId: "pane-ssh",
      workspaceId: "workspace-ssh",
      cwd: "/tmp",
      command: ["ssh", "-t", "devbox-vps"],
      cols: 100,
      rows: 30,
      onOutput: vi.fn(),
      controller,
    });

    await session.connectPromise;

    expect(controller.connect).not.toHaveBeenCalled();
    expect(controller.connectToCommand).toHaveBeenCalledWith(
      "/tmp",
      ["ssh", "-t", "devbox-vps"],
      100,
      30,
      expect.any(Function),
      "pane-ssh",
      undefined,
    );
  });

  it("closes the previous controller when replacing a pane session", () => {
    const oldController = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-old"),
    };
    const newController = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-new"),
    };

    createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller: oldController,
    });
    createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller: newController,
    });

    closeTerminalSession("pane-1");

    expect(oldController.abort).toHaveBeenCalledOnce();
    expect(newController.abort).toHaveBeenCalledOnce();
  });

  it("detaches a pane session output without closing its controller", () => {
    let emitOutput: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_: string, __: number, ___: number, onOutput: (data: string) => void) => {
        emitOutput = onOutput;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };
    const onOutput = vi.fn();

    createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput,
      controller,
    });

    emitOutput("before detach");
    detachTerminalSession("pane-1");
    emitOutput("after detach");
    writeTerminalSession("pane-1", "still alive\r");
    closeTerminalSession("pane-1");

    expect(onOutput).toHaveBeenCalledOnce();
    expect(onOutput).toHaveBeenCalledWith("before detach");
    expect(controller.write).toHaveBeenCalledWith("still alive\r");
    expect(controller.abort).toHaveBeenCalledOnce();
  });

  it("reattaches output for an existing pane session", () => {
    let emitOutput: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_: string, __: number, ___: number, onOutput: (data: string) => void) => {
        emitOutput = onOutput;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };
    const oldOutput = vi.fn();
    const newOutput = vi.fn();

    createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: oldOutput,
      controller,
    });

    detachTerminalSession("pane-1");
    const attached = attachTerminalSession("pane-1", newOutput, {
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
    });
    emitOutput("after reattach");

    expect(attached).toBe(true);
    expect(oldOutput).not.toHaveBeenCalled();
    expect(newOutput).toHaveBeenCalledWith("after reattach");
    expect(controller.abort).not.toHaveBeenCalled();
  });

  it("reattaches even when the cwd has drifted since the session was spawned", () => {
    // Regression: a live shell reports its cwd (OSC 7/133) and agents cd / switch
    // worktrees, so the pane's cwd drifts from the spawn cwd. Reattach must still
    // succeed on a canvas project switch — otherwise a fresh PTY spawns ("reset").
    let emitOutput: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_: string, __: number, ___: number, onOutput: (data: string) => void) => {
        emitOutput = onOutput;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };
    const oldOutput = vi.fn();
    const newOutput = vi.fn();

    createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project-a",
      cols: 80,
      rows: 24,
      onOutput: oldOutput,
      controller,
    });

    detachTerminalSession("pane-1");
    const attached = attachTerminalSession("pane-1", newOutput, {
      workspaceId: "workspace-1",
      cwd: "/tmp/project-a/packages/worker",
    });
    emitOutput("after reattach");

    expect(attached).toBe(true);
    expect(oldOutput).not.toHaveBeenCalled();
    expect(newOutput).toHaveBeenCalledWith("after reattach");
    expect(controller.abort).not.toHaveBeenCalled();
  });

  it("does not reattach output when the workspace owner no longer matches", () => {
    let emitOutput: (data: string) => void = () => {};
    const controller = {
      connect: vi.fn((_: string, __: number, ___: number, onOutput: (data: string) => void) => {
        emitOutput = onOutput;
        return Promise.resolve();
      }),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };
    const oldOutput = vi.fn();
    const newOutput = vi.fn();

    createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project-a",
      cols: 80,
      rows: 24,
      onOutput: oldOutput,
      controller,
    });

    detachTerminalSession("pane-1");
    const attached = attachTerminalSession("pane-1", newOutput, {
      workspaceId: "workspace-2",
      cwd: "/tmp/project-a",
    });
    emitOutput("after failed reattach");

    expect(attached).toBe(false);
    expect(oldOutput).not.toHaveBeenCalled();
    expect(newOutput).not.toHaveBeenCalled();
    expect(controller.abort).not.toHaveBeenCalled();
  });

  it("tracks runtime status across create, connect, detach, attach, and close", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    expect(getTerminalSessionStatus("pane-1")).toBe("starting");

    await session.connectPromise;
    expect(getTerminalSessionStatus("pane-1")).toBe("live");

    detachTerminalSession("pane-1");
    expect(getTerminalSessionStatus("pane-1")).toBe("detached");

    attachTerminalSession("pane-1", vi.fn(), {
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
    });
    expect(getTerminalSessionStatus("pane-1")).toBe("live");

    closeTerminalSession("pane-1");
    expect(getTerminalSessionStatus("pane-1")).toBe("exited");
  });

  it("tracks failed status when controller connect fails", async () => {
    const controller = {
      connect: vi.fn(() => Promise.reject(new Error("connect failed"))),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => null),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    await expect(session.connectPromise).rejects.toThrow("connect failed");
    expect(getTerminalSessionStatus("pane-1")).toBe("failed");
  });

  it("marks a naturally ended terminal session as exited without aborting twice", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    await session.connectPromise;
    markTerminalSessionExited("pane-1");
    closeTerminalSession("pane-1");

    expect(getTerminalSessionStatus("pane-1")).toBe("exited");
    expect(controller.abort).not.toHaveBeenCalled();
  });

  it("notifies subscribers when terminal status changes", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-1"),
    };
    const statuses: string[] = [];

    const unsubscribe = subscribeTerminalSessionStatus("pane-1", (status) => {
      statuses.push(status);
    });

    const session = createTerminalSession({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/tmp/project",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
      controller,
    });

    await session.connectPromise;
    detachTerminalSession("pane-1");
    closeTerminalSession("pane-1");
    unsubscribe();
    closeTerminalSession("pane-1");

    expect(statuses).toEqual(["idle", "starting", "live", "detached", "exited"]);
  });

  it("forwards workspace location to controller.connect when provided", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-ssh"),
    };

    const session = createTerminalSession({
      paneId: "pane-ssh",
      workspaceId: "workspace-ssh",
      cwd: "/home/alwi/repo",
      cols: 100,
      rows: 30,
      onOutput: vi.fn(),
      controller,
      location: {
        kind: "ssh",
        host: "alpha.example",
        user: "alwi",
        port: 22,
        remoteCwd: "/home/alwi/repo",
      },
    });

    await session.connectPromise;

    expect(controller.connect).toHaveBeenCalledWith(
      "/home/alwi/repo",
      100,
      30,
      expect.any(Function),
      "pane-ssh",
      expect.objectContaining({ kind: "ssh", host: "alpha.example" }),
      undefined,
    );
  });

  it("does not preserve the old SSH nested-hop command stripping path", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      connectToCommand: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-ssh-command"),
    };

    const session = createTerminalSession({
      paneId: "pane-ssh-command",
      workspaceId: "workspace-ssh",
      cwd: "/repo",
      command: ["ssh", "-t", "devbox-vps"],
      cols: 100,
      rows: 30,
      onOutput: vi.fn(),
      controller,
      location: { kind: "ssh", host: "devbox-vps", remoteCwd: "/repo" },
    });

    await session.connectPromise;

    expect(controller.connect).not.toHaveBeenCalled();
    expect(controller.connectToCommand).toHaveBeenCalledWith(
      "/repo",
      ["ssh", "-t", "devbox-vps"],
      100,
      30,
      expect.any(Function),
      "pane-ssh-command",
      expect.objectContaining({ kind: "ssh", host: "devbox-vps" }),
    );
  });

  it("forwards command argv for historical SSH workspace metadata", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      connectToCommand: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-ssh-claude"),
    };

    const session = createTerminalSession({
      paneId: "pane-ssh-claude",
      workspaceId: "workspace-ssh",
      cwd: "/repo",
      command: ["claude", "--print"],
      cols: 100,
      rows: 30,
      onOutput: vi.fn(),
      controller,
      location: { kind: "ssh", host: "devbox-vps", remoteCwd: "/repo" },
    });

    await session.connectPromise;

    expect(controller.connectToCommand).toHaveBeenCalledTimes(1);
    expect(controller.connect).not.toHaveBeenCalled();
  });

  it("forwards workspace location to controller.connectToCommand when provided", async () => {
    const controller = {
      connect: vi.fn(() => Promise.resolve()),
      connectToCommand: vi.fn(() => Promise.resolve()),
      write: vi.fn(),
      resize: vi.fn(),
      abort: vi.fn(),
      getSessionId: vi.fn(() => "runtime-ssh-cmd"),
    };

    const session = createTerminalSession({
      paneId: "pane-ssh-cmd",
      workspaceId: "workspace-ssh",
      cwd: "/repo",
      command: ["claude", "--print"],
      cols: 100,
      rows: 30,
      onOutput: vi.fn(),
      controller,
      location: {
        kind: "ssh",
        host: "alpha.example",
        remoteCwd: "/repo",
      },
    });

    await session.connectPromise;

    expect(controller.connectToCommand).toHaveBeenCalledWith(
      "/repo",
      ["claude", "--print"],
      100,
      30,
      expect.any(Function),
      "pane-ssh-cmd",
      expect.objectContaining({ kind: "ssh", host: "alpha.example" }),
    );
  });
});
