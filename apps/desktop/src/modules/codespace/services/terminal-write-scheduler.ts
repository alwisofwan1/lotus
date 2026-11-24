export type TerminalWriteCallback = () => void;

/**
 * Emitted as the first write batch when the pending queue overflows
 * `maxPendingBytes`. Does NOT include \x1bc so existing scrollback is
 * preserved — only the queued data is dropped, not the rendered buffer.
 */
export const SCHEDULER_OVERFLOW_NOTICE =
  "\x1b[2m[write queue full; some output was dropped]\x1b[0m\r\n";

export type TerminalWriteFn = (data: string, callback: TerminalWriteCallback) => void;

export interface TerminalWriteScheduler {
  push(data: string): void;
  flush(): void;
  dispose(): void;
  hasPending(): boolean;
}

export interface TerminalWriteSchedulerMetrics {
  queued(bytes: number, pendingBytes: number): void;
  writeStarted(bytes: number, pendingBytes: number): void;
  writeCompleted(): void;
  refreshed(): void;
}

export interface TerminalWriteSchedulerOptions {
  write: TerminalWriteFn;
  refresh?: () => void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  metrics?: TerminalWriteSchedulerMetrics;
  /** Maximum bytes per write batch. Remainder is re-queued and sent in the
   *  next frame, preventing a large hidden-buffer drain from appearing as one
   *  glitchy burst. Default: 128 KB. */
  maxBatchBytes?: number;
  /**
   * Maximum bytes that may accumulate in the pending queue before the oldest
   * data is dropped and `SCHEDULER_OVERFLOW_NOTICE` is prepended to the next
   * batch. Unset (default) means unbounded — suitable when the caller already
   * provides back-pressure (e.g. DormantRing with its own cap).
   */
  maxPendingBytes?: number;
}

function defaultRequestFrame(callback: FrameRequestCallback): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(performance.now()), 16);
}

function defaultCancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }
  window.clearTimeout(id);
}

/**
 * Serialises xterm writes so a new batch is not handed to xterm until its
 * previous asynchronous write callback has completed. This gives the terminal
 * renderer a single backpressure point while still coalescing bursty PTY output
 * to one write per animation frame.
 */
const DEFAULT_MAX_BATCH_BYTES = 128 * 1024;

export function createTerminalWriteScheduler({
  write,
  refresh,
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
  metrics,
  maxBatchBytes = DEFAULT_MAX_BATCH_BYTES,
  maxPendingBytes,
}: TerminalWriteSchedulerOptions): TerminalWriteScheduler {
  let pending = "";
  let frameId: number | null = null;
  let writeInFlight = false;
  let disposed = false;
  let pendingOverflowed = false;

  function clearScheduledFrame() {
    if (frameId === null) return;
    cancelFrame(frameId);
    frameId = null;
  }

  function scheduleFlush() {
    if (disposed || writeInFlight || frameId !== null || !pending) return;
    frameId = requestFrame(() => {
      frameId = null;
      flushNow();
    });
  }

  function completeWrite() {
    writeInFlight = false;
    metrics?.writeCompleted();
    if (disposed) return;
    refresh?.();
    metrics?.refreshed();
    scheduleFlush();
  }

  function flushNow() {
    if (disposed || writeInFlight || (!pending && !pendingOverflowed)) return;
    if (pendingOverflowed) {
      pendingOverflowed = false;
      writeInFlight = true;
      metrics?.writeStarted(SCHEDULER_OVERFLOW_NOTICE.length, pending.length);
      write(SCHEDULER_OVERFLOW_NOTICE, completeWrite);
      return;
    }
    const batch = pending.length > maxBatchBytes ? pending.slice(0, maxBatchBytes) : pending;
    pending = pending.length > maxBatchBytes ? pending.slice(maxBatchBytes) : "";
    writeInFlight = true;
    metrics?.writeStarted(batch.length, pending.length);
    write(batch, completeWrite);
  }

  return {
    push(data: string) {
      if (disposed || !data) return;
      pending += data;
      if (maxPendingBytes !== undefined && pending.length > maxPendingBytes) {
        pending = pending.slice(-maxPendingBytes);
        pendingOverflowed = true;
      }
      metrics?.queued(data.length, pending.length);
      scheduleFlush();
    },
    flush() {
      if (disposed) return;
      clearScheduledFrame();
      flushNow();
    },
    dispose() {
      disposed = true;
      pending = "";
      pendingOverflowed = false;
      clearScheduledFrame();
    },
    hasPending() {
      return !disposed && (Boolean(pending) || pendingOverflowed || writeInFlight || frameId !== null);
    },
  };
}
