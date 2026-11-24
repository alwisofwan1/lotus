import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectOrSpawnSessiond,
  prepareSocketDir,
  resolveSessiondBinary,
  SessiondClient,
  sessiondSocketPath,
  SessiondVersionError,
  type SessionEvent,
} from "../sessiond-client.js";
import { encodeFrame, FrameDecoder, type Frame } from "../sessiond-frame.js";

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  dirs.push(dir);
  return dir;
}

/// A daemon stand-in: answers hello with `proto`, records every frame, replies via `onFrame`.
async function fakeDaemon(onFrame: (f: Frame, reply: (h: object, p?: Buffer) => void, sock: Socket) => void, proto = 1, features?: string[]) {
  const path = join(tempDir(), "s.sock");
  const frames: Frame[] = [];
  const server = createServer((sock) => {
    const decoder = new FrameDecoder();
    const reply = (h: object, p?: Buffer) => sock.write((h as { t: string }).t === "_raw" ? p! : encodeFrame(h, p));
    sock.on("data", (chunk) => {
      for (const f of decoder.push(chunk)) {
        frames.push(f);
        if (f.header.t === "hello") reply({ t: "hello", proto, daemon_pid: 4242, ...(features ? { features } : {}) });
        else onFrame(f, reply, sock);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(path, r));
  return { path, frames };
}

describe("SessiondClient", () => {
  it("says hello and learns the daemon's pid", async () => {
    const d = await fakeDaemon(() => undefined);
    const c = await SessiondClient.connect(d.path);
    expect(c.daemonPid).toBe(4242);
    expect(d.frames[0]?.header).toEqual({ t: "hello", proto: 1 });
    c.close();
  });

  it("refuses a daemon that speaks another protocol", async () => {
    const d = await fakeDaemon(() => undefined, 2);
    await expect(SessiondClient.connect(d.path)).rejects.toBeInstanceOf(SessiondVersionError);
  });

  it("matches replies to requests and routes output to the session's listener", async () => {
    const d = await fakeDaemon((f, reply) => {
      const req = f.header["req"];
      if (f.header.t === "create") {
        // The real order: `created`, then the creator's output at once, in the same chunk.
        const sock = [encodeFrame({ t: "created", req, id: "s1", pid: 7 }), encodeFrame({ t: "output", id: "s1", offset: 0 }, Buffer.from("hi"))];
        reply({ t: "_raw" }, Buffer.concat(sock));
      }
      if (f.header.t === "list") reply({ t: "sessions", req, sessions: [{ id: "s1", cwd: "/w", tag: "{}" }] });
    });
    const c = await SessiondClient.connect(d.path);
    const events: SessionEvent[] = [];
    const spec = { argv: ["sh"], env: [], cwd: "/w", cols: 80, rows: 24, owner: { pane_id: null, canvas_terminal_id: null, window_label: "host" }, tag: "{}" };
    expect(await c.create(spec, (e) => events.push(e))).toEqual({ id: "s1", pid: 7 });
    expect(events).toEqual([{ t: "output", offset: 0, payload: Buffer.from("hi") }]);
    expect((await c.list()).map((s) => [s.id, s.cwd, s.tag])).toEqual([["s1", "/w", "{}"]]);
    expect(d.frames[1]?.header["spec"]).toEqual(spec);
    c.close();
  });

  it("reads a snapshot only from a daemon that offers one", async () => {
    const d = await fakeDaemon((f, reply) => reply({ t: "snapshot", req: f.header["req"], id: "s1", cols: 90, rows: 30 }, Buffer.from("$ ls")), 1, ["snapshot"]);
    const c = await SessiondClient.connect(d.path);
    expect(await c.snapshot("s1")).toEqual({ text: "$ ls", cols: 90, rows: 30 });
    c.close();

    // An older daemon drops a client on a request it cannot parse, so none is sent.
    const old = await fakeDaemon(() => undefined);
    const o = await SessiondClient.connect(old.path);
    expect(await o.snapshot("s1")).toBeUndefined();
    expect(old.frames.map((f) => f.header.t)).toEqual(["hello"]);
    o.close();
  });

  it("rejects a request the daemon answers with an error", async () => {
    const d = await fakeDaemon((f, reply) => reply({ t: "error", req: f.header["req"], id: null, message: "no shell" }));
    const c = await SessiondClient.connect(d.path);
    await expect(c.create({ argv: [], env: [], cwd: null, cols: 1, rows: 1, owner: { pane_id: null, canvas_terminal_id: null, window_label: "h" } })).rejects.toThrow("no shell");
    c.close();
  });

  it("sends input as the payload and control messages as headers", async () => {
    const d = await fakeDaemon(() => undefined);
    const c = await SessiondClient.connect(d.path);
    c.write("s1", "ls\r");
    c.resize("s1", 100, 30);
    c.attach("s1", 12);
    c.detach("s1");
    c.kill("s1");
    await new Promise((r) => setTimeout(r, 50));
    expect(d.frames.slice(1).map((f) => [f.header, f.payload.toString()])).toEqual([
      [{ t: "write", id: "s1" }, "ls\r"],
      [{ t: "resize", id: "s1", cols: 100, rows: 30 }, ""],
      [{ t: "attach", id: "s1", from: 12 }, ""],
      [{ t: "detach", id: "s1" }, ""],
      [{ t: "kill", id: "s1" }, ""],
    ]);
    c.close();
  });

  it("fails pending requests and tells listeners when the daemon goes away", async () => {
    const d = await fakeDaemon((_f, _reply, sock) => sock.destroy());
    const c = await SessiondClient.connect(d.path);
    const closed = new Promise<Error>((r) => c.onClose(r));
    await expect(c.list()).rejects.toThrow(/closed/);
    expect((await closed).message).toMatch(/closed/);
    expect(() => c.kill("s1")).toThrow(/closed/);
  });
});

describe("socket and binary", () => {
  it("falls back to /tmp when the socket path is too long to bind", () => {
    expect(sessiondSocketPath("/home/a/.lotus/host-sessiond", 1001)).toBe("/home/a/.lotus/host-sessiond/sessiond.sock");
    expect(sessiondSocketPath(`/${"x".repeat(100)}`, 1001)).toBe("/tmp/lotus-host-1001/sessiond.sock");
  });

  it("tightens a loose socket dir to 0700", () => {
    const dir = join(tempDir(), "run");
    mkdirSync(dir, { mode: 0o755 });
    prepareSocketDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("extracts the embedded daemon once, executable, named by its content", async () => {
    const dir = tempDir();
    const file = Object.assign(new Blob([Buffer.from("ELF")]), { name: "lotus-sessiond-linux-x64-ab12." });
    const path = await resolveSessiondBinary(dir, undefined, [file]);
    expect(path).toMatch(/bin\/lotus-sessiond-[0-9a-f]{12}$/);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toBe("ELF");
    expect(await resolveSessiondBinary(dir, undefined, [file])).toBe(path);
    expect(await resolveSessiondBinary(dir, " /opt/sd ", [file])).toBe("/opt/sd");
    await expect(resolveSessiondBinary(dir, undefined, [])).rejects.toThrow(/embeds no lotus-sessiond/);
  });

  it("gives up after the wait when the binary never listens", async () => {
    const socket = join(tempDir(), "run", "sessiond.sock");
    await expect(connectOrSpawnSessiond(socket, async () => "/usr/bin/true", 200)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// The real daemon, when one is built: `cargo build -p lotus-sessiond` then
// LOTUS_SESSIOND_BIN=<target>/debug/lotus-sessiond bun run test.
const realBin = process.env["LOTUS_SESSIOND_BIN"];
describe.skipIf(!realBin)("against lotus-sessiond", () => {
  it("spawns it, runs a session, and a second connection reads the history", async () => {
    const socket = join(tempDir(), "run", "sessiond.sock");
    const c = await connectOrSpawnSessiond(socket, async () => realBin!);
    const spec = { argv: ["/bin/sh", "-c", "echo ready; sleep 30"], env: [["PATH", "/usr/bin:/bin"]] as [string, string][], cwd: "/tmp", cols: 80, rows: 24, owner: { pane_id: null, canvas_terminal_id: null, window_label: "host" }, tag: '{"provider":"claude"}' };
    const { id } = await c.create(spec);
    c.close();

    const again = await connectOrSpawnSessiond(socket, async () => "/nonexistent");
    const listed = (await again.list()).find((s) => s.id === id);
    expect([listed?.cwd, listed?.tag]).toEqual(["/tmp", spec.tag]);
    const got: SessionEvent[] = [];
    again.on(id, (e) => got.push(e));
    again.attach(id, 0);
    for (let i = 0; i < 100 && !got.some((e) => e.t === "output" && e.payload.toString().includes("ready")); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(got[0]?.t).toBe("screen");
    expect(got.some((e) => e.t === "output" && e.offset === 0 && e.payload.toString().includes("ready"))).toBe(true);
    again.kill(id);
    for (let i = 0; i < 150 && got.at(-1)?.t !== "exited"; i++) await new Promise((r) => setTimeout(r, 20));
    expect(got.at(-1)).toMatchObject({ t: "exited" });
    again.close();
  });
});
