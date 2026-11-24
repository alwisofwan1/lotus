import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock tauri-api PTY functions
const mockCreatePtySession = vi.fn<(cwd: string, cols: number, rows: number, onOutput: (data: string) => void, paneId?: string, canvasTerminalId?: string) => Promise<string>>();
const mockCreateCommandPtySession = vi.fn<(cwd: string, command: string[], cols: number, rows: number, onOutput: (data: string) => void, paneId?: string, canvasTerminalId?: string) => Promise<string>>();
const mockKillPtySession = vi.fn<(sessionId: string) => Promise<void>>();
const mockWriteToSession = vi.fn<(sessionId: string, data: string) => Promise<void>>();
const mockResizeSession = vi.fn<(sessionId: string, cols: number, rows: number) => Promise<void>>();
const mockListPtySessions = vi.fn<() => Promise<{ id: string; cwd: string }[]>>();
const mockAdoptPtySession = vi.fn<(paneId: string, onOutput: (data: string) => void) => Promise<string | null>>();
const mockReconcilePtySessions = vi.fn<(paneIds: string[]) => Promise<number>>();

vi.mock("@/lib/tauri-api", () => ({
  createPtySession: (...args: unknown[]) => mockCreatePtySession(...args as [string, number, number, (data: string) => void, string | undefined, string | undefined]),
  createCommandPtySession: (...args: unknown[]) => mockCreateCommandPtySession(...args as [string, string[], number, number, (data: string) => void, string | undefined, string | undefined]),
  killPtySession: (...args: unknown[]) => mockKillPtySession(...args as [string]),
  writeToSession: (...args: unknown[]) => mockWriteToSession(...args as [string, string]),
  resizeSession: (...args: unknown[]) => mockResizeSession(...args as [string, number, number]),
  listPtySessions: () => mockListPtySessions(),
  adoptPtySession: (...args: unknown[]) => mockAdoptPtySession(...args as [string, (data: string) => void]),
  reconcilePtySessions: (...args: unknown[]) => mockReconcilePtySessions(...args as [string[]]),
}));

describe("PtySessionController adopt (session daemon)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdoptPtySession.mockResolvedValue(null);
    mockCreatePtySession.mockResolvedValue("fresh");
    mockCreateCommandPtySession.mockResolvedValue("fresh-command");
    mockResizeSession.mockResolvedValue(undefined);
    mockKillPtySession.mockResolvedValue(undefined);
  });

  it("takes over the pane's running session instead of starting one", async () => {
    mockAdoptPtySession.mockResolvedValue("kept");
    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const onOutput = vi.fn();
    await ctrl.connectToCommand("/repo", ["claude"], 80, 24, onOutput, "pane-1");

    expect(mockAdoptPtySession).toHaveBeenCalledWith("pane-1", expect.any(Function));
    expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
    expect(ctrl.getSessionId()).toBe("kept");
    expect(ctrl.wasAdopted()).toBe(true);
    // The adopted PTY has the old pane's size, so the first fit — even at the spawn size — is sent.
    ctrl.resize(80, 24);
    expect(mockResizeSession).toHaveBeenCalledWith("kept", 80, 24);
  });

  it("applies a size asked for while the session was being found", async () => {
    let found!: (id: string) => void;
    mockAdoptPtySession.mockImplementationOnce(() => new Promise((resolve) => { found = resolve; }));
    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const connecting = ctrl.connect("/repo", 80, 24, vi.fn(), "pane-6");
    ctrl.resize(132, 40);
    found("kept");
    await connecting;
    expect(mockResizeSession).toHaveBeenCalledExactlyOnceWith("kept", 132, 40);
  });

  it("starts a session when there is none to adopt, or adopting fails", async () => {
    const { PtySessionController } = await import("../pty-session-controller");
    const none = new PtySessionController();
    await none.connect("/repo", 80, 24, vi.fn(), "pane-2");
    expect(none.getSessionId()).toBe("fresh");
    expect(none.wasAdopted()).toBe(false);

    mockAdoptPtySession.mockRejectedValueOnce(new Error("daemon gone"));
    const failed = new PtySessionController();
    await failed.connect("/repo", 80, 24, vi.fn(), "pane-3");
    expect(failed.getSessionId()).toBe("fresh");
  });

  it("does not look for a session when the pane has no id", async () => {
    const { PtySessionController } = await import("../pty-session-controller");
    await new PtySessionController().connect("/repo", 80, 24, vi.fn());
    expect(mockAdoptPtySession).not.toHaveBeenCalled();
  });

  it("kills an adopted session when the pane closed while it was being found", async () => {
    let found!: (id: string) => void;
    mockAdoptPtySession.mockImplementationOnce(() => new Promise((resolve) => { found = resolve; }));
    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const connecting = ctrl.connect("/repo", 80, 24, vi.fn(), "pane-4");
    await Promise.resolve();
    const closing = ctrl.abortConfirmed();
    found("late-adopt");
    await Promise.all([connecting, closing]);
    expect(mockKillPtySession).toHaveBeenCalledWith("late-adopt");
    expect(mockCreatePtySession).not.toHaveBeenCalled();
  });

  it("starts nothing when the pane closed while no session was found", async () => {
    let found!: (id: string | null) => void;
    mockAdoptPtySession.mockImplementationOnce(() => new Promise((resolve) => { found = resolve; }));
    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const connecting = ctrl.connect("/repo", 80, 24, vi.fn(), "pane-5");
    await Promise.resolve();
    const closing = ctrl.abortConfirmed();
    found(null);
    await Promise.all([connecting, closing]);
    expect(mockCreatePtySession).not.toHaveBeenCalled();
    expect(mockKillPtySession).not.toHaveBeenCalled();
  });
});

