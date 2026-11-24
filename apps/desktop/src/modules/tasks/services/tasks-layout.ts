import type { TaskSort } from "@/modules/tasks/services/task-list";
import type { FilterIdentity, TaskFilterRule } from "@/modules/tasks/services/task-filters";

/**
 * The part of a host's saved layout that Tasks reads and writes. Its own type, so the surface
 * needs no shell: Code passes its `ShellLayoutPreferences` and the Canvas Dock the same one, and
 * each keeps the fields Tasks never touches (ADR-0060, "host-neutral part and shell glue").
 */
export interface TasksLayout {
  taskNavWidth: number;
  taskNavVisible: boolean;
  taskHideDone: boolean;
  taskSort: TaskSort;
  ticketOrder: Record<string, number>;
  taskFilters: Record<string, TaskFilterRule[]>;
  taskMe: FilterIdentity | null;
}
