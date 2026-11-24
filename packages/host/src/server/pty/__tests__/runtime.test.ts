import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPtyRuntime, type DaemonConnection } from "../runtime.js";
import type { SessionInfo } from "../sessiond-frame.js";

const dir = (): string => mkdtempSync(join(tmpdir(), "lotus-pty-runtime-"));

function daemon(sessions: SessionInfo[]): DaemonConnection & { closed: boolean; attached: string[] } {
  return {
    closed: false,
    attached: [],
    list: async () => sessions,
    create: async () => ({ id: "d9", pid: 1 }),
    on: () => () => undefined,
    onClose: () => () => undefined,
    attach(id) { this.attached.push(id); },
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    snapshot: async () => undefined,
    close() { this.closed = true; },
  };
}

const info = (id: string, tag?: string): SessionInfo => ({
  id, owner: { pane_id: null, canvas_terminal_id: null, window_label: "host" }, cols: 100, rows: 30,
  total_bytes: 0, idle: true, started_ago_ms: 0, pid: 1, cwd: "/w", ...(tag !== undefined ? { tag } : {}),
});

describe("createPtyRuntime on lotus-sessiond", () => {
  it("adopts the sessions a previous host left in the daemon, and only those", async () => {
    const d = daemon([info("d1", JSON.stringify({ sessionId: "h1", provider: "codex" })), info("d2")]);
    const runtime = await createPtyRuntime({ mode: "standalone", env: {}, logDir: dir(), sessiondDir: dir(), connectSessiond: async () => d });
    expect(runtime.manager.list().map((s) => [s.id, s.cwd, s.cols, s.provider])).toEqual([["h1", "/w", 100, "codex"]]);
    await new Promise((r) => setTimeout(r, 0));
    expect(d.attached).toEqual(["d1"]);
    runtime.stop();
    await new Promise((r) => setTimeout(r, 0));
    expect(d.closed).toBe(true);
  });

  it("refuses to start when it cannot reach or start the daemon, and says what that costs", async () => {
    await expect(
      createPtyRuntime({ mode: "standalone", env: {}, logDir: dir(), sessiondDir: dir(), connectSessiond: async () => { throw new Error("this build embeds no lotus-sessiond"); } }),
    ).rejects.toThrow(/embeds no lotus-sessiond.*survive/s);
  });

  it("still honours an operator who asked for node-pty on purpose", async () => {
    const runtime = await createPtyRuntime({ mode: "standalone", env: { LOTUS_PTY: "node-pty" }, logDir: dir(), sessiondDir: dir() });
    runtime.stop();
  });
});

// `cargo build -p lotus-sessiond`, then LOTUS_SESSIOND_BIN=<target>/debug/lotus-sessiond bun run test.
const realBin = process.env["LOTUS_SESSIOND_BIN"];
describe.skipIf(!realBin)("against lotus-sessiond", () => {
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 150 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("a session outlives its host: the next host adopts it with history, screen and input", async () => {
    // Short: a socket path under $TMPDIR on macOS is past the 103-byte limit.
    const sessiondDir = mkdtempSync("/tmp/sd-");
    const logDir = dir();
    const opts = { mode: "standalone" as const, env: {}, logDir, sessiondDir, sessiondBin: realBin! };
    const first = await createPtyRuntime(opts);
    const { id } = first.manager.create({ command: ["/bin/sh", "-c", "echo one; read x; echo got-$x; sleep 30"], cwd: "/tmp", provider: "codex" });
    const s1 = first.manager.getSession(id);
    await until(() => s1.getBufferTail().includes("one"));
    first.manager.stop();
    first.stop();

    const second = await createPtyRuntime(opts);
    expect(second.manager.list().map((s) => [s.id, s.cwd, s.provider])).toEqual([[id, "/tmp", "codex"]]);
    const s2 = second.manager.getSession(id);
    s2.write("two\r");
    await until(() => s2.getBufferTail().includes("got-two"));
    expect(s2.getBufferTail()).toMatch(/one[\s\S]*got-two/);
    expect(await s2.renderScreen()).toMatch(/^one\ntwo\ngot-two/);
    second.manager.kill(id);
    second.stop();
  });
});
