import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/** The four counters Fase 0 needs — see plans/session-history-hardening/issues/01. */
export type SessionHistoryMetric =
  | "cell.truncated"
  | "bytes.served"
  | "poll.tick"
  | "read.failed";

export interface SessionHistoryLabels {
  paneId: string;
  rate?: "fast" | "slow";
}

export interface SessionHistoryRecord {
  at: number;
  layer: "host";
  metric: SessionHistoryMetric;
  value: number;
  labels: SessionHistoryLabels;
}

export interface SessionHistoryDiagnosticsOptions {
  /** `<state dir>/diagnostics/session-history.jsonl` in production; a temp path in tests. */
  path: string;
  /** How often the buffer hits disk. Must stay coarser than the 70ms typing poll. */
  flushMs?: number;
  now?: () => number;
  appendFile?: (path: string, data: string) => Promise<void>;
  mkdir?: (path: string) => Promise<void>;
  /** Told about a flush failure so it can be logged; never rethrown. */
  onFlushError?: (error: unknown) => void;
}

const DEFAULT_FLUSH_MS = 5_000;

/**
 * Buffers Fase 0 counters in memory and flushes them to one JSONL file.
 *
 * `record` is called from `output-tail.ts`'s poll loop, which ticks every 70ms while a
 * pane is being typed into — one `fs` write per event would turn measurement into the
 * write storm PLAN.md explicitly forbids, so writes only happen on the flush timer.
 */
export class SessionHistoryDiagnostics {
  private buffer: SessionHistoryRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly appendFile: (path: string, data: string) => Promise<void>;
  private readonly mkdir: (path: string) => Promise<void>;

  constructor(private readonly opts: SessionHistoryDiagnosticsOptions) {
    this.now = opts.now ?? Date.now;
    this.appendFile = opts.appendFile ?? ((path, data) => appendFile(path, data, "utf8"));
    this.mkdir = opts.mkdir ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined));
  }

  /**
   * Never throws: this rides along the polling hot path, and a measurement bug must
   * not be the thing that breaks output streaming.
   */
  record(metric: SessionHistoryMetric, value: number, labels: SessionHistoryLabels): void {
    try {
      this.buffer.push({ at: this.now(), layer: "host", metric, value, labels });
    } catch {
      // Pushing to an array cannot realistically fail; guarded anyway per the same rule.
    }
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushMs ?? DEFAULT_FLUSH_MS);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      const lines = batch.map((record) => JSON.stringify(record)).join("\n") + "\n";
      await this.mkdir(dirname(this.opts.path));
      await this.appendFile(this.opts.path, lines);
    } catch (error) {
      // Best-effort: a broken disk drops this batch instead of growing the buffer
      // forever, which would itself be a regression under sustained polling.
      this.opts.onFlushError?.(error);
    }
  }
}
