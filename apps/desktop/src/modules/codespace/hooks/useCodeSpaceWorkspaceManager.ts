"use client";

import { useCallback, useRef, useState } from "react";
import { optimalGrid } from "@/modules/codespace/components/constants";
import type {
  CellType,
  ChatCellData,
  GridCell,
  LayoutTemplate,
  PaneTitleStatus,
  TerminalCellData,
  WorkbenchCellData,
  Workspace,
  WorkspacePaneLayout,
  WorkspacePaneLayoutMode,
} from "@/modules/codespace/components/types";
import { buildSshCommand, type SshTarget } from "@/modules/codespace/services/ssh-command";
import { sshResolveRemoteCwd } from "@/lib/tauri/codespace-editor-ssh";
import { reorderItemsByDropPosition, type DropPosition } from "@/modules/codespace/services/workspace-order";
import { createEqualFractions, normalizeFractions, resizeTrackFractions } from "@/modules/codespace/services/terminal-grid-layout";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { CodeSpaceWorkspaceSnapshot } from "@/modules/codespace/services/workspace-metadata";
import { reusableWorkspaceId, workspacePlaceKey, type KnownWorkspace } from "@/modules/codespace/services/workspace-identity";
import { releaseEditorFileHolder } from "@/modules/codespace/services/editor-file-store";
import { rememberedFocusCellId } from "@/modules/codespace/services/workspace-focus-memory";
import { destroyCodeSpaceWorkspaceWebviews } from "@/modules/codespace/services/webview-registry";
import { closeTerminalSession } from "@/modules/codespace/services/terminal-session-registry";
import { detectFleetProvider, type AgentAddressCounters } from "@/modules/codespace/services/bridge/fleet-naming";
import { shuffled, uniqueAgentName } from "@/lib/agent-catalog";
import { currentNamePool } from "@/lib/agent-naming";
import { buildPaneLaunchCommand } from "@/modules/codespace/services/pane-identity-launch";
import { renameAgentCell, type AgentRenameError } from "@/modules/codespace/services/agent-rename";
import {
  applyTerminalV2WorkspaceFocus,
  applyTerminalV2WorkspaceRemove,
  applyTerminalV2WorkspaceSplit,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-workspace-actions";

const TAB_COLORS = [
  "#4F8CFF",
  "#2BB8A5",
  "#FF8A4C",
  "#8E7DFF",
  "#31C48D",
  "#F97066",
  "#F5B942",
  "#38BDF8",
];

function createTerminalCell(
  cwd: string,
  agentCommand?: string,
  terminalCommand?: string[],
  id?: string,
  agentName?: string,
  claudeAccount?: string,
): TerminalCellData {
  return {
    id: id ?? crypto.randomUUID(),
    cwd,
    type: "terminal",
    terminalCommand,
    runtimeSessionId: null,
    runtimeStatus: "idle",
    agentCommand,
    agentName,
    ...(claudeAccount ? { claudeAccount } : {}),
  };
}

function isAbsoluteRemoteCwd(cwd: string | undefined): cwd is string {
  return Boolean(cwd?.trim().startsWith("/"));
}

function areWorkspacePaneLayoutsEqual(a: WorkspacePaneLayout | undefined, b: WorkspacePaneLayout): boolean {
  return (a?.mode ?? "grid") === b.mode
    && (a?.focusCellId ?? null) === (b.focusCellId ?? null)
    && JSON.stringify(a?.terminalV2Layout ?? null) === JSON.stringify(b.terminalV2Layout ?? null)
    && (a?.framesMigrated ?? false) === (b.framesMigrated ?? false)
    && JSON.stringify(a?.frames ?? null) === JSON.stringify(b.frames ?? null);
}

function createWorkspaceCell(
  cwd: string,
  type: CellType = "terminal",
  agentCommand?: string,
  terminalCommand?: string[],
  id = crypto.randomUUID(),
): GridCell {
  if (type === "browser") {
    return { id, cwd, type: "browser", url: "", zoom: 1, loading: false };
  }

  if (type === "workbench") {
    return {
      id,
      cwd,
      type: "workbench",
      rootDir: cwd,
      tabs: [],
      activeTabId: null,
      sidebarCollapsed: false,
      sidebarWidth: 206,
    };
  }

  return createTerminalCell(cwd, agentCommand, terminalCommand, id);
}

/** The panes closed: their buffers go, except a file another open pane still shows. */
function clearWorkbenchFileBuffers(cells: GridCell[]) {
  for (const cell of cells) {
    if (cell.type !== "workbench") continue;
    releaseEditorFileHolder(cell.id, cell.tabs.flatMap((tab) => (tab.kind === "file" ? [tab.filePath] : [])));
  }
}

function arraysEqual(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveFocusedCellIdAfterTerminalV2Remove(workspace: Workspace, cellId: string): string | null {
  const nextWorkspace = applyTerminalV2WorkspaceRemove(workspace, cellId);
  const activePaneId = nextWorkspace.paneLayout?.terminalV2Layout?.activePaneId;
  if (activePaneId && nextWorkspace.cells.some((cell) => cell.id === activePaneId)) {
    return activePaneId;
  }
  return nextWorkspace.cells[0]?.id ?? null;
}

/**
 * Ends the PTY behind each closed terminal pane. A Terminal V2 session deliberately outlives its
 * pane's unmount — that is what lets a workspace switch keep it — so removing a pane from state
 * never ends it. Without this every closed pane kept its shell or agent running until the app quit,
 * still streaming output into every per-chunk consumer (measured 2026-10-27: 4 panes on screen,
 * 13 live sessions). Idempotent, so a StrictMode double-run of the updater is harmless.
 */
function closeCellSessions(cells: GridCell[]): void {
  for (const cell of cells) {
    if (cell.type === "terminal") closeTerminalSession(cell.id);
  }
}

export function useCodeSpaceWorkspaceManager() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [focusedCellId, setFocusedCellIdState] = useState<string | null>(null);
  const [confirmCloseWorkspaceId, setConfirmCloseWorkspaceId] = useState<string | null>(null);
  /** Every workspace seen, open or closed, so a reopened place takes back its id. */
  const knownWorkspaces = useRef<KnownWorkspace[]>([]);

  const rememberKnownWorkspaces = useCallback((known: readonly KnownWorkspace[]) => {
    const byId = new Map(knownWorkspaces.current.map((k) => [k.id, k]));
    for (const k of known) {
      const current = byId.get(k.id);
      if (!current || current.lastSeenAt <= k.lastSeenAt) byId.set(k.id, k);
    }
    knownWorkspaces.current = [...byId.values()];
  }, []);

  const idForPlace = useCallback((cwd: string, location: unknown) => {
    const openIds = new Set(workspaces.map((workspace) => workspace.id));
    return reusableWorkspaceId(workspacePlaceKey(cwd, location), knownWorkspaces.current, openIds) ?? crypto.randomUUID();
  }, [workspaces]);

  /**
   * Focus belongs to the workspace that OWNS the pane, not to whichever one happens to be active
   * when the call lands.
   *
   * The rail lists every folder's panes, so picking one in another folder arrives as a pair of
   * updates in the same batch: select that workspace, then focus that pane. Keying the write on
   * `activeWorkspaceId` read the value from BEFORE the pair — the old folder — and
   * `applyTerminalV2WorkspaceFocus` then found no such pane there and did nothing. The workspace
   * you were actually looking at never recorded the pane you had chosen, which is half of why
   * coming back to it lost your place. Finding the owner by the cell id removes the ordering
   * hazard rather than papering over it.
   */
  const setFocusedCellId = useCallback((cellId: string | null) => {
    setFocusedCellIdState(cellId);
    if (!cellId) return;
    setWorkspaces((previous) => {
      const owner = previous.find((workspace) =>
        workspace.cells.some((cell) => cell.id === cellId),
      );
      if (!owner) return previous;
      const next = applyTerminalV2WorkspaceFocus(owner, cellId);
      if (next === owner) return previous;
      return previous.map((workspace) => (workspace.id === owner.id ? next : workspace));
    });
  }, []);

  const createWorkspace = useCallback((
    template: LayoutTemplate,
    cwd: string,
    agentCommands: string[],
    workspaceLabel?: string,
    cellTypes?: CellType[],
  ) => {
    const cells = Array.from({ length: template.sessions }, (_, index) =>
      createWorkspaceCell(cwd, cellTypes?.[index] ?? "terminal", agentCommands[index] ?? ""),
    );

    const workspaceId = idForPlace(cwd, { kind: "local", cwd });
    const workspace: Workspace = {
      id: workspaceId,
      label: workspaceLabel?.trim() || `Workspace ${workspaces.length + 1}`,
      color: TAB_COLORS[workspaces.length % TAB_COLORS.length],
      cwd,
      location: { kind: "local", cwd },
      rows: template.rows,
      cols: template.cols,
      rowFractions: createEqualFractions(template.rows),
      colFractions: createEqualFractions(template.cols),
      cells,
    };

    rememberKnownWorkspaces([{ id: workspace.id, cwd, location: workspace.location, lastSeenAt: Date.now() }]);
    setWorkspaces((previous) => [...previous, workspace]);
    setActiveWorkspaceId(workspace.id);
    setFocusedCellIdState(cells[0]?.id ?? null);

    return workspace;
  }, [idForPlace, rememberKnownWorkspaces, workspaces.length]);

  const updateSshWorkspaceCwd = useCallback((workspaceId: string, cwd: string) => {
    const nextCwd = cwd.trim();
    if (!nextCwd.startsWith("/")) return;

    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId || workspace.location?.kind !== "ssh") {
          return workspace;
        }
        if (workspace.location.remoteCwd === nextCwd && workspace.cwd === nextCwd) {
          return workspace;
        }

        return {
          ...workspace,
          cwd: nextCwd,
          location: {
            ...workspace.location,
            remoteCwd: nextCwd,
          },
        };
      }),
    );
  }, []);

  const createSshWorkspace = useCallback(async (
    target: SshTarget,
    label?: string,
    remoteCwd?: string,
    /** The New workspace layout; absent = the old one-shell workspace. */
    template?: LayoutTemplate,
    /** One per pane, "" = a plain remote shell — the same shape `createWorkspace` takes. */
    agentCommands: string[] = [],
  ): Promise<Workspace> => {
    const normalizedTarget = {
      host: target.host,
      user: target.user ?? null,
      port: target.port ?? null,
    };
    const initialRemoteCwd = isAbsoluteRemoteCwd(remoteCwd)
      ? remoteCwd.trim()
      : undefined;
    const displayCwd = initialRemoteCwd ?? "~";
    // Each pane is its own `ssh` login, with the agent as its first command — exactly what add-pane
    // does for an SSH workspace, so a pane made here and one added later are the same kind of pane.
    const sessions = template?.sessions ?? 1;
    const cells = Array.from({ length: sessions }, (_, index) => {
      const agentCommand = agentCommands[index]?.trim() || undefined;
      const terminalCommand = buildSshCommand({
        target: { host: target.host, user: target.user, port: target.port },
        remoteCwd: initialRemoteCwd,
        initialCommand: agentCommand,
      });
      return createTerminalCell(displayCwd, agentCommand, terminalCommand);
    });
    const location: Workspace["location"] = {
      kind: "ssh",
      host: target.host,
      user: target.user ?? undefined,
      port: target.port ?? undefined,
      remoteCwd: initialRemoteCwd,
      label,
    };
    const workspaceId = idForPlace(displayCwd, location);
    rememberKnownWorkspaces([{ id: workspaceId, cwd: displayCwd, location, lastSeenAt: Date.now() }]);
    const workspace: Workspace = {
      id: workspaceId,
      label: label?.trim() || target.host,
      color: TAB_COLORS[workspaces.length % TAB_COLORS.length],
      cwd: displayCwd,
      location,
      rows: template?.rows ?? 1,
      cols: template?.cols ?? 1,
      rowFractions: createEqualFractions(template?.rows ?? 1),
      colFractions: createEqualFractions(template?.cols ?? 1),
      cells,
    };

    setWorkspaces((previous) => [...previous, workspace]);
    setActiveWorkspaceId(workspace.id);
    setFocusedCellIdState(cells[0].id);

    if (!initialRemoteCwd) {
      void sshResolveRemoteCwd(normalizedTarget, remoteCwd)
        .then((resolved) => {
          if (resolved.startsWith("/")) {
            updateSshWorkspaceCwd(workspaceId, resolved);
          }
        })
        .catch(() => {
          // Best-effort only. The interactive SSH terminal remains the source
          // of truth and will update cwd via shell integration after `cd`.
        });
    }

    return workspace;
  }, [idForPlace, rememberKnownWorkspaces, updateSshWorkspaceCwd, workspaces.length]);

  const closeWorkspace = useCallback((workspaceId: string) => {
    setWorkspaces((previous) => {
      const currentIndex = previous.findIndex((workspace) => workspace.id === workspaceId);
      if (currentIndex < 0) return previous;
      const closedWorkspace = previous[currentIndex];
      clearWorkbenchFileBuffers(closedWorkspace?.cells ?? []);
      destroyCodeSpaceWorkspaceWebviews(workspaceId, closedWorkspace?.cells ?? []);
      closeCellSessions(closedWorkspace?.cells ?? []);
      const next = previous.filter((workspace) => workspace.id !== workspaceId);
      setActiveWorkspaceId((currentActiveWorkspaceId) => {
        if (currentActiveWorkspaceId !== workspaceId) {
          setFocusedCellIdState((currentFocusedCellId) => {
            if (!closedWorkspace?.cells.some((cell) => cell.id === currentFocusedCellId)) {
              return currentFocusedCellId;
            }
            const activeWorkspace = next.find((workspace) => workspace.id === currentActiveWorkspaceId);
            return rememberedFocusCellId(activeWorkspace);
          });
          return currentActiveWorkspaceId;
        }
        const fallbackIndex = Math.min(currentIndex, next.length - 1);
        const fallbackWorkspace = next[fallbackIndex];
        setFocusedCellIdState(rememberedFocusCellId(fallbackWorkspace));
        return fallbackWorkspace?.id ?? null;
      });
      return next;
    });
    setConfirmCloseWorkspaceId((current) => (current === workspaceId ? null : current));
  }, []);

  const requestCloseWorkspace = useCallback((workspaceId: string) => {
    setConfirmCloseWorkspaceId(workspaceId);
  }, []);

  const closeAllWorkspaces = useCallback(() => {
    setWorkspaces((previous) => {
      for (const workspace of previous) {
        clearWorkbenchFileBuffers(workspace.cells);
        destroyCodeSpaceWorkspaceWebviews(workspace.id, workspace.cells);
        closeCellSessions(workspace.cells);
      }
      return [];
    });
    setActiveWorkspaceId(null);
    setFocusedCellIdState(null);
    setConfirmCloseWorkspaceId(null);
  }, []);

  const addPane = useCallback((workspaceId: string, agentCommand: string, cwdOverride?: string, claudeAccount?: string): string => {
    // Generate the ID before setWorkspaces — React's state updater runs during render,
    // not synchronously, so any value captured inside the updater is not available when
    // addPane returns.
    const newCellId = crypto.randomUUID();
    // (Slice 02) Same reasoning as newCellId above: the pool is pulled OUTSIDE the updater
    // so React StrictMode invoking the updater twice draws from one fixed pool both times.
    // `uniqueAgentName` itself is pure — calling it INSIDE the updater below (with this same
    // `pool` and a `taken` set derived from `previous`) is safe and idempotent either way.
    // (Slice 03) Shuffled once per addPane call, not inside name-pool.ts — that leaf's
    // determinism is a deliberate, tested contract.
    const pool = shuffled(currentNamePool());
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const paneCwd = cwdOverride || workspace.cwd;
        const remoteCwd = workspace.location?.kind === "ssh"
          ? cwdOverride || workspace.location.remoteCwd
          : undefined;
        // Shell panes don't get a person's name — only a real agent does (slice 02 §3).
        // `taken` is scoped to THIS workspace only: a name may repeat across workspaces,
        // real uniqueness is agentAddress + workspace scoping, already built.
        const taken = workspace.cells
          .filter((c): c is TerminalCellData => c.type === "terminal")
          .map((c) => c.agentName)
          .filter((n): n is string => Boolean(n?.trim()));
        const agentName = detectFleetProvider(agentCommand) === "shell"
          ? undefined
          : uniqueAgentName("", taken, pool);
        // For local workspaces, launch the binary directly as the PTY process instead of starting
        // a shell and typing the command after a fixed delay — and, when the runner accepts one,
        // carry the identity overlay that tells the agent the name allocated just above. A command
        // that cannot be tokenized safely still falls back to the shell path.
        const terminalCommand = workspace.location?.kind === "ssh"
          ? buildSshCommand({
              target: workspace.location,
              remoteCwd,
              initialCommand: agentCommand || undefined,
            })
          : buildPaneLaunchCommand({ agentCommand, agentName, roster: taken });
        const newCell = createTerminalCell(
          paneCwd,
          agentCommand || undefined,
          terminalCommand,
          newCellId,
          agentName,
          // An account id names a folder on this desktop; an SSH pane runs on the far machine.
          workspace.location?.kind === "ssh" ? undefined : claudeAccount,
        );
        const newCells = [...workspace.cells, newCell];
        const { rows, cols } = optimalGrid(newCells.length);
        return {
          ...workspace,
          cells: newCells,
          rows,
          cols,
          rowFractions: createEqualFractions(rows),
          colFractions: createEqualFractions(cols),
        };
      }),
    );
    return newCellId;
  }, []);

  /**
   * Open a conversation as a pane (M1.3).
   *
   * The session is created by the caller, in the CodeChat store, and only its id arrives here:
   * a workspace never owns a conversation, it points at one. That is also why this takes a
   * `sessionId` instead of creating the session itself — the store has exactly one owner, and
   * the workspace manager is not it.
   */
  const addChatPane = useCallback((
    workspaceId: string,
    sessionId: string,
    sourcePaneId?: string,
    /* Which way the source pane is cut. The caller decides, because only the surface knows how big
       that pane is on screen — "horizontal" here always produced another column. */
    direction: "horizontal" | "vertical" = "horizontal",
    /** New Chat (beta, 07d): a pane running the new chat, with `sessionId` "". */
    thread?: ChatCellData["thread"],
  ): string => {
    const newCellId = crypto.randomUUID();
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const newCell: GridCell = {
          id: newCellId,
          cwd: workspace.cwd,
          type: "chat",
          sessionId,
          ...(thread ? { thread } : {}),
        };
        // Go through the same split path the pane buttons use. Appending to `cells` alone puts
        // the pane in state but NOT in the terminal-v2 pane-layout tree, and a pane the tree does
        // not know has no frame: the rail counts it, the grid never draws it. Verified live on
        // 2026-09-20 — the pane was invisible until this call replaced the manual append.
        return applyTerminalV2WorkspaceSplit(workspace, {
          sourcePaneId: sourcePaneId ?? workspace.cells.at(-1)?.id,
          newCell,
          direction,
        });
      }),
    );
    return newCellId;
  }, []);

  /**
   * Open a browser, an editor or a bridge as a PANE.
   *
   * These three cell types have existed since before the shell did, but only the right panel ever
   * created them — so the shell's add-pane menu offered all three and opened an empty terminal for
   * each. This is the missing constructor, not a new kind of pane.
   *
   * `createWorkspaceCell` already knows how to build each one; the work here is the same as
   * `addChatPane`'s: go through the split path so the pane lands in the terminal-v2 layout tree.
   * A pane the tree does not know has no frame — the rail counts it and the grid never draws it.
   */
  const addCellPane = useCallback((
    workspaceId: string,
    type: Exclude<CellType, "chat">,
    sourcePaneId?: string,
    direction: "horizontal" | "vertical" = "horizontal",
  ): string => {
    const newCellId = crypto.randomUUID();
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const newCell = createWorkspaceCell(workspace.cwd, type, undefined, undefined, newCellId);
        return applyTerminalV2WorkspaceSplit(workspace, {
          sourcePaneId: sourcePaneId ?? workspace.cells.at(-1)?.id,
          newCell,
          direction,
        });
      }),
    );
    return newCellId;
  }, []);

  const splitPaneV = useCallback((workspaceId: string, sourceCellId?: string) => {
    const newCellId = crypto.randomUUID();
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const sourceType = workspace.cells.find((cell) => cell.id === sourceCellId)?.type ?? "terminal";
        const terminalCommand = workspace.location?.kind === "ssh"
          ? buildSshCommand({ target: workspace.location, remoteCwd: workspace.location.remoteCwd })
          : undefined;
        const newCell = createWorkspaceCell(workspace.cwd, sourceType, undefined, terminalCommand, newCellId);
        return applyTerminalV2WorkspaceSplit(workspace, {
          sourcePaneId: sourceCellId,
          newCell,
          direction: "horizontal",
        });
      }),
    );
    if (activeWorkspaceId === workspaceId) {
      setFocusedCellIdState(newCellId);
    }
  }, [activeWorkspaceId]);

  const splitPaneH = useCallback((workspaceId: string, sourceCellId?: string) => {
    const newCellId = crypto.randomUUID();
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const sourceType = workspace.cells.find((cell) => cell.id === sourceCellId)?.type ?? "terminal";
        const terminalCommand = workspace.location?.kind === "ssh"
          ? buildSshCommand({ target: workspace.location, remoteCwd: workspace.location.remoteCwd })
          : undefined;
        const newCell = createWorkspaceCell(workspace.cwd, sourceType, undefined, terminalCommand, newCellId);
        return applyTerminalV2WorkspaceSplit(workspace, {
          sourcePaneId: sourceCellId,
          newCell,
          direction: "vertical",
        });
      }),
    );
    if (activeWorkspaceId === workspaceId) {
      setFocusedCellIdState(newCellId);
    }
  }, [activeWorkspaceId]);

  const removePane = useCallback((workspaceId: string, cellId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace?.cells.some((cell) => cell.id === cellId)) return;

    if (workspace.cells.length <= 1) {
      closeWorkspace(workspaceId);
      return;
    }

    setWorkspaces((previous) =>
      previous.map((item) => {
        if (item.id !== workspaceId) return item;
        const removedCell = item.cells.find((cell) => cell.id === cellId);
        if (removedCell) {
          clearWorkbenchFileBuffers([removedCell]);
          destroyCodeSpaceWorkspaceWebviews(workspaceId, [removedCell]);
          closeCellSessions([removedCell]);
        }
        return applyTerminalV2WorkspaceRemove(item, cellId);
      }),
    );

    const nextFocusedCellId = resolveFocusedCellIdAfterTerminalV2Remove(workspace, cellId);
    setFocusedCellIdState((currentFocusedCellId) => (
      currentFocusedCellId === cellId ? nextFocusedCellId : currentFocusedCellId
    ));
  }, [closeWorkspace, workspaces]);

  const renameWorkspace = useCallback((id: string, newLabel: string) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => (workspace.id === id ? { ...workspace, label: newLabel.trim() || workspace.label } : workspace)),
    );
  }, []);

  const reorderWorkspaces = useCallback((draggedId: string, targetId: string, position: "before" | "after") => {
    if (draggedId === targetId) return;
    setWorkspaces((previous) => reorderItemsByDropPosition(previous, draggedId, targetId, position));
  }, []);

  const reorderPanes = useCallback((workspaceId: string, draggedCellId: string, targetCellId: string, position: DropPosition) => {
    if (draggedCellId === targetCellId) return;

    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        return {
          ...workspace,
          cells: reorderItemsByDropPosition(workspace.cells, draggedCellId, targetCellId, position),
        };
      }),
    );
  }, []);

  const resizePaneColumn = useCallback((
    workspaceId: string,
    columnIndex: number,
    deltaPx: number,
    containerWidth: number,
    startFractions?: number[],
  ) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const baseFractions = normalizeFractions(
          startFractions ?? workspace.colFractions ?? createEqualFractions(workspace.cols),
          workspace.cols,
        );
        return {
          ...workspace,
          colFractions: resizeTrackFractions(baseFractions, columnIndex, deltaPx, containerWidth),
        };
      }),
    );
  }, []);

  const resizePaneRow = useCallback((
    workspaceId: string,
    rowIndex: number,
    deltaPx: number,
    containerHeight: number,
    startFractions?: number[],
  ) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const baseFractions = normalizeFractions(
          startFractions ?? workspace.rowFractions ?? createEqualFractions(workspace.rows),
          workspace.rows,
        );
        return {
          ...workspace,
          rowFractions: resizeTrackFractions(baseFractions, rowIndex, deltaPx, containerHeight),
        };
      }),
    );
  }, []);

  const updateWorkspacePaneLayout = useCallback((workspaceId: string, layoutPatch: WorkspacePaneLayout) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        // Callers that only rearrange the split leave the Frames out; they must not erase them.
        const { frames, framesMigrated } = workspace.paneLayout ?? {};
        const paneLayout: WorkspacePaneLayout = {
          ...(frames ? { frames } : {}),
          ...(framesMigrated ? { framesMigrated } : {}),
          ...layoutPatch,
        };
        if (areWorkspacePaneLayoutsEqual(workspace.paneLayout, paneLayout)) return workspace;
        return { ...workspace, paneLayout };
      }),
    );
  }, []);

  /**
   * Zoom one pane to fill the folder, or give the folder its grid back.
   *
   * Zoom belongs to the FOLDER it was taken in. It was a single boolean in the shell, one per
   * window, so maximising a pane in one folder and then opening another showed that second folder
   * with one pane filling the frame and the rest collapsed to nothing — a view nobody asked for,
   * in a folder where nothing had been maximised.
   *
   * It is written into `paneLayout` rather than kept beside the workspaces because that is where
   * this already has a name: `mode: "focus"` with the pane in `focusCellId` is exactly what the
   * legacy layout engine means by it, the snapshot already carries both, and a zoom stored there
   * is dropped when the folder is closed instead of outliving it in a map keyed by dead ids.
   */
  const setWorkspaceZoom = useCallback((workspaceId: string, paneId: string | null) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        // A pane that is not in this folder cannot be the one filling it.
        const target = paneId && workspace.cells.some((cell) => cell.id === paneId) ? paneId : null;
        const mode: WorkspacePaneLayoutMode = target ? "focus" : "grid";
        const current = workspace.paneLayout;
        if ((current?.mode ?? "grid") === mode && (current?.focusCellId ?? null) === target) {
          return workspace;
        }
        return {
          ...workspace,
          paneLayout: {
            ...current,
            mode,
            focusCellId: target,
            terminalV2Layout: current?.terminalV2Layout ?? null,
          },
        };
      }),
    );
  }, []);

  /** Opening a folder returns you to the pane you were on in it — see `rememberedFocusCellId`. */
  const handleSelectWorkspace = useCallback((id: string) => {
    const targetWorkspace = workspaces.find((workspace) => workspace.id === id);
    setActiveWorkspaceId(id);
    setFocusedCellIdState(rememberedFocusCellId(targetWorkspace));
  }, [workspaces]);

  const restoreWorkspaceSnapshot = useCallback((snapshot: CodeSpaceWorkspaceSnapshot) => {
    setWorkspaces(snapshot.workspaces);
    setActiveWorkspaceId(snapshot.activeWorkspaceId);
    setFocusedCellIdState(snapshot.focusedCellId);
    setConfirmCloseWorkspaceId(null);
  }, []);

  const updateCellRuntimeSessionId = useCallback((workspaceId: string, cellId: string, runtimeSessionId: string | null) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;

        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId) return cell;
          if (cell.type !== "terminal") return cell;
          if ((cell.runtimeSessionId ?? null) === runtimeSessionId) return cell;
          changed = true;
          return {
            ...cell,
            runtimeSessionId,
          };
        });

        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  const updateCellRuntimeStatus = useCallback((workspaceId: string, cellId: string, runtimeStatus: TerminalRuntimeStatus) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;

        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId) return cell;
          if (cell.type !== "terminal") return cell;
          if ((cell.runtimeStatus ?? "idle") === runtimeStatus) return cell;
          changed = true;
          return {
            ...cell,
            runtimeStatus,
          };
        });

        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  /** Renames an agent pane (ADR-0068): the error, or null. Checked again inside the updater, against the cells as they are then. */
  const renameTerminalAgent = useCallback((workspaceId: string, cellId: string, name: string): AgentRenameError | null => {
    const cells = workspaces.find((w) => w.id === workspaceId)?.cells ?? [];
    const check = renameAgentCell(cells, cellId, name);
    if (check && "error" in check) return check.error;
    setWorkspaces((previous) =>
      previous.map((w) => {
        const result = w.id === workspaceId ? renameAgentCell(w.cells, cellId, name) : null;
        return result && "cells" in result ? { ...w, cells: result.cells } : w;
      }),
    );
    return null;
  }, [workspaces]);

  const updateTerminalAgentIdentity = useCallback((
    workspaceId: string,
    cellId: string,
    patch: {
      agentAddress?: string;
      legacyAgentAddresses?: string[];
      runtimeProvider?: TerminalCellData["runtimeProvider"];
      agentAddressCounters?: AgentAddressCounters;
      agentName?: string;
    },
  ) => {
    // Drawn outside the updater, as in addPane: StrictMode may run the updater twice.
    const pool = shuffled(currentNamePool());
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;

        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId || cell.type !== "terminal") return cell;
          const nextAgentAddress = patch.agentAddress ?? cell.agentAddress;
          const nextLegacy = patch.legacyAgentAddresses ?? cell.legacyAgentAddresses;
          const nextRuntimeProvider = patch.runtimeProvider ?? cell.runtimeProvider;
          // The name was picked from a snapshot that can be a render old: two new panes both got
          // "Ivo" (seen live, 2026-11-20). Checked again here, against the cells as they are now.
          const wantedName = patch.agentName ?? cell.agentName;
          const nextAgentName = wantedName && wantedName !== cell.agentName
            ? uniqueAgentName(
                wantedName,
                workspace.cells.flatMap((c) => (c.type === "terminal" && c.id !== cellId && c.agentName ? [c.agentName] : [])),
                pool,
              )
            : wantedName;
          if (
            nextAgentAddress === cell.agentAddress &&
            nextRuntimeProvider === cell.runtimeProvider &&
            nextAgentName === cell.agentName &&
            arraysEqual(nextLegacy, cell.legacyAgentAddresses)
          ) {
            return cell;
          }
          changed = true;
          return {
            ...cell,
            agentAddress: nextAgentAddress,
            legacyAgentAddresses: nextLegacy,
            runtimeProvider: nextRuntimeProvider,
            agentName: nextAgentName,
          };
        });

        const nextCounters = patch.agentAddressCounters ?? workspace.agentAddressCounters;
        const countersChanged = nextCounters !== workspace.agentAddressCounters;
        return changed || countersChanged
          ? { ...workspace, cells, agentAddressCounters: nextCounters }
          : workspace;
      }),
    );
  }, []);

  /**
   * Patch the auto-generated conversation title fields on a terminal cell.
   * Pass `undefined` for any field you don't want to touch; pass `null` to
   * explicitly clear it. Only `ready` titles are persisted to disk
   * (transient `generating`/`failed` states are runtime-only and live just
   * long enough to drive the header skeleton/retry pill).
   */
  const updateCellTitle = useCallback((
    workspaceId: string,
    cellId: string,
    patch: {
      title?: string | null;
      status?: PaneTitleStatus | null;
      updatedAt?: number | null;
      /** The agent conversation the title names; see `TerminalCellData.titleSessionKey`. */
      sessionKey?: string | null;
    },
  ) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;

        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId) return cell;
          if (cell.type !== "terminal") return cell;
          const nextTitle = patch.title === undefined ? cell.title : (patch.title ?? undefined);
          const nextStatus = patch.status === undefined ? cell.titleStatus : (patch.status ?? undefined);
          const nextUpdatedAt = patch.updatedAt === undefined ? cell.titleUpdatedAt : (patch.updatedAt ?? undefined);
          const nextSessionKey = patch.sessionKey === undefined ? cell.titleSessionKey : (patch.sessionKey ?? undefined);
          if (
            nextTitle === cell.title
            && nextStatus === cell.titleStatus
            && nextUpdatedAt === cell.titleUpdatedAt
            && nextSessionKey === cell.titleSessionKey
          ) {
            return cell;
          }
          changed = true;
          return {
            ...cell,
            title: nextTitle,
            titleStatus: nextStatus,
            titleUpdatedAt: nextUpdatedAt,
            titleSessionKey: nextSessionKey,
          };
        });

        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  /**
   * Run a terminal pane's agent on another Claude account with this command. The caller closes the
   * pane's PTY first: the terminal effect re-runs on the account change and, finding no session to
   * reattach to, starts the command again in place.
   */
  const moveTerminalToAccount = useCallback((workspaceId: string, cellId: string, claudeAccount: string, agentCommand: string) => {
    setWorkspaces((previous) =>
      previous.map((workspace) =>
        workspace.id !== workspaceId
          ? workspace
          : {
              ...workspace,
              cells: workspace.cells.map((cell) => {
                if (cell.id !== cellId || cell.type !== "terminal") return cell;
                // A local agent pane runs its launch argv directly, built once at creation; rebuild
                // it from the new command, or the restart runs the old argv without `--resume`.
                const roster = workspace.cells
                  .filter((c): c is TerminalCellData => c.type === "terminal" && c.id !== cellId)
                  .map((c) => c.agentName)
                  .filter((n): n is string => Boolean(n?.trim()));
                const terminalCommand = cell.terminalCommand && workspace.location?.kind !== "ssh"
                  ? buildPaneLaunchCommand({ agentCommand, agentName: cell.agentName, roster })
                  : cell.terminalCommand;
                return { ...cell, claudeAccount, agentCommand, terminalCommand };
              }),
            },
      ),
    );
  }, []);

  /**
   * Start a terminal pane's launch again in place ("Buka lagi" on an SSH pane whose link dropped).
   * The PTY is closed, and a fresh copy of the same argv makes the terminal effect run again; with
   * no session to reattach to, it starts the command anew.
   */
  const relaunchTerminal = useCallback((workspaceId: string, cellId: string) => {
    closeTerminalSession(cellId);
    setWorkspaces((previous) =>
      previous.map((workspace) =>
        workspace.id !== workspaceId
          ? workspace
          : {
              ...workspace,
              cells: workspace.cells.map((cell) =>
                cell.id !== cellId || cell.type !== "terminal" || !cell.terminalCommand
                  ? cell
                  : { ...cell, terminalCommand: [...cell.terminalCommand], runtimeSessionId: null },
              ),
            },
      ),
    );
  }, []);

  /**
   * The agent in a local pane exited (Ctrl+C, /exit, a crash): the pane falls back to a plain shell
   * in the same folder instead of sitting dead. An agent pane runs its argv directly, with no shell
   * under it, so clearing the launch is what makes the runtime start a login shell in its place.
   * The conversation's title and provider go with the agent; a rename by the user stays.
   * Also called (`shellAlive`) when an agent exits back to a prompt that is still running: only
   * the pane's identity changes and the runtime reattaches to that same shell. In an SSH pane that
   * shell is the remote one, so the launch becomes a bare `ssh` login, not a local shell, and a
   * restart of the app does not start the agent again. A dead SSH pane is left as it is.
   */
  const fallBackToShell = useCallback((workspaceId: string, cellId: string, shellAlive = false) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        const ssh = workspace.location?.kind === "ssh" ? workspace.location : null;
        if (ssh && !shellAlive) return workspace;
        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId || cell.type !== "terminal") return cell;
          if (!cell.agentCommand?.trim() && !cell.runtimeProvider) return cell;
          changed = true;
          if (!ssh) return dropAgentLaunch(cell);
          const remoteCwd = isAbsoluteRemoteCwd(cell.cwd) ? cell.cwd : ssh.remoteCwd;
          return { ...dropAgentLaunch(cell), terminalCommand: buildSshCommand({ target: ssh, remoteCwd }) };
        });
        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  const updateWorkbenchCell = useCallback((
    workspaceId: string,
    cellId: string,
    updater: (cell: WorkbenchCellData) => WorkbenchCellData,
  ) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;

        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId) return cell;
          if (cell.type !== "workbench") return cell;
          const next = updater(cell);
          if (next === cell) return cell;
          changed = true;
          return next;
        });

        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  /** New Chat (beta): the thread a pane's first message created (07d) or its session was imported into (07f), and its title; null drops it. */
  const updateChatPaneThread = useCallback((
    workspaceId: string,
    cellId: string,
    thread: NonNullable<ChatCellData["thread"]> | null,
  ) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;

        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId || cell.type !== "chat") return cell;
          if (cell.thread?.id === thread?.id && cell.thread?.title === thread?.title) return cell;
          changed = true;
          // null: back to the pane's CodeChat session (07f, the beta turned off).
          return thread ? { ...cell, thread } : { ...cell, thread: undefined };
        });

        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  const updateBrowserCellUrl = useCallback((
    workspaceId: string,
    cellId: string,
    url: string,
  ) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;

        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId || cell.type !== "browser") return cell;
          if (cell.url === url) return cell;
          changed = true;
          return { ...cell, url };
        });

        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  /** The agent pane a Browser pane's picks go to; null unlinks it. */
  const updateBrowserCellLink = useCallback((workspaceId: string, cellId: string, linkedPaneId: string | null) => {
    setWorkspaces((previous) =>
      previous.map((workspace) => {
        if (workspace.id !== workspaceId) return workspace;
        let changed = false;
        const cells = workspace.cells.map((cell) => {
          if (cell.id !== cellId || cell.type !== "browser" || (cell.linkedPaneId ?? null) === linkedPaneId) return cell;
          changed = true;
          return { ...cell, linkedPaneId: linkedPaneId ?? undefined };
        });
        return changed ? { ...workspace, cells } : workspace;
      }),
    );
  }, []);

  return {
    workspaces,
    activeWorkspaceId,
    focusedCellId,
    setFocusedCellId,
    confirmCloseWorkspaceId,
    setConfirmCloseWorkspaceId,
    createWorkspace,
    createSshWorkspace,
    rememberKnownWorkspaces,
    closeWorkspace,
    requestCloseWorkspace,
    closeAllWorkspaces,
    addPane,
    addChatPane,
    addCellPane,
    splitPaneV,
    splitPaneH,
    removePane,
    renameWorkspace,
    reorderWorkspaces,
    reorderPanes,
    resizePaneColumn,
    resizePaneRow,
    updateWorkspacePaneLayout,
    setWorkspaceZoom,
    handleSelectWorkspace,
    restoreWorkspaceSnapshot,
    updateCellRuntimeSessionId,
    updateCellRuntimeStatus,
    renameTerminalAgent,
    updateTerminalAgentIdentity,
    updateCellTitle,
    updateSshWorkspaceCwd,
    updateWorkbenchCell,
    moveTerminalToAccount,
    relaunchTerminal,
    fallBackToShell,
    updateBrowserCellUrl,
    updateChatPaneThread,
    updateBrowserCellLink,
  };
}

/** A terminal cell with its agent launch cleared, so it runs a plain shell. Exported for the test. */
export function dropAgentLaunch(cell: TerminalCellData): TerminalCellData {
  // A title the user typed is theirs, not the conversation's.
  const manual = cell.titleStatus === "manual";
  return {
    ...cell,
    agentCommand: undefined,
    terminalCommand: undefined,
    runtimeProvider: undefined,
    title: manual ? cell.title : undefined,
    titleStatus: manual ? cell.titleStatus : undefined,
    titleUpdatedAt: manual ? cell.titleUpdatedAt : undefined,
    titleSessionKey: undefined,
  };
}
