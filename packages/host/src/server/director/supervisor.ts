import { readFileSync } from "node:fs";
import { atomicWriteSync } from "../../core/atomic-write.js";
import type { DirectorInvokeResult, DirectorRunner } from "./director-runner.js";

/** Persists the Director's session id so it resumes the same conversation across restarts. */
export interface DirectorSessionStore {
  load(): string | null;
  save(id: string): void;
}

export interface DirectorSupervisorDeps {
  runner: DirectorRunner;
  /** Working directory the Director process runs in (the workspace root). */
  cwd: string;
  sessionStore: DirectorSessionStore;
  /** Generates a fresh session id (UUID) for the Director's first turn. */
  newSessionId: () => string;
  /** Optional sink for the Director's reply text (e.g. relay to Telegram). */
  onReply?: (result: DirectorInvokeResult) => void;
}

const WORKER_IDLE_EVENT =
  "A worker cell has gone idle. Check the fleet with lotus_list_fleet, read finished workers' output, and continue the task.";

/**
 * Runs the Headless Director as an event-driven, single-session agent: each
 * event (goal, worker-idle) is a `--resume` turn on one persistent session.
 * Turns are serialized — the Director session is single-threaded, so concurrent
 * events queue rather than interleave `--resume` calls (ADR-0019).
 */
export class DirectorSupervisor {
  private sessionId: string | null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DirectorSupervisorDeps) {
    this.sessionId = deps.sessionStore.load();
  }

  /** Sends a goal to the Director and returns its reply. */
  submitGoal(goal: string): Promise<DirectorInvokeResult> {
    return this.handleEvent(goal);
  }

  /** Re-pokes the Director when a worker goes idle so it can continue monitoring. */
  pokeWorkerIdle(): Promise<DirectorInvokeResult> {
    return this.handleEvent(WORKER_IDLE_EVENT);
  }

  /** Queues an event behind any in-flight turn, then runs it as one Director turn. */
  handleEvent(event: string): Promise<DirectorInvokeResult> {
    const run = this.tail.then(() => this.invokeOnce(event));
    this.tail = run.then(noop, noop);
    return run;
  }

  private async invokeOnce(event: string): Promise<DirectorInvokeResult> {
    const resume = this.sessionId !== null;
    const sessionId = this.sessionId ?? this.deps.newSessionId();
    let result: DirectorInvokeResult;
    try {
      result = await this.deps.runner.invoke({ event, sessionId, cwd: this.deps.cwd, resume });
      if (this.sessionId === null) {
        this.sessionId = result.sessionId || sessionId;
        this.deps.sessionStore.save(this.sessionId);
      }
    } catch (err) {
      // Infra failure (binary missing, spawn error). Surface it as a reply so a
      // fire-and-forget caller never sees an unhandled rejection, and leave the
      // session unsaved so the next turn starts fresh rather than resuming a
      // session that was never created.
      const message = err instanceof Error ? err.message : String(err);
      result = { sessionId: this.sessionId ?? sessionId, text: `Director error: ${message}`, isError: true };
    }
    this.deps.onReply?.(result);
    return result;
  }
}

/** File-backed {@link DirectorSessionStore} (atomic writes). */
export class FileDirectorSessionStore implements DirectorSessionStore {
  constructor(private readonly filePath: string) {}

  load(): string | null {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as { sessionId?: string };
      return parsed.sessionId ?? null;
    } catch {
      return null;
    }
  }

  save(id: string): void {
    atomicWriteSync(this.filePath, { sessionId: id });
  }
}

function noop(): void {}
