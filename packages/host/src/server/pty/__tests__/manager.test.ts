import { describe, it, expect, vi, afterEach } from "vitest";
import type { IPty, IPtyForkOptions } from "node-pty";
import { PtyManager } from "../manager.js";
import { SessionNotFoundError } from "../errors.js";
import type { PtyBackend } from "../session.js";

function makeMockPty(callbacks?: {
  onExit?: (trigger: (code: number) => void) => void;
}) {
  let onDataCb: ((data: string) => void) | undefined;
  let onExitCb: ((e: { exitCode: number }) => void) | undefined;
  const disp = { dispose: vi.fn() };

  const pty: IPty = {
    pid: 999,
    cols: 80,
    rows: 24,
    process: "sh",
    handleFlowControl: false,
    onData: (cb) => { onDataCb = cb; return disp; },
    onExit: (cb) => { onExitCb = cb; return disp; },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };

  callbacks?.onExit?.((code) => onExitCb?.({ exitCode: code }));

  return {
    pty,
    emit: {
      data: (chunk: string) => onDataCb?.(chunk),
      exit: (code = 0) => onExitCb?.({ exitCode: code }),
    },
  };
}

function makeSpawnFn(ptyOrFn: IPty | (() => IPty)): (file: string, args: string[], opts: IPtyForkOptions) => IPty {
  return typeof ptyOrFn === "function"
    ? () => ptyOrFn()
    : () => ptyOrFn;
}

describe("PtyManager", () => {
  it("create() returns a PtySessionState with the requested cwd", () => {
    const { pty } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    const state = manager.create({ cwd: "/home/user", cols: 100, rows: 30 });
    expect(state.cwd).toBe("/home/user");
    expect(state.cols).toBe(100);
    expect(state.rows).toBe(30);
    expect(state.status).toBe("running");
    expect(typeof state.id).toBe("string");
    manager.stop();
  });

  it("list() returns all active sessions", () => {
    const { pty } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    manager.create({ cwd: "/a" });
    manager.create({ cwd: "/b" });
    expect(manager.list()).toHaveLength(2);
    manager.stop();
  });

  it("getSession() returns the PtySession", () => {
    const { pty } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    const state = manager.create({ cwd: "/tmp" });
    const session = manager.getSession(state.id);
    expect(session.state.id).toBe(state.id);
    manager.stop();
  });

  it("getSession() throws SessionNotFoundError for unknown id", () => {
    const manager = new PtyManager(makeSpawnFn(makeMockPty().pty));
    expect(() => manager.getSession("not-a-real-id")).toThrow(SessionNotFoundError);
  });

  it("write() delegates data to the session", () => {
    const { pty } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    const state = manager.create({ cwd: "/tmp" });
    manager.write(state.id, "ls\n");
    expect(pty.write).toHaveBeenCalledWith("ls\n");
    manager.stop();
  });

  it("write() throws SessionNotFoundError for unknown id", () => {
    const manager = new PtyManager(makeSpawnFn(makeMockPty().pty));
    expect(() => manager.write("no-such-id", "data")).toThrow(SessionNotFoundError);
  });

  it("resize() delegates to the session and updates state", () => {
    const { pty } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    const state = manager.create({ cwd: "/tmp" });
    manager.resize(state.id, 120, 40);
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
    expect(manager.getSession(state.id).state.cols).toBe(120);
    manager.stop();
  });

  it("resize() throws SessionNotFoundError for unknown id", () => {
    const manager = new PtyManager(makeSpawnFn(makeMockPty().pty));
    expect(() => manager.resize("no-such-id", 80, 24)).toThrow(SessionNotFoundError);
  });

  it("kill() removes the session from the map", () => {
    const { pty } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    const state = manager.create({ cwd: "/tmp" });
    manager.kill(state.id);
    expect(manager.list()).toHaveLength(0);
  });

  it("kill() throws SessionNotFoundError for unknown id", () => {
    const manager = new PtyManager(makeSpawnFn(makeMockPty().pty));
    expect(() => manager.kill("ghost")).toThrow(SessionNotFoundError);
  });

  it("session is removed from list when it exits naturally", () => {
    const { pty, emit } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    manager.create({ cwd: "/tmp" });
    emit.exit(0);
    expect(manager.list()).toHaveLength(0);
  });

  it("stop() kills all running sessions", () => {
    let ptyCount = 0;
    const ptys = [makeMockPty(), makeMockPty()];
    const manager = new PtyManager(makeSpawnFn(() => ptys[ptyCount++ % 2]!.pty));
    manager.create({ cwd: "/a" });
    manager.create({ cwd: "/b" });
    manager.stop();
    expect(manager.list()).toHaveLength(0);
  });
});

