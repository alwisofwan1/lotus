import { randomUUID } from "node:crypto";
import { PtySession, type PtyBackend, type PtySpawnFn } from "./session.js";
import { SessionNotAdoptableError, SessionNotFoundError } from "./errors.js";
import type { PtySessionMetadata, PtySessionState } from "./types.js";
import type { CreateSessionRequest } from "../../types/index.js";

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export class PtyManager {
  private readonly sessions = new Map<string, PtySession>();

  /**
   * spawnFn is injected — callers load node-pty before constructing PtyManager.
   * attachFn is present only on hosts whose sessions outlive them (lotus-sessiond); without it
   * `adopt` has nothing to adopt.
   */
  constructor(
    private readonly spawnFn: PtySpawnFn,
    private readonly attachFn?: (sessionId: string) => PtyBackend,
  ) {}

  /** Reuse the normal session constructor with the attached backend so resumed sessions share the same lifecycle. */
  adopt(id: string, opts: { cwd: string; cols: number; rows: number } & PtySessionMetadata): PtySessionState {
    if (this.attachFn === undefined) throw new SessionNotAdoptableError(id);
    const { cwd, cols, rows, ...metadata } = opts;
    const backend = this.attachFn(id);
    const session = new PtySession(id, cwd, cols, rows, [], () => backend, metadata);
    this.sessions.set(id, session);
    session.onExit(() => this.sessions.delete(id));
    return session.state;
  }

  create(req: CreateSessionRequest = {}): PtySessionState {
    const id = randomUUID();
    const cwd = req.cwd ?? process.cwd();
    const cols = req.cols ?? DEFAULT_COLS;
    const rows = req.rows ?? DEFAULT_ROWS;
    const command = req.command ?? [process.env["SHELL"] ?? "/bin/sh"];
    const metadata = {
      ...(req.provider !== undefined ? { provider: req.provider } : {}),
      ...(req.runnerLabel !== undefined ? { runnerLabel: req.runnerLabel } : {}),
      ...(req.workspaceId !== undefined ? { workspaceId: req.workspaceId } : {}),
      ...(req.title !== undefined ? { title: req.title } : {}),
      ...(req.permissionMode !== undefined ? { permissionMode: req.permissionMode } : {}),
    };

    const session = new PtySession(id, cwd, cols, rows, command, this.spawnFn, metadata);
    this.sessions.set(id, session);
    session.onExit(() => this.sessions.delete(id));

    return session.state;
  }

  list(): PtySessionState[] {
    return [...this.sessions.values()].map((s) => s.state);
  }

  getSession(id: string): PtySession {
    const session = this.sessions.get(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  }

  write(id: string, data: string): void {
    this.getSession(id).write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.getSession(id).resize(cols, rows);
  }

  kill(id: string): void {
    const session = this.getSession(id);
    this.sessions.delete(id);
    session.kill();
  }

  /**
   * Host shutdown. Sessions that outlive the host are released, not killed — that is the
   * difference between restarting Lotus and throwing away an agent's afternoon.
   */
  stop(): void {
    for (const session of this.sessions.values()) {
      if (session.outlivesHost) continue;
      try {
        session.kill();
      } catch {
        // best-effort: session may have already exited
      }
    }
    this.sessions.clear();
  }
}
