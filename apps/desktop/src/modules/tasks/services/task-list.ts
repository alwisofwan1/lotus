import {
  LOTUS_VOCABULARY,
  statusIsOpen,
  statusLabel,
  statusTone,
  type StatusVocabulary,
  taskPriorityRank,
  type TaskStatusTone,
} from "@/modules/tasks/services/task-vocabulary";
import { taskLiveness } from "@/modules/tasks/services/task-liveness";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * What the list does to a pile of tasks: filter it, order it, cut it into sections, count it.
 *
 * All pure, and all separate. bb keeps the same split (`views/list/lib.ts`, `sorting.tsx`,
 * `optimistic.ts`) and the reason shows the moment a bug arrives: "the wrong tasks are showing",
 * "they are in the wrong order" and "the count is wrong" are three questions, and a single
 * function that did all three would answer none of them under a test.
 */

export interface TaskListFilter {
  /** Empty or absent means every status — a filter nobody set must not hide anything. */
  statuses?: ReadonlySet<BridgeTaskStatus>;
  priorities?: ReadonlySet<BridgePriority>;
  projectIds?: ReadonlySet<string>;
  /** Free text over the title and the key. */
  query?: string;
  /** Hide what is finished. The rail's `Active`/`All` switch, in one flag. */
  openOnly?: boolean;
}

export type TaskSort = "priority" | "recent" | "number" | "manual";

export interface TaskSection {
  /**
   * `string`, not `BridgeTaskStatus`: a vault ticket is `qa-revision`, a word Lotus's union does
   * not contain and must not be widened to contain. The section carries whatever its project says.
   */
  status: string;
  label: string;
  tone: TaskStatusTone;
  tasks: TrackerTask[];
}

/** Case- and whitespace-insensitive, because this is fed by typing. */
function matchesQuery(task: TrackerTask, keyOf: (task: TrackerTask) => string | null, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (task.title.toLowerCase().includes(needle)) return true;
  const key = keyOf(task);
  return key ? key.toLowerCase().includes(needle) : false;
}

export interface FilterOptions {
  /** How to render a task's key, so a search for "INT-2" can find it. */
  keyOf?: (task: TrackerTask) => string | null;
  /**
   * Which words decide "finished", for each task. Required only by `openOnly`, which is the one
   * filter whose answer is not in the task itself: `released` ends a vault ticket and means
   * nothing to a Lotus one.
   */
  vocabularyOf?: (task: TrackerTask) => StatusVocabulary;
}

export function filterTasks(
  tasks: readonly TrackerTask[],
  filter: TaskListFilter = {},
  { keyOf = () => null, vocabularyOf = () => LOTUS_VOCABULARY }: FilterOptions = {},
): TrackerTask[] {
  return tasks.filter((task) => {
    // An EMPTY set is treated as "no filter", not as "match nothing". A chip someone opened and
    // closed again without choosing must leave the list as it found it.
    if (filter.statuses?.size && !filter.statuses.has(task.status)) return false;
    if (filter.priorities?.size && !filter.priorities.has(task.priority)) return false;
    if (filter.projectIds?.size && !filter.projectIds.has(task.projectId)) return false;
    if (filter.openOnly && !statusIsOpen(vocabularyOf(task), task.status)) return false;
    if (filter.query && !matchesQuery(task, keyOf, filter.query)) return false;
    return true;
  });
}

/**
 * Order inside one section.
 *
 * Every comparator ends on the same tie-breaker — the task's own number, then its id — because a
 * list that reorders equal rows between two renders is a list you cannot point at. `recent` sorts
 * newest first; the other two ascend.
 */
export function sortTasks(tasks: readonly TrackerTask[], sort: TaskSort = "priority"): TrackerTask[] {
  const stable = (left: TrackerTask, right: TrackerTask): number =>
    (left.number ?? Number.MAX_SAFE_INTEGER) - (right.number ?? Number.MAX_SAFE_INTEGER) ||
    left.id.localeCompare(right.id);

  return [...tasks].sort((left, right) => {
    if (sort === "manual") return manualPlace(left) - manualPlace(right) || stable(left, right);
    if (sort === "recent") return right.updatedAt - left.updatedAt || stable(left, right);
    if (sort === "number") return stable(left, right);
    return taskPriorityRank(left.priority) - taskPriorityRank(right.priority) || stable(left, right);
  });
}

