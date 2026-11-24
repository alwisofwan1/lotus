import { useEffect, useRef } from "react";
import type { PtyOutputMetrics } from "@/lib/tauri-api";

export type WatchedCell = {
  paneId: string;
  sessionId: string;
  runId?: number;
};

type CellPhase =
  | { kind: "armed" }
  | { kind: "busy" }
  | { kind: "fired" };

type CellTrack = {
  sessionId: string;
  runId?: number;
  baselineBytes: number | null;
  lastTotalBytes: number;
  phase: CellPhase;
  /** totalBytes at the moment the cell fired — the baseline for detecting a NEW turn (reArm). */
  firedAtBytes?: number;
};

export type CellIdleWatcherProps = {
  cells: WatchedCell[];
  getMetrics: (sessionId: string) => Promise<PtyOutputMetrics | null>;
  onIdle: (paneId: string, sessionId: string) => void;
  /** ms of idle time after a busy period before declaring the cell done. Default 8000. */
  idleThresholdMs?: number;
  /** Minimum bytes produced before a cell is considered "busy". Default 200. */
  minBusyBytes?: number;
  /** Poll interval in ms. Default 2000. */
  pollIntervalMs?: number;
  enabled?: boolean;
  /**
   * When true, a cell that has `fired` re-arms on a fresh burst of output (a new turn) and can fire
   * again — so a persistent agent session is announced every turn, not just once. Default `false`
   * (one fire per session), which the loop/orchestrator consumers rely on. Opt-in per consumer.
   */
  reArmOnActivity?: boolean;
};

/**
 * Watches a set of PTY cells for busy→idle transitions.
 *
 * State machine per cell (keyed by sessionId):
 *   armed → busy   when totalBytes > minBusyBytes AND idleMs < busyWindowMs
 *   busy  → fired  when idleMs >= idleThresholdMs (output settled)
 *
 * Resets to `armed` when the sessionId changes (new agent session in same pane).
 * `onIdle` fires exactly once per busy→idle cycle.
 */
export function useCellIdleWatcher({
  cells,
  getMetrics,
  onIdle,
  idleThresholdMs = 8_000,
  minBusyBytes = 200,
  pollIntervalMs = 2_000,
  enabled = true,
  reArmOnActivity = false,
}: CellIdleWatcherProps): void {
  const onIdleRef = useRef(onIdle);

  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  const trackRef = useRef<Map<string, CellTrack>>(new Map());

  useEffect(() => {
    if (!enabled || cells.length === 0) return;

    const busyWindowMs = idleThresholdMs / 2;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      const track = trackRef.current;

      // Prune entries for panes that are no longer watched.
      const activePaneIds = new Set(cells.map((c) => c.paneId));
      for (const paneId of track.keys()) {
        if (!activePaneIds.has(paneId)) track.delete(paneId);
      }

      await Promise.all(
        cells.map(async ({ paneId, sessionId, runId }) => {
          const existing = track.get(paneId);

          // Already fired for this session — nothing to do, UNLESS reArm is on (then we keep polling
          // so a fresh burst of output can re-arm the cell for the next turn).
          if (
            !reArmOnActivity &&
            existing &&
            existing.sessionId === sessionId &&
            existing.runId === runId &&
            existing.phase.kind === "fired"
          ) {
            return;
          }

          let metrics: PtyOutputMetrics | null = null;
          try {
            metrics = await getMetrics(sessionId);
          } catch {
            return;
          }
          if (!metrics || cancelled) return;

          const shouldReset =
            !existing || existing.sessionId !== sessionId || existing.runId !== runId;
          const current: CellTrack = shouldReset
            ? {
                sessionId,
                runId,
                baselineBytes:
                  existing && existing.sessionId === sessionId
                    ? existing.lastTotalBytes
                    : metrics.totalBytes,
                lastTotalBytes: metrics.totalBytes,
                phase: { kind: "armed" },
              }
            : {
                ...existing,
                lastTotalBytes: metrics.totalBytes,
              };

          if (current.phase.kind === "armed") {
            // Transition armed → busy when output appears and idleMs is low.
            const producedBytes = metrics.totalBytes - (current.baselineBytes ?? metrics.totalBytes);
            if (producedBytes >= minBusyBytes && metrics.idleMs < busyWindowMs) {
              track.set(paneId, { ...current, phase: { kind: "busy" } });
            } else {
              track.set(paneId, current);
            }
            return;
          }

          // phase === "fired" (only reachable when reArm is on): a fresh burst of output since we
          // fired means a NEW turn started — re-arm straight to busy so the next settle fires again.
          if (current.phase.kind === "fired") {
            const sinceFired = metrics.totalBytes - (current.firedAtBytes ?? metrics.totalBytes);
            if (sinceFired >= minBusyBytes && metrics.idleMs < busyWindowMs) {
              track.set(paneId, { ...current, phase: { kind: "busy" } });
            } else {
              track.set(paneId, current);
            }
            return;
          }

          // phase === "busy": wait for idle threshold.
          if (metrics.idleMs >= idleThresholdMs) {
            track.set(paneId, { ...current, phase: { kind: "fired" }, firedAtBytes: metrics.totalBytes });
            onIdleRef.current(paneId, sessionId);
          } else {
            track.set(paneId, current);
          }
        }),
      );
    };

    const id = window.setInterval(() => {
      void tick();
    }, pollIntervalMs);

    // Run immediately on mount.
    void tick();

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [cells, enabled, getMetrics, idleThresholdMs, minBusyBytes, pollIntervalMs, reArmOnActivity]);
}
