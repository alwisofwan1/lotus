"use client";

import { useEffect, useMemo, useState } from "react";
import { bridgeGetTask, type BridgeTask } from "@/lib/tauri-api";
import type { CanvasCollaborationLaunch } from "../services/canvas-collaboration-launch";

export interface CanvasCollaborationTaskState {
  task: BridgeTask | null;
  loading: boolean;
  error: string | null;
}

function taskFetchTarget(launch: CanvasCollaborationLaunch): { key: string; workspaceId: string; taskId: string } | null {
  if (launch.mode !== "swarm-task" || !launch.workspaceId || !launch.taskId) return null;
  return {
    key: `${launch.workspaceId}:${launch.taskId}`,
    workspaceId: launch.workspaceId,
    taskId: launch.taskId,
  };
}

/** Fetches the Swarm/Bridge task projected into an explicit CodeCanvas collaboration launch. */
export function useCanvasCollaborationTask(launch: CanvasCollaborationLaunch): CanvasCollaborationTaskState {
  const target = useMemo(() => taskFetchTarget(launch), [launch]);
  const [state, setState] = useState<{ key: string | null; task: BridgeTask | null; error: string | null }>({
    key: null,
    task: null,
    error: null,
  });

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    bridgeGetTask(target.workspaceId, target.taskId)
      .then((task) => {
        if (cancelled) return;
        if (!task) {
          setState({ key: target.key, task: null, error: `Task ${target.taskId} no longer exists.` });
          return;
        }
        setState({ key: target.key, task, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ key: target.key, task: null, error: message });
      });
    return () => { cancelled = true; };
  }, [target]);

  if (!target) return { task: null, loading: false, error: null };
  return {
    task: state.key === target.key ? state.task : null,
    loading: state.key !== target.key,
    error: state.key === target.key ? state.error : null,
  };
}
