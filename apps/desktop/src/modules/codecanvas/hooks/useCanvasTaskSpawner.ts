"use client";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { Node } from "@xyflow/react";
import type { PaneTask } from "@/modules/codespace/services/task-execution/useTaskExecution";
import type { TaskSpawner } from "@/modules/tasks/services/task-spawner";
import type { FrameSeed } from "../services/canvas-frames";
import { decideTaskFrame } from "../services/canvas-task-frame";

export interface CanvasTaskWorkspace {
  id: string;
  cwd: string;
  remote: boolean;
}

export const CANVAS_DELEGATE_REMOTE_BOARD =
  "This canvas runs on another machine. Delegate from Tasks in Code for now.";
export const CANVAS_DELEGATE_REMOTE_WORKSPACE =
  "That workspace is on another machine. Delegate it from Tasks in Code for now.";
export const CANVAS_DELEGATE_UNKNOWN_WORKSPACE =
  "Lotus cannot find that task's workspace folder. Open it in Code once, then try again.";
export const CANVAS_DELEGATE_SHELL_COMMAND =
  "This preset's command uses double quotes or shell operators, which a canvas terminal cannot start yet. Delegate it from Tasks in Code.";

const SHELL_SYNTAX = /["\\$&|;<>`(){}*?~#]/;

/**
 * A command as argv, for running without a shell: plain words, and single-quoted words taken
 * verbatim, as POSIX `sh` reads them. Null for anything else (double quotes, escapes, operators,
 * globs outside quotes), which only a shell could run faithfully.
 *
 * Single quotes are allowed because delegation writes them: `withDeniedTools` quotes each
 * `--disallowedTools` rule (`'Bash(gh issue close:*)'`, `'mcp__*__notion-update-page'`) so a shell
 * leaves its `*` alone. Refusing them refused every Notion and GitHub delegation.
 */
export function canvasLaunchArgv(command: string): string[] | null {
  const argv: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (/\s/.test(ch)) {
      if (word !== null) argv.push(word);
      word = null;
    } else if (SHELL_SYNTAX.test(ch)) {
      return null;
    } else {
      word = (word ?? "") + ch;
    }
  }
  if (word !== null) argv.push(word);
  return argv.length > 0 ? argv : null;
}

/**
 * Where a delegated task's terminal goes, and what it runs (S4b). Pure.
 *
 * The canvas starts the agent as the PTY's own process, the way Code mode starts a local pane
 * (`buildPaneLaunchCommand`). Code falls back to typing a command it cannot tokenize into a shell;
 * a canvas terminal has no such path, so that case is refused with a sentence instead.
 */
export function planCanvasTaskPane(input: {
  workspaceId: string;
  agentCommand: string;
  cwdOverride?: string;
  workspaces: readonly CanvasTaskWorkspace[];
  boardIsRemote: boolean;
}): { ok: true; cwd: string; folder: string; launchCommand: string[] } | { ok: false; error: string } {
  if (input.boardIsRemote) return { ok: false, error: CANVAS_DELEGATE_REMOTE_BOARD };
  const workspace = input.workspaces.find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) return { ok: false, error: CANVAS_DELEGATE_UNKNOWN_WORKSPACE };
  if (workspace.remote) return { ok: false, error: CANVAS_DELEGATE_REMOTE_WORKSPACE };
  const launchCommand = canvasLaunchArgv(input.agentCommand.trim());
  if (!launchCommand) return { ok: false, error: CANVAS_DELEGATE_SHELL_COMMAND };
  // `folder` is the project the work belongs to, and so the board it goes on.
  return { ok: true, cwd: input.cwdOverride || workspace.cwd, folder: workspace.cwd, launchCommand };
}

/**
 * "LOT-2 Fix login": the key the person uses, then the title. A title that already starts with the
 * key (a GitHub issue's task is titled "#18 — …") is not prefixed again.
 */
export function canvasTaskTitle(task: PaneTask): string {
  const key = task.key?.trim();
  const title = task.title?.trim();
  if (key && title?.startsWith(key)) return title;
  return [key, title].filter(Boolean).join(" ") || task.id;
}

export const CANVAS_DELEGATE_BOARD_TIMEOUT =
  "Lotus could not open that project's canvas in time, so nothing was started.";

/** A folder compared as a folder: a trailing separator does not make it another one. */
export const sameFolder = (a: string, b: string) => a.trim().replace(/[\\/]+$/, "") === b.trim().replace(/[\\/]+$/, "");

const BOARD_SWITCH_BUDGET_MS = 8_000;
const BOARD_SWITCH_POLL_MS = 50;

/**
 * Bring the canvas for `folder` on screen and wait until its board has loaded: a node added before
 * that lands on the outgoing board. `read` is a ref read, because the switch lands as a render.
 * Throws `CANVAS_DELEGATE_BOARD_TIMEOUT` when it does not arrive in time.
 */
export async function bringBoardOnScreen(
  folder: string,
  read: () => { rootDir: string; boardReady: boolean },
  openProject: (folder: string) => Promise<unknown>,
): Promise<void> {
  const here = () => sameFolder(folder, read().rootDir) && read().boardReady;
  if (here()) return;
  if (!sameFolder(folder, read().rootDir)) await openProject(folder);
  const deadline = Date.now() + BOARD_SWITCH_BUDGET_MS;
  while (!here()) {
    if (Date.now() >= deadline) throw new Error(CANVAS_DELEGATE_BOARD_TIMEOUT);
    await new Promise((resolve) => setTimeout(resolve, BOARD_SWITCH_POLL_MS));
  }
}