describe("PtySessionController", () => {
  it("waits for native kill acknowledgement and permits retry after failure", async () => {
    mockCreatePtySession.mockResolvedValue("retry-close");
    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    await ctrl.connect("/tmp", 80, 24, vi.fn());
    mockKillPtySession.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(ctrl.abortConfirmed()).rejects.toThrow("IPC unavailable");
    let acknowledge!: () => void;
    mockKillPtySession.mockImplementationOnce(() => new Promise<void>((resolve) => { acknowledge = resolve; }));
    let finished = false;
    const close = ctrl.abortConfirmed().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    acknowledge();
    await close;
    expect(mockKillPtySession).toHaveBeenCalledTimes(2);
  });

  it("confirmed close waits for a connecting PTY and its kill", async () => {
    let spawn!: (id: string) => void;
    mockCreatePtySession.mockImplementationOnce(() => new Promise<string>((resolve) => { spawn = resolve; }));
    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const connecting = ctrl.connect("/tmp", 80, 24, vi.fn());
    let finished = false;
    const closing = ctrl.abortConfirmed().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    spawn("late-pty");
    await Promise.all([connecting, closing]);
    expect(mockKillPtySession).toHaveBeenCalledExactlyOnceWith("late-pty");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockKillPtySession.mockResolvedValue(undefined);
    mockCreateCommandPtySession.mockResolvedValue("command-session");
    mockWriteToSession.mockResolvedValue(undefined);
    mockResizeSession.mockResolvedValue(undefined);
    mockListPtySessions.mockResolvedValue([]);
  });

  it("kills session when abort() is called before createPtySession resolves", async () => {
    // Simulate slow PTY creation — resolve is deferred
    let resolveCreate!: (id: string) => void;
    mockCreatePtySession.mockReturnValue(
      new Promise((resolve) => { resolveCreate = resolve; })
    );

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const onOutput = vi.fn();

    // Start connecting (does not await)
    const connectPromise = ctrl.connect("/tmp", 80, 24, onOutput);

    // Abort while still in-flight
    ctrl.abort();

    // Now resolve the creation — simulates Rust returning the session ID
    resolveCreate("session-123");
    await connectPromise;

    // The controller should have killed the session it just received
    expect(mockKillPtySession).toHaveBeenCalledWith("session-123");
    expect(ctrl.getSessionId()).toBeNull();
  });

  it("kills session immediately when abort() is called after connected", async () => {
    mockCreatePtySession.mockResolvedValue("session-456");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connect("/tmp", 80, 24, vi.fn());
    expect(ctrl.getSessionId()).toBe("session-456");

    ctrl.abort();

    expect(mockKillPtySession).toHaveBeenCalledWith("session-456");
    expect(ctrl.getSessionId()).toBeNull();
    expect(ctrl.isAborted()).toBe(true);
  });

  it("double abort only kills once", async () => {
    mockCreatePtySession.mockResolvedValue("session-789");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connect("/tmp", 80, 24, vi.fn());

    ctrl.abort();
    ctrl.abort();

    expect(mockKillPtySession).toHaveBeenCalledTimes(1);
  });

  it("write and resize are no-ops after abort", async () => {
    mockCreatePtySession.mockResolvedValue("session-abc");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connect("/tmp", 80, 24, vi.fn());
    ctrl.abort();

    ctrl.write("hello");
    ctrl.resize(120, 40);

    expect(mockWriteToSession).not.toHaveBeenCalled();
    expect(mockResizeSession).not.toHaveBeenCalled();
  });

  it("write and resize work when connected", async () => {
    mockCreatePtySession.mockResolvedValue("session-ok");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connect("/tmp", 80, 24, vi.fn());

    ctrl.write("ls\r");
    ctrl.resize(100, 30);

    expect(mockWriteToSession).toHaveBeenCalledWith("session-ok", "ls\r");
    expect(mockResizeSession).toHaveBeenCalledWith("session-ok", 100, 30);
  });

  it("exposes a confirmed write that settles with the native PTY acknowledgement", async () => {
    mockCreatePtySession.mockResolvedValue("session-confirmed");
    let acknowledgeWrite: () => void = () => {};
    mockWriteToSession.mockReturnValue(new Promise<void>((resolve) => { acknowledgeWrite = resolve; }));

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    await ctrl.connect("/tmp", 80, 24, vi.fn());
    const writeConfirmed = (ctrl as unknown as {
      writeConfirmed?: (data: string) => Promise<void>;
    }).writeConfirmed;

    expect(writeConfirmed).toBeTypeOf("function");
    const completion = writeConfirmed?.call(ctrl, "submit\r");
    let settled = false;
    void completion?.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    acknowledgeWrite();
    await expect(completion).resolves.toBeUndefined();
    expect(mockWriteToSession).toHaveBeenCalledWith("session-confirmed", "submit\r");
  });

  it("deduplicates repeated resize geometry for a connected session", async () => {
    mockCreatePtySession.mockResolvedValue("session-resize-dedupe");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connect("/tmp", 80, 24, vi.fn());
    ctrl.resize(100, 30);
    ctrl.resize(100, 30);
    ctrl.resize(101, 30);

    expect(mockResizeSession).toHaveBeenCalledTimes(2);
    expect(mockResizeSession).toHaveBeenNthCalledWith(1, "session-resize-dedupe", 100, 30);
    expect(mockResizeSession).toHaveBeenNthCalledWith(2, "session-resize-dedupe", 101, 30);
  });

  it("logs warning when write fails", async () => {
    mockCreatePtySession.mockResolvedValue("session-warn");
    mockWriteToSession.mockRejectedValue(new Error("broken pipe"));

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ctrl.connect("/tmp", 80, 24, vi.fn());
    ctrl.write("hello");

    // Wait for the catch handler to fire
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[pty] write failed"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("logs warning when resize fails", async () => {
    mockCreatePtySession.mockResolvedValue("session-warn2");
    mockResizeSession.mockRejectedValue(new Error("session gone"));

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await ctrl.connect("/tmp", 80, 24, vi.fn());
    ctrl.resize(120, 40);

    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[pty] resize failed"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("suppresses onOutput callback after abort", async () => {
    let capturedOnOutput!: (data: string) => void;
    mockCreatePtySession.mockImplementation((_cwd, _cols, _rows, onOutput) => {
      capturedOnOutput = onOutput;
      return Promise.resolve("session-sup");
    });

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const onOutput = vi.fn();

    await ctrl.connect("/tmp", 80, 24, onOutput);
    ctrl.abort();

    // Simulate Tauri sending data after abort
    capturedOnOutput("late data");

    expect(onOutput).not.toHaveBeenCalled();
  });

  it("forwards paneId to createPtySession so the backend can inject LOTUS_PANE_ID env", async () => {
    mockCreatePtySession.mockResolvedValue("session-pane");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connect("/tmp", 80, 24, vi.fn(), "pane-uuid-123");

    expect(mockCreatePtySession).toHaveBeenCalledWith(
      "/tmp",
      80,
      24,
      expect.any(Function),
      "pane-uuid-123",
      undefined,
      null,
    );
  });

  it("forwards canvasTerminalId to shell PTYs so Canvas agents get browser API env", async () => {
    mockCreatePtySession.mockResolvedValue("session-canvas");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connect("/tmp", 80, 24, vi.fn(), "pane-uuid-123", null, "agent-node-1");

    expect(mockCreatePtySession).toHaveBeenCalledWith(
      "/tmp",
      80,
      24,
      expect.any(Function),
      "pane-uuid-123",
      "agent-node-1",
      null,
    );
  });

  it("forwards paneId to createCommandPtySession so the backend can inject LOTUS_PANE_ID env", async () => {
    mockCreateCommandPtySession.mockResolvedValue("session-cmd-pane");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connectToCommand("/tmp", ["claude"], 80, 24, vi.fn(), "pane-uuid-cmd");

    expect(mockCreateCommandPtySession).toHaveBeenCalledWith(
      "/tmp",
      ["claude"],
      80,
      24,
      expect.any(Function),
      "pane-uuid-cmd",
      undefined,
      null,
    );
  });

  it("forwards canvasTerminalId to direct command PTYs so live AgentNodes get browser API env", async () => {
    mockCreateCommandPtySession.mockResolvedValue("session-cmd-canvas");

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();

    await ctrl.connectToCommand("/tmp", ["claude"], 80, 24, vi.fn(), "pane-uuid-cmd", null, "agent-node-1");

    expect(mockCreateCommandPtySession).toHaveBeenCalledWith(
      "/tmp",
      ["claude"],
      80,
      24,
      expect.any(Function),
      "pane-uuid-cmd",
      "agent-node-1",
      null,
    );
  });

  describe("connectPreferCommand (direct spawn with shell fallback)", () => {
    it("spawns the command directly and reports mode 'command'", async () => {
      mockCreateCommandPtySession.mockResolvedValue("cmd-session-1");
      const { PtySessionController } = await import("../pty-session-controller");
      const ctrl = new PtySessionController();

      const mode = await ctrl.connectPreferCommand("/repo", ["claude", "--model", "opus"], 80, 24, vi.fn(), "pane-1", "agent-node-1");

      expect(mode).toBe("command");
      expect(ctrl.getSessionId()).toBe("cmd-session-1");
      expect(mockCreateCommandPtySession).toHaveBeenCalledWith(
        "/repo",
        ["claude", "--model", "opus"],
        80,
        24,
        expect.any(Function),
        "pane-1",
        "agent-node-1",
        null,
      );
      expect(mockCreatePtySession).not.toHaveBeenCalled();
    });

    it("falls back to a shell session (mode 'shell') when the direct spawn fails", async () => {
      mockCreateCommandPtySession.mockRejectedValue(new Error("exec failed: no such binary"));
      mockCreatePtySession.mockResolvedValue("shell-session-1");
      const { PtySessionController } = await import("../pty-session-controller");
      const ctrl = new PtySessionController();

      const mode = await ctrl.connectPreferCommand("/repo", ["wesley-cli"], 80, 24, vi.fn(), "pane-2", "agent-node-2");

      expect(mode).toBe("shell");
      expect(ctrl.getSessionId()).toBe("shell-session-1");
      expect(mockCreatePtySession).toHaveBeenCalledWith("/repo", 80, 24, expect.any(Function), "pane-2", "agent-node-2", null);
    });

    it("goes straight to the shell when no argv is given", async () => {
      mockCreatePtySession.mockResolvedValue("shell-session-2");
      const { PtySessionController } = await import("../pty-session-controller");
      const ctrl = new PtySessionController();

      const mode = await ctrl.connectPreferCommand("/repo", null, 80, 24, vi.fn(), "pane-3");

      expect(mode).toBe("shell");
      expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
    });
  });

  it("connects to an explicit command PTY and forwards output", async () => {
    let capturedOnOutput!: (data: string) => void;
    mockCreateCommandPtySession.mockImplementation((_cwd, _command, _cols, _rows, onOutput) => {
      capturedOnOutput = onOutput;
      return Promise.resolve("command-session-123");
    });

    const { PtySessionController } = await import("../pty-session-controller");
    const ctrl = new PtySessionController();
    const onOutput = vi.fn();

    await ctrl.connectToCommand("/tmp", ["cursor-agent", "login"], 100, 30, onOutput);
    capturedOnOutput("auth prompt");

    expect(ctrl.getSessionId()).toBe("command-session-123");
    expect(mockCreateCommandPtySession).toHaveBeenCalledWith(
      "/tmp",
      ["cursor-agent", "login"],
      100,
      30,
      expect.any(Function),
      undefined,
      undefined,
      null,
    );
    expect(onOutput).toHaveBeenCalledWith("auth prompt");
  });

  describe("a machine other than this one", () => {
    const sshLocation = {
      kind: "ssh" as const,
      host: "alpha.example",
      user: "alwi",
      port: 22,
      remoteCwd: "/home/alwi/repo",
    };

    // The Rust SSH PTY dispatcher was deleted on purpose (`067eca6d`, 461 lines). A remote session
    // is an ORDINARY local pty whose child happens to be `ssh` — these two tests pin that shape, so
    // a future change cannot quietly reintroduce a second kind of session.
    it("opens a remote shell as a local pty running ssh, not through a removed dispatcher", async () => {
      mockCreateCommandPtySession.mockResolvedValue("remote-shell-session");

      const { PtySessionController } = await import("../pty-session-controller");
      const ctrl = new PtySessionController();

      await ctrl.connect("/home/alwi/repo", 100, 30, vi.fn(), "pane-ssh-1", sshLocation);

      expect(mockCreatePtySession).not.toHaveBeenCalled();
      const [cwd, argv] = mockCreateCommandPtySession.mock.calls[0];
      expect(argv.slice(0, 5)).toEqual(["ssh", "-t", "-p", "22", "alwi@alpha.example"]);
      expect(cwd).toBe("");
      expect(ctrl.getSessionId()).toBe("remote-shell-session");
    });

    it("quotes a runner's argv for the remote shell instead of joining it into one string", async () => {
      mockCreateCommandPtySession.mockResolvedValue("command-session-for-ssh");

      const { PtySessionController } = await import("../pty-session-controller");
      const ctrl = new PtySessionController();

      await ctrl.connectToCommand(
        "/repo",
        ["claude", "--print"],
        100,
        30,
        vi.fn(),
        "pane-ssh-cmd",
        sshLocation,
      );

      const [cwd, argv, cols, rows, , paneId] = mockCreateCommandPtySession.mock.calls[0];
      const remote = argv.at(-1) as string;
      // Through a login shell: a runner's own installer puts it on a PATH that only an interactive
      // login shell sets (measured against devbox-vps, 2026-09-15). The pane id rides in front of
      // it, because a remote agent's hooks have no other way to learn which pane they belong to.
      expect(remote.startsWith("cd '/repo' && LOTUS_PANE_ID='pane-ssh-cmd' exec ${SHELL:-bash} -lic ")).toBe(true);
      expect(remote).toContain("claude");
      expect(cwd).toBe("");
      expect(cols).toBe(100);
      expect(rows).toBe(30);
      expect(paneId).toBe("pane-ssh-cmd");
    });
  });
});
