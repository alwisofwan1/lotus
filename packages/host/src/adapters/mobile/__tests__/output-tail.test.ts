import { describe, expect, it, vi } from "vitest";

import { MAX_BYTES, OutputTail, POLL_MS } from "../output-tail.js";
import { ApiError } from "../../../core/api-error.js";
import type { ApiClient } from "../../../core/api-client.js";
import type { StreamHub } from "../stream-hub.js";
import type { SessionHistoryDiagnostics } from "../session-history-diagnostics.js";

/**
 * The producer the first live smoke run found missing: `publishOutput` was called
 * only by tests, so a phone could subscribe to a pane and receive nothing forever.
 */
function harness(chunks: Array<{ text: string; offset: number; totalBytes: number }>) {
  const published: Array<{ paneId: string; chunk: string; byteOffset: number }> = [];
  const truncated: Array<{ paneId: string; requested: number; served: number }> = [];
  const requests: Array<{ paneId: string; fromByte: number }> = [];

  const readScrollback = vi.fn(async (req: { paneId: string; fromByte: number }) => {
    requests.push({ paneId: req.paneId, fromByte: req.fromByte });
    return chunks.shift() ?? { text: "", offset: req.fromByte, totalBytes: req.fromByte };
  });

  const hub = {
    publishOutput: (paneId: string, chunk: string, byteOffset: number) =>
      published.push({ paneId, chunk, byteOffset }),
    publishTruncated: (paneId: string, requested: number, served: number) =>
      truncated.push({ paneId, requested, served }),
  } as unknown as StreamHub;

  let panes: string[] = ["p-1"];
  const tail = new OutputTail({
    api: { readScrollback } as unknown as ApiClient,
    hub,
    subscribedPanes: () => panes,
    pollMs: 1,
  });

  return {
    tail,
    published,
    truncated,
    requests,
    readScrollback,
    setPanes: (next: string[]) => (panes = next),
  };
}

/** One poll cycle, without waiting on wall-clock time. */
async function tick(tail: OutputTail): Promise<void> {
  const internal = tail as unknown as { tick: () => Promise<void> };
  await internal.tick();
}

