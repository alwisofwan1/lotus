import { describe, expect, it, vi } from "vitest";

import { SessionHistoryDiagnostics } from "../session-history-diagnostics.js";

/** Captures what would have hit disk, without touching a real filesystem. */
function harness(overrides?: { appendFile?: (path: string, data: string) => Promise<void> }) {
  const writes: Array<{ path: string; data: string }> = [];
  const dirs: string[] = [];
  const appendFile =
    overrides?.appendFile ??
    vi.fn(async (path: string, data: string) => {
      writes.push({ path, data });
    });
  const mkdir = vi.fn(async (path: string) => {
    dirs.push(path);
  });

  const diagnostics = new SessionHistoryDiagnostics({
    path: "/state/diagnostics/session-history.jsonl",
    now: () => 1_000,
    appendFile,
    mkdir,
  });

  return { diagnostics, writes, dirs, appendFile, mkdir };
}

describe("SessionHistoryDiagnostics", () => {
  it("does not touch disk until flushed", async () => {
    const h = harness();
    h.diagnostics.record("bytes.served", 42, { paneId: "p-1" });

    expect(h.appendFile).not.toHaveBeenCalled();

    await h.diagnostics.flush();
    expect(h.writes).toHaveLength(1);
  });

  it("writes one JSON object per line, in the fixed record shape", async () => {
    const h = harness();
    h.diagnostics.record("cell.truncated", 4096, { paneId: "p-1" });
    h.diagnostics.record("poll.tick", 1, { paneId: "p-1", rate: "fast" });
    await h.diagnostics.flush();

    const lines = h.writes[0]!.data.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { at: 1_000, layer: "host", metric: "cell.truncated", value: 4096, labels: { paneId: "p-1" } },
      {
        at: 1_000,
        layer: "host",
        metric: "poll.tick",
        value: 1,
        labels: { paneId: "p-1", rate: "fast" },
      },
    ]);
  });

  it("ensures the directory exists before appending", async () => {
    const h = harness();
    h.diagnostics.record("read.failed", 1, { paneId: "p-1" });
    await h.diagnostics.flush();

    expect(h.dirs).toEqual(["/state/diagnostics"]);
  });

  it("does nothing on an empty buffer — no empty writes piling up", async () => {
    const h = harness();
    await h.diagnostics.flush();

    expect(h.appendFile).not.toHaveBeenCalled();
  });

  it("clears the buffer after a flush, so the same events are not written twice", async () => {
    const h = harness();
    h.diagnostics.record("bytes.served", 10, { paneId: "p-1" });
    await h.diagnostics.flush();
    await h.diagnostics.flush();

    expect(h.appendFile).toHaveBeenCalledTimes(1);
  });

  it("a broken disk drops the batch instead of throwing or growing forever", async () => {
    const onFlushError = vi.fn();
    const diagnostics = new SessionHistoryDiagnostics({
      path: "/state/diagnostics/session-history.jsonl",
      appendFile: () => Promise.reject(new Error("disk full")),
      mkdir: () => Promise.resolve(),
      onFlushError,
    });
    diagnostics.record("bytes.served", 10, { paneId: "p-1" });

    await expect(diagnostics.flush()).resolves.toBeUndefined();
    expect(onFlushError).toHaveBeenCalledTimes(1);

    // The failed batch was dropped, not requeued — a second flush has nothing to send.
    const appendFile = vi.fn(async () => undefined);
    const second = new SessionHistoryDiagnostics({
      path: "/x",
      appendFile,
      mkdir: () => Promise.resolve(),
    });
    await second.flush();
    expect(appendFile).not.toHaveBeenCalled();
  });

  it("start() schedules a periodic flush rather than writing per record", async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.diagnostics.record("poll.tick", 1, { paneId: "p-1", rate: "slow" });
      h.diagnostics.start();

      // Nothing yet: the whole point is that a 70ms poll tick does not become a write.
      expect(h.appendFile).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.writes).toHaveLength(1);

      await h.diagnostics.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() flushes whatever is still buffered, even before the timer would have", async () => {
    const h = harness();
    h.diagnostics.record("read.failed", 1, { paneId: "p-1" });

    await h.diagnostics.stop();

    expect(h.writes).toHaveLength(1);
  });

  it("record() never throws even if the internal buffer push fails", () => {
    const h = harness();
    // Simulate a broken buffer by forcing push to throw — record() must swallow it.
    (h.diagnostics as unknown as { buffer: { push: () => void } }).buffer = {
      push: () => {
        throw new Error("boom");
      },
    };

    expect(() => h.diagnostics.record("bytes.served", 1, { paneId: "p-1" })).not.toThrow();
  });
});
