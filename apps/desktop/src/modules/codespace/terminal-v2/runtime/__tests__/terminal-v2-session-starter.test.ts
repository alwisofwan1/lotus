import { describe, expect, it, vi } from "vitest";
import {
  TerminalV2SessionStarter,
  type TerminalV2SessionStarterPort,
} from "../terminal-v2-session-starter";

function createHandle(connectPromise: Promise<void> = Promise.resolve(), adopted = false) {
  return {
    connectPromise,
    close: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    getSessionId: vi.fn(() => null),
    adopted: vi.fn(() => adopted),
  };
}

function createPort(overrides: Partial<TerminalV2SessionStarterPort> = {}): TerminalV2SessionStarterPort {
  return {
    attachSession: vi.fn(() => false),
    createSession: vi.fn(() => createHandle()),
    getSessionId: vi.fn(() => "session-1"),
    resizeSession: vi.fn(),
    resizeSessionAndRedraw: vi.fn(),
    ...overrides,
  };
}

describe("TerminalV2SessionStarter", () => {
  it("creates and awaits a new session when no compatible session exists", async () => {
    let connected = false;
    const port = createPort({
      createSession: vi.fn(() => createHandle(Promise.resolve().then(() => {
        connected = true;
      }))),
      getSessionId: vi.fn(() => connected ? "new-session" : null),
    });
    const starter = new TerminalV2SessionStarter(port);
    const onOutput = vi.fn();

    const outcome = await starter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput,
      command: ["claude"],
      provider: "claude",
      location: { kind: "local", cwd: "/repo" },
      canvasTerminalId: "canvas-1",
    });

    expect(outcome).toEqual({ kind: "created", sessionId: "new-session" });
    expect(port.createSession).toHaveBeenCalledWith({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput,
      command: ["claude"],
      provider: "claude",
      location: { kind: "local", cwd: "/repo" },
      canvasTerminalId: "canvas-1",
    });
    expect(port.resizeSession).not.toHaveBeenCalled();
    expect(port.resizeSessionAndRedraw).not.toHaveBeenCalled();
  });

  it("surfaces connection failures so the terminal UI can render retry state", async () => {
    const error = new Error("pty unavailable");
    const port = createPort({
      createSession: vi.fn(() => createHandle(Promise.reject(error))),
    });
    const starter = new TerminalV2SessionStarter(port);

    await expect(starter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 80, rows: 24 },
      onOutput: vi.fn(),
    })).rejects.toThrow("pty unavailable");
  });

  it("treats a session adopted from the daemon as a reattach: nothing launched, size redrawn", async () => {
    const port = createPort({
      createSession: vi.fn(() => createHandle(Promise.resolve(), true)),
      getSessionId: vi.fn(() => "adopted-session"),
    });
    const starter = new TerminalV2SessionStarter(port);

    const outcome = await starter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 120, rows: 40 },
      onOutput: vi.fn(),
      command: ["claude"],
    });

    expect(outcome).toEqual({ kind: "reattached", sessionId: "adopted-session" });
    expect(port.resizeSessionAndRedraw).toHaveBeenCalledWith("pane-1", 120, 40);
  });

  it("reattaches a compatible live session before creating a new one", async () => {
    const port = createPort({
      attachSession: vi.fn(() => true),
      getSessionId: vi.fn(() => "existing-session"),
    });
    const starter = new TerminalV2SessionStarter(port);

    const outcome = await starter.start({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      cwd: "/repo",
      geometry: { cols: 100, rows: 30 },
      onOutput: vi.fn(),
    });

    expect(outcome).toEqual({ kind: "reattached", sessionId: "existing-session" });
    expect(port.attachSession).toHaveBeenCalledWith(
      "pane-1",
      expect.any(Function),
      { workspaceId: "workspace-1", cwd: "/repo" },
    );
    expect(port.resizeSessionAndRedraw).toHaveBeenCalledWith("pane-1", 100, 30);
    expect(port.createSession).not.toHaveBeenCalled();
  });
});
