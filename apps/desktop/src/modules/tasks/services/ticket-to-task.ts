import { TASK_GOAL_CAP, TASK_TITLE_CAP, cutToBytes } from "@/modules/tasks/services/task-draft";
import { statusIsOpen, type StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import type { VaultTicketDetail } from "@/modules/tasks/services/vault-api";
import type { TrackerTask } from "@/modules/tasks/types";
import type { TaskSource } from "@/modules/codespace/services/bridge/task-store";

/**
 * A vault ticket, turned into a Lotus task that can be worked.
 *
 * The vault stays read-only: nothing here writes a byte back to it. Delegating a ticket creates a
 * task ALONGSIDE it, and that task is where the machinery lives — the pane binding, the history an
 * agent writes, the session that can be resumed. The vault goes on being the human's record and
 * Notion goes on being the team's; neither learns about panes, and neither has to.
 */

export interface TicketTaskDraft {
  title: string;
  goal: string;
  knowledge: string;
  source: TaskSource;
}

export function taskDraftFromTicket(detail: VaultTicketDetail): TicketTaskDraft {
  const { ticket, sections } = detail;

  // The key stays in the title because that is what the work is called out loud — in a commit
  // message, in a standup, in Notion.
  const title = cutToBytes(`${ticket.ticket} — ${ticket.title}`.trim(), TASK_TITLE_CAP);

  /*
    The goal is what the ticket OPENS with: the preamble is the Notion description, and when there
    is none the first named section is the nearest thing to a statement of intent. It is cut to the
    store's 500 bytes, visibly — `validate_create` refuses a longer one, so cutting it here is the
    difference between a task that reads oddly and a write that fails.
  */
  const opening = sections.find((section) => section.body.trim())?.body.trim() ?? "";
  const goal = cutToBytes(opening || `Work ${ticket.ticket}.`, TASK_GOAL_CAP);

  // Everything, headings and all: the goal is cut to fit, and the worker still gets what was said.
  const knowledge = sections
    .map((section) => (section.heading ? `## ${section.heading}\n\n${section.body}` : section.body))
    .join("\n\n")
    .trim();

  return {
    title,
    goal,
    knowledge,
    source: {
      kind: "vault",
      // The FILE, not the key: two files in the real vault both say `ticket: DRAFT`, and a key
      // cannot reopen the right one.
      ref: ticket.file,
      label: ticket.ticket,
    },
  };
}

/**
 * The tasks a ticket has become, in any workspace, finished or not — what the ticket's page lists.
 * Matched by FILE, like the source itself: two files in the real vault share `ticket: DRAFT`.
 */
export function tasksFromTicket(tasks: readonly TrackerTask[], file: string): TrackerTask[] {
  return tasks.filter((task) => task.sourceRef === file);
}

/**
 * The task a Delegate should hand on, rather than making another.
 *
 * Delegating a ticket twice used to make two tasks, each with half the history. A task from this
 * ticket that is still open in the chosen workspace is where the work already is, so the next agent
 * joins it there. Finished work is left finished: picking a ticket up again after a task was closed
 * is new work, and a new task says so.
 */
export function taskToReuseForTicket(
  tasks: readonly TrackerTask[],
  file: string,
  projectId: string,
  vocabularyOf: (task: TrackerTask) => StatusVocabulary,
): TrackerTask | null {
  return (
    tasksFromTicket(tasks, file).find(
      (task) => task.projectId === projectId && statusIsOpen(vocabularyOf(task), task.status),
    ) ?? null
  );
}
