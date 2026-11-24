"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri } from "@/lib/tauri-api";
import { codecanvasLoadCollaborationRecord, codecanvasSaveCollaborationRecord } from "@/lib/tauri/codecanvas";
import { loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import type { CanvasCollaborationLaunch } from "../services/canvas-collaboration-launch";
import {
  canvasCollaborationRunId,
  createCanvasCollaborationLedger,
  recordCanvasCollaborationAssigneeSpawn,
  syncCanvasCollaborationLedgerFromParticipants,
  type CanvasCollaborationLedger,
  type CanvasCollaborationLedgerParticipantSnapshot,
  type RecordCanvasCollaborationAssigneeSpawnInput,
} from "../services/collaboration/canvas-collaboration-ledger";
import {
  CODECANVAS_COLLABORATION_RECORD_UPDATED_EVENT,
  type CodeCanvasCollaborationRecordUpdatedPayload,
} from "../services/collaboration/canvas-collaboration-store-events";

const STORAGE_PREFIX = "lotus:canvas-collaboration-ledger:v1";
const STORE_KIND = "ledger";

function storageKey(projectId: string, runId: string): string {
  return `${STORAGE_PREFIX}:${projectId}:${runId}`;
}

function readLedger(projectId: string | null, runId: string | null): CanvasCollaborationLedger | null {
  if (!projectId || !runId || typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storageKey(projectId, runId));
  if (!raw) return createCanvasCollaborationLedger(runId);
  try {
    const parsed = JSON.parse(raw) as CanvasCollaborationLedger;
    if (parsed?.runId !== runId || !parsed.assignments || typeof parsed.assignments !== "object") {
      return createCanvasCollaborationLedger(runId);
    }
    return parsed;
  } catch {
    return createCanvasCollaborationLedger(runId);
  }
}

function writeLedger(projectId: string, ledger: CanvasCollaborationLedger): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(projectId, ledger.runId), JSON.stringify(ledger));
}

function isLedger(value: unknown, runId: string): value is CanvasCollaborationLedger {
  const candidate = value as CanvasCollaborationLedger | null;
  return Boolean(candidate?.runId === runId && candidate.assignments && typeof candidate.assignments === "object");
}

function saveNativeLedger(projectId: string, ledger: CanvasCollaborationLedger): void {
  if (!isTauri()) return;
  void codecanvasSaveCollaborationRecord(projectId, ledger.runId, STORE_KIND, ledger).catch(() => { /* localStorage fallback remains authoritative for this render */ });
}

export function useCanvasCollaborationLedger(projectId: string | null, launch: CanvasCollaborationLaunch) {
  const runId = useMemo(() => canvasCollaborationRunId(launch), [launch]);
  const [, setRevision] = useState(0);
  const ledger = readLedger(projectId, runId);

  useEffect(() => {
    if (!projectId || !runId || !isTauri()) return;
    let live = true;
    void codecanvasLoadCollaborationRecord<CanvasCollaborationLedger>(projectId, runId, STORE_KIND)
      .then((nativeLedger) => {
        if (!live) return;
        const latestLocal = readLedger(projectId, runId);
        if (isLedger(nativeLedger, runId)) {
          const next = latestLocal && latestLocal.updatedAt > nativeLedger.updatedAt ? latestLocal : nativeLedger;
          writeLedger(projectId, next);
          setRevision((value) => value + 1);
          if (next === latestLocal) saveNativeLedger(projectId, next);
          return;
        }
        if (latestLocal) saveNativeLedger(projectId, latestLocal);
      })
      .catch(() => { /* localStorage fallback remains readable */ });
    return () => { live = false; };
  }, [projectId, runId]);

  useEffect(() => {
    if (!projectId || !runId || !isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const reloadNativeLedger = async () => {
      const nativeLedger = await codecanvasLoadCollaborationRecord<CanvasCollaborationLedger>(projectId, runId, STORE_KIND);
      if (!isLedger(nativeLedger, runId)) return;
      writeLedger(projectId, nativeLedger);
      setRevision((value) => value + 1);
    };
    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<CodeCanvasCollaborationRecordUpdatedPayload>(CODECANVAS_COLLABORATION_RECORD_UPDATED_EVENT, (event) => {
        const payload = event.payload;
        if (payload.projectId === projectId && payload.runId === runId && payload.kind === STORE_KIND) void reloadNativeLedger();
      });
      if (disposed) {
        safeTauriUnlisten(next);
        return;
      }
      unlisten = next;
    })().catch(() => { /* localStorage fallback remains readable */ });
    return () => {
      disposed = true;
      safeTauriUnlisten(unlisten);
    };
  }, [projectId, runId]);

  const persistLedger = useCallback((next: CanvasCollaborationLedger) => {
    if (!projectId) return;
    writeLedger(projectId, next);
    saveNativeLedger(projectId, next);
    setRevision((value) => value + 1);
  }, [projectId]);

  const recordSpawn = useCallback((input: RecordCanvasCollaborationAssigneeSpawnInput) => {
    if (!projectId || !runId) return;
    const current = readLedger(projectId, runId) ?? createCanvasCollaborationLedger(runId);
    const next = recordCanvasCollaborationAssigneeSpawn(current, input);
    persistLedger(next);
  }, [persistLedger, projectId, runId]);

  const syncParticipants = useCallback((participants: readonly CanvasCollaborationLedgerParticipantSnapshot[], now?: number) => {
    if (!projectId || !runId) return;
    const current = readLedger(projectId, runId) ?? createCanvasCollaborationLedger(runId);
    const next = syncCanvasCollaborationLedgerFromParticipants(current, participants, now);
    if (next === current) return;
    persistLedger(next);
  }, [persistLedger, projectId, runId]);

  return { ledger, recordSpawn, syncParticipants };
}
