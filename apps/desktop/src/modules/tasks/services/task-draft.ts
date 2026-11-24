import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import type { TrackerTask } from "@/modules/tasks/types";

/**
 * What the tracker is allowed to write, and what it must refuse.
 *
 * The store checks only lengths — an empty title is accepted by Rust — so the judgement about what
 * makes a task worth creating lives here, where it can be tested without a store and stated once
 * for every surface that writes.
 *
 * The caps are the store's own (`bridge_tasks.rs`): 120 BYTES for a title, 500 for a goal. They are
 * repeated rather than imported because they are a WIRE contract, and a silent drift on either
 * side should fail a test here rather than a write in the field.
 */

export const TASK_TITLE_CAP = 120;
export const TASK_GOAL_CAP = 500;
export const TASK_KNOWLEDGE_CAP = 200_000;

const encoder = new TextEncoder();

/**
 * Length as the store measures it: UTF-8 bytes (`.len()` in `validate_text`), not characters.
 *
 * The two agree only for plain ASCII. An em dash or an ellipsis is three bytes, so a 120-character
 * title can be 126 bytes — which is exactly how three real tickets became tasks the store refused.
 */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Cut to at most `cap` bytes, ending in `…` when anything was cut. Whole characters only: walking
 * by code point means a cut never lands inside a multi-byte one.
 */
export function cutToBytes(text: string, cap: number): string {
  if (utf8Length(text) <= cap) return text;
  const room = cap - utf8Length("…");
  let used = 0;
  let out = "";
  for (const char of text) {
    const size = utf8Length(char);
    if (used + size > room) break;
    out += char;
    used += size;
  }
  return `${out.trimEnd()}…`;
}

export interface TaskDraft {
  title: string;
  projectId: string;
  priority: BridgePriority;
  /** The brief, written in the New task modal. Blank falls back to the title — see below. */
  description?: string;
  /** Picked in the modal. Absent means `todo`, which is where listed work starts. */
  status?: BridgeTaskStatus;
}

export type TaskDraftRefusal = "empty-title" | "no-project" | "title-too-long" | "description-too-long";

export interface PreparedTaskDraft {
  workspaceId: string;
  title: string;
  goal: string;
  priority: BridgePriority;
  status: BridgeTaskStatus;
}

/**
 * Turn what someone typed into what the store accepts, or say why not.
 *
 * **`goal` is the title.** The plan said to send it empty and let the MCP tools fill in a brief —
 * and the store refused, on every path: `validate_create` requires a non-empty goal because a task
 * is a brief for an agent to execute (`bridge_tasks.rs`). Found by creating a task against the
 * running app, not by reading the type, which shows `goal: string` and says nothing about empty.
 *
 * Copying the title is the honest reading of what someone typed one line and meant: the goal of
 * "Fix the flaky login test" is to fix the flaky login test. The alternative — relaxing the
 * store — would weaken a rule twelve MCP tools rely on, to save a composer one field.
 *
 * A new task starts `todo`: the tracker is where work is listed before it is picked up, and
 * anything else would claim a state nobody chose.
 */
export function prepareTaskDraft(
  draft: TaskDraft,
): { ok: true; input: PreparedTaskDraft } | { ok: false; reason: TaskDraftRefusal } {
  const title = draft.title.trim().replace(/\s+/g, " ");
  if (!title) return { ok: false, reason: "empty-title" };
  if (utf8Length(title) > TASK_TITLE_CAP) return { ok: false, reason: "title-too-long" };
  if (!draft.projectId.trim()) return { ok: false, reason: "no-project" };
  // Trimmed only at the ends: a written brief keeps its own line breaks.
  const description = (draft.description ?? "").trim();
  if (utf8Length(description) > TASK_GOAL_CAP) return { ok: false, reason: "description-too-long" };

  return {
    ok: true,
    input: {
      workspaceId: draft.projectId,
      title,
      goal: description || title,
      priority: draft.priority,
      status: draft.status ?? "todo",
    },
  };
}

export function taskDraftRefusalMessage(reason: TaskDraftRefusal): string {
  if (reason === "empty-title") return "A task needs a title.";
  // "Bytes" is said out loud: a title that fits the character counter can still be too long once
  // its dashes and accents are counted the way the store counts them.
  if (reason === "title-too-long") return `A title is at most ${TASK_TITLE_CAP} bytes — dashes and accents count as more than one.`;
  if (reason === "description-too-long") return `A description is at most ${TASK_GOAL_CAP} bytes — dashes and accents count as more than one.`;
  return "Pick a project for this task.";
}

/**
 * The list as it looks the instant someone clicks, before the store has answered.
 *
 * Applied locally first and sent second: a list that waits a round-trip for every status click
 * feels broken even when it is correct. The write that follows can still fail, and then the caller
 * puts the old row back — which is why this returns a NEW list rather than mutating, and why the
 * caller keeps the task it replaced.
 */
export function applyTrackerTaskPatch(
  tasks: readonly TrackerTask[],
  taskId: string,
  patch: Partial<Pick<TrackerTask, "title" | "status" | "priority" | "position">>,
  now: number,
): TrackerTask[] {
  return tasks.map((task) =>
    task.id === taskId ? { ...task, ...patch, updatedAt: now } : task,
  );
}

/** Put one task back exactly as it was, for when the store refused the change. */
export function restoreTrackerTask(
  tasks: readonly TrackerTask[],
  original: TrackerTask,
): TrackerTask[] {
  return tasks.map((task) => (task.id === original.id ? original : task));
}
