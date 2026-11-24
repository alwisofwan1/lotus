import { describe, expect, it, vi } from "vitest";
import { startTerminalV2NativeSession } from "../terminal-v2-native-session-start";

function createOptions(overrides = {}) {
  return {
    container: { getBoundingClientRect: () => ({ width: 800, height: 400 }) },
    cwd: "/repo",
    handleOutput: vi.fn(),
    initialCommand: "pnpm dev",
    location: null,
    notifyRuntimeStatus: vi.fn(),
    onRuntimeSessionIdChange: vi.fn(),
    paneId: "pane-1",
    resolveInitialGeometryEvent: vi.fn((geometry) => geometry
      ? { kind: "start-session" as const, geometry }
      : { kind: "defer-start" as const }),
    sendInitialCommand: vi.fn(),
    sessionStarter: { start: vi.fn(async () => ({ kind: "created" as const, sessionId: "session-1" })) },
    setLive: vi.fn(),
    terminal: { cols: 120, rows: 32 },
    terminalCommand: undefined,
    workspaceId: "workspace-1",
    writeConnectFailure: vi.fn(),
    ...overrides,
  };
}

describe("startTerminalV2NativeSession", () => {
  it("starts session with measured geometry and emits live state", async () => {
    const options = createOptions();

    expect(startTerminalV2NativeSession(options)).toBe(true);
    await Promise.resolve();

    expect(options.notifyRuntimeStatus).toHaveBeenCalledWith("starting");
    expect(options.sessionStarter.start).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "pane-1",
      workspaceId: "workspace-1",
      geometry: { cols: 120, rows: 32 },
      onOutput: options.handleOutput,
    }));
    expect(options.setLive).toHaveBeenCalledWith(true);
    expect(options.onRuntimeSessionIdChange).toHaveBeenCalledWith("session-1");
    expect(options.notifyRuntimeStatus).toHaveBeenCalledWith("live");
    expect(options.sendInitialCommand).toHaveBeenCalledWith(true);
  });

  it("defers when initial geometry is invalid", () => {
    const options = createOptions({ terminal: { cols: undefined, rows: 32 } });

    expect(startTerminalV2NativeSession(options)).toBe(false);

    expect(options.sessionStarter.start).not.toHaveBeenCalled();
  });

  it("emits failed state on start rejection", async () => {
    const options = createOptions({
      sessionStarter: { start: vi.fn(async () => { throw new Error("boom"); }) },
    });

    startTerminalV2NativeSession(options);
    await Promise.resolve();
    await Promise.resolve();

    expect(options.setLive).toHaveBeenCalledWith(false);
    expect(options.notifyRuntimeStatus).toHaveBeenCalledWith("failed");
    expect(options.writeConnectFailure).toHaveBeenCalledWith(expect.any(Error));
  });
});
