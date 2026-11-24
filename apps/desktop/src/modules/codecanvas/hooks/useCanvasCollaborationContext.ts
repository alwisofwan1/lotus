"use client";

import { useEffect, useMemo } from "react";
import { isTauri, type BridgeTask } from "@/lib/tauri-api";
import { codecanvasSaveCollaborationRecord } from "@/lib/tauri/codecanvas";
import type { CanvasCollaborationLaunch } from "../services/canvas-collaboration-launch";
import { canvasCollaborationRunId } from "../services/collaboration/canvas-collaboration-ledger";
import { buildCanvasCollaborationContextRecord } from "../services/collaboration/canvas-collaboration-context";

const STORAGE_PREFIX = "lotus:canvas-collaboration-context:v1";
const STORE_KIND = "context";

function storageKey(projectId: string, runId: string): string {
  return `${STORAGE_PREFIX}:${projectId}:${runId}`;
}

export function useCanvasCollaborationContext(
  projectId: string | null,
  launch: CanvasCollaborationLaunch,
  task: BridgeTask | null | undefined,
): void {
  const runId = useMemo(() => canvasCollaborationRunId(launch), [launch]);
  const record = useMemo(() => buildCanvasCollaborationContextRecord({ launch, runId, task }), [launch, runId, task]);

  useEffect(() => {
    if (!projectId || !runId || !record || typeof window === "undefined") return;
    window.localStorage.setItem(storageKey(projectId, runId), JSON.stringify(record));
    if (!isTauri()) return;
    void codecanvasSaveCollaborationRecord(projectId, runId, STORE_KIND, record).catch(() => { /* local fallback remains readable */ });
  }, [projectId, record, runId]);
}
