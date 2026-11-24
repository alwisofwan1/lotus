"use client";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { Node } from "@xyflow/react";
import type { FrameSeed } from "../services/canvas-frames";
import {
  CANVAS_BRAINSTORM_REMOTE,
  brainstormBoardFolder,
  brainstormLaunchCommand,
  planBrainstormFrame,
  type BrainstormRun,
} from "../services/canvas-factory-brainstorm";
import { bringBoardOnScreen } from "./useCanvasTaskSpawner";

/**
 * Brainstorm live for the Dock's Factory (S3): a canvas terminal running the agent in the run's
 * checkout, inside the run's Frame beside its Factory node — placed first when the board lacks it.
 * Code's shell opens a pane instead; this is the same action for a canvas host.
 *
 * The terminal goes on the canvas that holds the checkout, as Delegate's does: that canvas comes on
 * screen first (opened, when no canvas holds the folder yet). A terminal for one project drawn on
 * another's board is the bug Delegate's first cut shipped; a repo in a subfolder stays on its parent's.
 */
export function useCanvasFactoryBrainstorm({
  nodes,
  rootDir,
  boardReady,
  openProject,
  projectFolders,
  boardIsRemote,
  addFactoryNode,
  addLaunchedTerminalNode,
  createFrame,
  revealNode,
  onStarted,
}: {
  nodes: readonly Node[];
  /** The folder of the board on screen. */
  rootDir: string;
  /** False while a board is loading. */
  boardReady: boolean;
  /** Bring the canvas for this folder on screen, opening one when it has none. */
  openProject: (folder: string) => Promise<unknown>;
  /** The folders that have a canvas, read at the click. */
  projectFolders: () => readonly string[];
  boardIsRemote: () => boolean;
  addFactoryNode: (run: BrainstormRun) => string;
  addLaunchedTerminalNode: (opts: { cwd: string; launchCommand: string[]; label?: string; frameId?: string }) => { id: string };
  createFrame: (ids: string[], seed?: FrameSeed) => string | null;
  revealNode: (nodeId: string) => void;
  /** After the terminal is placed: the Dock steps aside so the user sees it. */
  onStarted?: () => void;
}): (prompt: string, checkout: string, run?: BrainstormRun) => Promise<string | null> {
  const live = useRef({ nodes, rootDir, boardReady, openProject, projectFolders, boardIsRemote, addFactoryNode, addLaunchedTerminalNode, createFrame, revealNode, onStarted });
  // Read from a click and across a board switch, never during render.
  useLayoutEffect(() => {
    live.current = { nodes, rootDir, boardReady, openProject, projectFolders, boardIsRemote, addFactoryNode, addLaunchedTerminalNode, createFrame, revealNode, onStarted };
  });

  return useCallback(async (prompt: string, checkout: string, run?: BrainstormRun) => {
    try {
      const board = brainstormBoardFolder(checkout, live.current.rootDir, live.current.projectFolders());
      await bringBoardOnScreen(board, () => live.current, (folder) => live.current.openProject(folder));
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
    // Read after the switch: these belong to the checkout's board now.
    const now = live.current;
    if (now.boardIsRemote()) return CANVAS_BRAINSTORM_REMOTE;
    const launchCommand = brainstormLaunchCommand(prompt);
    const start = (opts: { label: string; frameId?: string }) => {
      const created = now.addLaunchedTerminalNode({ cwd: checkout, launchCommand, ...opts });
      return created.id;
    };
    const finish = (terminalId: string) => {
      now.revealNode(terminalId);
      now.onStarted?.();
      return null;
    };
    if (!run) return finish(start({ label: "Brainstorm" }));
    const plan = planBrainstormFrame(now.nodes, run);
    const label = `Brainstorm ${plan.title}`;
    if (plan.kind === "join") return finish(start({ label, frameId: plan.frameId }));
    const factoryNodeId = plan.factoryNodeId ?? now.addFactoryNode(run);
    const terminalId = start({ label });
    // Refused at the Frame limit: the terminal stays loose and still runs; the Frame notice says why.
    now.createFrame([factoryNodeId, terminalId], { title: plan.title, taskKey: plan.taskKey, relocate: true });
    return finish(terminalId);
  }, []);
}
