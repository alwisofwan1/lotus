import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCreatePtySession = vi.fn<(cwd: string, cols: number, rows: number, onOutput: (data: string) => void) => Promise<string>>();
const mockCreateCommandPtySession = vi.fn<(cwd: string, command: string[], cols: number, rows: number, onOutput: (data: string) => void) => Promise<string>>();
const mockResizeSession = vi.fn<(sessionId: string, cols: number, rows: number) => Promise<void>>();

vi.mock("@/lib/tauri-api", () => ({
  createPtySession: (...args: unknown[]) => mockCreatePtySession(...args as [string, number, number, (data: string) => void]),
  createCommandPtySession: (...args: unknown[]) => mockCreateCommandPtySession(...args as [string, string[], number, number, (data: string) => void]),
  killPtySession: vi.fn(async () => undefined),
  writeToSession: vi.fn(async () => undefined),
  resizeSession: (...args: unknown[]) => mockResizeSession(...args as [string, number, number]),
  listPtySessions: vi.fn(async () => []),
  adoptPtySession: vi.fn(async () => null),
}));

describe("PTY geometry when the pane is fitted while the PTY is still spawning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResizeSession.mockResolvedValue(undefined);
  });

  it("the PTY ends up at the size the renderer was fitted to", async () => {
    let spawn!: (id: string) => void;
    mockCreatePtySession.mockImplementationOnce(() => new Promise<string>((resolve) => { spawn = resolve; }));
    const { TerminalV2SessionManager } = await import("../terminal-v2-session-manager");
    const manager = new TerminalV2SessionManager();

    // Spawned at the size known before the pooled slot reached the pane.
    const handle = manager.createSession({
      paneId: "pane-1",
      workspaceId: "ws-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: () => undefined,
      provider: "claude",
    });

    // The slot attaches and fits before createPtySession resolves.
    manager.resizeSession("pane-1", 160, 48);

    // createPtySession starts once the adopt lookup found nothing.
    await vi.waitFor(() => expect(mockCreatePtySession).toHaveBeenCalled());
    spawn("pty-1");
    await handle.connectPromise;

    // Every later fit at the same size (ResizeObserver, re-attach) is all the runtime ever sends.
    manager.resizeSession("pane-1", 160, 48);

    const ptySize = mockResizeSession.mock.calls.at(-1)?.slice(1) ?? [80, 24];
    expect(ptySize).toEqual([160, 48]);
  });

  it("retries a size whose resize call failed when the pane is fitted at that size again", async () => {
    mockCreatePtySession.mockResolvedValueOnce("pty-1");
    mockResizeSession.mockRejectedValueOnce(new Error("IPC unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { TerminalV2SessionManager } = await import("../terminal-v2-session-manager");
    const manager = new TerminalV2SessionManager();
    const handle = manager.createSession({
      paneId: "pane-1",
      workspaceId: "ws-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: () => undefined,
      provider: "claude",
    });
    await handle.connectPromise;

    manager.resizeSession("pane-1", 160, 48);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    manager.resizeSession("pane-1", 160, 48);

    expect(mockResizeSession).toHaveBeenCalledTimes(2);
    expect(mockResizeSession).toHaveBeenLastCalledWith("pty-1", 160, 48);
    warn.mockRestore();
  });

  it("applies a size asked for while a command PTY (agent pane) spawns", async () => {
    let spawn!: (id: string) => void;
    mockCreateCommandPtySession.mockImplementationOnce(() => new Promise<string>((resolve) => { spawn = resolve; }));
    const { PtySessionController } = await import("@/lib/pty-session-controller");
    const ctrl = new PtySessionController();

    const connecting = ctrl.connectToCommand("/repo", ["claude"], 80, 24, () => undefined);
    ctrl.resize(160, 48);
    spawn("pty-cmd");
    await connecting;

    expect(mockResizeSession).toHaveBeenCalledExactlyOnceWith("pty-cmd", 160, 48);
  });

  it("sends nothing extra when the size asked for during spawn is the spawn size", async () => {
    let spawn!: (id: string) => void;
    mockCreatePtySession.mockImplementationOnce(() => new Promise<string>((resolve) => { spawn = resolve; }));
    const { PtySessionController } = await import("@/lib/pty-session-controller");
    const ctrl = new PtySessionController();

    const connecting = ctrl.connect("/repo", 80, 24, () => undefined);
    ctrl.resize(80, 24);
    spawn("pty-same");
    await connecting;

    expect(mockResizeSession).not.toHaveBeenCalled();
  });
});
