export interface TerminalWritePaneMetrics {
  paneId: string;
  queuedBytes: number;
  writtenBytes: number;
  writeCount: number;
  refreshCount: number;
  pendingBytes: number;
  maxPendingBytes: number;
  inFlight: boolean;
  lastWriteDurationMs: number;
  averageWriteDurationMs: number;
}

export interface TerminalWriteMetricsSnapshot {
  panes: TerminalWritePaneMetrics[];
  totals: {
    paneCount: number;
    queuedBytes: number;
    writtenBytes: number;
    writeCount: number;
    refreshCount: number;
    maxPendingBytes: number;
    inFlightCount: number;
  };
}

export interface TerminalWriteMetricsObserver {
  queued(bytes: number, pendingBytes: number): void;
  writeStarted(bytes: number, pendingBytes: number): void;
  writeCompleted(): void;
  refreshed(): void;
}

export interface TerminalWriteMetricsDiagnosticsApi {
  snapshot(): TerminalWriteMetricsSnapshot;
  reset(): void;
}

declare global {
  interface Window {
    __LOTUS_TERMINAL_WRITE_METRICS__?: TerminalWriteMetricsDiagnosticsApi;
  }
}

type MutablePaneMetrics = TerminalWritePaneMetrics & {
  totalWriteDurationMs: number;
  currentWriteStartedAt: number | null;
};

const panes = new Map<string, MutablePaneMetrics>();

function createEmptyPaneMetrics(paneId: string): MutablePaneMetrics {
  return {
    paneId,
    queuedBytes: 0,
    writtenBytes: 0,
    writeCount: 0,
    refreshCount: 0,
    pendingBytes: 0,
    maxPendingBytes: 0,
    inFlight: false,
    lastWriteDurationMs: 0,
    averageWriteDurationMs: 0,
    totalWriteDurationMs: 0,
    currentWriteStartedAt: null,
  };
}

function metricsForPane(paneId: string): MutablePaneMetrics {
  const existing = panes.get(paneId);
  if (existing) return existing;
  const created = createEmptyPaneMetrics(paneId);
  panes.set(paneId, created);
  return created;
}

export function createTerminalWriteMetricsObserver(
  paneId: string,
  now: () => number = () => performance.now(),
): TerminalWriteMetricsObserver {
  return {
    queued(bytes, pendingBytes) {
      const pane = metricsForPane(paneId);
      pane.queuedBytes += bytes;
      pane.pendingBytes = pendingBytes;
      pane.maxPendingBytes = Math.max(pane.maxPendingBytes, pendingBytes);
    },
    writeStarted(bytes, pendingBytes) {
      const pane = metricsForPane(paneId);
      pane.writtenBytes += bytes;
      pane.writeCount += 1;
      pane.pendingBytes = pendingBytes;
      pane.maxPendingBytes = Math.max(pane.maxPendingBytes, pendingBytes);
      pane.inFlight = true;
      pane.currentWriteStartedAt = now();
    },
    writeCompleted() {
      const pane = metricsForPane(paneId);
      const startedAt = pane.currentWriteStartedAt;
      const duration = startedAt === null ? 0 : Math.max(0, now() - startedAt);
      pane.lastWriteDurationMs = duration;
      pane.totalWriteDurationMs += duration;
      pane.averageWriteDurationMs = pane.writeCount > 0
        ? pane.totalWriteDurationMs / pane.writeCount
        : 0;
      pane.inFlight = false;
      pane.currentWriteStartedAt = null;
    },
    refreshed() {
      metricsForPane(paneId).refreshCount += 1;
    },
  };
}

export function getTerminalWriteMetricsSnapshot(): TerminalWriteMetricsSnapshot {
  const panesSnapshot = Array.from(panes.values())
    .map((pane) => ({
      paneId: pane.paneId,
      queuedBytes: pane.queuedBytes,
      writtenBytes: pane.writtenBytes,
      writeCount: pane.writeCount,
      refreshCount: pane.refreshCount,
      pendingBytes: pane.pendingBytes,
      maxPendingBytes: pane.maxPendingBytes,
      inFlight: pane.inFlight,
      lastWriteDurationMs: pane.lastWriteDurationMs,
      averageWriteDurationMs: pane.averageWriteDurationMs,
    }))
    .sort((a, b) => a.paneId.localeCompare(b.paneId));

  return {
    panes: panesSnapshot,
    totals: panesSnapshot.reduce(
      (acc, pane) => ({
        paneCount: acc.paneCount + 1,
        queuedBytes: acc.queuedBytes + pane.queuedBytes,
        writtenBytes: acc.writtenBytes + pane.writtenBytes,
        writeCount: acc.writeCount + pane.writeCount,
        refreshCount: acc.refreshCount + pane.refreshCount,
        maxPendingBytes: Math.max(acc.maxPendingBytes, pane.maxPendingBytes),
        inFlightCount: acc.inFlightCount + (pane.inFlight ? 1 : 0),
      }),
      {
        paneCount: 0,
        queuedBytes: 0,
        writtenBytes: 0,
        writeCount: 0,
        refreshCount: 0,
        maxPendingBytes: 0,
        inFlightCount: 0,
      },
    ),
  };
}

export function resetTerminalWriteMetrics(): void {
  panes.clear();
}

export function installTerminalWriteMetricsDiagnostics(): () => void {
  if (typeof window === "undefined") return () => {};

  const api: TerminalWriteMetricsDiagnosticsApi = {
    snapshot: getTerminalWriteMetricsSnapshot,
    reset: resetTerminalWriteMetrics,
  };

  window.__LOTUS_TERMINAL_WRITE_METRICS__ = api;
  return () => {
    if (window.__LOTUS_TERMINAL_WRITE_METRICS__ === api) {
      delete window.__LOTUS_TERMINAL_WRITE_METRICS__;
    }
  };
}
