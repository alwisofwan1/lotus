"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { canvasSessionStore, type CanvasSessionStore } from "../services/session-store";
import type { CanvasSessionRecord } from "../services/session-record";
import { planSessionReconciliation } from "../services/session-reconcile";
import { canvasRuntimePaneId } from "../services/canvas-runtime-scope";
import { listPersistentPtyKeys } from "@/lib/pty-session-pool";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import { resumeCapability } from "../services/session-resume-capability";
import { deleteDecision } from "../services/session-delete";
import { setNodeSessionPinned } from "../services/session-mutations";

export interface CanvasSessionsState {
  sessions: CanvasSessionRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Remove a row from the list now and write it through after a grace period.
   *
   * Optimistic on purpose: a list that waits for the round trip reads as a button that did nothing.
   * The grace period is what makes {@link undoDelete} real rather than decorative — nothing has
   * been written yet when the user changes their mind. A live row is refused
   * (`services/session-delete.ts`).
   */
  deleteSession: (session: CanvasSessionRecord) => void;
  /** Put the last deleted row back, before its write lands. */
  undoDelete: () => void;
  /** The row awaiting its write, so the panel can name it in the undo bar. */
  pendingDelete: CanvasSessionRecord | null;
  /** Pinned rows survive retention; the same switch the node's own list has. */
  setPinned: (session: CanvasSessionRecord, pinned: boolean) => Promise<void>;
}

/** How long a deleted row can still be brought back. Long enough to read the bar and decide. */
const UNDO_GRACE_MS = 6000;

/**
 * The project's sessions, for the corner panel and the ⌘K rows
 * (`plans/codecanvas-session-widget/`, Slice 02).
 *
 * Read on demand rather than subscribed: sessions change when an agent is launched or a capture
 * lands, which is rare next to how often this canvas re-renders. The panel refreshes when it opens.
 */
export function useCanvasSessions(
  projectId: string | null | undefined,
  store: CanvasSessionStore = canvasSessionStore,
): CanvasSessionsState {
  const [sessions, setSessions] = useState<CanvasSessionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CanvasSessionRecord | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Read through a ref so the delete/undo callbacks keep a stable identity. */
  const pendingDeleteRef = useRef<CanvasSessionRecord | null>(null);
  pendingDeleteRef.current = pendingDelete;
  const storeRef = useRef(store);
  storeRef.current = store;

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSessions([]);
      return;
    }
    setLoading(true);
    try {
      const rows = await store.list(projectId);

      // `live` is a cache about a process. A force-quit writes nothing on the way out, so rows can
      // claim to be running with nothing behind them — and a stale `live` row is the one state the
      // UI cannot act on at all: it does not offer resume, and "open" leads nowhere (Slice 08).
      const stale = planSessionReconciliation({
        sessions: rows,
        livePaneIds: listPersistentPtyKeys(),
        paneIdForNode: (nodeId) => canvasRuntimePaneId(projectId, nodeId),
        // One predicate, shared with launch and dormancy
        // (`services/session-resume-capability.ts`). `off-by-setting` still counts as resumable:
        // the mechanism exists and the ban is one toggle away, so a row must not claim the
        // conversation is unreachable (`plans/codecanvas-session-refactor/issues/01`).
        canResume: (session) =>
          resumeCapability(session.runner as AgentRunnerType).kind !== "unsupported",
      });
      if (stale.length) {
        const corrected = new Map(stale.map((c) => [c.session.id, c.to]));
        await Promise.all(
          stale.map((change) => store.upsert({ ...change.session, status: change.to })),
        );
        setSessions(rows.map((row) => (corrected.has(row.id) ? { ...row, status: corrected.get(row.id)! } : row)));
      } else {
        setSessions(rows);
      }
      setError(null);
    } catch (err) {
      // A store that cannot be read must not blank the canvas: keep the last list and say so.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, store]);

  const deleteSession = useCallback(
    (session: CanvasSessionRecord) => {
      if (!deleteDecision(session).allowed) return;
      if (commitTimerRef.current) {
        // A second delete commits the first one right away: two rows cannot share one undo bar.
        clearTimeout(commitTimerRef.current);
        const earlier = pendingDeleteRef.current;
        if (earlier) void store.remove(earlier.id).catch(() => {});
      }
      setSessions((rows) => rows.filter((row) => row.id !== session.id));
      setPendingDelete(session);
      commitTimerRef.current = setTimeout(() => {
        commitTimerRef.current = null;
        setPendingDelete(null);
        void store.remove(session.id).catch((err: unknown) => {
          // The write failed, so the row still exists: say so rather than leave the list lying.
          setError(err instanceof Error ? err.message : String(err));
          void refresh();
        });
      }, UNDO_GRACE_MS);
    },
    [store, refresh],
  );

  const undoDelete = useCallback(() => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    const restored = pendingDeleteRef.current;
    setPendingDelete(null);
    if (!restored) return;
    setSessions((rows) => (rows.some((row) => row.id === restored.id) ? rows : [restored, ...rows]));
  }, []);

  /**
   * Closing the surface ends the undo window — it does not cancel the delete.
   *
   * Cancelling would be a silent no-op: the user asked for the row to go, saw it go, and it would
   * come back on the next read with nothing said.
   */
  useEffect(
    () => () => {
      if (!commitTimerRef.current) return;
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
      const pending = pendingDeleteRef.current;
      if (pending) void storeRef.current.remove(pending.id).catch(() => {});
    },
    [],
  );

  // Switching projects must not leave the previous project's sessions on screen for a frame.
  useEffect(() => {
    setSessions([]);
    void refresh();
  }, [refresh]);

  const setPinned = useCallback(
    async (session: CanvasSessionRecord, pinned: boolean) => {
      const next = await setNodeSessionPinned(store, session, pinned);
      setSessions((rows) => rows.map((row) => (row.id === next.id ? next : row)));
    },
    [store],
  );

  return { sessions, loading, error, refresh, deleteSession, undoDelete, pendingDelete, setPinned };
}
