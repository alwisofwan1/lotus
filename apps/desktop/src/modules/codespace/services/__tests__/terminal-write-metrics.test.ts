import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalWriteMetricsObserver,
  getTerminalWriteMetricsSnapshot,
  installTerminalWriteMetricsDiagnostics,
  resetTerminalWriteMetrics,
} from "../terminal-write-metrics";

describe("terminal write metrics", () => {
  beforeEach(() => {
    resetTerminalWriteMetrics();
  });

  afterEach(() => {
    resetTerminalWriteMetrics();
    delete window.__LOTUS_TERMINAL_WRITE_METRICS__;
    vi.restoreAllMocks();
  });

  it("records queued bytes, write duration, and refresh counts per pane", () => {
    const now = vi.fn()
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(26);
    const observer = createTerminalWriteMetricsObserver("pane-1", now);

    observer.queued(5, 5);
    observer.writeStarted(5, 0);
    observer.writeCompleted();
    observer.refreshed();

    expect(getTerminalWriteMetricsSnapshot()).toEqual({
      panes: [{
        paneId: "pane-1",
        queuedBytes: 5,
        writtenBytes: 5,
        writeCount: 1,
        refreshCount: 1,
        pendingBytes: 0,
        maxPendingBytes: 5,
        inFlight: false,
        lastWriteDurationMs: 16,
        averageWriteDurationMs: 16,
      }],
      totals: {
        paneCount: 1,
        queuedBytes: 5,
        writtenBytes: 5,
        writeCount: 1,
        refreshCount: 1,
        maxPendingBytes: 5,
        inFlightCount: 0,
      },
    });
  });

  it("installs a console diagnostics API", () => {
    const cleanup = installTerminalWriteMetricsDiagnostics();

    expect(window.__LOTUS_TERMINAL_WRITE_METRICS__).toBeDefined();
    expect(window.__LOTUS_TERMINAL_WRITE_METRICS__?.snapshot().totals.paneCount).toBe(0);

    cleanup();
    expect(window.__LOTUS_TERMINAL_WRITE_METRICS__).toBeUndefined();
  });
});
