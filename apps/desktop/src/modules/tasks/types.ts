import type { StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import type { TicketSourceMeta } from "@/modules/tasks/services/ticket-sources";
import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * A task as the tracker draws it.
 *
 * Narrower than `BridgeTask` on purpose. The stored task carries everything the agent flow needs —
 * goal, knowledge, intake, blocker, feedback events, subtasks — and a list row needs none of it.
 * Keeping the row's shape small is what lets grouping, sorting and filtering be pure functions
 * with tests that read like sentences, instead of fixtures the size of a real task.
 */
export interface TrackerTask {
  id: string;
  /** The project this task belongs to. In Lotus a project IS a workspace. */
  projectId: string;
  /**
   * The number in its project, which is half of the key people speak (`INT-2`).
   *
   * Optional because the store did not number tasks before this work: a task written by an older
   * build has none, and the row draws no key rather than inventing one.
   */
  number?: number;
  /**
   * The key this row prints, when the row carries its own rather than deriving one.
   *
   * A Lotus task derives `INT-2` from its project's prefix and its number, because a workspace has
   * exactly one prefix. A vault does not: the real one holds 76 `TKT-*` beside 2 `DRAFT`, so a
   * single prefix on the project would print `TKT-?` over a ticket that is not an TKT at all. The
   * ticket brings its own name, and this is where it lands.
   */
  key?: string;
  title: string;
  status: BridgeTaskStatus;
  priority: BridgePriority;
  createdAt: number;
  updatedAt: number;
  /**
   * The pane executing this task right now, if one is.
   *
   * This is what the rail's `Active` count means: not "in progress" (a status someone set and may
   * have walked away from) but "a process is on it this second".
   */
  cellId?: string;
  /**
   * The file this task was made from, when it was made from a vault ticket — which is how the
   * ticket finds the tasks it has become, and how a second Delegate reuses one.
   */
  sourceRef?: string;
  /** Its place when the list is ordered by hand. Absent until first moved. */
  position?: number;
  /**
   * The people on it, as its source names them. Absent — not empty — where the source has no such
   * field at all (a Lotus task), which is how Filters knows not to offer "Assignee" over nobody.
   */
  assignees?: { id: string; name: string }[];
  /** Its labels (a Notion multi-select, a vault ticket's `tags:`). Absent where there are none to have. */
  labels?: string[];
}

/**
 * A project in the tracker.
 *
 * `prefix` is stored rather than derived at render time: it is the name people speak, it has to
 * survive a rename of the folder, and two projects must never share one.
 */
export interface TrackerProject {
  id: string;
  name: string;
  prefix: string;
  /**
   * The words this project's tasks are in.
   *
   * A property of the project rather than a constant of the app, because a project's statuses are
   * its own: a workspace speaks Lotus's six, an Obsidian vault speaks its seven, and three of the
   * vault's have no Lotus equivalent at all. Translating between them would flatten two columns of
   * the human's board into one — the same failure as the missing `blocked`, made on purpose.
   */
  vocabulary: StatusVocabulary;
  /**
   * What can be done to this project from here. Absent means a Lotus workspace, which can do all
   * of it; a source that cannot says which parts, one by one.
   *
   * This replaced a single `readOnly` flag that had come to mean three things — "rows cannot be
   * changed", "cannot hold a new task", "cannot be reordered" — and stopped being true of the vault
   * the day its tickets became editable on their own page. The list kept obeying it and the page
   * did not, so the same ticket was editable in one place and frozen in the other.
   */
  capabilities?: ProjectCapabilities;
  /** The dot on every row of this project, as the screenshot shows. */
  color?: string;
  /**
   * Set when this project is a ticket source — an Obsidian vault, a Notion database — rather than a
   * workspace. Absent means a workspace. This is what the tracker asks instead of comparing ids
   * with the vault's, so a second kind of source needs no new special case.
   */
  source?: TicketSourceMeta;
}

export interface ProjectCapabilities {
  /** A new Lotus task can be made here — by the composer, or by delegating a ticket into it. */
  holdsTasks: boolean;
  /** A row's status and title can be changed from the list. */
  editRows: boolean;
  /** Rows can be put in an order by hand. */
  reorder: boolean;
  /** Its rows carry a priority at all. A vault ticket has none, and must not be offered one. */
  hasPriority: boolean;
}

/** A Lotus workspace: its tasks are Lotus's own, and every part of them is. */
export const WORKSPACE_CAPABILITIES: ProjectCapabilities = {
  holdsTasks: true,
  editRows: true,
  reorder: true,
  hasPriority: true,
};

/** What this project allows, reading an absent set as a workspace's. */
export function capabilitiesOf(project: Pick<TrackerProject, "capabilities"> | undefined): ProjectCapabilities {
  return project?.capabilities ?? WORKSPACE_CAPABILITIES;
}