/**
 * Where a row sits in the manual order.
 *
 * A row never moved sits where its number puts it — the order tasks were made in, which is the
 * order a manual list starts from. The two share one scale, so a row dragged between two unmoved
 * rows takes the midpoint of their numbers and the rest need no write at all.
 */
function manualPlace(task: TrackerTask): number {
  return task.position ?? task.number ?? Number.MAX_SAFE_INTEGER;
}

/** Below this, two neighbours are too close to split again: the section is laid out afresh. */
const MIN_GAP = 1e-6;

export interface PositionWrite {
  id: string;
  position: number;
}

/**
 * What to write when one row of a section is moved to `toIndex`.
 *
 * `section` is the rows as drawn, top to bottom, in manual order. Usually one write: the moved
 * row takes the midpoint of its new neighbours, or one past the end it was moved to. Only when
 * those neighbours have been split so often that no room is left is the whole section renumbered
 * 1, 2, 3… — and even then a row already at its number is left alone.
 */
export function reorderWrites(
  section: readonly TrackerTask[],
  movedId: string,
  toIndex: number,
): PositionWrite[] {
  const from = section.findIndex((task) => task.id === movedId);
  if (from === -1 || from === toIndex) return [];

  const rest = section.filter((task) => task.id !== movedId);
  const at = Math.max(0, Math.min(toIndex, rest.length));
  const above = at > 0 ? manualPlace(rest[at - 1]) : null;
  const below = at < rest.length ? manualPlace(rest[at]) : null;

  if (above === null && below === null) return [];
  if (above === null) return [{ id: movedId, position: below! - 1 }];
  if (below === null) return [{ id: movedId, position: above + 1 }];
  if (below - above > MIN_GAP) return [{ id: movedId, position: (above + below) / 2 }];

  const order = [...rest.slice(0, at), section[from], ...rest.slice(at)];
  return order
    .map((task, index) => ({ task, position: index + 1 }))
    .filter(({ task, position }) => manualPlace(task) !== position)
    .map(({ task, position }) => ({ id: task.id, position }));
}

/**
 * Cut the list into the sections the screenshot shows.
 *
 * Empty sections are dropped rather than drawn: "Done 0" is a row of chrome that tells you
 * nothing, and with five statuses a young project would be four-fifths empty headings.
 *
 * A status this build does not know still gets a section — at the end, labelled by its own raw
 * value. The vocabulary can grow in the store (or in an MCP tool) without a desktop release, and
 * silently dropping those tasks would hide work rather than show it late.
 */
export function groupTasksByStatus(
  tasks: readonly TrackerTask[],
  sort: TaskSort,
  vocabulary: StatusVocabulary,
): TaskSection[] {
  const byStatus = new Map<string, TrackerTask[]>();
  for (const task of tasks) {
    const bucket = byStatus.get(task.status);
    if (bucket) bucket.push(task);
    else byStatus.set(task.status, [task]);
  }

  const known = vocabulary.order.filter((status) => byStatus.has(status));
  const unknown = [...byStatus.keys()]
    .filter((status) => !vocabulary.order.includes(status))
    .sort((left, right) => left.localeCompare(right));

  return [...known, ...unknown].map((status) => ({
    status,
    label: statusLabel(vocabulary, status),
    tone: statusTone(vocabulary, status),
    tasks: sortTasks(byStatus.get(status) ?? [], sort),
  }));
}

/** Is a process on this task at this second? */
function isRunningNow(
  task: TrackerTask,
  activities: ReadonlyMap<string, PaneActivityState> | undefined,
): boolean {
  if (!task.cellId) return false;
  if (!activities) return true;
  const liveness = taskLiveness(task, activities);
  if (liveness.kind !== "running") return false;
  return liveness.activity !== "done" && liveness.activity !== "failed";
}

