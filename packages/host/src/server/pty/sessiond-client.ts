import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { encodeFrame, FrameDecoder, PROTO_VERSION, type Header, type SessionInfo, type SpawnSpec } from "./sessiond-frame.js";

/// sockaddr_un.sun_path is 104 bytes on macOS, NUL included.
const MAX_SOCKET_PATH = 103;
const SPAWN_WAIT_MS = 5_000;

/** What the daemon says about one session. `payload` is the screen or the output bytes. */
export type SessionEvent =
  | { t: "screen"; totalBytes: number; payload: Buffer }
  | { t: "output"; offset: number; payload: Buffer }
  | { t: "exited"; code: number }
  | { t: "error"; message: string };

export class SessiondVersionError extends Error {
  constructor(readonly daemon: unknown) {
    super(`lotus-sessiond speaks protocol ${String(daemon)}, this host speaks ${PROTO_VERSION}`);
  }
}

/// `<dir>/sessiond.sock`, or under `/tmp/lotus-host-<uid>/` when that path is too long to bind.
export function sessiondSocketPath(dir: string, uid: number): string {
  const preferred = join(dir, "sessiond.sock");
  return Buffer.byteLength(preferred) <= MAX_SOCKET_PATH ? preferred : join(`/tmp/lotus-host-${uid}`, "sessiond.sock");
}

/// Node cannot ask a socket who serves it, so a 0700 directory of our own is the trust boundary.
export function prepareSocketDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const uid = process.getuid?.();
  const owner = statSync(dir).uid;
  if (uid !== undefined && owner !== uid) {
    throw Object.assign(new Error(`${dir} is owned by uid ${owner}`), { code: "EACCES" });
  }
  chmodSync(dir, 0o700);
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toEvent(h: Header, payload: Buffer): SessionEvent | undefined {
  if (h.t === "screen") return { t: "screen", totalBytes: num(h["total_bytes"]), payload };
  if (h.t === "output") return { t: "output", offset: num(h["offset"]), payload };
  if (h.t === "exited") return { t: "exited", code: num(h["code"]) };
  if (h.t === "error") return { t: "error", message: str(h["message"]) };
  return undefined;
}

interface Pending {
  resolve(header: Header, payload: Buffer): void;
  reject(error: Error): void;
}

export class SessiondClient {
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private nextReq = 1;
  private closed = false;
  daemonPid = 0;
  /** Requests added after v1 that this daemon understands (`proto.rs` FEATURES). */
  features: readonly string[] = [];

  private constructor(private readonly socket: Socket) {}

