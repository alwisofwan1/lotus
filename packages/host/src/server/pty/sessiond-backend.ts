import { StringDecoder } from "node:string_decoder";
import type { PtyBackend, PtyScrollback, PtySpawnFn, PtySpawnOptions } from "./session.js";
import type { SessiondClient, SessionEvent } from "./sessiond-client.js";
import type { SessionInfo, SpawnSpec } from "./sessiond-frame.js";
import { SessionLog } from "./session-log.js";
import type { PtySessionMetadata } from "./types.js";

/** The part of `SessiondClient` a session needs; narrow so tests can play the daemon. */
export type SessiondPort = Pick<SessiondClient, "create" | "on" | "onClose" | "attach" | "write" | "resize" | "kill" | "snapshot">;

export interface SessiondBackendDeps {
  /** The live connection, reconnecting (or spawning the daemon) when the last one closed. */
  client: () => Promise<SessiondPort>;
  /** Where each session's history is written, as `<sessionId>.log`. */
  logDir: string;
  maxLogBytes?: number;
  onError?: (sessionId: string, error: unknown) => void;
  /** True once the host is shutting down: a closing connection is then not a reason to reconnect. */
  isStopping?: () => boolean;
}

const METADATA_KEYS = ["provider", "runnerLabel", "workspaceId", "title", "permissionMode"] as const;

type Ready = { client: SessiondPort; id: string };
type Start = { create: SpawnSpec } | { attach: string };

/// A session that lives in `lotus-sessiond`, so it outlives this host (ADR-0067). The daemon names
/// sessions itself; the host's id travels in the spawn `tag` and comes back from `list`.
class SessiondPty implements PtyBackend {
  readonly outlivesHost = true;
  readonly scrollback: PtyScrollback;
  private readonly log: SessionLog;
  private readonly decoder = new StringDecoder("utf8");
  private readonly dataListeners: Array<(chunk: string) => void> = [];
  private readonly exitListeners: Array<() => void> = [];
  private readonly queued: Array<(r: Ready) => void> = [];
  private ready: Ready | undefined;
  private exited = false;
  /// Set once the log is deleted, so output still in flight cannot write it back.
  private logGone = false;

  constructor(
    private readonly sessionId: string,
    private readonly deps: SessiondBackendDeps,
    start: Start,
  ) {
    this.log = new SessionLog(deps.logDir, sessionId, deps.maxLogBytes);
    this.scrollback = { bytesSeen: () => this.log.total(), read: (from, max) => this.log.read(from, max) };
    void this.connect(start);
  }

  /// A dropped connection is not a dead session: the daemon also drops a client that falls
  /// behind. So reconnect and resume from the log; a daemon that no longer has it says `error`.
  private async connect(start: Start): Promise<void> {
    try {
      const client = await this.deps.client();
      let id: string | undefined;
      client.onClose(() => {
        this.ready = undefined;
        if (this.exited || this.deps.isStopping?.()) return;
        if (id === undefined) this.finish();
        else void this.connect({ attach: id });
      });
      const listener = (e: SessionEvent) => this.onEvent(e);
      if ("create" in start) {
        id = (await client.create(start.create, listener)).id;
      } else {
        id = start.attach;
        client.on(id, listener);
        client.attach(id, this.log.total());
      }
      this.ready = { client, id };
      for (const op of this.queued.splice(0)) op(this.ready);
    } catch (error) {
      this.deps.onError?.(this.sessionId, error);
      this.finish();
    }
  }

  private onEvent(e: SessionEvent): void {
    if (e.t === "output") {
      if (this.logGone) return;
      const fresh = this.log.append(e.offset, e.payload);
      const text = this.decoder.write(fresh);
      if (text.length > 0) for (const listener of this.dataListeners) listener(text);
    } else if (e.t === "exited" || e.t === "error") {
      // `error` about a session is "the daemon has no such session": as gone as an exit.
      this.finish();
    }
    // `screen` is for a terminal that draws; this host has none and keeps the raw stream.
  }

  private finish(): void {
    if (this.exited) return;
    this.exited = true;
    // The manager drops an exited session, so no route can reach these bytes any more.
    this.dropLog();
    for (const listener of this.exitListeners) listener();
  }

  private when(op: (r: Ready) => void): void {
    if (this.exited) return;
    if (this.ready !== undefined) op(this.ready);
    else this.queued.push(op);
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: () => void): void {
    this.exitListeners.push(listener);
  }

  write(data: string): void {
    this.when(({ client, id }) => client.write(id, data));
  }

  resize(cols: number, rows: number): void {
    this.when(({ client, id }) => client.resize(id, cols, rows));
  }

  kill(): void {
    this.when(({ client, id }) => client.kill(id));
    // Not done on host stop, which leaves the session for the next host to adopt.
    this.dropLog();
  }

  private dropLog(): void {
    this.logGone = true;
    this.log.remove();
  }

  async renderScreen(): Promise<string | undefined> {
    if (this.ready === undefined || this.exited) return undefined;
    return (await this.ready.client.snapshot(this.ready.id))?.text;
  }
}

function spawnSpec(file: string, args: string[], o: PtySpawnOptions): SpawnSpec {
  const env = Object.entries(o.env).filter((e): e is [string, string] => e[1] !== undefined);
  // node-pty sets TERM from `name`; a host under systemd has none of its own to pass on.
  if (!env.some(([k]) => k === "TERM")) env.push(["TERM", o.name]);
  return {
    argv: [file, ...args],
    env,
    cwd: o.cwd,
    cols: o.cols,
    rows: o.rows,
    owner: { pane_id: o.sessionId, canvas_terminal_id: null, window_label: "host" },
    tag: JSON.stringify({ sessionId: o.sessionId, ...o.metadata }),
  };
}

export function createSessiondSpawnFn(deps: SessiondBackendDeps): PtySpawnFn {
  return (file, args, options) =>
    new SessiondPty(options.sessionId, deps, { create: spawnSpec(file, args, options) });
}

/// Takes over a session a previous host started, from where this host's log of it ends.
export function attachSessiondSession(sessionId: string, daemonId: string, deps: SessiondBackendDeps): PtyBackend {
  return new SessiondPty(sessionId, deps, { attach: daemonId });
}

export interface AdoptableSession {
  daemonId: string;
  sessionId: string;
  opts: { cwd: string; cols: number; rows: number } & PtySessionMetadata;
}

/// The daemon's sessions this host started, read back from their tags. A session without a
/// readable tag was not started by a host and is left alone.
export function adoptableSessions(sessions: SessionInfo[], onSkipped: (daemonId: string) => void): AdoptableSession[] {
  const found: AdoptableSession[] = [];
  for (const s of sessions) {
    let tag: unknown;
    try {
      tag = JSON.parse(s.tag ?? "");
    } catch {
      tag = undefined;
    }
    const fields = typeof tag === "object" && tag !== null ? (tag as Record<string, unknown>) : {};
    const sessionId = fields["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      onSkipped(s.id);
      continue;
    }
    const metadata: Record<string, string> = {};
    for (const key of METADATA_KEYS) {
      const value = fields[key];
      if (typeof value === "string") metadata[key] = value;
    }
    found.push({ daemonId: s.id, sessionId, opts: { cwd: s.cwd ?? "/", cols: s.cols, rows: s.rows, ...(metadata as PtySessionMetadata) } });
  }
  return found;
}
