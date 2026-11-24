import {
  getTerminalRuntimeSessionId,
  subscribeTerminalSessionStatus,
} from "@/modules/codespace/services/terminal-session-registry";
import { awaitTerminalHandover } from "@/modules/codespace/services/terminal-handover";
import { getPtySessionMetrics, killPtySession, writeToSession } from "@/lib/tauri-api";
import { awaitSessionId } from "@/modules/tasks/services/await-session";
import type { PaneTask, TaskExecutionPrimitives } from "@/modules/codespace/services/task-execution/useTaskExecution";
import type { UpdateTaskPatch } from "@/modules/codespace/services/bridge/task-store";

/**
 * Everything delegation needs to open a pane and talk to it.
 *
 * Only ONE piece of this has to come from the mode that owns the grid — `addPane`. The rest is
 * reachable from anywhere: the PTY commands are app-wide, and the pane→session mapping lives in
 * the terminal session registry. So the shell passes down a single function rather than a whole
 * surface, and the tracker stays a panel that borrows the grid instead of one that knows it.
 */

export interface AddPane {
  (workspaceId: string, agentCommand: string, cwdOverride?: string, task?: PaneTask, claudeAccount?: string): string | null;
}

/** The same, for a host that may first have to bring the right board on screen (the canvas). */
export interface OpenPane {
  (workspaceId: string, agentCommand: string, cwdOverride?: string, task?: PaneTask, claudeAccount?: string): Promise<string | null>;
}

/**
 * The spawner, wrapped in an object — and that wrapper is the whole point.
 *
 * A bare function cannot cross a React state setter safely: `setSpawner(fn)` is read as an
 * UPDATER, so React calls `fn(previous)` and stores the result. Published that way, `addPane` ran
 * once with the previous state as its workspace id and a stray pane id became "the spawner";
 * Delegate then looked ready and threw the moment it was pressed. An object is a value, so the
 * mistake cannot be made again by forgetting to wrap.
 */
export interface TaskSpawner {
  addPane: AddPane;
  /** The workspace Code mode is showing, for callers with no workspace of their own (Automation). */
  activeWorkspaceId?: () => string | null;
  /** A workspace's folder and whether it is remote (ssh); null when it is not in the rail. */
  workspace?: (id: string) => { cwd: string; remote: boolean } | null;
  /** Every workspace in the rail, with its folder. */
  workspaces?: () => { id: string; cwd: string; remote: boolean; target?: string }[];
  /** Preferred over `addPane` for delegation when present: it may switch board first. */
  openPane?: OpenPane;
  /**
   * Its panes run the agent as the PTY's own process, with no shell in front. Delegation then waits
   * for the agent's own terminal handover before typing, instead of for quiet output.
   */
  launchesAgentDirectly?: boolean;
}

export function createTaskSpawner(
  addPane: AddPane | OpenPane,
  updateTask: (taskId: string, patch: UpdateTaskPatch) => Promise<unknown>,
  onPostSpawn?: (paneId: string) => void,
  options: { launchesAgentDirectly?: boolean } = {},
): TaskExecutionPrimitives {
  // `useTaskExecution` expects a pane id; a mode with no active workspace cannot give one, and
  // saying so here is clearer than letting `awaitSessionId` wait out its timeout on `null`.
  const must = (paneId: string | null): string => {
    if (!paneId) throw new Error("No workspace is open to put the agent in.");
    return paneId;
  };
  return {
    addPane: (workspaceId, agentCommand, cwdOverride, task, claudeAccount) => {
      const opened = addPane(workspaceId, agentCommand, cwdOverride, task, claudeAccount);
      return opened instanceof Promise ? opened.then(must) : must(opened);
    },
    ...(options.launchesAgentDirectly ? { awaitHandover: awaitTerminalHandover } : {}),
    awaitSessionId: (paneId, opts) =>
      awaitSessionId(
        paneId,
        { peek: getTerminalRuntimeSessionId, subscribe: subscribeTerminalSessionStatus },
        opts,
      ),
    writeToSession,
    killSession: killPtySession,
    getMetrics: getPtySessionMetrics,
    updateTask,
    onPostSpawn,
  };
}
