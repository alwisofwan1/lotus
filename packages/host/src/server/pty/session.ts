import type { PtySessionMetadata, PtySessionState } from "./types.js";
import { agentSpawnEnv } from "../../core/agent-env.js";

/// Bytes of output retained per session.
///
/// 256KB, matching the desktop's ring (`pty/output_tail.rs`) so a phone sees the same
/// history whichever host it is attached to. The number is measured rather than chosen:
/// a watching client polls every `POLL_MS`, so anything faster than `ring ÷ poll` is gone
/// before it can be read, and a rate ladder put the old 64KB cliff at 176KB/s with a
/// quarter of all output never arriving (`plans/session-history-hardening/issues/01`).
const BUFFER_SIZE = 256 * 1024;

/// Narrower than node-pty's `IPty` so a second implementation is expressible — `sessiond-backend.ts`
/// drives lotus-sessiond instead, which is what lets the host ship with no native module (ADR-F,
/// ADR-0067). `IPty` still satisfies this structurally; no adapter needed.
export interface PtyBackend {
  onData(listener: (chunk: string) => void): unknown;
  onExit(listener: () => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  /// Present only on backends whose history outlives this process. Without it the ring below
  /// is the only history there is.
  scrollback?: PtyScrollback;
  /// True when the SESSION survives this process, not just its history — sessiond, not node-pty.
  /// Host shutdown must leave these alone; see `PtyManager.stop`.
  outlivesHost?: boolean;
  /// The pane as the terminal has already drawn it. Present only on a backend that HAS a
  /// terminal behind it; the raw stream cannot be turned back into a screen (`issues/17`).
  renderScreen?(): Promise<string | undefined>;
}

/// History that survives the host, so a restarted host can answer for a session it never saw
/// start. Offsets are **bytes**, matching the wire.
export interface PtyScrollback {
  bytesSeen(): number;
  read(fromByte: number, maxBytes: number): { text: string; offset: number };
}

/// node-pty's `IPtyForkOptions` plus `sessionId`, which node-pty ignores and the sessiond backend
/// needs: it is the only stable handle by which a restarted host can find a session again.
export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: { [key: string]: string | undefined };
  sessionId: string;
  /**
   * What this cell IS, for a backend that can outlive the host and must be able to say so
   * afterwards. node-pty ignores it; the sessiond backend puts it in the spawn `tag`, which the
   * daemon keeps exactly as long as the session lives (`issues/16`).
   */
  metadata?: PtySessionMetadata;
}

export type PtySpawnFn = (file: string, args: string[], options: PtySpawnOptions) => PtyBackend;

export class PtySession {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
  private _cols: number;
  private _rows: number;
  private _status: "running" | "exited" = "running";
  private _lastOutputAt: number | undefined;
  /// Retained output, as **bytes**.
  ///
  /// Was a string trimmed by `.length`, which counts UTF-16 units while every offset on
  /// the wire counts UTF-8 bytes — a box-drawing character is one unit and three bytes, so
  /// the two drifted apart on exactly the TUI output this carries. Bytes are the unit the
  /// contract speaks, so this speaks it too.
  private _buffer: Buffer = Buffer.alloc(0);

  /// Every byte this session has ever produced, so a client can ask for an absolute
  /// offset and be told honestly where the answer actually starts.
  private _bytesSeen = 0;
  private readonly exitHandlers: Array<() => void> = [];
  private readonly dataHandlers = new Map<symbol, (chunk: string) => void>();
  private readonly pty: PtyBackend;

