import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreatePtySession = vi.fn();
const mockCreateCommandPtySession = vi.fn();
const mockCreateRemotePtySession = vi.fn();
const mockAdoptRemotePtySession = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  createPtySession: (...args: unknown[]) => mockCreatePtySession(...args),
  createCommandPtySession: (...args: unknown[]) => mockCreateCommandPtySession(...args),
  createRemotePtySession: (...args: unknown[]) => mockCreateRemotePtySession(...args),
  adoptRemotePtySession: (...args: unknown[]) => mockAdoptRemotePtySession(...args),
  adoptPtySession: vi.fn().mockResolvedValue(null),
  killPtySession: vi.fn().mockResolvedValue(undefined),
  writeToSession: vi.fn().mockResolvedValue(undefined),
  resizeSession: vi.fn().mockResolvedValue(undefined),
  listPtySessions: vi.fn().mockResolvedValue([]),
}));

const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root" };

async function controller() {
  const { PtySessionController } = await import("../pty-session-controller");
  return new PtySessionController();
}

describe("PtySessionController on another machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePtySession.mockResolvedValue("shell-session");
    mockCreateCommandPtySession.mockResolvedValue("command-session");
    // Most cases below are about the `ssh -t` argv: a machine without a Lotus host.
    mockAdoptRemotePtySession.mockResolvedValue(null);
    mockCreateRemotePtySession.mockResolvedValue(null);
  });

  it("still opens a plain local shell when there is no machine", async () => {
    const ctrl = await controller();
    await ctrl.connect("/repo", 80, 24, vi.fn(), "pane-1", null, "term-1");

    expect(mockCreatePtySession).toHaveBeenCalledWith("/repo", 80, 24, expect.any(Function), "pane-1", "term-1", null);
    expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
  });

  it("runs a local spawn on the pane's own Claude account, never a remote one (issues/07)", async () => {
    const { PtySessionController } = await import("../pty-session-controller");
    await new PtySessionController("hss").connectToCommand("/repo", ["claude"], 80, 24, vi.fn(), "p", null, "t");
    expect(mockCreateCommandPtySession.mock.calls[0][7]).toBe("hss");
    await new PtySessionController("hss").connect("/repo", 80, 24, vi.fn(), "p", null, "t");
    expect(mockCreatePtySession.mock.calls[0][6]).toBe("hss");
    // An account id names a folder on this desktop; the far machine has its own.
    await new PtySessionController("hss").connectToCommand("/srv", ["claude"], 80, 24, vi.fn(), "p", SSH, "t");
    expect(mockCreateCommandPtySession.mock.calls[1][7]).toBeNull();
  });

  it("runs a remote shell as a local pty whose child is ssh", async () => {
    const ctrl = await controller();
    await ctrl.connect("/srv/devbox/api", 120, 40, vi.fn(), "pane-2", SSH, "term-2");

    expect(mockCreatePtySession).not.toHaveBeenCalled();
    const [cwd, argv, cols, rows, , paneId, canvasTerminalId] = mockCreateCommandPtySession.mock.calls[0];
    expect(argv.slice(0, 7)).toEqual(["ssh", "-t", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "root@devbox-vps"]);
    expect(argv[7]).toContain("cd '/srv/devbox/api'");
    expect(cols).toBe(120);
    expect(rows).toBe(40);
    expect(paneId).toBe("pane-2");
    expect(canvasTerminalId).toBe("term-2");
    expect(cwd).toBe("");
  });

  it("never hands the remote path to the local spawn as a working directory", async () => {
    const ctrl = await controller();
    await ctrl.connectToCommand("/srv/devbox/api", ["claude"], 80, 24, vi.fn(), "pane-3", SSH, "term-3");

    const [cwd] = mockCreateCommandPtySession.mock.calls[0];
    expect(cwd).toBe("");
  });

  it("sends a runner's argv across ssh through a login shell, so the runner is on PATH", async () => {
    const ctrl = await controller();
    const argv = ["claude", "--append-system-prompt", "You are Rowan; never say \"as an AI\"."];
    await ctrl.connectToCommand("/srv/api", argv, 80, 24, vi.fn(), "pane-4", SSH, "term-4");

    // A runner installed by its own installer lives on a PATH that only `.zshrc` sets, so a
    // non-login ssh command reports it as `command not found` (measured against devbox-vps,
    // 2026-09-15). The login+interactive form is what finds it.
    const remote = mockCreateCommandPtySession.mock.calls[0][1].at(-1) as string;
    // The pane id rides in front of the exec: a remote agent's hooks have no other way to learn
    // which pane they belong to, and a file on that machine would outlive the session.
    expect(remote.startsWith("cd '/srv/api' && LOTUS_PANE_ID='pane-4' exec ${SHELL:-bash} -lic ")).toBe(true);
    expect(remote).toContain("claude");
    expect(remote).toContain("--append-system-prompt");
  });

  it("runs a pane whose command is already ssh as-is, not inside a second ssh", async () => {
    // Code's SSH workspaces store `ssh -t host ...` as the cell command; wrapped again, the VPS
    // itself ran `ssh devbox-vps` and failed with a Linux "Temporary failure in name resolution".
    const ctrl = await controller();
    const argv = ["ssh", "-t", "root@devbox-vps", "cd '/srv' && exec ${SHELL:-bash} -l"];
    await ctrl.connectToCommand("/srv", argv, 80, 24, vi.fn(), "pane-6", SSH, "term-6");

    const [cwd, spawned] = mockCreateCommandPtySession.mock.calls[0];
    expect(spawned).toEqual(argv);
    expect(cwd).toBe("");
  });

  it("leaves a local runner spawn exactly as it was", async () => {
    const ctrl = await controller();
    await ctrl.connectToCommand("/repo", ["claude", "--resume", "abc"], 80, 24, vi.fn(), "pane-5", null, "term-5");

    expect(mockCreateCommandPtySession).toHaveBeenCalledWith(
      "/repo",
      ["claude", "--resume", "abc"],
      80,
      24,
      expect.any(Function),
      "pane-5",
      "term-5",
      null,
    );
  });

  it("carries the machine through the prefer-command path, argv and fallback alike", async () => {
    const ctrl = await controller();
    const mode = await ctrl.connectPreferCommand("/srv/api", ["codex"], 80, 24, vi.fn(), "pane-6", "term-6", SSH);
    expect(mode).toBe("command");
    const viaArgv = mockCreateCommandPtySession.mock.calls[0][1].at(-1) as string;
    expect(viaArgv.startsWith("cd '/srv/api' && LOTUS_PANE_ID='pane-6' exec ${SHELL:-bash} -lic ")).toBe(true);
    expect(viaArgv).toContain("codex");

    mockCreateCommandPtySession.mockClear();
    mockCreateCommandPtySession
      .mockRejectedValueOnce(new Error("no such binary"))
      .mockResolvedValue("command-session");

    const fallback = await controller();
    const fallbackMode = await fallback.connectPreferCommand(
      "/srv/api",
      ["codex"],
      80,
      24,
      vi.fn(),
      "pane-7",
      "term-7",
      SSH,
    );
    expect(fallbackMode).toBe("shell");
    const shellArgv = mockCreateCommandPtySession.mock.calls.at(-1)?.[1] as string[];
    expect(shellArgv.slice(0, 7)).toEqual(["ssh", "-t", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "root@devbox-vps"]);
    expect(shellArgv.at(-1)).toContain("cd '/srv/api'");
  });

  describe("on a machine whose Lotus host runs a session daemon", () => {
    it("starts a shell pane in that daemon, with the command ssh -t would have sent", async () => {
      mockCreateRemotePtySession.mockResolvedValue("remote-session");
      const ctrl = await controller();
      await ctrl.connect("/srv/api", 100, 30, vi.fn(), "pane-r1", SSH, "term-r1");

      expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
      const [target, remoteCommand, cols, rows, , paneId, terminalId] = mockCreateRemotePtySession.mock.calls[0];
      expect(target).toEqual({ host: "devbox-vps", user: "root" });
      expect(remoteCommand).toContain("cd '/srv/api'");
      expect([cols, rows, paneId, terminalId]).toEqual([100, 30, "pane-r1", "term-r1"]);
      expect(ctrl.getSessionId()).toBe("remote-session");
      expect(ctrl.wasAdopted()).toBe(false);
    });

    it("starts a runner pane there with the same login-shell command, callback env included", async () => {
      mockCreateRemotePtySession.mockResolvedValue("remote-session");
      const ctrl = await controller();
      await ctrl.connectToCommand("/srv/api", ["claude"], 80, 24, vi.fn(), "pane-r2", SSH, "term-r2");

      const remoteCommand = mockCreateRemotePtySession.mock.calls[0][1] as string;
      expect(remoteCommand.startsWith("cd '/srv/api' && LOTUS_PANE_ID='pane-r2' exec ${SHELL:-bash} -lic ")).toBe(true);
      expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
    });

    it("takes over the pane's own session there instead of starting a second one", async () => {
      mockAdoptRemotePtySession.mockResolvedValue("adopted-remote");
      const ctrl = await controller();
      await ctrl.connectToCommand("/srv/api", ["claude"], 80, 24, vi.fn(), "pane-r3", SSH, "term-r3");

      expect(mockAdoptRemotePtySession.mock.calls[0][1]).toBe("pane-r3");
      expect(mockCreateRemotePtySession).not.toHaveBeenCalled();
      expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
      expect(ctrl.wasAdopted()).toBe(true);
    });

    it("falls back to ssh -t with a notice when the machine runs no daemon", async () => {
      const { NO_REMOTE_DAEMON_NOTICE } = await import("../pty-session-controller");
      const onOutput = vi.fn();
      const ctrl = await controller();
      await ctrl.connect("/srv/api", 80, 24, onOutput, "pane-r4", SSH, "term-r4");

      expect(onOutput).toHaveBeenCalledWith(NO_REMOTE_DAEMON_NOTICE);
      expect(mockCreateCommandPtySession.mock.calls[0][1][0]).toBe("ssh");
    });

    it("falls back to ssh -t quietly when the daemon cannot be reached", async () => {
      mockCreateRemotePtySession.mockRejectedValue(new Error("forward failed"));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onOutput = vi.fn();
      const ctrl = await controller();
      await ctrl.connect("/srv/api", 80, 24, onOutput, "pane-r5", SSH, "term-r5");

      expect(onOutput).not.toHaveBeenCalled();
      expect(mockCreateCommandPtySession.mock.calls[0][1][0]).toBe("ssh");
      warn.mockRestore();
    });

    it("leaves a stored ssh command under ssh -t when it carries no remote command", async () => {
      mockCreateRemotePtySession.mockResolvedValue("remote-session");
      const ctrl = await controller();
      await ctrl.connectToCommand("/srv", ["ssh", "-t", "root@devbox-vps"], 80, 24, vi.fn(), "pane-r6", SSH, "t");

      expect(mockCreateRemotePtySession).not.toHaveBeenCalled();
      expect(mockCreateCommandPtySession.mock.calls[0][1]).toEqual(["ssh", "-t", "root@devbox-vps"]);
    });

    it("moves a Code cell's stored ssh command into the daemon, older ones without keepalive too", async () => {
      mockCreateRemotePtySession.mockResolvedValue("remote-session");
      const stored = ["ssh", "-t", "-p", "2222", "root@devbox-vps", "cd '/srv' && exec ${SHELL:-bash} -l"];
      const ctrl = await controller();
      await ctrl.connectToCommand("/srv", stored, 80, 24, vi.fn(), "pane-r8", SSH, "t");

      const [target, remoteCommand] = mockCreateRemotePtySession.mock.calls[0];
      expect(target).toEqual({ host: "devbox-vps", user: "root", port: 2222 });
      expect(remoteCommand).toBe("cd '/srv' && exec ${SHELL:-bash} -l");
      expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
    });

    it("moves a Canvas node's ssh command into the daemon although the node passes no location", async () => {
      mockCreateRemotePtySession.mockResolvedValue("remote-session");
      const { buildSshCommand } = await import("@/modules/codespace/services/ssh-command");
      const argv = buildSshCommand({ target: { host: "devbox-vps" }, remoteCwd: "/srv" });
      const ctrl = await controller();
      await ctrl.connectToCommand("", argv, 80, 24, vi.fn(), "pane-r9", null, "t");

      expect(mockCreateRemotePtySession.mock.calls[0][0]).toEqual({ host: "devbox-vps" });
      expect(mockCreateCommandPtySession).not.toHaveBeenCalled();
    });

    it("never touches a local pane", async () => {
      const ctrl = await controller();
      await ctrl.connectToCommand("/repo", ["claude"], 80, 24, vi.fn(), "pane-r7", null, "t");
      expect(mockAdoptRemotePtySession).not.toHaveBeenCalled();
      expect(mockCreateRemotePtySession).not.toHaveBeenCalled();
    });
  });
});
