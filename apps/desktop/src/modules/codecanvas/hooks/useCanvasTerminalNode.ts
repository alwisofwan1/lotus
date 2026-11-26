"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type React from "react";
import type { TerminalTheme } from "@/lib/design-system";
import { useLegacyTerminalRuntime } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import { META_ENTER_SEQUENCE } from "@/modules/codespace/services/terminal-keybindings";
import { CANVAS_TERMINAL_TYPOGRAPHY } from "@/modules/codecanvas/services/canvas-terminal-typography";
import { buildSshCommand } from "@/modules/codespace/services/ssh-command";
import { remoteArgv } from "@/modules/codespace/services/ssh-argv";
import { tmuxSessionFor } from "@/modules/codecanvas/services/remote-host";
import { getActiveProjectLocation } from "@/modules/codecanvas/services/canvas-active-project";
import { machineKey } from "@/modules/codecanvas/services/machine";
import { getCanvasBehaviorSettings } from "./useCanvasBehaviorSettings";
import { useLinkStrip, type LinkStrip } from "@/modules/workspace-shell/components/SshLinkStrip";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import {
  subscribeTerminalActivity,
  type TerminalActivity,
} from "@/modules/codespace/services/terminal-activity-registry";

export type CanvasSearchAPI = {
  findNext: (query: string) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
};

export type CanvasActivePanel = "wt" | "sk" | null;

export interface UseCanvasTerminalNodeOptions {
  id: string;
  cwd: string;
  runtimeScope?: string;
  runtimePaneId?: string;
  onCwdChange?: (cwd: string) => void;
  onWorktreeChange?: (branch: string | null, path: string | null) => void;
  terminalTheme?: TerminalTheme;
  allowTransparency?: boolean;
  /** When false the runtime pauses WebGL rendering and buffers output (zoomed-out glyph tier). */
  active?: boolean;
  /** When set, injects AGENT_CANVAS_* env vars into the PTY so agents can call canvas APIs. */
  canvasTerminalId?: string;
  /**
   * Set when this node adopted a cell the machine's Standalone Host already runs.
   *
   * The node then attaches to that cell's tmux session rather than starting anything of its own.
   */
  adoptedPaneId?: string;
  /**
   * A program to run in place of the shell, on this machine (a task delegated from the Dock, S4b).
   * Read when the PTY starts; a node on another machine never gets one (the spawner refuses).
   */
  launchCommand?: string[];
  /** The Lotus Claude account the PTY runs on (issues/07); local projects only. */
  claudeAccount?: string;
}

export interface UseCanvasTerminalNodeResult {
  containerRef: React.Ref<HTMLDivElement>;
  helperTextareaRef: React.Ref<HTMLTextAreaElement>;
  runtimeStatus: TerminalRuntimeStatus;
  activity: TerminalActivity;
  currentCwd: string;
  searchAPI: CanvasSearchAPI | null;
  // Canvas Terminal Action Bar — panel state machine + worktree intent.
  activePanel: CanvasActivePanel;
  toggleWT: () => void;
  toggleSK: () => void;
  closePanel: () => void;
  assignWorktree: (branch: string, path: string) => void;
  unassignWorktree: () => void;
  // Search visibility — openSearch absorbs the "runtime must be ready" invariant.
  searchVisible: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  /** A remote node's link to its machine (plans/ssh-pane-durability, phase 3). */
  link: LinkStrip;
  sessionId: string | null;
}

/** canvas:default scopes all canvas PTYs out of the CodeSpace fleet snapshot. */
const CANVAS_WORKSPACE_ID = "canvas:default";

/**
 * Wires a Canvas Terminal Node to the CodeSpace Terminal Pane Runtime and owns
 * its Canvas Terminal Action Bar state. Every canvas terminal always runs
 * active:true — all nodes are visually present and must render live. PTY
 * survives React unmount/remount; only closing the node kills the session.
 */
