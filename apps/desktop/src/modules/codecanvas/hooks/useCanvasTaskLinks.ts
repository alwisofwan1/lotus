"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Node } from "@xyflow/react";
import { createTauriAutomationClient } from "@/modules/automation/services/automation-api";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import type { FindIssueCheckout } from "@/modules/tasks/hooks/useIssueCheckout";
import { useDelegation } from "@/modules/tasks/hooks/useDelegation";
import { EACH_TASK_WORKSPACE } from "@/modules/codespace/services/task-execution/useTaskExecution";
import { workspaceInFolder } from "@/modules/tasks/services/delegation-target";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import { trackerTaskKey } from "@/modules/tasks/services/task-mapping";
import type { TaskSpawner } from "@/modules/tasks/services/task-spawner";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { ticketDelegateOptions } from "@/modules/tasks/services/ticket-delegate-options";
import { capabilitiesOf, type TrackerTask } from "@/modules/tasks/types";
import type { SharedTrackerBoard } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
import type { CanvasTaskLinks } from "../components/nodes/canvas-task-links-context";
import type { CanvasTaskNodeData } from "../types/canvas";

/**
 * The canvas half of a linked Task node (`plans/canvas-dock/` board 18): what its node reads from
 * the window's one tracker board, and the writes it makes through it.
 *
 * - Status and title write the task record (`editTask` → `bridge_update_task`); the node's own
 *   copy follows the board, so a board opened offline still shows the last known values.
 * - Delegate is the Dock's: the same presets, the same canvas spawner (S4b), the same deny rules
 *   for a Notion or GitHub task (`ticketDelegateOptions`).
 * - The live line is the board's activities — the map the Tasks row reads.
 */

export interface UseCanvasTaskLinksOptions {
  nodes: readonly Node[];
  shared: SharedTrackerBoard | null;
  spawner: TaskSpawner | null;
  /** The board's folder: "Add to Tasks" files a local node in the workspace there. */
  rootDir: string;
  openInDock: (taskId: string) => void;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** Why Delegate cannot run while there is no spawner. */
  unavailable: string;
  /** Tests pass their own; the app's is the Tauri client's. */
  findCheckout?: FindIssueCheckout;
}

const leafOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function useCanvasTaskLinks({
  nodes,
  shared,
  spawner,
  rootDir,
  openInDock,
  patchNodeData,
  unavailable,
  findCheckout,
}: UseCanvasTaskLinksOptions): CanvasTaskLinks | null {
  const board = shared?.board ?? null;
  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  const editTask = board?.editTask;
  const updateTask = useCallback(
    (taskId: string, patch: Parameters<NonNullable<typeof editTask>>[1]) => editTask?.(taskId, patch) ?? Promise.resolve(null),
    [editTask],
  );
  // No one host workspace: each node's task brings its own.
  const delegation = useDelegation(
    EACH_TASK_WORKSPACE,
    spawner?.openPane ?? spawner?.addPane ?? null,
    updateTask,
    undefined,
    unavailable,
    spawner?.launchesAgentDirectly,
  );
  const find = useMemo<FindIssueCheckout>(() => {
    if (findCheckout) return findCheckout;
    const client = createTauriAutomationClient();
    return (repo, workspaces, preferred, options) => client.findCheckout(repo, workspaces, preferred, options);
  }, [findCheckout]);

  const tasksById = useMemo(() => new Map((board?.tasks ?? []).map((task) => [task.id, task])), [board?.tasks]);

  // A task's pane, when it is one of this board's terminals: the runner, and the node to centre.
  // Keyed on a signature: `nodes` is a new array on every drag, and every task node reads this.
  const terminalKey = nodes
    .flatMap((node) => {
      if (node.type !== "terminal") return [];
      const data = node.data as { runtimePaneId?: string; launchCommand?: string[] };
      if (!data.runtimePaneId) return [];
      // The runner, not the terminal's label: a delegated terminal is labelled with the task's title.
      const runner = data.launchCommand?.[0]?.split(/[\\/]/).at(-1) ?? "";
      return [`${data.runtimePaneId}\u0000${node.id}\u0000${runner}`];
    })
    .join("\u0001");
  const terminals = useMemo(() => {
    const byPane = new Map<string, { nodeId: string; label: string | null }>();
    for (const entry of terminalKey ? terminalKey.split("\u0001") : []) {
      const [paneId, nodeId, runner] = entry.split("\u0000");
      byPane.set(paneId!, { nodeId: nodeId!, label: runner || null });
    }
    return byPane;
  }, [terminalKey]);

  const writable = useMemo(
    () => (board?.projects ?? []).filter((project) => capabilitiesOf(project).holdsTasks),
    [board?.projects],
  );
  const workspaceFolders = shared?.workspaceFolders;
  const boardWorkspace = useMemo(() => {
    const id = workspaceInFolder(writable, rootDir, (projectId) => workspaceFolders?.().find((w) => w.id === projectId)?.cwd);
    if (!id) return null;
    return { id, name: board?.projectsById.get(id)?.name || leafOf(rootDir) };
  }, [writable, rootDir, workspaceFolders, board?.projectsById]);

  // The node's own copy follows the record, so a reload before the board settles shows the last one.
  useEffect(() => {
    if (!board || board.loading) return;
    for (const node of nodes) {
      if (node.type !== "task") continue;
      const data = node.data as CanvasTaskNodeData;
      const task = data.taskId ? tasksById.get(data.taskId) : undefined;
      if (!task) continue;
      const patch: Record<string, unknown> = {};
      if (task.title !== data.title) patch.title = task.title;
      if (task.status !== data.status) patch.status = task.status;
      if (task.priority !== data.priority) patch.priority = task.priority;
      if (Object.keys(patch).length > 0) patchNodeData(node.id, patch);
    }
  }, [board, nodes, tasksById, patchNodeData]);

  const delegateTask = delegation.delegate;
  const openTask = board?.openTask;
  const projectsById = board?.projectsById;
  const delegate = useCallback(
    async (task: TrackerTask, preset: DelegationPreset): Promise<string | null> => {
      if (!openTask) return "Tasks is not available here.";
      const opened = await openTask(task.projectId, task.id);
      if (opened?.kind !== "task") return "That task could not be read. Open it in Tasks and try again.";
      const options = await ticketDelegateOptions(opened.task, () => workspaceFolders?.() ?? [], find);
      return delegateTask(opened.task, preset, projectsById ? trackerTaskKey(task, projectsById) : null, options);
    },
    [openTask, workspaceFolders, find, delegateTask, projectsById],
  );

  const createFromTicket = board?.createFromTicket;
  const addToTasks = useCallback(
    async (nodeId: string): Promise<string | null> => {
      const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
      if (!node || !createFromTicket) return "Tasks is not available here.";
      if (!boardWorkspace) return "Open this board's folder as a workspace in Code first — Tasks files a task in a workspace.";
      const data = node.data as CanvasTaskNodeData;
      const title = data.title.trim();
      if (!title) return "Give the task a title first.";
      const criteria = (data.acceptanceCriteria ?? []).map((c) => `- [${c.done ? "x" : " "}] ${c.text}`).join("\n");
      const created = await createFromTicket(boardWorkspace.id, {
        title,
        goal: data.intent?.trim() || data.description.trim() || title,
        knowledge: criteria ? `Acceptance criteria\n${criteria}` : "",
        status: data.status,
        priority: data.priority,
      });
      if (!created) return "Tasks refused it. See Tasks for why.";
      patchNodeData(nodeId, { taskId: created.id, taskWorkspaceId: created.workspaceId });
      return null;
    },
    [createFromTicket, boardWorkspace, patchNodeData],
  );

  const activities = shared?.activities;
  const inFlightSet = delegation.inFlight;
  const presets = delegation.presets;
  const loading = board?.loading ?? true;
  return useMemo<CanvasTaskLinks | null>(() => {
    if (!board) return null;
    return {
      loaded: !loading,
      task: (taskId) => tasksById.get(taskId),
      taskKey: (task) => (projectsById ? trackerTaskKey(task, projectsById) : null),
      projectName: (projectId) => projectsById?.get(projectId)?.name,
      vocabulary: (projectId) => projectsById?.get(projectId)?.vocabulary ?? LOTUS_VOCABULARY,
      live: (task) => {
        const state = task.cellId ? activities?.get(task.cellId) : undefined;
        if (!task.cellId || !state) return null;
        const terminal = terminals.get(task.cellId);
        return { state, nodeId: terminal?.nodeId ?? null, label: terminal?.label ?? null };
      },
      setStatus: (task: TrackerTask, status: BridgeTaskStatus) => void editTask?.(task.id, { status }),
      setTitle: (task, title) => {
        const next = title.trim();
        if (next && next !== task.title) void editTask?.(task.id, { title: next });
      },
      presets,
      delegateUnavailable: spawner ? null : unavailable,
      inFlight: (taskId) => inFlightSet.has(taskId),
      delegate,
      openInDock,
      boardWorkspace,
      addToTasks,
    };
  }, [board, loading, tasksById, projectsById, activities, terminals, editTask, presets, spawner, unavailable, inFlightSet, delegate, openInDock, boardWorkspace, addToTasks]);
}
