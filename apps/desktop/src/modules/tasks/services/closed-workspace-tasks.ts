import { tauriInvoke } from "@/lib/tauri/runtime";
import type { InvokeFn } from "@/modules/codespace/services/bridge/task-api";

/**
 * A task file no open workspace owns.
 *
 * Before a reopened folder kept its workspace id, every reopen minted a new one, and the tasks
 * written under the old id stayed on disk where nothing read them. Lotus keeps no record linking
 * those ids to folders, so recovery is the user's choice: they are listed, and moved on request.
 */
export interface OrphanTaskFile {
  workspaceId: string;
  taskCount: number;
  /** Not complete or cancelled — what the user is actually missing. */
  openCount: number;
  lastUpdatedAt: number;
  /** A few open titles: the uuid means nothing to anyone, its tasks are how it is recognised. */
  sampleTitles: string[];
  /** Hidden by the user. Its file is untouched, so the tasks load again if the workspace reopens. */
  ignored: boolean;
}

export interface MovedTasks {
  moved: number;
  /** Left behind because the target already has a task with that title (the hand-copied ones). */
  skippedDuplicates: number;
}

export interface ClosedWorkspaceTaskClient {
  list: (openWorkspaceIds: readonly string[]) => Promise<readonly OrphanTaskFile[]>;
  move: (fromWorkspaceId: string, toWorkspaceId: string) => Promise<MovedTasks>;
  setIgnored: (workspaceId: string, ignored: boolean) => Promise<void>;
  /** Retires the file (restorable by hand); Rust refuses any id in `openWorkspaceIds`. */
  remove: (workspaceId: string, openWorkspaceIds: readonly string[]) => Promise<void>;
}

export function createTauriClosedWorkspaceTaskClient(
  invokeFn: InvokeFn = tauriInvoke as InvokeFn,
): ClosedWorkspaceTaskClient {
  return {
    async list(openWorkspaceIds) {
      return await invokeFn<OrphanTaskFile[]>("bridge_list_orphan_task_files", {
        openWorkspaceIds,
      });
    },
    async move(fromWorkspaceId, toWorkspaceId) {
      return await invokeFn<MovedTasks>("bridge_move_workspace_tasks", {
        fromWorkspaceId,
        toWorkspaceId,
      });
    },
    async setIgnored(workspaceId, ignored) {
      await invokeFn<void>("bridge_set_orphan_task_file_ignored", { workspaceId, ignored });
    },
    async remove(workspaceId, openWorkspaceIds) {
      await invokeFn<void>("bridge_delete_orphan_task_file", { workspaceId, openWorkspaceIds });
    },
  };
}

/** The first block of a uuid is enough to tell two files apart, and fits the nav column. */
export function shortWorkspaceId(workspaceId: string): string {
  return workspaceId.split("-")[0] ?? workspaceId;
}

export function describeMove(result: MovedTasks, targetName: string): string {
  const moved = `Moved ${result.moved} into ${targetName}`;
  return result.skippedDuplicates > 0
    ? `${moved} · ${result.skippedDuplicates} already there`
    : moved;
}