// ─── Real spawn integration test ─────────────────────────────────────────────

describe("PtyManager (real node-pty)", () => {
  let manager: PtyManager;

  afterEach(() => {
    manager?.stop();
  });

  it(
    "spawns a real process and buffers its output",
    async () => {
      const { spawn } = await import("node-pty");
      manager = new PtyManager(spawn);
      const state = manager.create({
        command: ["/bin/sh", "-c", "printf 'hello-pty'"],
        cwd: "/tmp",
      });
      // Hold a reference before waiting — manager removes the session from its
      // map on exit, so looking it up by ID afterwards would throw.
      const session = manager.getSession(state.id);
      await new Promise<void>((resolve) => {
        session.onExit(resolve);
        setTimeout(resolve, 2000); // safety timeout
      });
      expect(session.getBufferTail()).toContain("hello-pty");
      expect(manager.list()).toHaveLength(0); // cleaned up from map
    },
    5000 // generous timeout for CI
  );
});

describe("PtyManager.adopt", () => {
  /// A backend bound to a session that outlived the previous host process.
  function survivingBackend(history: string): PtyBackend {
    return {
      onData: () => undefined,
      onExit: () => undefined,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      scrollback: {
        bytesSeen: () => Buffer.byteLength(history, "utf8"),
        read: (from, max) => ({
          text: Buffer.from(history, "utf8").subarray(from, from + max).toString("utf8"),
          offset: from,
        }),
      },
    };
  }

  it("puts a session that outlived the host back under management", () => {
    // The whole point of ADR-B: restart the host and the agent is still there, with the
    // hours of output it produced while nothing was watching.
    const backend = survivingBackend("dua jam kerja");
    const manager = new PtyManager(makeSpawnFn(makeMockPty().pty), () => backend);

    const state = manager.adopt("abc-123", { cwd: "/srv/app", cols: 120, rows: 30 });

    expect(state.id).toBe("abc-123");
    expect(manager.list().map((s) => s.id)).toEqual(["abc-123"]);
    expect(manager.getSession("abc-123").bytesSeen).toBe(13);
    expect(manager.getSession("abc-123").readScrollback(0).text).toBe("dua jam kerja");
  });
});

describe("PtyManager.stop with sessions that outlive the host", () => {
  it("leaves a daemon-backed session running when the host shuts down", () => {
    // `stop()` is host shutdown, not a decision about the work. Killing here would undo the
    // entire point of ADR-0067: restart the host and the two-hour agent is gone.
    const kill = vi.fn();
    const backend: PtyBackend = {
      onData: () => undefined,
      onExit: () => undefined,
      write: vi.fn(),
      resize: vi.fn(),
      kill,
      outlivesHost: true,
      scrollback: { bytesSeen: () => 0, read: (from) => ({ text: "", offset: from }) },
    };
    const manager = new PtyManager(makeSpawnFn(makeMockPty().pty), () => backend);
    manager.adopt("abc-123", { cwd: "/srv", cols: 80, rows: 24 });

    manager.stop();

    expect(kill).not.toHaveBeenCalled();
  });

  it("still kills a node-pty session, whose child dies with the host anyway", () => {
    const { pty } = makeMockPty();
    const manager = new PtyManager(makeSpawnFn(pty));
    manager.create({ cwd: "/srv" });

    manager.stop();

    expect(pty.kill).toHaveBeenCalled();
  });

  it("kill() remains deliberate and ends the session either way", () => {
    const kill = vi.fn();
    const backend: PtyBackend = {
      onData: () => undefined, onExit: () => undefined,
      write: vi.fn(), resize: vi.fn(), kill, outlivesHost: true,
    };
    const manager = new PtyManager(makeSpawnFn(makeMockPty().pty), () => backend);
    manager.adopt("abc-123", { cwd: "/srv", cols: 80, rows: 24 });

    manager.kill("abc-123");

    expect(kill).toHaveBeenCalled();
  });
});