  constructor(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    command: string[],
    spawnFn: PtySpawnFn,
    private readonly metadata: PtySessionMetadata = {},
  ) {
    this.id = id;
    this.cwd = cwd;
    this._cols = cols;
    this._rows = rows;
    this.createdAt = Date.now();

    const file = command[0] ?? "/bin/sh";
    const args = command.slice(1);

    this.pty = spawnFn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      // The agent is told which pane it is, because a hook it fires later has no other way to
      // say. Every permission drop file is correlated by this and nothing else (`issues/01`,
      // slice 1b.1) — the structured path has always set it; this one did not.
      // OSC 8 keeps a link Claude Code hard-wraps over two rows clickable as one whole URL.
      env: agentSpawnEnv(process.env, {
        LOTUS_PANE_ID: id,
        FORCE_HYPERLINK: process.env["FORCE_HYPERLINK"] ?? "1",
      }),
      sessionId: id,
      metadata,
    });

    this.pty.onData((chunk) => {
      this._lastOutputAt = Date.now();
      const bytes = Buffer.from(chunk, "utf8");
      this._bytesSeen += bytes.length;
      this._buffer = Buffer.concat([this._buffer, bytes]);
      if (this._buffer.length > BUFFER_SIZE) {
        this._buffer = this._buffer.subarray(this._buffer.length - BUFFER_SIZE);
      }
      for (const handler of this.dataHandlers.values()) handler(chunk);
    });

    this.pty.onExit(() => {
      this._status = "exited";
      for (const h of this.exitHandlers) h();
    });
  }

  get state(): PtySessionState {
    return {
      id: this.id,
      cwd: this.cwd,
      cols: this._cols,
      rows: this._rows,
      createdAt: this.createdAt,
      status: this._status,
      ...(this.metadata.provider !== undefined ? { provider: this.metadata.provider } : {}),
      ...(this.metadata.runnerLabel !== undefined ? { runnerLabel: this.metadata.runnerLabel } : {}),
      ...(this.metadata.workspaceId !== undefined ? { workspaceId: this.metadata.workspaceId } : {}),
      ...(this.metadata.title !== undefined ? { title: this.metadata.title } : {}),
      ...(this.metadata.permissionMode !== undefined ? { permissionMode: this.metadata.permissionMode } : {}),
      ...(this._lastOutputAt !== undefined ? { lastOutputAt: this._lastOutputAt } : {}),
    };
  }

  write(data: string): void {
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    this._cols = cols;
    this._rows = rows;
    this.pty.resize(cols, rows);
  }

  kill(): void {
    this.pty.kill();
  }

  /** Whether shutting this host down would leave the session running. */
  get outlivesHost(): boolean {
    return this.pty.outlivesHost === true;
  }

  /// The pane as it looks on screen, when a backend can say. `undefined` is not "empty": it
  /// means nobody rendered this stream, and a caller that needs layout must not fall back to the
  /// raw bytes and pretend (`issues/17`).
  async renderScreen(): Promise<string | undefined> {
    return this.pty.renderScreen?.();
  }

  getBufferTail(maxBytes = BUFFER_SIZE): string {
    const durable = this.pty.scrollback;
    if (durable === undefined) return this._buffer.subarray(-maxBytes).toString("utf8");
    const total = durable.bytesSeen();
    return durable.read(Math.max(total - maxBytes, 0), maxBytes).text;
  }

  /** Total bytes produced, whether still retained or not. */
  get bytesSeen(): number {
    // A reattached session has seen nothing itself; the durable source is the only one that
    // knows how long the session has really been talking.
    return this.pty.scrollback?.bytesSeen() ?? this._bytesSeen;
  }

  /**
   * Output from an absolute byte offset — the only form that can resume.
   *
   * Mirrors the desktop's `pty::read_scrollback`: when the ring has moved past what was
   * asked for, the returned `offset` is ahead of the request, which is how a gap becomes
   * visible instead of a later position being served as if it were continuous.
   */
  readScrollback(fromByte: number, maxBytes = BUFFER_SIZE): { text: string; offset: number } {
    const durable = this.pty.scrollback;
    // Nothing scrolls away in a durable source, so `offset` always equals the request and
    // `cell.truncated` stops being an everyday event — it stays for log rotation.
    if (durable !== undefined) return durable.read(fromByte, maxBytes);
    const availableStart = this._bytesSeen - this._buffer.length;
    const start = Math.max(fromByte, availableStart);
    const relative = start - availableStart;
    if (relative >= this._buffer.length) return { text: "", offset: start };
    const end = Math.min(relative + maxBytes, this._buffer.length);
    return { text: this._buffer.subarray(relative, end).toString("utf8"), offset: start };
  }

  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
  }

  /** Subscribe to raw output chunks. Returns an unsubscribe function. */
  subscribeData(handler: (chunk: string) => void): () => void {
    const key = Symbol();
    this.dataHandlers.set(key, handler);
    return () => this.dataHandlers.delete(key);
  }
}
