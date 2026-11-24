import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  adoptableSessions,
  attachSessiondSession,
  createSessiondSpawnFn,
  type SessiondPort,
} from "../sessiond-backend.js";
import type { SessionEvent } from "../sessiond-client.js";
import type { SessionInfo, SpawnSpec } from "../sessiond-frame.js";
import { SessionLog } from "../session-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function logDir(): string {
  const d = mkdtempSync(join(tmpdir(), "sdb-"));
  dirs.push(d);
  return d;
}

/// Records what the backend asks of the daemon; `emit` plays the daemon's side.
class FakeDaemon implements SessiondPort {
  readonly sent: unknown[][] = [];
  readonly specs: SpawnSpec[] = [];
  private readonly listeners = new Map<string, (e: SessionEvent) => void>();
  private readonly closers: Array<(e: Error) => void> = [];
  createResult: Promise<{ id: string; pid: number | null }> = Promise.resolve({ id: "d1", pid: 9 });
  screen: { text: string; cols: number; rows: number } | undefined = { text: "row", cols: 80, rows: 24 };

  create(spec: SpawnSpec, listener?: (e: SessionEvent) => void) {
    this.specs.push(spec);
    return this.createResult.then((r) => {
      if (listener) this.listeners.set(r.id, listener);
      return r;
    });
  }
  on(id: string, listener: (e: SessionEvent) => void) {
    this.listeners.set(id, listener);
    return () => this.listeners.delete(id);
  }
  onClose(listener: (e: Error) => void) {
    this.closers.push(listener);
    return () => undefined;
  }
  attach(id: string, from: number) {
    this.sent.push(["attach", id, from]);
    if (this.gone) this.emit(id, { t: "error", message: `no session ${id}` });
  }
  gone = false;
  write(id: string, data: string | Uint8Array) { this.sent.push(["write", id, String(data)]); }
  resize(id: string, cols: number, rows: number) { this.sent.push(["resize", id, cols, rows]); }
  kill(id: string) { this.sent.push(["kill", id]); }
  snapshot(id: string) { this.sent.push(["snapshot", id]); return Promise.resolve(this.screen); }
  emit(id: string, e: SessionEvent) { this.listeners.get(id)?.(e); }
  close() { for (const c of this.closers) c(new Error("gone")); }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const out = (offset: number, s: string): SessionEvent => ({ t: "output", offset, payload: Buffer.from(s) });
const opts = { name: "xterm-256color", cols: 100, rows: 30, cwd: "/w", env: { PATH: "/bin", GONE: undefined }, sessionId: "h1", metadata: { provider: "codex" as const, title: "T" } };

describe("sessiond backend", () => {
  it("creates the session with the host's id and metadata in the tag", async () => {
    const d = new FakeDaemon();
    createSessiondSpawnFn({ client: async () => d, logDir: logDir() })("claude", ["--x"], opts);
    await flush();
    const spec = d.specs[0]!;
    expect([spec.argv, spec.cwd, spec.cols, spec.rows, spec.owner.pane_id]).toEqual([["claude", "--x"], "/w", 100, 30, "h1"]);
    expect(spec.env).toEqual([["PATH", "/bin"], ["TERM", "xterm-256color"]]);
    expect(JSON.parse(spec.tag!)).toEqual({ sessionId: "h1", provider: "codex", title: "T" });
  });

  it("queues input until the daemon has named the session", async () => {
    const d = new FakeDaemon();
    const pty = createSessiondSpawnFn({ client: async () => d, logDir: logDir() })("sh", [], opts);
    pty.write("ls\r");
    pty.resize(90, 20);
    expect(d.sent).toEqual([]);
    await flush();
    pty.write("pwd\r");
    expect(d.sent).toEqual([["write", "d1", "ls\r"], ["resize", "d1", 90, 20], ["write", "d1", "pwd\r"]]);
  });

  it("logs output and serves it as scrollback, skipping bytes it already has", async () => {
    const d = new FakeDaemon();
    const pty = createSessiondSpawnFn({ client: async () => d, logDir: logDir() })("sh", [], opts);
    const seen: string[] = [];
    pty.onData((c) => seen.push(c));
    await flush();
    d.emit("d1", { t: "screen", totalBytes: 0, payload: Buffer.from("\x1b[H") });
    d.emit("d1", out(0, "hello "));
    d.emit("d1", out(3, "lo world"));
    expect(seen).toEqual(["hello ", "world"]);
    expect(pty.scrollback?.bytesSeen()).toBe(11);
    expect(pty.scrollback?.read(6, 100)).toEqual({ text: "world", offset: 6 });
  });

  it("decodes a character split across two chunks", async () => {
    const d = new FakeDaemon();
    const pty = createSessiondSpawnFn({ client: async () => d, logDir: logDir() })("sh", [], opts);
    const seen: string[] = [];
    pty.onData((c) => seen.push(c));
    await flush();
    const box = Buffer.from("─");
    d.emit("d1", { t: "output", offset: 0, payload: box.subarray(0, 1) });
    d.emit("d1", { t: "output", offset: 1, payload: box.subarray(1) });
    expect(seen.join("")).toBe("─");
  });

  it("exits on the daemon's word, on a lost connection, and on a failed create", async () => {
    const d = new FakeDaemon();
    const spawn = createSessiondSpawnFn({ client: async () => d, logDir: logDir() });
    const exits: string[] = [];
    spawn("sh", [], opts).onExit(() => exits.push("exited"));
    await flush();
    d.emit("d1", { t: "exited", code: 0 });

    // The connection drops and the daemon that answers next no longer has the session.
    const lost = new FakeDaemon();
    const fresh = new FakeDaemon();
    fresh.gone = true;
    let calls = 0;
    createSessiondSpawnFn({ client: async () => (calls++ === 0 ? lost : fresh), logDir: logDir() })("sh", [], opts)
      .onExit(() => exits.push("lost"));
    await flush();
    lost.close();
    await flush();

    const refused = new FakeDaemon();
    refused.createResult = Promise.reject(new Error("no shell"));
    const errors: unknown[] = [];
    createSessiondSpawnFn({ client: async () => refused, logDir: logDir(), onError: (_id, e) => errors.push(e) })("sh", [], opts)
      .onExit(() => exits.push("refused"));
    await flush();
    await flush();
    expect(exits).toEqual(["exited", "lost", "refused"]);
    expect(String(errors[0])).toMatch(/no shell/);
  });

  it("resumes from its log on a new connection when the old one drops", async () => {
    const first = new FakeDaemon();
    const second = new FakeDaemon();
    let calls = 0;
    const pty = createSessiondSpawnFn({ client: async () => (calls++ === 0 ? first : second), logDir: logDir() })("sh", [], opts);
    const seen: string[] = [];
    pty.onData((c) => seen.push(c));
    let exited = false;
    pty.onExit(() => (exited = true));
    await flush();
    first.emit("d1", out(0, "abc"));
    first.close();
    pty.write("typed while away");
    await flush();
    second.emit("d1", out(2, "cde"));
    expect([seen, exited]).toEqual([["abc", "de"], false]);
    expect(second.sent).toEqual([["attach", "d1", 3], ["write", "d1", "typed while away"]]);
  });

  it("kill ends the daemon session and deletes its history", async () => {
    const d = new FakeDaemon();
    const dir = logDir();
    const pty = createSessiondSpawnFn({ client: async () => d, logDir: dir })("sh", [], opts);
    await flush();
    d.emit("d1", out(0, "secret"));
    pty.kill();
    expect(d.sent).toEqual([["kill", "d1"]]);
    // The daemon still delivers what the shell printed while dying: it must not rewrite the log.
    d.emit("d1", out(6, "bye"));
    expect(readdirSync(dir)).toEqual([]);
    expect(pty.outlivesHost).toBe(true);
  });

  it("a session that ends by itself leaves no history behind, nobody can read it", async () => {
    const d = new FakeDaemon();
    const dir = logDir();
    createSessiondSpawnFn({ client: async () => d, logDir: dir })("sh", [], opts);
    await flush();
    d.emit("d1", out(0, "done"));
    d.emit("d1", { t: "exited", code: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a host shutting down neither reconnects nor drops the log", async () => {
    const d = new FakeDaemon();
    const dir = logDir();
    let stopping = false;
    let calls = 0;
    const pty = createSessiondSpawnFn({ client: async () => (calls++, d), logDir: dir, isStopping: () => stopping })("sh", [], opts);
    let exited = false;
    pty.onExit(() => (exited = true));
    await flush();
    d.emit("d1", out(0, "keep"));
    stopping = true;
    d.close();
    await flush();
    expect([calls, exited, new SessionLog(dir, "h1").total()]).toEqual([1, false, 4]);
  });

  it("reads the screen from the daemon, and nothing before the session exists", async () => {
    const d = new FakeDaemon();
    const pty = createSessiondSpawnFn({ client: async () => d, logDir: logDir() })("sh", [], opts);
    expect(await pty.renderScreen?.()).toBeUndefined();
    await flush();
    expect(await pty.renderScreen?.()).toBe("row");
    d.screen = undefined;
    expect(await pty.renderScreen?.()).toBeUndefined();
  });

  it("reattaches from where the host's log ends, so the gap is only what it missed", async () => {
    const d = new FakeDaemon();
    const dir = logDir();
    new SessionLog(dir, "h1").append(0, Buffer.from("before restart "));
    const pty = attachSessiondSession("h1", "d7", { client: async () => d, logDir: dir });
    const seen: string[] = [];
    pty.onData((c) => seen.push(c));
    await flush();
    expect(d.sent).toEqual([["attach", "d7", 15]]);
    d.emit("d7", out(15, "after"));
    expect(seen).toEqual(["after"]);
    expect(pty.scrollback?.read(0, 100).text).toBe("before restart after");
  });
});

describe("adoptableSessions", () => {
  const info = (id: string, tag: string | undefined): SessionInfo => ({
    id, owner: { pane_id: null, canvas_terminal_id: null, window_label: "host" }, cols: 120, rows: 40,
    total_bytes: 0, idle: false, started_ago_ms: 0, pid: 1, cwd: "/w", ...(tag !== undefined ? { tag } : {}),
  });

  it("reads back the host id, shape and identity, and names what it cannot use", () => {
    const skipped: string[] = [];
    const found = adoptableSessions(
      [info("d1", JSON.stringify({ sessionId: "h1", provider: "codex", permissionMode: "yolo" })), info("d2", "not json"), info("d3", undefined)],
      (id) => skipped.push(id),
    );
    expect(found).toEqual([{ daemonId: "d1", sessionId: "h1", opts: { cwd: "/w", cols: 120, rows: 40, provider: "codex", permissionMode: "yolo" } }]);
    expect(skipped).toEqual(["d2", "d3"]);
  });
});
