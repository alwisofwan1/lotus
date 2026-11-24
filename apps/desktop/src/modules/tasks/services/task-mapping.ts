import { githubIssueKey } from "@/modules/tasks/services/github-issues-source";
import { formatTaskKey } from "@/modules/tasks/services/task-key";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";

/**
 * The one place the stored task and the tracker's row meet.
 *
 * Same arrangement as `cell-mapping.ts` in the shell, and for the same reason: the list, the
 * sections and the counts stay pure functions over a small shape, and there is exactly one answer
 * to "what does a stored task look like on a row".
 */

export function toTrackerTask(task: BridgeTask): TrackerTask {
  return {
    id: task.id,
    projectId: task.workspaceId,
    number: task.number,
    title: task.title,
    status: task.status,
    priority: task.priority,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    cellId: task.cellId,
    sourceRef: task.source?.ref,
    position: task.position,
  };
}

/**
 * The key a row prints, given the projects it might belong to.
 *
 * `null` when the project is unknown to this window or the task predates numbering — the row then
 * shows its title alone rather than a key it cannot stand behind.
 */
export function trackerTaskKey(
  task: TrackerTask,
  projects: ReadonlyMap<string, TrackerProject>,
): string | null {
  // A row that brought its own name keeps it. Only a task whose key is DERIVED asks its project.
  if (task.key) return task.key;
  const project = projects.get(task.projectId);
  if (!project) return null;
  // A GitHub issue is `#123`: its number is its name, and it has no prefix (ADR-0048 §5).
  if (project.source?.kind === "github") return githubIssueKey(task.number);
  return formatTaskKey(project.prefix, task.number);
}

/** Projects by id, which is how every row looks its own up. */
export function indexProjects(projects: readonly TrackerProject[]): Map<string, TrackerProject> {
  return new Map(projects.map((project) => [project.id, project]));
}
