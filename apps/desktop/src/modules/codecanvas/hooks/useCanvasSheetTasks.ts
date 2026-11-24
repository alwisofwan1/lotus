"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Node } from "@xyflow/react";
import { trackerTaskKey } from "@/modules/tasks/services/task-mapping";
import { LOTUS_VOCABULARY, statusIsOpen, statusLabel } from "@/modules/tasks/services/task-vocabulary";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import type { SharedTrackerBoard } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
import type { SheetTrackerTask } from "../services/commands/command-sheet-items";

/**
 * ⌘K "From Tasks…" (`plans/canvas-dock/` board 18, decision 6): the open tasks on the window's
 * tracker board, as command-sheet rows. A row places the task as a linked Task node; a task that
 * already has one on this board centres that node instead of drawing it twice.
 */

export interface UseCanvasSheetTasksOptions {
  nodes: readonly Node[];
  shared: SharedTrackerBoard | null;
  /** The workspace in this board's folder: its tasks are listed first. */
  boardWorkspaceId: string | null;
  addTaskNode: (seed: { title: string; taskId: string; taskWorkspaceId: string }) => string;
  revealNode: (nodeId: string) => void;
  /** ⌘↵ on a row: also open the task's row in the Dock's Tasks. */
  openInDock?: (taskId: string) => void;
}

/** Open tasks, this board's workspace first, then the most recently touched. Pure, for tests. */
export function sheetTrackerTasks(
  tasks: readonly TrackerTask[],
  projectsById: ReadonlyMap<string, TrackerProject>,
  linkedNodes: ReadonlyMap<string, string>,
  boardWorkspaceId: string | null,
): SheetTrackerTask[] {
  return tasks
    .filter((task) => statusIsOpen(projectsById.get(task.projectId)?.vocabulary ?? LOTUS_VOCABULARY, task.status))
    .sort((a, b) => {
      const home = Number(b.projectId === boardWorkspaceId) - Number(a.projectId === boardWorkspaceId);
      return home !== 0 ? home : b.updatedAt - a.updatedAt;
    })
    .map((task) => {
      const project = projectsById.get(task.projectId);
      return {
        id: task.id,
        workspaceId: task.projectId,
        title: task.title,
        key: trackerTaskKey(task, projectsById),
        workspaceName: project?.name ?? task.projectId,
        statusLabel: statusLabel(project?.vocabulary ?? LOTUS_VOCABULARY, task.status),
        nodeId: linkedNodes.get(task.id) ?? null,
      };
    });
}

export function useCanvasSheetTasks({ nodes, shared, boardWorkspaceId, addTaskNode, revealNode, openInDock }: UseCanvasSheetTasksOptions) {
  const board = shared?.board ?? null;
  // Keyed on a signature: `nodes` is a new array on every drag.
  const linkKey = nodes
    .flatMap((node) => {
      const taskId = node.type === "task" ? (node.data as { taskId?: string }).taskId : undefined;
      return taskId ? [`${taskId}\u0000${node.id}`] : [];
    })
    .join("\u0001");
  const linkedNodes = useMemo(
    () => new Map(linkKey ? linkKey.split("\u0001").map((entry) => entry.split("\u0000") as [string, string]) : []),
    [linkKey],
  );
  const trackerTasks = useMemo(
    () => (board && !board.loading ? sheetTrackerTasks(board.tasks, board.projectsById, linkedNodes, boardWorkspaceId) : undefined),
    [board, linkedNodes, boardWorkspaceId],
  );
  // The page passes fresh closures each render; the callback it gets back stays one identity.
  const live = useRef({ addTaskNode, revealNode, openInDock });
  useEffect(() => {
    live.current = { addTaskNode, revealNode, openInDock };
  }, [addTaskNode, revealNode, openInDock]);
  const placeTask = useCallback((task: SheetTrackerTask, options?: { openInDock?: boolean }) => {
    // Title, status and priority follow the task once placed (useCanvasTaskLinks).
    const nodeId = task.nodeId ?? live.current.addTaskNode({ title: task.title, taskId: task.id, taskWorkspaceId: task.workspaceId });
    live.current.revealNode(nodeId);
    if (options?.openInDock) live.current.openInDock?.(task.id);
  }, []);
  return { trackerTasks, placeTask: board ? placeTask : undefined, linkedNodes };
}
