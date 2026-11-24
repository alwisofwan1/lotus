"use client";

import { createContext, useContext } from "react";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import type { DelegationPreset } from "@/modules/tasks/services/delegation-preset";
import type { StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";
import type { TrackerTask } from "@/modules/tasks/types";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";

/**
 * What a Task node reads from the window's one tracker board (`plans/canvas-dock/` board 18).
 *
 * A linked node keeps only `taskId` + `taskWorkspaceId`; its title, status and priority are the
 * board's, so the node and the Dock's Tasks cannot disagree. Absent (null) outside a canvas that
 * provides it — tests, previews — where the node draws from its own data, as a local task.
 */
export interface CanvasTaskLinks {
  /** False until the board's first read settles: a link is not "removed" while it is still loading. */
  loaded: boolean;
  task: (taskId: string) => TrackerTask | undefined;
  /** `FT-12`, `#18`; null when the task has no number yet. */
  taskKey: (task: TrackerTask) => string | null;
  projectName: (projectId: string) => string | undefined;
  vocabulary: (projectId: string) => StatusVocabulary;
  /** What the task's pane is doing, and the canvas node showing it when that pane is on this board. */
  live: (task: TrackerTask) => { state: PaneActivityState; nodeId: string | null; label: string | null } | null;
  setStatus: (task: TrackerTask, status: BridgeTaskStatus) => void;
  setTitle: (task: TrackerTask, title: string) => void;
  presets: readonly DelegationPreset[];
  /** Why Delegate cannot run here, or null when it can. */
  delegateUnavailable: string | null;
  inFlight: (taskId: string) => boolean;
  /** Resolves to why it did not happen, or null. */
  delegate: (task: TrackerTask, preset: DelegationPreset) => Promise<string | null>;
  openInDock: (taskId: string) => void;
  /** Where "Add to Tasks" files a local node: the workspace in this board's folder. */
  boardWorkspace: { id: string; name: string } | null;
  /** Resolves to why it did not happen, or null once the node is linked. */
  addToTasks: (nodeId: string) => Promise<string | null>;
}

export const CanvasTaskLinksContext = createContext<CanvasTaskLinks | null>(null);

export function useCanvasTaskLinksContext(): CanvasTaskLinks | null {
  return useContext(CanvasTaskLinksContext);
}
