import type { ApiClient } from "./api-client.js";
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_CHUNK_SIZE,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
  RECONNECT_MAX_RETRIES,
} from "./constants.js";

export interface StreamOptions {
  /**
   * Max characters per forwarded chunk. Splits land on the last newline before
   * this, so ANSI sequences are never sliced. Adapters with a hard protocol
   * ceiling of their own pass it explicitly; the default is transport-agnostic.
   */
  maxChunkSize?: number;
  /** Debounce window in ms — events within this window are batched together before delivery. */
  debounceMs?: number;
  /** Max reconnect attempts on SSE failure (default 5). Set to 0 to disable reconnect. */
  maxRetries?: number;
  onData: (chunk: string) => Promise<void> | void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

/** Batch rapid PTY writes and split at newline boundaries to avoid flooding adapters or cutting escape sequences. */
export class OutputStreamer {
  private conn: ReturnType<ApiClient["streamSession"]> | null = null;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private endFired = false;

  private readonly maxChunkSize: number;
  private readonly debounceMs: number;
  private readonly maxRetries: number;

  constructor(
    private readonly client: Pick<ApiClient, "streamSession">,
    private readonly sessionId: string,
    private readonly opts: StreamOptions,
  ) {
    this.maxChunkSize = opts.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.maxRetries = opts.maxRetries ?? RECONNECT_MAX_RETRIES;
  }

  start(): void {
    if (this.conn || this.stopped) return;
    void this.connect(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
    this.conn?.close();
    this.conn = null;
    this.fireEnd();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private async connect(attempt: number): Promise<void> {
    if (this.stopped) return;

    try {
      const conn = this.client.streamSession(this.sessionId);
      this.conn = conn;
      await this.readLines(conn);
      if (!this.stopped) this.fireEnd();
    } catch (err) {
      if (this.stopped) return;

      if (attempt >= this.maxRetries) {
        this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      const delay = Math.min(RECONNECT_INITIAL_MS * 2 ** attempt, RECONNECT_MAX_MS);
      await sleep(delay);
      void this.connect(attempt + 1);
    }
  }

  private async readLines(conn: ReturnType<ApiClient["streamSession"]>): Promise<void> {
    for await (const line of conn.lines()) {
      if (this.stopped) break;
      // Append without double-newlines
      this.buffer += line.endsWith("\n") ? line : line + "\n";
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    if (!this.buffer) return;
    while (this.buffer.length > 0) {
      const end = splitPoint(this.buffer, this.maxChunkSize);
      const chunk = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      void this.opts.onData(chunk);
    }
    this.timer = null;
  }

  private fireEnd(): void {
    if (!this.endFired) {
      this.endFired = true;
      this.opts.onEnd?.();
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns the ideal split point for a buffer — at the last newline before
 * `maxSize` to avoid cutting ANSI sequences mid-sequence. Falls back to
 * `maxSize` if no newline is found.
 */
function splitPoint(buf: string, maxSize: number): number {
  if (buf.length <= maxSize) return buf.length;
  const nl = buf.lastIndexOf("\n", maxSize - 1);
  return nl > 0 ? nl + 1 : maxSize;
}
