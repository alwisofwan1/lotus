"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { loadPersistedCodeSpaceSnapshot } from "@/modules/codespace/services/workspace-metadata";
import { useTrackerBoard, type TrackerBoard, type TrackerProjectInput } from "@/modules/tasks/hooks/useTrackerBoard";
import { useVaultPath } from "@/modules/tasks/hooks/useVaultPath";
import type { GitHubSourceConfig } from "@/modules/tasks/services/github-issues-source";
import type { NotionSourceConfig } from "@/modules/tasks/services/notion-source";
import type { TaskSpawner } from "@/modules/tasks/services/task-spawner";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";
import { useShellLayout } from "./useShellLayout";

/**
 * The window's one tracker board (`plans/canvas-dock/` S4), above every route.
 *
 * It was owned by the workspace shell, which is mounted on `/canvas` only after a visit to `/` in
 * that window. The Canvas Dock's Tasks and the shell's both read this one, so their lists, counts
 * and writes cannot disagree, and a canvas opened first still has a board.
 *
 * What only Code mode knows (its workspaces, what its panes are doing, how to open one) is
 * published here by the shell. Until it is, the workspaces come from the saved snapshot, read only:
 * the shell's `useCodeSpaceWorkspaces` stays the snapshot's one writer.
 */
export interface SharedTrackerBoard {
  board: TrackerBoard;
  vault: ReturnType<typeof useVaultPath>;
  notionSources: NotionSourceConfig[];
  githubSources: GitHubSourceConfig[];
  activities: ReadonlyMap<string, PaneActivityState>;
  /** How Code mode opens a pane; null until it has mounted. */
  spawner: TaskSpawner | null;
  /**
   * Code's workspaces with their folders: live from Code mode once it has published its spawner,
   * else the saved snapshot. What the canvas reads to put a delegated agent in the right folder.
   */
  workspaceFolders: () => { id: string; cwd: string; remote: boolean }[];
  publishProjects: (projects: TrackerProjectInput[]) => void;
  publishActivities: (activities: ReadonlyMap<string, PaneActivityState>) => void;
  /** The canvas's task cells (S4b): merged with Code's, so a canvas-delegated task is not `gone`. */
  publishCanvasActivities: (activities: ReadonlyMap<string, PaneActivityState>) => void;
  publishSpawner: (spawner: TaskSpawner | null) => void;
  /** A host showing Tasks (the Canvas Dock): Notion and GitHub are polled while any is. */
  setViewing: (viewer: string, viewing: boolean) => void;
}

const SharedTrackerBoardContext = createContext<SharedTrackerBoard | null>(null);

const leafOf = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function TrackerBoardProvider({ children }: { children: ReactNode }) {
  const { layout, update } = useShellLayout();
  const vault = useVaultPath();
  const notionSources = useMemo(
    () => vault.sources.filter((source): source is NotionSourceConfig => source.kind === "notion"),
    [vault.sources],
  );
  const githubSources = useMemo(
    () => vault.sources.filter((source): source is GitHubSourceConfig => source.kind === "github"),
    [vault.sources],
  );

  const [published, setPublished] = useState<TrackerProjectInput[] | null>(null);
  const [saved, setSaved] = useState<{ id: string; name: string; cwd: string; remote: boolean }[]>([]);
  useEffect(() => {
    let alive = true;
    // Named as the rail names them (`cell-mapping.ts`): the label, else the folder.
    void loadPersistedCodeSpaceSnapshot()
      .then((snapshot) => {
        if (!alive || !snapshot) return;
        setSaved(
          snapshot.workspaces.map((w) => ({
            id: w.id,
            name: w.label?.trim() || leafOf(w.cwd),
            cwd: w.cwd,
            remote: w.location?.kind === "ssh",
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const savedProjects = useMemo(() => saved.map(({ id, name }) => ({ id, name })), [saved]);
  const projects = published ?? savedProjects;

  const [codeActivities, setActivities] = useState<ReadonlyMap<string, PaneActivityState>>(() => new Map());
  const [canvasActivities, setCanvasActivities] = useState<ReadonlyMap<string, PaneActivityState>>(() => new Map());
  // Ids do not collide: a canvas pane is `canvas:<project>:<node>` (or its node id), a Code cell a uuid.
  const activities = useMemo<ReadonlyMap<string, PaneActivityState>>(() => {
    if (canvasActivities.size === 0) return codeActivities;
    if (codeActivities.size === 0) return canvasActivities;
    return new Map([...codeActivities, ...canvasActivities]);
  }, [codeActivities, canvasActivities]);
  const [spawner, setSpawner] = useState<TaskSpawner | null>(null);
  const [viewers, setViewers] = useState<ReadonlySet<string>>(() => new Set());
  const setViewing = useCallback((viewer: string, viewing: boolean) => {
    setViewers((was) => {
      if (was.has(viewer) === viewing) return was;
      const next = new Set(was);
      if (viewing) next.add(viewer);
      else next.delete(viewer);
      return next;
    });
  }, []);

  const workspaceFolders = useCallback(
    () => spawner?.workspaces?.() ?? saved.map(({ id, cwd, remote }) => ({ id, cwd, remote })),
    [spawner, saved],
  );

  const onPrefixesChange = useCallback((taskPrefixes: Record<string, string>) => update({ taskPrefixes }), [update]);
  const board = useTrackerBoard({
    projects,
    storedPrefixes: layout.taskPrefixes,
    vaultPath: vault.path,
    notionSources,
    githubSources,
    tasksOpen: layout.tasksOpen || viewers.size > 0,
    // The board records what the panes did even while no Tasks is open.
    activities,
    onPrefixesChange,
  });

  const value = useMemo<SharedTrackerBoard>(
    () => ({
      board,
      vault,
      notionSources,
      githubSources,
      activities,
      spawner,
      workspaceFolders,
      publishProjects: setPublished,
      publishActivities: setActivities,
      publishCanvasActivities: setCanvasActivities,
      publishSpawner: setSpawner,
      setViewing,
    }),
    [board, vault, notionSources, githubSources, activities, spawner, workspaceFolders, setViewing],
  );
  return <SharedTrackerBoardContext.Provider value={value}>{children}</SharedTrackerBoardContext.Provider>;
}

export function useSharedTrackerBoard(): SharedTrackerBoard {
  const shared = useContext(SharedTrackerBoardContext);
  if (!shared) throw new Error("useSharedTrackerBoard needs a TrackerBoardProvider above it (AppShell mounts one).");
  return shared;
}

/** The same, or null without a provider: for hosts that also render in tests and previews. */
export function useOptionalSharedTrackerBoard(): SharedTrackerBoard | null {
  return useContext(SharedTrackerBoardContext);
}
