import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreatePtySession = vi.fn();
const mockCreateCommandPtySession = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  createPtySession: (...args: unknown[]) => mockCreatePtySession(...args),
  createCommandPtySession: (...args: unknown[]) => mockCreateCommandPtySession(...args),
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
    expect(argv.slice(0, 3)).toEqual(["ssh", "-t", "root@devbox-vps"]);
    expect(argv[3]).toContain("cd '/srv/devbox/api'");
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
    expect(shellArgv.slice(0, 3)).toEqual(["ssh", "-t", "root@devbox-vps"]);
    expect(shellArgv.at(-1)).toContain("cd '/srv/api'");
  });
});
