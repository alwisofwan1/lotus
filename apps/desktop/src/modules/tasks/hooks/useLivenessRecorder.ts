"use client";

import { useEffect, useRef } from "react";
import { createTauriTaskClient } from "@/modules/codespace/services/bridge/task-api";
import { isTauri } from "@/lib/tauri/runtime";
import { livenessWrites } from "@/modules/tasks/services/task-liveness";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity } from "@/modules/workspace-shell/types";
import type { TrackerTask } from "@/modules/tasks/types";

/**
 * Writing what the panes did into the tasks they were doing it for.
 *
 * Until now a task's history only filled if an agent chose to report — and the prompt never asked
 * it to, so in practice it never filled at all. This writes what Lotus can SEE rather than what a
 * worker remembered to say: the pane finished, the pane broke, the pane is waiting on you.
 *
 * It stays quiet while work merely proceeds. The rule lives in `livenessWrites`, which returns
 * what it has already written alongside what to write — because a working pane reports on every
 * tick, and a recorder without that memory turns a history into a stream.
 */
export function useLivenessRecorder(
  tasks: readonly TrackerTask[],
  activities: ReadonlyMap<string, PaneActivityState>,
  onRecorded?: () => void,
): void {
  const client = useRef(createTauriTaskClient());
  const seen = useRef<Map<string, PaneActivity>>(new Map());
  // Read from the effect, never a dependency: the list changes on every keystroke elsewhere in
  // the tracker, and this must run when the PANES move.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const onRecordedRef = useRef(onRecorded);
  onRecordedRef.current = onRecorded;

  useEffect(() => {
    if (!isTauri()) return;

    const { writes, seen: next } = livenessWrites(tasksRef.current, activities, seen.current);
    seen.current = next;
    if (writes.length === 0) return;

    let cancelled = false;
    void Promise.all(
      writes.map(async (write) => {
        // The binding is released only where the pane is known to be over — see `clearCell`.
        if (write.clearCell) {
          await client.current
            .update(write.projectId, write.taskId, { cellId: null })
            .catch(() => undefined);
        }
        return client.current
          .appendEvent(write.projectId, write.taskId, {
            id: `pane_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
            at: Date.now(),
            // `system`, not `agent`: nobody reported this. Lotus watched a pane and wrote down
            // what it saw, and saying otherwise would put words in a worker's mouth.
            actor: "system",
            kind: write.event.kind,
            summary: write.event.summary,
          })
          .catch(() => undefined);
      }),
    ).then(() => {
      if (!cancelled) onRecordedRef.current?.();
    });

    return () => {
      cancelled = true;
    };
  }, [activities]);
}