/**
 * Active: a pane is moving on this task right now, and the task is still open.
 *
 * The ONE definition, shared by the `Active` count and the `Active` list. They once answered it
 * differently — the count asked the panes, the list trusted `cellId` — so a binding that was never
 * released put a task in the list that the number beside it did not count.
 */
export function isActiveTask(
  task: TrackerTask,
  vocabulary: StatusVocabulary,
  activities?: ReadonlyMap<string, PaneActivityState>,
): boolean {
  return statusIsOpen(vocabulary, task.status) && isRunningNow(task, activities);
}

export interface ProjectGroup {
  project: TrackerProject;
  sections: TaskSection[];
  /** How many of this project's tasks survived the filter. */
  total: number;
}

/**
 * Project first, status inside it.
 *
 * Grouping by status across projects would have to rank words from different vocabularies against
 * each other — is Lotus's `blocked` above or below the vault's `qa-revision`? They are never
 * neighbours in any vocabulary, so any answer is invented. One project at a time means one
 * vocabulary at a time, and the question never arises.
 *
 * Projects keep the order they were given, which is the order the rail shows them in. A project
 * with nothing left after filtering is dropped, for the same reason an empty status section is:
 * a heading over nothing tells you only how long a list of headings is.
 */
export function groupTasksByProject(
  tasks: readonly TrackerTask[],
  projects: readonly TrackerProject[],
  sort: TaskSort,
): ProjectGroup[] {
  const byProject = new Map<string, TrackerTask[]>();
  for (const task of tasks) {
    const bucket = byProject.get(task.projectId);
    if (bucket) bucket.push(task);
    else byProject.set(task.projectId, [task]);
  }

  return projects
    .map((project) => {
      const owned = byProject.get(project.id) ?? [];
      return {
        project,
        sections: groupTasksByStatus(owned, sort, project.vocabulary),
        total: owned.length,
      };
    })
    .filter((group) => group.total > 0);
}

/**
 * "Which words does this task speak?", answered by its own project.
 *
 * One function for every caller that counts across projects. The sidebar badge once passed Lotus's
 * words for every row, vault tickets included — so a ticket in `in-review` counted as open and one
 * in `qa-revision` did not. A project this board has not heard of speaks Lotus's words, which is
 * what every workspace speaks.
 */
export function vocabularyByProject(
  projectsById: ReadonlyMap<string, TrackerProject>,
): (task: TrackerTask) => StatusVocabulary {
  return (task) => projectsById.get(task.projectId)?.vocabulary ?? LOTUS_VOCABULARY;
}

export interface TaskCounts {
  /** Everything the filter let through. */
  total: number;
  /** Still someone's problem — todo, in progress, in review. */
  open: number;
  /** A pane is executing it right now. */
  active: number;
}

/**
 * `vocabularyOf` rather than one vocabulary, because this counts across every project at once —
 * it is what the sidebar badge shows. "Open" is a different set of words in each project, and
 * answering from one of them would count 37 released vault tickets as work still waiting.
 */
export function countTasks(
  tasks: readonly TrackerTask[],
  vocabularyOf: (task: TrackerTask) => StatusVocabulary,
  /**
   * The panes this window is actually holding.
   *
   * Optional, and its absence is answered honestly: without it there is nothing better to go on
   * than the task's own claim, and reporting zero would be a worse answer than the old one.
   */
  activities?: ReadonlyMap<string, PaneActivityState>,
): TaskCounts {
  let open = 0;
  let active = 0;
  for (const task of tasks) {
    const vocabulary = vocabularyOf(task);
    if (statusIsOpen(vocabulary, task.status)) open += 1;
    /*
      `cellId` is a CLAIM: written on dispatch, never taken back. Asked of the panes this window
      actually holds, it becomes an observation — which is the difference between "was dispatched
      once" and "is moving right now", and the whole point of the number.
    */
    if (isActiveTask(task, vocabulary, activities)) active += 1;
  }
  return { total: tasks.length, open, active };
}
