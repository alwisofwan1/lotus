import { ApiError } from "../../core/api-error.js";
import type { ApiClient } from "../../core/api-client.js";
import type { StreamHub } from "./stream-hub.js";
import type { SessionHistoryDiagnostics } from "./session-history-diagnostics.js";

/** Read interval; with MAX_BYTES it sets the rate above which output is lost (Fase 2). */
export const POLL_MS = 250;

/**
 * How often a pane is read while somebody is typing into it.
 * This is the echo, so it is the felt latency of a keystroke: a terminal draws nothing until
 * the bytes come back, and the quiet rate made typing feel stuck.
 */
const TYPING_POLL_MS = 70;

/**
 * How long a pane stays quick after the last key. Long enough to cover the gap between
 * words, short enough that a pane left open does not poll a desktop forever.
 */
const TYPING_WINDOW_MS = 3_000;

/** One ring's worth, so a full interval can be drained in one read. Measured: 256KB/250ms
 *  clears the ~794KB/s this PTY path sustains; 64KB/400ms lost 25% of it (`issues/01`). */
export const MAX_BYTES = 256 * 1024;

export interface OutputTailDeps {
  api: ApiClient;
  hub: StreamHub;
  /** Panes any connection is currently tailing. */
  subscribedPanes: () => string[];
  pollMs?: number;
  onError?: (paneId: string, error: unknown) => void;
  /** Fase 0 measurement (plans/session-history-hardening/issues/01); absent disables it. */
  diagnostics?: SessionHistoryDiagnostics;
}

/**
 * Turns PTY output into `cell.output` frames.
 * Polls by absolute offset, not a stream: `/api/fleet/scrollback` says where the text
 * starts, so a ring buffer that moved on is reported as `cell.truncated`, not silently skipped.
 */
export class OutputTail {
  constructor(private readonly deps: OutputTailDeps) {}

  private timer: ReturnType<typeof setInterval> | null = null;

  /** Last offset published per pane, so a poll only asks for what is new. */
  private readonly offsets = new Map<string, number>();

  /** Until when a pane is worth reading quickly — set by a write, not by a guess. */
  private readonly quickUntil = new Map<string, number>();

  /** 404 here means the host has no scrollback route at all, not that the pane is gone —
   *  one fact, stated once, instead of 240 lines a minute of it (Fase 4). */
  private readonly unsupported = new Set<string>();

  /** The interval currently scheduled, so a re-schedule only happens when it changes. */
  private rate = 0;

  private polling = false;

  start(): void {
    if (this.timer !== null) return;
    this.deps.diagnostics?.start();
    this.schedule(this.slowRate);
  }

  /**
   * Says a pane just received input, so the tail reads quickly for a moment. Called by the
   * write route: output cannot tell "somebody typed" from a pane printing. It changes the
   * interval, never what a `tick` does ("read every pane somebody is watching").
   */
  quicken(paneId: string): void {
    this.quickUntil.set(paneId, Date.now() + TYPING_WINDOW_MS);
    if (this.timer !== null) this.schedule(this.fastRate);
  }

  private get slowRate(): number {
    return this.deps.pollMs ?? POLL_MS;
  }

  /** Never slower than the configured rate — a test that asks for 10ms means 10ms. */
  private get fastRate(): number {
    return Math.min(this.slowRate, TYPING_POLL_MS);
  }

  private schedule(ms: number): void {
    if (this.rate === ms && this.timer !== null) return;
    if (this.timer !== null) clearInterval(this.timer);
    this.rate = ms;
    this.timer = setInterval(() => void this.tick(), ms);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.rate = 0;
    // Fire-and-forget: `stop()` stays synchronous for existing callers, and a final
    // flush failing is already handled inside `SessionHistoryDiagnostics` itself.
    void this.deps.diagnostics?.stop();
  }

  /**
   * Serves an explicit `resume { paneId, fromByte }`. The answer may say "that far back is
   * gone": a returned offset ahead of the requested one.
   */
  async resume(paneId: string, fromByte: number): Promise<void> {
    await this.read(paneId, fromByte, { announceGap: true });
  }

  /** One poll across every pane somebody is watching. */
  private async tick(): Promise<void> {
    // A slow host must not queue overlapping polls; a skipped tick costs one interval
    // of latency, while overlapping ones would reorder chunks.
    if (this.polling) return;
    this.polling = true;
    try {
      const panes = new Set(this.deps.subscribedPanes());
      // The rate actually scheduled right now, not a guess: answers Fase 0's question
      // of how often the typing window is the binding constraint vs. the quiet rate.
      const rate: "fast" | "slow" = this.rate === this.fastRate ? "fast" : "slow";
      for (const paneId of panes) {
        this.deps.diagnostics?.record("poll.tick", 1, { paneId, rate });
        await this.read(paneId, this.offsets.get(paneId) ?? 0, { announceGap: false });
      }
      // Back to the quiet rate once nobody is typing, so a pane left open does not poll
      // a desktop fourteen times a second forever.
      const now = Date.now();
      const typing = [...panes].some((pane) => (this.quickUntil.get(pane) ?? 0) > now);
      if (!typing && this.timer !== null) this.schedule(this.slowRate);
      // Forget panes nobody watches, so a long session does not accumulate offsets
      // for cells that are gone.
      for (const paneId of [...this.offsets.keys()]) {
        if (!panes.has(paneId)) {
          this.offsets.delete(paneId);
          this.quickUntil.delete(paneId);
          this.unsupported.delete(paneId);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async read(
    paneId: string,
    fromByte: number,
    opts: { announceGap: boolean },
  ): Promise<void> {
    let chunk;
    try {
      chunk = await this.deps.api.readScrollback({ paneId, fromByte, maxBytes: MAX_BYTES });
    } catch (error) {
      // A pane that vanished mid-poll is normal (the cell closed); reporting it as a
      // stream failure would make a routine event look like a fault.
      const missingRoute = error instanceof ApiError && error.status === 404;
      if (!missingRoute || !this.unsupported.has(paneId)) {
        if (missingRoute) this.unsupported.add(paneId);
        this.deps.onError?.(paneId, error);
      }
      this.deps.diagnostics?.record("read.failed", 1, { paneId });
      return;
    }

    // The buffer moved past what was asked for. Say so before the text, so a client
    // never renders a jump as continuous output (R-4).
    if (chunk.offset > fromByte && (opts.announceGap || this.offsets.has(paneId))) {
      this.deps.hub.publishTruncated(paneId, fromByte, chunk.offset);
      this.deps.diagnostics?.record("cell.truncated", chunk.offset - fromByte, { paneId });
    }

    if (chunk.text.length === 0) {
      // Still record where we stand: a first read of a quiet pane establishes the
      // offset, otherwise the next poll would re-announce the whole buffer.
      this.offsets.set(paneId, Math.max(fromByte, chunk.offset));
      return;
    }

    // A host that answers again has been upgraded or the route came back; forget the
    // fault so a later one is reported rather than silently suppressed.
    this.unsupported.delete(paneId);
    const bytes = Buffer.byteLength(chunk.text, "utf8");
    this.deps.diagnostics?.record("bytes.served", bytes, { paneId });
    const end = chunk.offset + bytes;
    this.offsets.set(paneId, end);
    this.deps.hub.publishOutput(paneId, chunk.text, end);
  }
}
