"use client";
import { useCallback, useState } from "react";

/** A git worktree the agent runs inside — branch for the label, path for the run cwd. */
export interface AgentWorktree {
  branch: string;
  path: string;
}

export type AgentActionPanel = "wt" | "diff" | null;

export interface UseAgentNodeActionsOptions {
  /** The agent's base working directory, used when no worktree is assigned. */
  cwd: string;
  /** Persisted worktree restored from the canvas snapshot on mount. */
  initialWorktree?: AgentWorktree | null;
}

export interface UseAgentNodeActionsResult {
  activePanel: AgentActionPanel;
  worktree: AgentWorktree | null;
  /** The directory the next run executes in: the assigned worktree, else the base cwd. */
  runCwd: string;
  toggleWT: () => void;
  toggleDiff: () => void;
  closePanel: () => void;
  assignWorktree: (branch: string, path: string) => void;
  unassignWorktree: () => void;
}

/**
 * Owns a Canvas Agent Node's action-bar state: which overlay panel is open and
 * the optional git worktree that repoints the run cwd. Session-only — resets when
 * the node unmounts, mirroring the Terminal Node's worktree affordance.
 */
export function useAgentNodeActions({ cwd, initialWorktree }: UseAgentNodeActionsOptions): UseAgentNodeActionsResult {
  const [activePanel, setActivePanel] = useState<AgentActionPanel>(null);
  const [worktree, setWorktree] = useState<AgentWorktree | null>(initialWorktree ?? null);

  const togglePanel = useCallback(
    (panel: Exclude<AgentActionPanel, null>) =>
      setActivePanel((cur) => (cur === panel ? null : panel)),
    [],
  );
  const toggleWT = useCallback(() => togglePanel("wt"), [togglePanel]);
  const toggleDiff = useCallback(() => togglePanel("diff"), [togglePanel]);
  const closePanel = useCallback(() => setActivePanel(null), []);

  const assignWorktree = useCallback((branch: string, path: string) => {
    setWorktree({ branch, path });
    setActivePanel(null);
  }, []);
  const unassignWorktree = useCallback(() => {
    setWorktree(null);
    setActivePanel(null);
  }, []);

  return {
    activePanel,
    worktree,
    runCwd: worktree?.path ?? cwd,
    toggleWT,
    toggleDiff,
    closePanel,
    assignWorktree,
    unassignWorktree,
  };
}
