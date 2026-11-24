import { describe, it, expect, vi } from "vitest";
import type { IPty } from "node-pty";
import { PtySession, type PtySpawnFn } from "../session.js";

const noop = (): void => undefined;

function mockDisposable() {
  return { dispose: vi.fn() };
}

function makeMockPty(overrides?: Partial<IPty>): {
  pty: IPty;
  simulateData: (chunk: string) => void;
  simulateExit: (code: number) => void;
} {
  let onDataListener: ((data: string) => void) | undefined;
  let onExitListener: ((e: { exitCode: number }) => void) | undefined;

  const pty: IPty = {
    pid: 1234,
    cols: 80,
    rows: 24,
    process: "sh",
    handleFlowControl: false,
    onData: (listener) => {
      onDataListener = listener;
      return mockDisposable();
    },
    onExit: (listener) => {
      onExitListener = listener;
      return mockDisposable();
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    ...overrides,
  };

  return {
    pty,
    simulateData: (chunk) => onDataListener?.(chunk),
    simulateExit: (code) => onExitListener?.({ exitCode: code }),
  };
}

function makeSpawnFn(pty: IPty): PtySpawnFn {
  return () => pty;
}

describe("PtySession", () => {
  it("spawns with correct options", () => {
    const { pty } = makeMockPty();
    const spawnFn = vi.fn(() => pty);
    new PtySession("id1", "/tmp", 120, 40, ["/bin/sh"], spawnFn);
    expect(spawnFn).toHaveBeenCalledWith(
      "/bin/sh",
      [],
      expect.objectContaining({ cwd: "/tmp", cols: 120, rows: 40 })
    );
  });

  /**
   * Slice 1b.1 (`plans/pocket-without-laptop`). Every permission hook a runner fires writes a
   * drop file, and the ONLY thing that can tie that file back to a cell is the pane id the
   * agent was started with — `issues/01` names it the prerequisite for the whole of 1b.
   *
   * The structured path has set it since it was written (`codex-app-server/session.ts`); the
   * PTY path never did, so a TUI cell's hook events could not be correlated with anything.
   */
  it("tells the agent which pane it is running in", () => {
    const { pty } = makeMockPty();
    const spawnFn = vi.fn(() => pty);

    new PtySession("pane-7", "/tmp", 80, 24, ["/bin/sh"], spawnFn);

    expect(spawnFn).toHaveBeenCalledWith("/bin/sh", [], expect.objectContaining({
      env: expect.objectContaining({ LOTUS_PANE_ID: "pane-7" }),
    }));
  });

  it("keeps the rest of the environment it was given", () => {
    const { pty } = makeMockPty();
    const spawnFn = vi.fn(() => pty);
    process.env["LOTUS_TEST_MARKER"] = "kept";

    try {
      new PtySession("pane-7", "/tmp", 80, 24, ["/bin/sh"], spawnFn);
      expect(spawnFn).toHaveBeenCalledWith("/bin/sh", [], expect.objectContaining({
        env: expect.objectContaining({ LOTUS_TEST_MARKER: "kept" }),
      }));
    } finally {
      delete process.env["LOTUS_TEST_MARKER"];
    }
  });

  it("asks CLIs for OSC 8 links, unless the operator already chose", () => {
    const { pty } = makeMockPty();
    const spawnFn = vi.fn(() => pty);
    const previous = process.env["FORCE_HYPERLINK"];

    try {
      delete process.env["FORCE_HYPERLINK"];
      new PtySession("pane-7", "/tmp", 80, 24, ["/bin/sh"], spawnFn);
      expect(spawnFn).toHaveBeenLastCalledWith("/bin/sh", [], expect.objectContaining({
        env: expect.objectContaining({ FORCE_HYPERLINK: "1" }),
      }));

      process.env["FORCE_HYPERLINK"] = "0";
      new PtySession("pane-8", "/tmp", 80, 24, ["/bin/sh"], spawnFn);
      expect(spawnFn).toHaveBeenLastCalledWith("/bin/sh", [], expect.objectContaining({
        env: expect.objectContaining({ FORCE_HYPERLINK: "0" }),
      }));
    } finally {
      if (previous === undefined) delete process.env["FORCE_HYPERLINK"];
      else process.env["FORCE_HYPERLINK"] = previous;
    }
  });

  it("initial state is running", () => {
    const { pty } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    expect(session.state.status).toBe("running");
    expect(session.state.id).toBe("id1");
    expect(session.state.cwd).toBe("/tmp");
    expect(session.state.cols).toBe(80);
    expect(session.state.rows).toBe(24);
  });

  it("status becomes exited after pty exit", () => {
    const { pty, simulateExit } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    simulateExit(0);
    expect(session.state.status).toBe("exited");
  });

  it("write() delegates to pty", () => {
    const { pty } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    session.write("ls\n");
    expect(pty.write).toHaveBeenCalledWith("ls\n");
  });

  it("resize() updates state and delegates to pty", () => {
    const { pty } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    session.resize(120, 40);
    expect(pty.resize).toHaveBeenCalledWith(120, 40);
    expect(session.state.cols).toBe(120);
    expect(session.state.rows).toBe(40);
  });

  it("kill() delegates to pty", () => {
    const { pty } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    session.kill();
    expect(pty.kill).toHaveBeenCalledOnce();
  });

  it("buffers output and getBufferTail() returns it", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    simulateData("hello ");
    simulateData("world");
    expect(session.getBufferTail()).toBe("hello world");
  });

  it("getBufferTail() trims to maxBytes", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    simulateData("abcde");
    expect(session.getBufferTail(3)).toBe("cde");
  });

  it("ring buffer clamps at its cap, and reports what it dropped", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    // Twice the cap, so eviction is guaranteed whatever the cap currently is. A literal
    // here became a tautology once the ring was resized (Fase 2), passing while testing
    // the opposite of its name.
    const cap = session.getBufferTail().length || 256 * 1024;
    simulateData("a".repeat(cap * 2));
    const held = session.getBufferTail().length;
    expect(held).toBeLessThanOrEqual(cap * 2);
    expect(session.bytesSeen).toBe(cap * 2);
    expect(held).toBeLessThan(session.bytesSeen);
  });

  /// The mismatch Fase 4 exists to fix: offsets on the wire count UTF-8 bytes, and this
  /// buffer used to count UTF-16 units. A box-drawing character is one unit and three
  /// bytes, and TUI output is made of them.
  it("counts bytes, not UTF-16 units", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    simulateData("░▒▓"); // three chars, nine UTF-8 bytes
    expect(session.bytesSeen).toBe(9);
  });

  it("serves an absolute offset, and says where the answer really starts", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    simulateData("abcdefghij");

    expect(session.readScrollback(4, 3)).toEqual({ text: "efg", offset: 4 });
    // Past the end is empty rather than an error: a caller polls, and "nothing new yet"
    // is a normal answer.
    expect(session.readScrollback(10, 5)).toEqual({ text: "", offset: 10 });
  });

  it("an offset the ring has moved past comes back ahead of the request", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    const cap = 256 * 1024;
    simulateData("x".repeat(cap + 100));

    const got = session.readScrollback(0, 10);
    // Ahead of 0, which is how a gap becomes visible instead of a later position being
    // served as if it were continuous.
    expect(got.offset).toBe(100);
  });

  it("onExit() handlers are called when pty exits", () => {
    const { pty, simulateExit } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    const handler = vi.fn();
    session.onExit(handler);
    simulateExit(0);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("splits argv array into file and args", () => {
    const { pty } = makeMockPty();
    const spawnFn = vi.fn(() => pty);
    new PtySession("id1", "/tmp", 80, 24, ["/usr/bin/python3", "-i"], spawnFn);
    expect(spawnFn).toHaveBeenCalledWith("/usr/bin/python3", ["-i"], expect.anything());
  });

  it("uses /bin/sh if command is empty", () => {
    const { pty } = makeMockPty();
    const spawnFn = vi.fn(() => pty);
    new PtySession("id1", "/tmp", 80, 24, [], spawnFn);
    expect(spawnFn).toHaveBeenCalledWith("/bin/sh", [], expect.anything());
  });

  it("subscribeData() handler receives output chunks", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    const received: string[] = [];
    session.subscribeData((chunk) => received.push(chunk));
    simulateData("chunk-a");
    simulateData("chunk-b");
    expect(received).toEqual(["chunk-a", "chunk-b"]);
  });

  it("subscribeData() unsubscribe stops delivery", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    const received: string[] = [];
    const unsub = session.subscribeData((chunk) => received.push(chunk));
    simulateData("before");
    unsub();
    simulateData("after");
    expect(received).toEqual(["before"]);
  });

  it("multiple subscribeData() subscribers all receive chunks", () => {
    const { pty, simulateData } = makeMockPty();
    const session = new PtySession("id1", "/tmp", 80, 24, ["/bin/sh"], makeSpawnFn(pty));
    const a: string[] = [];
    const b: string[] = [];
    session.subscribeData((c) => a.push(c));
    session.subscribeData((c) => b.push(c));
    simulateData("x");
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  // Suppress unused warning from helper
  void noop;
});