export function useCanvasTerminalNode({
  id,
  cwd,
  runtimeScope = CANVAS_WORKSPACE_ID,
  runtimePaneId = id,
  onCwdChange,
  onWorktreeChange,
  terminalTheme,
  allowTransparency,
  active = true,
  canvasTerminalId,
  adoptedPaneId,
  launchCommand,
  claudeAccount,
}: UseCanvasTerminalNodeOptions): UseCanvasTerminalNodeResult {
  const [runtimeStatus, setRuntimeStatus] = useState<TerminalRuntimeStatus>("idle");
  const [activity, setActivity] = useState<TerminalActivity>("idle");
  const [currentCwd, setCurrentCwd] = useState(cwd);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // A dropped plain `ssh -t` node already gets the "Terminal exited" recovery, so no red strip.
  const link = useLinkStrip(sessionId, false);

  useEffect(() => subscribeTerminalActivity(runtimePaneId, setActivity), [runtimePaneId]);
  const [searchAPI, setSearchAPI] = useState<CanvasSearchAPI | null>(null);
  const [activePanel, setActivePanel] = useState<CanvasActivePanel>(null);
  const [searchVisible, setSearchVisible] = useState(false);

  const handleCwdChange = useCallback(
    (newCwd: string) => {
      setCurrentCwd(newCwd);
      onCwdChange?.(newCwd);
    },
    [onCwdChange],
  );

  // A terminal on another machine is the same pane running `ssh -t` — the shape CodeSpace has used
  // since the Rust SSH PTY path was pruned (`useCodeSpaceWorkspaceManager.ts`). The pane's own cwd
  // goes empty because `cwd` names a directory over there, not here; the real one rides inside the
  // ssh command.
  const projectLocation = getActiveProjectLocation();
  const remoteKey = machineKey(projectLocation);
  const launchKey = launchCommand?.join("\u0000") ?? "";
  const terminalCommand = useMemo(
    () => {
      if (!projectLocation) return launchCommand?.length ? launchCommand : undefined;
      // An adopted cell is already running, in a tmux session the host started. Attaching is the
      // only honest thing a canvas node can do with it: opening a shell would leave the cell where
      // it was and draw an empty prompt next to it.
      if (adoptedPaneId) {
        return remoteArgv(projectLocation, ["tmux", "attach", "-t", tmuxSessionFor(adoptedPaneId)], cwd);
      }
      return buildSshCommand({ target: projectLocation, remoteCwd: cwd });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remoteKey stands in for the machine
    [remoteKey, cwd, adoptedPaneId, launchKey],
  );

  const { containerRef, helperTextareaRef } = useLegacyTerminalRuntime({
    active,
    workspaceId: runtimeScope,
    paneId: runtimePaneId,
    cwd: projectLocation ? "" : cwd,
    terminalCommand,
    // An account id names a folder on this desktop; a remote project's PTY is ssh.
    claudeAccount: projectLocation ? undefined : claudeAccount,
    fontSize: CANVAS_TERMINAL_TYPOGRAPHY.fontSize,
    history: [],
    onRuntimeStatusChange: setRuntimeStatus,
    onRuntimeSessionIdChange: setSessionId,
    onCurrentDirectoryChange: handleCwdChange,
    terminalTheme,
    allowTransparency,
    onSearchReady: setSearchAPI,
    canvasTerminalId,
    // Shift+Enter → Meta+Enter (newline in zsh/Claude Code, no-op in bash) while the canvas
    // setting is on. Read live from the store so the Settings toggle applies without a remount.
    shiftEnterNewline: () =>
      getCanvasBehaviorSettings().terminalShiftEnterNewline ? META_ENTER_SEQUENCE : null,
  });

  const togglePanel = useCallback(
    (panel: Exclude<CanvasActivePanel, null>) =>
      setActivePanel((cur) => (cur === panel ? null : panel)),
    [],
  );
  const toggleWT = useCallback(() => togglePanel("wt"), [togglePanel]);
  const toggleSK = useCallback(() => togglePanel("sk"), [togglePanel]);
  const closePanel = useCallback(() => setActivePanel(null), []);

  const assignWorktree = useCallback(
    (branch: string, path: string) => {
      onWorktreeChange?.(branch, path);
      setActivePanel(null);
    },
    [onWorktreeChange],
  );
  const unassignWorktree = useCallback(() => {
    onWorktreeChange?.(null, null);
    setActivePanel(null);
  }, [onWorktreeChange]);

  const openSearch = useCallback(() => {
    if (searchAPI) setSearchVisible(true);
  }, [searchAPI]);
  const closeSearch = useCallback(() => setSearchVisible(false), []);

  return {
    containerRef: containerRef as React.Ref<HTMLDivElement>,
    helperTextareaRef: helperTextareaRef as React.Ref<HTMLTextAreaElement>,
    runtimeStatus,
    activity,
    currentCwd,
    searchAPI,
    activePanel,
    toggleWT,
    toggleSK,
    closePanel,
    assignWorktree,
    unassignWorktree,
    searchVisible,
    link: link.state,
    sessionId,
    openSearch,
    closeSearch,
  };
}