  /** Connects and says hello; rejects with `SessiondVersionError` on another protocol. */
  static connect(socketPath: string): Promise<SessiondClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const client = new SessiondClient(socket);
      let greeted = false;
      socket.on("error", (error) => {
        if (!greeted) reject(error);
      });
      socket.on("connect", () => socket.write(encodeFrame({ t: "hello", proto: PROTO_VERSION })));
      socket.on("data", (chunk: Buffer) => {
        let frames;
        try {
          frames = client.decoder.push(chunk);
        } catch (error) {
          socket.destroy(error as Error);
          return;
        }
        for (const { header, payload } of frames) {
          if (greeted) {
            client.dispatch(header, payload);
            continue;
          }
          greeted = true;
          if (header.t !== "hello" || header["proto"] !== PROTO_VERSION) {
            socket.destroy();
            reject(new SessiondVersionError(header["proto"]));
            return;
          }
          client.daemonPid = num(header["daemon_pid"]);
          const features = header["features"];
          client.features = Array.isArray(features) ? features.filter((f): f is string => typeof f === "string") : [];
          resolve(client);
        }
      });
      socket.on("close", () => {
        if (!greeted) reject(new Error("lotus-sessiond closed the connection before hello"));
        client.shutdown(new Error("lotus-sessiond connection closed"));
      });
    });
  }

  private dispatch(header: Header, payload: Buffer): void {
    const req = header["req"];
    const waiting = typeof req === "number" ? this.pending.get(req) : undefined;
    if (waiting !== undefined) {
      this.pending.delete(req as number);
      if (header.t === "error") waiting.reject(new Error(str(header["message"])));
      else waiting.resolve(header, payload);
      return;
    }
    const id = header["id"];
    const event = toEvent(header, payload);
    if (typeof id !== "string" || event === undefined) return;
    for (const listener of this.listeners.get(id) ?? []) listener(event);
  }

  private shutdown(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
  }

  private send(header: object, payload?: Uint8Array): void {
    if (this.closed) throw new Error("lotus-sessiond connection closed");
    this.socket.write(encodeFrame(header, payload));
  }

  private request(header: object, onReply?: (reply: Header) => void): Promise<{ header: Header; payload: Buffer }> {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      const done = (h: Header, payload: Buffer) => {
        onReply?.(h);
        resolve({ header: h, payload });
      };
      this.pending.set(req, { resolve: done, reject });
      try {
        this.send({ ...header, req });
      } catch (error) {
        this.pending.delete(req);
        reject(error as Error);
      }
    });
  }

  /// `listener` is subscribed while `created` is dispatched: the creator's output follows it in
  /// the same read, before an `await` could resume to call `on`.
  async create(spec: SpawnSpec, listener?: (event: SessionEvent) => void): Promise<{ id: string; pid: number | null }> {
    const { header } = await this.request({ t: "create", spec }, (h) => {
      if (listener !== undefined) this.on(str(h["id"]), listener);
    });
    return { id: str(header["id"]), pid: typeof header["pid"] === "number" ? header["pid"] : null };
  }

  async list(): Promise<SessionInfo[]> {
    const { header } = await this.request({ t: "list" });
    return Array.isArray(header["sessions"]) ? (header["sessions"] as SessionInfo[]) : [];
  }

  /** The screen as plain rows, or `undefined` from a daemon too old to draw one. */
  async snapshot(id: string): Promise<{ text: string; cols: number; rows: number } | undefined> {
    if (!this.features.includes("snapshot")) return undefined;
    const { header, payload } = await this.request({ t: "snapshot", id });
    return { text: payload.toString("utf8"), cols: num(header["cols"]), rows: num(header["rows"]) };
  }

  /** A screen at `totalBytes`, then output from `from`; an `offset` past `from` is a gap. */
  attach(id: string, from: number): void {
    this.send({ t: "attach", id, from });
  }

  detach(id: string): void {
    this.send({ t: "detach", id });
  }

  write(id: string, data: string | Uint8Array): void {
    this.send({ t: "write", id }, typeof data === "string" ? Buffer.from(data, "utf8") : data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.send({ t: "resize", id, cols, rows });
  }

  kill(id: string): void {
    this.send({ t: "kill", id });
  }

  on(id: string, listener: (event: SessionEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (set === undefined) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    this.socket.end();
    this.shutdown(new Error("lotus-sessiond connection closed by this host"));
  }
}

type EmbeddedFile = Blob & { name?: string };

/// `override` (LOTUS_SESSIOND_BIN) or the copy `build:vps` embedded, extracted under a content hash
/// so an older daemon's file stays while it still holds sessions.
/// shortcut: old `lotus-sessiond-<hash>` files are never removed; prune once upgrades are routine.
export async function resolveSessiondBinary(
  dir: string,
  override: string | undefined,
  embedded: readonly EmbeddedFile[] = (globalThis as { Bun?: { embeddedFiles?: EmbeddedFile[] } }).Bun?.embeddedFiles ?? [],
): Promise<string> {
  if (override?.trim()) return override.trim();
  const file = embedded.find((f) => f.name?.startsWith("lotus-sessiond-"));
  if (file === undefined) throw new Error("this build embeds no lotus-sessiond and LOTUS_SESSIOND_BIN is unset");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const path = join(binDir, `lotus-sessiond-${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`);
  if (!existsSync(path)) {
    // Aside then renamed: a crash mid-write must not leave a truncated daemon to exec.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes, { mode: 0o700 });
    chmodSync(tmp, 0o700);
    renameSync(tmp, path);
  }
  return path;
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

/// Two hosts racing both spawn; the daemon's lock lets one serve and the other exit quietly.
export async function connectOrSpawnSessiond(
  socketPath: string,
  binary: () => Promise<string>,
  waitMs = SPAWN_WAIT_MS,
): Promise<SessiondClient> {
  try {
    return await SessiondClient.connect(socketPath);
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
  const dir = dirname(socketPath);
  prepareSocketDir(dir);
  const bin = await binary();
  const log = openSync(join(dir, "sessiond.log"), "a", 0o600);
  try {
    // The daemon calls setsid itself; detached + unref only stop us from waiting on it.
    const child = spawn(bin, ["--socket", socketPath], { detached: true, stdio: ["ignore", "ignore", log] });
    child.on("error", () => undefined); // a bad binary surfaces as the connect deadline below
    child.unref();
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await SessiondClient.connect(socketPath);
    } catch (error) {
      if (!isAbsent(error) || Date.now() >= deadline) throw error;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
