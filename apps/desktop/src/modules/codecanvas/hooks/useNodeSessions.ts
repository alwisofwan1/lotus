"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { canvasSessionStore, type CanvasSessionStore } from "../services/session-store";
import { listNodeSessions, setNodeSessionPinned } from "../services/session-mutations";
import type { CanvasSessionRecord } from "../services/session-record";

export interface NodeSessionsState {
  sessions: CanvasSessionRecord[];
  /** The row matching the node's current resume pointer, so the list can say "you are here". */
  activeSessionId: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setPinned: (session: CanvasSessionRecord, pinned: boolean) => Promise<void>;
}

/**
 * One node's conversations (`plans/codecanvas-session-widget/`, Slice 03).
 *
 * The active session is resolved from the node's `resumeSessionId` pointer rather than stored
 * separately: that pointer is still what decides which conversation the runner is launched against
 * (Slice 01), so deriving from it means the list can never disagree with what is actually running.
 */
export function useNodeSessions(
  projectId: string | null | undefined,
  nodeId: string,
  options: { activeProviderSessionId?: string | null; store?: CanvasSessionStore } = {},
): NodeSessionsState {
  const store = options.store ?? canvasSessionStore;
  const { activeProviderSessionId } = options;
  const [sessions, setSessions] = useState<CanvasSessionRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setSessions([]);
      return;
    }
    setLoading(true);
    try {
      setSessions(await listNodeSessions(store, projectId, nodeId));
    } catch {
      // A node header must never break because a list could not be read.
    } finally {
      setLoading(false);
    }
  }, [projectId, nodeId, store]);

  // Re-read when the pointer moves: capture writes the row elsewhere (CanvasPage) BEFORE it patches
  // the pointer, so without this a fresh node never finds its row — no title, and its opening ask
  // stays held forever.
  useEffect(() => {
    void refresh();
  }, [refresh, activeProviderSessionId]);

  const activeSessionId = useMemo(() => {
    if (!activeProviderSessionId) return null;
    return sessions.find((s) => s.providerSessionId === activeProviderSessionId)?.id ?? null;
  }, [sessions, activeProviderSessionId]);

  const setPinned = useCallback(
    async (session: CanvasSessionRecord, pinned: boolean) => {
      const next = await setNodeSessionPinned(store, session, pinned);
      setSessions((rows) => rows.map((row) => (row.id === next.id ? next : row)));
    },
    [store],
  );

  return { sessions, activeSessionId, loading, refresh, setPinned };
}