/**
 * The canvas side of Delegate in the Dock's Tasks (S4b): a TaskSpawner whose panes are canvas
 * terminals. `useTaskExecution` then works unchanged — it waits on the pane id in the terminal
 * session registry, where a canvas terminal registers under its runtime pane id.
 *
 * Cells for one task group as an agent's task spawns do (decision 30): the first stays loose, a
 * second makes the Frame named after the task and pulls the first in, later ones join it.
 *
 * The cell goes on the board of the folder it works in: `openPane` brings that project's canvas on
 * screen first (opening it, so a folder with no canvas yet gets one), as the MCP spawn bridge does
 * for an agent's spawn. A terminal in one project drawn on another's board is what the first cut
 * did, and the two lists (Code's workspaces, the canvas' projects) then never agreed.
 */
export function useCanvasTaskSpawner({
  nodes,
  workspaces,
  boardIsRemote,
  addLaunchedTerminalNode,
  createFrame,
  revealNode,
  rootDir,
  boardReady,
  openProject,
}: {
  nodes: readonly Node[];
  /** Read when a pane is opened, so a workspace added in Code since is found. */
  workspaces: (() => CanvasTaskWorkspace[]) | null;
  boardIsRemote: () => boolean;
  addLaunchedTerminalNode: (opts: { cwd: string; launchCommand: string[]; label?: string; frameId?: string; spawnTaskKey?: string; claudeAccount?: string }) => { id: string; runtimePaneId: string };
  createFrame: (ids: string[], seed?: FrameSeed) => string | null;
  revealNode: (nodeId: string) => void;
  /** The folder of the board on screen. */
  rootDir: string;
  /** False while a board is loading: a node added then lands on the outgoing one. */
  boardReady: boolean;
  /** Bring the canvas for this folder on screen, opening one when it has none. */
  openProject: (folder: string) => Promise<unknown>;
}): TaskSpawner | null {
  const nodesRef = useRef(nodes);
  const live = useRef({ workspaces, boardIsRemote, addLaunchedTerminalNode, createFrame, revealNode, rootDir, boardReady, openProject });
  // Read by `addPane`, which runs from a click, never during render.
  useLayoutEffect(() => {
    nodesRef.current = nodes;
    live.current = { workspaces, boardIsRemote, addLaunchedTerminalNode, createFrame, revealNode, rootDir, boardReady, openProject };
  });
  const available = workspaces !== null;

  return useMemo<TaskSpawner | null>(() => {
    if (!available) return null;
    const list = () => live.current.workspaces?.() ?? [];
    const planFor = (workspaceId: string, agentCommand: string, cwdOverride?: string) => {
      const plan = planCanvasTaskPane({
        workspaceId,
        agentCommand,
        cwdOverride,
        workspaces: list(),
        boardIsRemote: live.current.boardIsRemote(),
      });
      // `useTaskExecution` reports a thrown message as the delegation's error.
      if (!plan.ok) throw new Error(plan.error);
      return plan;
    };
    const place = (plan: { cwd: string; launchCommand: string[] }, task?: PaneTask, claudeAccount?: string): string => {
      const title = task ? canvasTaskTitle(task) : undefined;
      const loose = task
        ? nodesRef.current.find((n) => n.type !== "frame" && (n.data as { spawnTaskKey?: unknown }).spawnTaskKey === task.id)
        : undefined;
      const decision = task
        ? decideTaskFrame({
            nodes: nodesRef.current,
            task: { id: task.id, title },
            pending: loose ? { looseNodeId: loose.id, fresh: false } : undefined,
          })
        : ({ kind: "none" } as const);

      const created = live.current.addLaunchedTerminalNode({
        cwd: plan.cwd,
        launchCommand: plan.launchCommand,
        label: title,
        ...(decision.kind === "reuse" ? { frameId: decision.frameId } : {}),
        ...(task ? { spawnTaskKey: task.id } : {}),
        ...(claudeAccount ? { claudeAccount } : {}),
      });
      if (decision.kind === "create") {
        live.current.createFrame([decision.pullNodeId, created.id], {
          title: decision.title,
          taskKey: decision.taskKey,
          relocate: true,
        });
      }
      live.current.revealNode(created.id);
      return created.runtimePaneId;
    };
    return {
      // The board on screen, whatever folder it is: the synchronous form `TaskSpawner` requires.
      addPane: (workspaceId, agentCommand, cwdOverride, task, claudeAccount) =>
        place(planFor(workspaceId, agentCommand, cwdOverride), task, claudeAccount),
      openPane: async (workspaceId, agentCommand, cwdOverride, task, claudeAccount) => {
        const plan = planFor(workspaceId, agentCommand, cwdOverride);
        // Read through `live`: the switch lands as a render, and only the ref sees it.
        await bringBoardOnScreen(plan.folder, () => live.current, (folder) => live.current.openProject(folder));
        return place(plan, task, claudeAccount);
      },
      launchesAgentDirectly: true,
      workspace: (id) => {
        const found = list().find((candidate) => candidate.id === id);
        return found ? { cwd: found.cwd, remote: found.remote } : null;
      },
      workspaces: list,
    };
  }, [available]);
}
