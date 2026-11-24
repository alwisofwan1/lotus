import type {
  BridgeSubTask,
  BridgeTask,
  BridgeTaskBlocker,
  BridgeTaskFeedbackActor,
  BridgeTaskFeedbackEvent,
  BridgeTaskFeedbackKind,
  BridgeTaskIntake,
} from "@/modules/codespace/services/bridge/task-store";

/**
 * Reading a task's record out loud.
 *
 * Every field here has been written since the MCP tools shipped — intake decisions, blockers,
 * review verdicts, an agent's result — and none of it has ever been on screen: the desktop's own
 * `BridgeTask` type did not declare the fields, so nothing could read them even by accident. This
 * module turns that record into lines a person can read, and nothing else: no fetching, no state.
 */

const ACTOR_LABEL: Record<BridgeTaskFeedbackActor, string> = {
  director: "Director",
  human: "You",
  agent: "Agent",
  reviewer: "Reviewer",
  system: "System",
};

/**
 * What each entry says happened.
 *
 * Written as past-tense statements rather than as the enum's own words: `assignment-dispatched`
 * names a mechanism, and a history is read for what changed, not for which function ran.
 */
const KIND_LABEL: Record<BridgeTaskFeedbackKind, string> = {
  "intake-created": "read the task",
  "hitl-question": "asked you a question",
  "hitl-answer": "answered",
  "assignment-plan-created": "planned the work",
  "assignment-dispatched": "handed it to an agent",
  "agent-result": "reported a result",
  "review-requested": "asked for a review",
  "review-verdict": "reviewed it",
  "revision-requested": "asked for changes",
  "task-blocked": "hit a blocker",
  "task-status-changed": "moved the task",
};

/** What a row needs to walk back into the session it records. */
export interface ResumableSession {
  sessionId: string;
  /** The whole command, stored at dispatch — so the button still works if the preset is deleted. */
  command: string;
  presetName?: string;
}

export interface TaskActivityRow {
  id: string;
  at: number;
  /** "Reviewer reviewed it" — who, then what, in that order. */
  actor: string;
  action: string;
  /** The line whoever wrote the entry left. Empty when they left none. */
  summary: string;
  /** Present only on a dispatch that can be walked back into. */
  resume?: ResumableSession;
}

/**
 * The history, oldest first.
 *
 * A task's record is a story: intake, plan, dispatch, result, verdict. Newest-first is right for a
 * feed you dip into and wrong for a sequence you are trying to follow, and this is the second kind.
 */
export function taskActivityRows(
  events: readonly BridgeTaskFeedbackEvent[] | undefined,
): TaskActivityRow[] {
  return [...(events ?? [])]
    .sort((left, right) => left.at - right.at)
    .map((event) => ({
      id: event.id,
      at: event.at,
      actor: ACTOR_LABEL[event.actor] ?? event.actor,
      action: KIND_LABEL[event.kind] ?? event.kind,
      summary: event.summary.trim(),
      ...(resumeFrom(event.payload) ? { resume: resumeFrom(event.payload)! } : {}),
    }));
}

/**
 * How long ago, in the coarsest honest unit.
 *
 * Deliberately not `formatPaneActivityAge`: that one returns nothing under a minute, because a pane
 * badge counting seconds pulls the eye to work that has only just started. A history entry from ten
 * seconds ago is the most important line in the list, and "just now" is what it should say.
 */
