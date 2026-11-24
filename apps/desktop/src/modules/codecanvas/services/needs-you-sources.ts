/**
 * The Dock apps' asks, as the one Needs-you queue lists them (`plans/canvas-dock/` S5). Pure: the
 * host passes how each one opens, so this file knows what waits, not where it is answered.
 */

import { isAsk, type AutomationDraft } from "@/modules/automation";
import { factoryCardLine, factoryRefLabel, type FactoryRunRow } from "@/modules/factory";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { NeedsYouAsk } from "./needs-you-queue";

/**
 * When a run started waiting: the end of its last step (the agent stopped, the run turned to you),
 * else its last reported output, else its start. A run has no "asked at" of its own, and this is
 * the latest moment the app knows it was still working.
 */
export function factoryAskedAt(row: Pick<FactoryRunRow, "startedAt" | "progress">): number {
  const last = row.progress?.steps.at(-1);
  return last?.endedAt ?? row.progress?.lastOutput?.at ?? row.startedAt;
}

/** The runs in the `needs-you` group: the same set the Dock's Factory badge counts. */
export function factoryNeedsYouAsks(rows: readonly FactoryRunRow[], open: (row: FactoryRunRow) => void): NeedsYouAsk[] {
  return rows
    .filter((row) => row.group === "needs-you")
    .map((row) => ({
      id: `factory:${row.id}`,
      source: "factory" as const,
      name: `${factoryRefLabel(row.issue)} ${row.title}`,
      line: factoryCardLine(row),
      askedAtMs: factoryAskedAt(row),
      onOpen: () => open(row),
    }));
}

/** What a waiting Automation row is for, in the lane's few words. */
export function automationAskLine(draft: AutomationDraft): string {
  if (isAsk(draft)) return "Asks you a question";
  if (draft.kind === "pr_review") return "Review ready to send";
  return "Result to read";
}

/** The Inbox's waiting rows (`waitingItems`), one ask each. */
export function automationNeedsYouAsks(waiting: readonly AutomationDraft[], open: (draft: AutomationDraft) => void): NeedsYouAsk[] {
  return waiting.map((draft) => ({
    id: `automation:${draft.id}`,
    source: "automation" as const,
    name: draft.subject,
    line: automationAskLine(draft),
    askedAtMs: draft.createdAtMs,
    onOpen: () => open(draft),
  }));
}

/**
 * Lotus tasks in review: a worker reported and waits for the person's ack. A ticket source's own
 * `in-review` is the team's word for a PR under review, not a question to this person, so only a
 * workspace's tasks (a project with no `source`) count.
 */
export function tasksInReview(tasks: readonly TrackerTask[], projectsById: ReadonlyMap<string, TrackerProject>): TrackerTask[] {
  return tasks.filter((task) => task.status === "in-review" && projectsById.has(task.projectId) && !projectsById.get(task.projectId)?.source);
}

/** Each task in review, as `INT-2 Title`, waiting since its last update. */
export function taskNeedsYouAsks(
  tasks: readonly TrackerTask[],
  projectsById: ReadonlyMap<string, TrackerProject>,
  open: (task: TrackerTask) => void,
): NeedsYouAsk[] {
  return tasksInReview(tasks, projectsById).map((task) => {
    const prefix = projectsById.get(task.projectId)?.prefix;
    const key = task.key ?? (prefix && task.number !== undefined ? `${prefix}-${task.number}` : null);
    return {
      id: `task:${task.id}`,
      source: "task" as const,
      name: key ? `${key} ${task.title}` : task.title,
      line: "In review: waiting for your ack",
      askedAtMs: task.updatedAt,
      onOpen: () => open(task),
    };
  });
}