describe("OutputTail", () => {
  it("reads quickly while somebody is typing, and settles back after", () => {
    vi.useFakeTimers();
    try {
      const h = harness([{ text: "", offset: 0, totalBytes: 0 }]);
      h.tail.start();

      const quiet = vi.getTimerCount();
      expect(quiet).toBe(1);

      // A key just landed: the echo is the whole felt latency of a keystroke, so the
      // tail stops waiting 400ms to go and look for it.
      h.tail.quicken("p-1");
      vi.advanceTimersByTime(80);
      const whileTyping = h.requests.length;
      expect(whileTyping).toBeGreaterThan(0);

      // And a pane left open does not keep polling a desktop fourteen times a second.
      vi.advanceTimersByTime(4_000);
      const settled = h.requests.length;
      vi.advanceTimersByTime(200);
      expect(h.requests.length).toBe(settled);

      h.tail.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes what the pane produced, at the offset it ends on", async () => {
    const h = harness([{ text: "npm test\n", offset: 0, totalBytes: 9 }]);

    await tick(h.tail);

    expect(h.published).toEqual([{ paneId: "p-1", chunk: "npm test\n", byteOffset: 9 }]);
  });

  it("asks only for what is new on the next poll", async () => {
    const h = harness([
      { text: "first\n", offset: 0, totalBytes: 6 },
      { text: "second\n", offset: 6, totalBytes: 13 },
    ]);

    await tick(h.tail);
    await tick(h.tail);

    expect(h.requests.map((r) => r.fromByte)).toEqual([0, 6]);
    expect(h.published.map((p) => p.byteOffset)).toEqual([6, 13]);
  });

  it("stays quiet when nothing was produced", async () => {
    const h = harness([{ text: "", offset: 0, totalBytes: 0 }]);

    await tick(h.tail);

    expect(h.published).toEqual([]);
  });

  /**
   * R-4: the ring buffer is 64 KB, so a phone that was away long enough asked for
   * bytes that no longer exist. Serving a later position silently would render a jump
   * as continuous output — the operator would read a diff that skipped a line.
   */
  it("announces a gap before the text when the buffer moved on", async () => {
    const h = harness([
      { text: "early\n", offset: 0, totalBytes: 6 },
      { text: "late\n", offset: 5000, totalBytes: 5005 },
    ]);

    await tick(h.tail);
    await tick(h.tail);

    expect(h.truncated).toEqual([{ paneId: "p-1", requested: 6, served: 5000 }]);
    expect(h.published.at(-1)!.byteOffset, 'text still follows the warning').toBe(5005);
  });

  it("does not cry truncation on the very first read of a busy pane", async () => {
    // A pane that has been running for an hour starts far past zero. That is a cold
    // start, not a gap — the phone never had those bytes to lose.
    const h = harness([{ text: "mid-session\n", offset: 900_000, totalBytes: 900_012 }]);

    await tick(h.tail);

    expect(h.truncated).toEqual([]);
    expect(h.published).toHaveLength(1);
  });

  it("an explicit resume is allowed to report the gap it found", async () => {
    const h = harness([{ text: "back\n", offset: 8000, totalBytes: 8005 }]);

    await h.tail.resume("p-1", 42);

    expect(h.truncated).toEqual([{ paneId: "p-1", requested: 42, served: 8000 }]);
  });

  it("polls nothing when nobody is watching", async () => {
    const h = harness([]);
    h.setPanes([]);

    await tick(h.tail);

    expect(h.readScrollback).not.toHaveBeenCalled();
  });

  it("forgets a pane once it is unsubscribed, so offsets cannot pile up", async () => {
    const h = harness([{ text: "x\n", offset: 0, totalBytes: 2 }]);
    await tick(h.tail);
    h.setPanes([]);
    await tick(h.tail);

    h.setPanes(["p-1"]);
    await tick(h.tail);

    // Back to zero: a re-subscribe is a fresh start, not a continuation of state the
    // client may no longer have.
    expect(h.requests.at(-1)!.fromByte).toBe(0);
  });

  it("a pane that vanished mid-poll is reported, not thrown", async () => {
    const errors: unknown[] = [];
    const readScrollback = vi.fn().mockRejectedValue(new Error("pane gone"));
    const tail = new OutputTail({
      api: { readScrollback } as unknown as ApiClient,
      hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      onError: (_pane, error) => errors.push(error),
    });

    await expect(tick(tail)).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("skips a tick rather than letting polls overlap", async () => {
    let release: (() => void) | null = null;
    const readScrollback = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ text: "", offset: 0, totalBytes: 0 });
        }),
    );
    const tail = new OutputTail({
      api: { readScrollback } as unknown as ApiClient,
      hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
    });

    const first = tick(tail);
    await tick(tail); // While the first is still in flight.
    release!();
    await first;

    // Overlapping reads would reorder chunks, which is worse than 400ms of latency.
    expect(readScrollback).toHaveBeenCalledTimes(1);
  });
});

/** A fake for asserting exactly what Fase 0 needs recorded, without touching disk. */
function fakeDiagnostics() {
  const records: Array<{ metric: string; value: number; labels: Record<string, unknown> }> = [];
  const diagnostics = {
    record: (metric: string, value: number, labels: Record<string, unknown>) =>
      records.push({ metric, value, labels }),
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
  } as unknown as SessionHistoryDiagnostics;
  return { diagnostics, records };
}