export function formatTaskEventAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 60_000) return "just now";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`;
}

/**
 * The session a dispatch can be resumed into, if it recorded one.
 *
 * Read defensively: this payload is written by whatever dispatched the task, including builds that
 * did not record a session at all, and a history entry must never fail to draw because of it.
 */
function resumeFrom(payload: unknown): ResumableSession | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!sessionId || !command) return null;
  return {
    sessionId,
    command,
    ...(typeof record.presetName === "string" ? { presetName: record.presetName } : {}),
  };
}

const BLOCKER_PHASE_LABEL: Record<BridgeTaskBlocker["phase"], string> = {
  intake: "while reading the task",
  assignment: "while planning the work",
  execution: "while doing the work",
  review: "while reviewing",
};

const BLOCKER_TYPE_LABEL: Record<BridgeTaskBlocker["type"], string> = {
  "human-input": "needs you",
  ambiguity: "unclear",
  auth: "not signed in",
  dependency: "waiting on something else",
  "verification-failed": "verification failed",
  "system-error": "system error",
};

/** One line that says what stopped, where, and why — or null when nothing is blocked. */
export function blockerLine(blocker: BridgeTaskBlocker | undefined): string | null {
  if (!blocker) return null;
  const what = BLOCKER_TYPE_LABEL[blocker.type] ?? blocker.type;
  const where = BLOCKER_PHASE_LABEL[blocker.phase] ?? blocker.phase;
  const reason = blocker.reason.trim();
  return reason ? `${what} ${where} — ${reason}` : `${what} ${where}`;
}

/**
 * What the director concluded, and how sure it was.
 *
 * The confidence is printed because the decision alone reads as certainty: "assign" at 0.4 and
 * "assign" at 0.95 are the same word about two different situations.
 */
export function intakeLine(intake: BridgeTaskIntake | undefined): string | null {
  if (!intake) return null;
  const decision =
    intake.decision === "assign"
      ? "Assign to an agent"
      : intake.decision === "ask-human"
        ? "Ask you first"
        : "Blocked";
  const confidence = Math.round(Math.max(0, Math.min(1, intake.confidence)) * 100);
  return `${decision} · ${confidence}% confident`;
}

export interface SubTaskProgress {
  done: number;
  total: number;
}

/** `null` when there are no subtasks — a 0/0 counter is a claim that there was a checklist. */
export function subTaskProgress(
  subtasks: readonly BridgeSubTask[] | undefined,
): SubTaskProgress | null {
  if (!subtasks || subtasks.length === 0) return null;
  return {
    done: subtasks.filter((subtask) => subtask.status === "completed").length,
    total: subtasks.length,
  };
}

/**
 * Whether this task carries anything an agent wrote.
 *
 * Used to decide between "nothing has happened to this task yet" and an empty history, which are
 * different facts: the first is true of a task typed a second ago, and the second would be a bug.
 */
export function taskHasRecord(task: Pick<BridgeTask, "intake" | "blocker" | "feedbackEvents">): boolean {
  return Boolean(task.intake || task.blocker || (task.feedbackEvents?.length ?? 0) > 0);
}

/** Case, runs of spaces and trailing punctuation do not make two titles different. */
function sameTitle(a: string, b: string): boolean {
  const norm = (value: string) =>
    value.trim().replace(/\s+/g, " ").replace(/[.:!?]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The description, minus a first line that only repeats the title.
 *
 * Agents and pasted briefs usually open with `# <the title>`. Drawn under a title that already
 * says it, that line is the same sentence twice at two sizes — the first thing the eye meets on
 * the page, and pure noise. Only an EXACT repeat is dropped; a heading that says anything else is
 * the author's structure and stays.
 */
export function stripRepeatedTitle(markdown: string, title: string): string {
  const lines = markdown.replace(/^\s+/, "").split("\n");
  const first = lines[0] ?? "";
  const heading = first.replace(/^#{1,6}\s+/, "");
  if (!sameTitle(heading, title)) return markdown;
  return lines.slice(1).join("\n").replace(/^\s+/, "");
}

export interface ListPosition {
  /** One-based, as it is printed: "2 / 3". */
  index: number;
  total: number;
  prev: string | null;
  next: string | null;
}

/**
 * Where the open task sits in the list as it is currently DRAWN — filters and sort applied — so
 * the ↑ ↓ in the detail bar walk the same rows the eye just left. `null` when the filters hide it:
 * a position in a list that does not show the task would be a number about nothing.
 */
export function listPosition(ids: readonly string[], current: string): ListPosition | null {
  const at = ids.indexOf(current);
  if (at < 0) return null;
  return {
    index: at + 1,
    total: ids.length,
    prev: at > 0 ? ids[at - 1] : null,
    next: at < ids.length - 1 ? ids[at + 1] : null,
  };
}
