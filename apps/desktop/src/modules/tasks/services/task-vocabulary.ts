import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * The words the tracker uses, and the order it puts them in.
 *
 * Taken from `bb/plugins/tasks`, whose grammar the screenshot that started this work shows:
 * **status groups, priority sorts**. Someone reads "In Progress 3" first and only then asks which
 * of the three is urgent — so status is what splits the list into sections, and priority is what
 * orders the rows inside one.
 *
 * The vocabulary itself is LOTUS's, not bb's. bb has six statuses and five priorities; Lotus's
 * store has five and four, and the two extra (`backlog`, `urgent`) are not invented here — a
 * status no writer can produce is a section that is always empty, and a priority nothing can be
 * set to is a filter that never matches. They arrive when the store can hold them, together with
 * the MCP tools that would set them.
 */

/**
 * Sections, top to bottom.
 *
 * Work in flight first, finished work last: the list exists to answer "what is happening", and a
 * done pile at the top answers a question nobody opened it for.
 */
/**
 * The words one project speaks, and the order it puts them in.
 *
 * Pure data rather than an object of functions: a vocabulary is compared in tests, printed when
 * something is wrong, and will eventually be read from somewhere other than this file. A record of
 * closures can do none of those.
 *
 * It exists because a project's statuses are ITS OWN. A vault ticket is `qa-revision` or
 * `ready-to-prod` — words Lotus has no equivalent for — and translating them into Lotus's six
 * would flatten two columns of the human's board into one. That is the same failure as `blocked`,
 * committed on purpose instead of by accident.
 */
export interface StatusVocabulary {
  /** Sections, top to bottom. */
  readonly order: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly tones: Readonly<Record<string, TaskStatusTone>>;
  /** The statuses that are still somebody's problem. */
  readonly open: readonly string[];
}

const TASK_STATUS_ORDER: readonly BridgeTaskStatus[] = [
  "in-progress",
  "in-review",
  // Above `todo`, because work that is stuck is the work that most needs eyes, and it is not work
  // nobody has started. Agents write this with `lotus_update_task` on a failed review, so the task
  // that just failed review was, until this line existed, drawn at the very bottom under Done.
  "blocked",
  "todo",
  "complete",
  "cancelled",
] as const;

const STATUS_LABEL: Record<BridgeTaskStatus, string> = {
  "in-progress": "In Progress",
  blocked: "Blocked",
  "in-review": "In Review",
  todo: "Todo",
  complete: "Done",
  cancelled: "Canceled",
};

/**
 * The hue a section and its glyph wear.
 *
 * Deliberately the tracker's own five, not the pane-activity five: a task that is `in-progress` is
 * a statement about work someone committed to, and a pane that is `working` is a statement about a
 * process this second. Sharing a palette would suggest they move together, and they do not.
 */
export type TaskStatusTone = "progress" | "review" | "blocked" | "open" | "done" | "dropped";

const STATUS_TONE: Record<BridgeTaskStatus, TaskStatusTone> = {
  "in-progress": "progress",
  // Its own hue, never `dropped`: a task somebody cancelled and a task that is stuck are two
  // different fates, and one colour for both would say they are the same.
  blocked: "blocked",
  "in-review": "review",
  todo: "open",
  complete: "done",
  cancelled: "dropped",
};




/**
 * Priorities, most urgent first.
 *
 * `none` last rather than first: an unset priority is the absence of a claim, and sorting it above
 * `low` would make "I have not decided" outrank "I decided this can wait".
 */
export const TASK_PRIORITY_ORDER: readonly BridgePriority[] = ["high", "medium", "low", "none"] as const;

const PRIORITY_LABEL: Record<BridgePriority, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "No priority",
};

const SUBTASK_LABEL: Record<string, string> = {
  pending: "Not started",
  "in-progress": "In progress",
  completed: "Done",
};

/**
 * What a sub-task's state is called on screen.
 *
 * The panel used to print the enum itself, so a finished item read `completed` — the store's word
 * for its own benefit, not a word written for anybody to read.
 */
export function subTaskStatusLabel(status: string): string {
  return SUBTASK_LABEL[status] ?? status;
}

export function taskPriorityLabel(priority: BridgePriority): string {
  return PRIORITY_LABEL[priority];
}

/** Rank for sorting: lower sorts first. Unknown values fall to the end rather than to the top. */
export function taskPriorityRank(priority: BridgePriority): number {
  const rank = TASK_PRIORITY_ORDER.indexOf(priority);
  return rank === -1 ? TASK_PRIORITY_ORDER.length : rank;
}

/** Lotus's own words — the vocabulary every workspace-backed project speaks. */
export const LOTUS_VOCABULARY: StatusVocabulary = {
  order: TASK_STATUS_ORDER,
  labels: STATUS_LABEL,
  tones: STATUS_TONE,
  open: ["todo", "in-progress", "in-review", "blocked"],
};

/**
 * What a status is called, in one project's words.
 *
 * A word the vocabulary does not carry is returned AS ITSELF rather than dropped or renamed: the
 * store can learn a status without a desktop release, and showing it late beats hiding it.
 */
export function statusLabel(vocabulary: StatusVocabulary, status: string): string {
  return vocabulary.labels[status] ?? status;
}

export function statusTone(vocabulary: StatusVocabulary, status: string): TaskStatusTone {
  return vocabulary.tones[status] ?? "open";
}

export function statusIsOpen(vocabulary: StatusVocabulary, status: string): boolean {
  return vocabulary.open.includes(status);
}

/** Position in this vocabulary; a word it does not know falls to the end. */
export function statusRank(vocabulary: StatusVocabulary, status: string): number {
  const rank = vocabulary.order.indexOf(status);
  return rank === -1 ? vocabulary.order.length : rank;
}