describe("OutputTail — Fase 0 diagnostics (plans/session-history-hardening/issues/01)", () => {
  it("counts a poll.tick per pane per tick, labelled by which rate is active", async () => {
    const d = fakeDiagnostics();
    const readScrollback = vi.fn().mockResolvedValue({ text: "", offset: 0, totalBytes: 0 });
    const tail = new OutputTail({
      api: { readScrollback } as unknown as ApiClient,
      hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      diagnostics: d.diagnostics,
    });

    await (tail as unknown as { tick: () => Promise<void> }).tick();

    expect(d.records).toContainEqual({ metric: "poll.tick", value: 1, labels: { paneId: "p-1", rate: "slow" } });
  });

  it("labels poll.tick as fast while the pane is being typed into", async () => {
    vi.useFakeTimers();
    try {
      const d = fakeDiagnostics();
      const readScrollback = vi.fn().mockResolvedValue({ text: "", offset: 0, totalBytes: 0 });
      const tail = new OutputTail({
        api: { readScrollback } as unknown as ApiClient,
        hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
        subscribedPanes: () => ["p-1"],
        diagnostics: d.diagnostics,
      });

      tail.start(); // Establishes the slow-rate offset read so the fast tick below is not a cold start.
      await vi.advanceTimersByTimeAsync(400);
      d.records.length = 0;

      tail.quicken("p-1"); // Reschedules onto the 70ms interval, exactly as a real keystroke would.
      await vi.advanceTimersByTimeAsync(70);

      expect(d.records).toContainEqual({ metric: "poll.tick", value: 1, labels: { paneId: "p-1", rate: "fast" } });
      tail.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records cell.truncated with the exact gap size, matching what the client is told", async () => {
    const d = fakeDiagnostics();
    const readScrollback = vi.fn().mockResolvedValue({ text: "late\n", offset: 5000, totalBytes: 5005 });
    const tail = new OutputTail({
      api: { readScrollback } as unknown as ApiClient,
      hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      diagnostics: d.diagnostics,
    });

    await tail.resume("p-1", 6);

    expect(d.records).toContainEqual({
      metric: "cell.truncated",
      value: 4994, // 5000 - 6, the same arithmetic that feeds publishTruncated
      labels: { paneId: "p-1" },
    });
  });

  it("records bytes.served using the same byte length that decides the next offset", async () => {
    const d = fakeDiagnostics();
    const readScrollback = vi.fn().mockResolvedValue({ text: "hello\n", offset: 0, totalBytes: 6 });
    const tail = new OutputTail({
      api: { readScrollback } as unknown as ApiClient,
      hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      diagnostics: d.diagnostics,
    });

    await (tail as unknown as { tick: () => Promise<void> }).tick();

    expect(d.records).toContainEqual({
      metric: "bytes.served",
      value: Buffer.byteLength("hello\n", "utf8"),
      labels: { paneId: "p-1" },
    });
  });

  it("records read.failed on the same failure onError reports", async () => {
    const d = fakeDiagnostics();
    const readScrollback = vi.fn().mockRejectedValue(new Error("pane gone"));
    const tail = new OutputTail({
      api: { readScrollback } as unknown as ApiClient,
      hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      diagnostics: d.diagnostics,
    });

    await (tail as unknown as { tick: () => Promise<void> }).tick();

    expect(d.records).toContainEqual({ metric: "read.failed", value: 1, labels: { paneId: "p-1" } });
  });

  it("starts and stops diagnostics alongside its own lifecycle", () => {
    vi.useFakeTimers();
    try {
      const d = fakeDiagnostics();
      const tail = new OutputTail({
        api: { readScrollback: vi.fn().mockResolvedValue({ text: "", offset: 0, totalBytes: 0 }) } as unknown as ApiClient,
        hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
        subscribedPanes: () => [],
        diagnostics: d.diagnostics,
      });

      tail.start();
      expect(d.diagnostics.start).toHaveBeenCalledTimes(1);

      tail.stop();
      expect(d.diagnostics.stop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays silent with no diagnostics dependency — the disable path", async () => {
    const readScrollback = vi.fn().mockResolvedValue({ text: "hi\n", offset: 0, totalBytes: 3 });
    const tail = new OutputTail({
      api: { readScrollback } as unknown as ApiClient,
      hub: { publishOutput: () => undefined, publishTruncated: () => undefined } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
    });

    // No diagnostics injected: nothing above should throw, which is the whole contract.
    await expect((tail as unknown as { tick: () => Promise<void> }).tick()).resolves.toBeUndefined();
  });
});

describe("capacity is sized from a measurement, not a preference", () => {
  /**
   * Fase 2 of plans/session-history-hardening. A watching client polls every POLL_MS and
   * can take MAX_BYTES per read, so anything faster than that ratio is lost before it can
   * be read. The rate ladder in issues/01 put the old cliff at 176KB/s (64KB/400ms) and
   * measured this PTY path sustaining ~794KB/s — a quarter of all output never arrived.
   *
   * This locks the ratio rather than the numbers: either constant may move, but not in a
   * direction that reopens the gap the measurement closed.
   */
  const MEASURED_PEAK_BYTES_PER_SEC = 794 * 1024;

  it("clears the fastest output rate actually observed", () => {
    const capacity = MAX_BYTES / (POLL_MS / 1000);
    expect(capacity).toBeGreaterThan(MEASURED_PEAK_BYTES_PER_SEC);
  });

  it("keeps headroom, because a jittery tick must not reopen the cliff", () => {
    const capacity = MAX_BYTES / (POLL_MS / 1000);
    expect(capacity / MEASURED_PEAK_BYTES_PER_SEC).toBeGreaterThanOrEqual(1.25);
  });
});

describe("a host with no scrollback route says so once", () => {
  // Fase 4 (`issues/05`): a Standalone Host had no scrollback route at all, and the poller
  // swallowed the 404 every 250ms — the one fact worth knowing, buried in its own noise.
  it("reports the missing route once, not on every poll", async () => {
    const errors: unknown[] = [];
    const api = {
      readScrollback: vi.fn(async () => {
        throw new ApiError(404, "not found");
      }),
    } as unknown as ApiClient;
    const tail = new OutputTail({
      api,
      hub: { publishOutput: vi.fn(), publishTruncated: vi.fn() } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      onError: (_pane, err) => errors.push(err),
    });

    await tail.resume("p-1", 0);
    await tail.resume("p-1", 0);
    await tail.resume("p-1", 0);

    expect(api.readScrollback).toHaveBeenCalledTimes(3);
    expect(errors).toHaveLength(1);
  });

  it("a failure that is not a missing route is reported every time", async () => {
    const errors: unknown[] = [];
    const api = {
      readScrollback: vi.fn(async () => {
        throw new ApiError(500, "boom");
      }),
    } as unknown as ApiClient;
    const tail = new OutputTail({
      api,
      hub: { publishOutput: vi.fn(), publishTruncated: vi.fn() } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      onError: (_pane, err) => errors.push(err),
    });

    await tail.resume("p-1", 0);
    await tail.resume("p-1", 0);

    // "this host cannot do it" and "this host is broken" must not be collapsed into one.
    expect(errors).toHaveLength(2);
  });

  it("forgets the fault once the host answers, so a later one is not swallowed", async () => {
    const errors: unknown[] = [];
    let fail = true;
    const api = {
      readScrollback: vi.fn(async () => {
        if (fail) throw new ApiError(404, "not found");
        return { paneId: "p-1", text: "hi", offset: 0, totalBytes: 2 };
      }),
    } as unknown as ApiClient;
    const tail = new OutputTail({
      api,
      hub: { publishOutput: vi.fn(), publishTruncated: vi.fn() } as unknown as StreamHub,
      subscribedPanes: () => ["p-1"],
      onError: (_pane, err) => errors.push(err),
    });

    await tail.resume("p-1", 0);
    fail = false;
    await tail.resume("p-1", 0);
    fail = true;
    await tail.resume("p-1", 0);

    expect(errors).toHaveLength(2);
  });
});
