import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import type { PaneActivity } from "@/modules/workspace-shell/types";
import type { BridgeTaskFeedbackKind } from "@/modules/codespace/services/bridge/task-store";
import type { TrackerTask } from "@/modules/tasks/types";

/**
 * What the pane a task claims is actually doing.
 *
 * `cellId` is a claim, not an observation: it is written when a task is dispatched and nothing
 * has ever taken it back. A pane that finished an hour ago, failed, or died when the app closed
 * leaves the task saying "a process is on this" — which is what the `Active` count has been
 * counting all along.
 */

export type TaskLiveness =
  | { kind: "none" }
  /** The task names a pane that is not in this window any more. */
  | { kind: "gone" }
  | { kind: "running"; activity: PaneActivity };

export function taskLiveness(
  task: Pick<TrackerTask, "cellId">,
  activities: ReadonlyMap<string, PaneActivityState>,
): TaskLiveness {
  if (!task.cellId) return { kind: "none" };
  const state = activities.get(task.cellId);
  // Absent from the map means absent from the window — the pane was closed, or died with the app.
  if (!state) return { kind: "gone" };
  return { kind: "running", activity: state.activity };
}

export interface LivenessEvent {
  kind: BridgeTaskFeedbackKind;
  summary: string;
}

/**
 * Only the endings, and only once.
 *
 * A working pane reports constantly; a history that took every tick would be a log, and nobody
 * reads a log to find out what happened to a task. So three states earn a line — the work ended,
 * the work broke, the worker asked something — and only on the change INTO them.
 *
 * The words are past-tense statements rather than the state's own name: `failed` is a machine's
 * word for itself, and a history is read for what changed.
 */
const ENDINGS: Partial<Record<PaneActivity, LivenessEvent>> = {
  done: { kind: "agent-result", summary: "The agent finished and its pane went quiet." },
  failed: {
    kind: "task-blocked",
    summary: "The agent's pane ended in failure. Its output is the place to look.",
  },
  "needs-you": {
    kind: "hitl-question",
    summary: "The agent is waiting on you before it can go further.",
  },
};

export function livenessEvent(
  previous: PaneActivity | undefined,
  next: PaneActivity,
): LivenessEvent | null {
  if (previous === next) return null;
  return ENDINGS[next] ?? null;
}

export interface LivenessWrite {
  taskId: string;
  projectId: string;
  event: LivenessEvent;
  /**
   * Whether the task should stop naming this pane.
   *
   * Only on an ENDING — finished or failed — because that is the one moment the pane is known to
   * be over. Sweeping stale bindings at app start would look tempting and be wrong: after a
   * restart every pane is gone by definition and the activity map fills as panes mount, so a
   * sweep then would cut the bindings of panes that are coming back.
   */
  clearCell: boolean;
}

/**
 * What to write, given what was last seen.
 *
 * Pure, and returning the NEXT memory alongside the writes, because "only once per transition" is
 * the entire rule: a working pane reports on every tick, and a recorder that forgot what it had
 * already written would turn a task's history into a stream.
 */
export function livenessWrites(
  tasks: readonly TrackerTask[],
  activities: ReadonlyMap<string, PaneActivityState>,
  seen: ReadonlyMap<string, PaneActivity>,
): { writes: LivenessWrite[]; seen: Map<string, PaneActivity> } {
  const next = new Map(seen);
  const writes: LivenessWrite[] = [];

  for (const task of tasks) {
    const liveness = taskLiveness(task, activities);
    if (liveness.kind !== "running") {
      // A pane that is gone stops being remembered: if the same task is dispatched again later,
      // its first state is a change, not a repeat of whatever it was doing hours ago.
      next.delete(task.id);
      continue;
    }

    const event = livenessEvent(seen.get(task.id), liveness.activity);
    next.set(task.id, liveness.activity);
    if (event) {
      writes.push({
        taskId: task.id,
        projectId: task.projectId,
        event,
        // `needs-you` is not an ending: the pane is alive and waiting, and cutting its binding
        // would lose the thread the person is about to answer.
        clearCell: liveness.activity === "done" || liveness.activity === "failed",
      });
    }
  }

  return { writes, seen: next };
}
