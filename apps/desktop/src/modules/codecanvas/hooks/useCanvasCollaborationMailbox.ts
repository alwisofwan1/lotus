"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isTauri, type BridgeTask } from "@/lib/tauri-api";
import { codecanvasLoadCollaborationRecord, codecanvasSaveCollaborationRecord } from "@/lib/tauri/codecanvas";
import { loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import type { CanvasCollaborationLaunch } from "../services/canvas-collaboration-launch";
import { canvasCollaborationRunId } from "../services/collaboration/canvas-collaboration-ledger";
import {
  appendCanvasCollaborationMessage,
  createCanvasCollaborationMailbox,
  listCanvasCollaborationMessages,
  recordCanvasCollaborationEvidence,
  syncCanvasCollaborationMailboxFromTaskFeedback,
  type AppendCanvasCollaborationMessageInput,
  type CanvasCollaborationMailbox,
  type ListCanvasCollaborationMessagesFilter,
  type RecordCanvasCollaborationEvidenceInput,
} from "../services/collaboration/canvas-collaboration-mailbox";
import {
  CODECANVAS_COLLABORATION_RECORD_UPDATED_EVENT,
  type CanvasCollaborationStorageStatus,
  type CodeCanvasCollaborationRecordUpdatedPayload,
} from "../services/collaboration/canvas-collaboration-store-events";

const STORAGE_PREFIX = "lotus:canvas-collaboration-mailbox:v1";
const STORE_KIND = "mailbox";

function storageKey(projectId: string, runId: string): string {
  return `${STORAGE_PREFIX}:${projectId}:${runId}`;
}

function readMailbox(projectId: string | null, runId: string | null): CanvasCollaborationMailbox | null {
  if (!projectId || !runId || typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storageKey(projectId, runId));
  if (!raw) return createCanvasCollaborationMailbox(runId);
  try {
    const parsed = JSON.parse(raw) as CanvasCollaborationMailbox;
    if (parsed?.runId !== runId || !Array.isArray(parsed.messages)) return createCanvasCollaborationMailbox(runId);
    return parsed;
  } catch {
    return createCanvasCollaborationMailbox(runId);
  }
}

function writeMailbox(projectId: string, mailbox: CanvasCollaborationMailbox): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(storageKey(projectId, mailbox.runId), JSON.stringify(mailbox));
}

function isMailbox(value: unknown, runId: string): value is CanvasCollaborationMailbox {
  const candidate = value as CanvasCollaborationMailbox | null;
  return Boolean(candidate?.runId === runId && Array.isArray(candidate.messages));
}

function saveNativeMailbox(projectId: string, mailbox: CanvasCollaborationMailbox): void {
  if (!isTauri()) return;
  void codecanvasSaveCollaborationRecord(projectId, mailbox.runId, STORE_KIND, mailbox).catch(() => { /* localStorage fallback remains authoritative for this render */ });
}

export function useCanvasCollaborationMailbox(projectId: string | null, launch: CanvasCollaborationLaunch) {
  const runId = useMemo(() => canvasCollaborationRunId(launch), [launch]);
  const [, setRevision] = useState(0);
  const [storageStatus, setStorageStatus] = useState<CanvasCollaborationStorageStatus>(() => isTauri() ? "project-synced" : "local-fallback");
  const mailbox = readMailbox(projectId, runId);

  useEffect(() => {
    if (!projectId || !runId || !isTauri()) return;
    let live = true;
    void codecanvasLoadCollaborationRecord<CanvasCollaborationMailbox>(projectId, runId, STORE_KIND)
      .then((nativeMailbox) => {
        if (!live) return;
        const latestLocal = readMailbox(projectId, runId);
        if (isMailbox(nativeMailbox, runId)) {
          const next = latestLocal && latestLocal.updatedAt > nativeMailbox.updatedAt ? latestLocal : nativeMailbox;
          writeMailbox(projectId, next);
          setStorageStatus("project-synced");
          setRevision((value) => value + 1);
          if (next === latestLocal) saveNativeMailbox(projectId, next);
          return;
        }
        if (latestLocal) saveNativeMailbox(projectId, latestLocal);
        setStorageStatus(isTauri() ? "project-synced" : "local-fallback");
      })
      .catch(() => { setStorageStatus("local-fallback"); });
    return () => { live = false; };
  }, [projectId, runId]);

  useEffect(() => {
    if (!projectId || !runId || !isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const reloadNativeMailbox = async (source?: string) => {
      try {
        const nativeMailbox = await codecanvasLoadCollaborationRecord<CanvasCollaborationMailbox>(projectId, runId, STORE_KIND);
        if (!isMailbox(nativeMailbox, runId)) return;
        writeMailbox(projectId, nativeMailbox);
        setStorageStatus(source === "mcp" ? "mcp-updated" : "project-synced");
        setRevision((value) => value + 1);
      } catch {
        setStorageStatus("local-fallback");
      }
    };
    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<CodeCanvasCollaborationRecordUpdatedPayload>(CODECANVAS_COLLABORATION_RECORD_UPDATED_EVENT, (event) => {
        const payload = event.payload;
        if (payload.projectId === projectId && payload.runId === runId && payload.kind === STORE_KIND) void reloadNativeMailbox(payload.source);
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

  const updateMailbox = useCallback((nextMailbox: CanvasCollaborationMailbox) => {
    if (!projectId) return;
    writeMailbox(projectId, nextMailbox);
    saveNativeMailbox(projectId, nextMailbox);
    setRevision((value) => value + 1);
  }, [projectId]);

  const appendMessage = useCallback((input: AppendCanvasCollaborationMessageInput) => {
    if (!projectId || !runId) return;
    const current = readMailbox(projectId, runId) ?? createCanvasCollaborationMailbox(runId);
    const next = appendCanvasCollaborationMessage(current, input);
    if (next === current) return;
    updateMailbox(next);
  }, [projectId, runId, updateMailbox]);

  const recordEvidence = useCallback((input: RecordCanvasCollaborationEvidenceInput) => {
    if (!projectId || !runId) return;
    const current = readMailbox(projectId, runId) ?? createCanvasCollaborationMailbox(runId);
    const next = recordCanvasCollaborationEvidence(current, input);
    if (next === current) return;
    updateMailbox(next);
  }, [projectId, runId, updateMailbox]);

  const syncTaskFeedback = useCallback((task: BridgeTask | null | undefined) => {
    if (!projectId || !runId) return;
    const current = readMailbox(projectId, runId) ?? createCanvasCollaborationMailbox(runId);
    const next = syncCanvasCollaborationMailboxFromTaskFeedback(current, task);
    if (next === current) return;
    updateMailbox(next);
  }, [projectId, runId, updateMailbox]);

  const messages = useCallback((filter: ListCanvasCollaborationMessagesFilter = {}) => listCanvasCollaborationMessages(mailbox, filter), [mailbox]);

  return {
    mailbox,
    messages: messages(),
    listMessages: messages,
    appendMessage,
    recordEvidence,
    syncTaskFeedback,
    storageStatus,
  };
}
