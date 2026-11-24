import {
  loadCodeSpaceSnapshot,
  saveCodeSpaceSnapshot,
  type CodeSpaceStoredSnapshot,
  type CodeSpaceStoredWorkspace,
} from "@/lib/tauri-api";
import type { BrowserCellData, CellType, ChatCellData, GridCell, TerminalCellData, WorkbenchCellData, Workspace, WorkspacePaneLayout } from "@/modules/codespace/components/types";
import { sanitizeTerminalV2LayoutTree } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import { withoutDiffTabs } from "@/modules/codespace/services/workbench-tab-state";
import { providerFromAgentCommand } from "@/modules/codespace/services/terminal-provider-detection";
import { claudeResumeCommand, claudeSessionIdFromTranscript } from "@/modules/workspace-shell/services/agent-catalog";
import { sanitizeFrames } from "@/modules/workspace-shell/services/code-frames";

export type CodeSpaceWorkspaceSnapshot = {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  focusedCellId: string | null;
};

export function toStoredCodeSpaceSnapshot(snapshot: CodeSpaceWorkspaceSnapshot): CodeSpaceStoredSnapshot {
  return {
    workspaces: snapshot.workspaces.map(toStoredWorkspace),
    activeWorkspaceId: snapshot.activeWorkspaceId,
    focusedCellId: snapshot.focusedCellId,
    updatedAt: Date.now(),
  };
}

export function fromStoredCodeSpaceSnapshot(snapshot: CodeSpaceStoredSnapshot): CodeSpaceWorkspaceSnapshot {
  const workspaces = snapshot.workspaces.map(fromStoredWorkspace);
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const cellIds = new Set(workspaces.flatMap((workspace) => workspace.cells.map((cell) => cell.id)));

  return {
    workspaces,
    activeWorkspaceId: snapshot.activeWorkspaceId && workspaceIds.has(snapshot.activeWorkspaceId)
      ? snapshot.activeWorkspaceId
      : workspaces[0]?.id ?? null,
    focusedCellId: snapshot.focusedCellId && cellIds.has(snapshot.focusedCellId)
      ? snapshot.focusedCellId
      : workspaces[0]?.cells[0]?.id ?? null,
  };
}

export async function loadPersistedCodeSpaceSnapshot(): Promise<CodeSpaceWorkspaceSnapshot | null> {
  const snapshot = await loadCodeSpaceSnapshot();
  return snapshot ? fromStoredCodeSpaceSnapshot(snapshot) : null;
}

export async function savePersistedCodeSpaceSnapshot(snapshot: CodeSpaceWorkspaceSnapshot): Promise<void> {
  await saveCodeSpaceSnapshot(toStoredCodeSpaceSnapshot(snapshot));
}

function legacyMockFilePaths(rootDir: string): Set<string> {
  return new Set([
    `${rootDir}/src/components/CryptoProjectCard.tsx`,
    `${rootDir}/src/app/page.tsx`,
  ]);
}

function removeLegacyMockWorkbenchTabs(cell: CodeSpaceStoredWorkspace["cells"][number]) {
  const rootDir = cell.rootDir ?? cell.cwd;
  const mockFilePaths = legacyMockFilePaths(rootDir);
  const tabs = (cell.tabs ?? []).filter((tab) => {
    if (tab.kind === "file") return !mockFilePaths.has(tab.filePath);
    return !(tab.url === "http://localhost:3000" && (tab.title ?? "Preview") === "Preview");
  });
  const activeTabId = tabs.some((tab) => tab.id === cell.activeTabId)
    ? cell.activeTabId ?? null
    : tabs[0]?.id ?? null;

  return { tabs, activeTabId };
}

function normalizePaneLayout(
  layout: CodeSpaceStoredWorkspace["paneLayout"] | WorkspacePaneLayout | undefined,
  cells: readonly { id: string }[],
): WorkspacePaneLayout {
  const cellIds = new Set(cells.map((cell) => cell.id));
  const terminalV2Layout = sanitizeTerminalV2LayoutTree(
    layout?.terminalV2Layout,
    cells.map((cell) => cell.id),
    layout?.focusCellId ?? null,
  );
  const v2Patch = {
    ...(terminalV2Layout ? { terminalV2Layout } : {}),
    ...(layout?.frames ? { frames: sanitizeFrames(layout.frames, [...cellIds]) } : {}),
    ...(layout?.framesMigrated ? { framesMigrated: true as const } : {}),
  };
  const mode = layout?.mode;
  if (mode === "grid") return { mode: "grid", focusCellId: null, ...v2Patch };
  if (mode !== "focus" && mode !== "main-right" && mode !== "main-bottom") {
    return { mode: "grid", focusCellId: null, ...v2Patch };
  }

  const focusCellId = layout?.focusCellId ?? null;
  return focusCellId && cellIds.has(focusCellId)
    ? { mode, focusCellId, ...v2Patch }
    : { mode: "grid", focusCellId: null, ...v2Patch };
}

function toStoredWorkspace(workspace: Workspace): CodeSpaceStoredWorkspace {
  return {
    id: workspace.id,
    label: workspace.label,
    name: workspace.name ?? null,
    color: workspace.color,
    cwd: workspace.cwd,
    schemaVersion: 3,
    location: workspace.location ?? { kind: "local", cwd: workspace.cwd },
    rows: workspace.rows,
    cols: workspace.cols,
    rowFractions: workspace.rowFractions ?? [],
    colFractions: workspace.colFractions ?? [],
    paneLayout: normalizePaneLayout(workspace.paneLayout, workspace.cells),
    cells: workspace.cells.map((cell) => {
      const legacyCell = cell as GridCell & { type?: CellType };
      const type = legacyCell.type ?? "terminal";
      if (type === "browser") {
        const browserCell = cell as BrowserCellData;
        return {
          id: cell.id,
          cwd: cell.cwd,
          type,
          runtimeStatus: "idle",
          url: browserCell.url,
          zoom: browserCell.zoom,
          title: browserCell.title,
          linkedPaneId: browserCell.linkedPaneId,
        };
      }

      if (type === "workbench") {
        const workbenchCell = cell as WorkbenchCellData;
        const { tabs, activeTabId } = withoutDiffTabs({ tabs: workbenchCell.tabs, activeTabId: workbenchCell.activeTabId });
        return {
          id: cell.id,
          cwd: cell.cwd,
          type,
          runtimeStatus: "idle",
          rootDir: workbenchCell.rootDir,
          // Narrowed for the store: live-only tabs are gone by now.
          tabs: tabs.filter((tab) => tab.kind === "file" || tab.kind === "url"),
          activeTabId,
          sidebarCollapsed: workbenchCell.sidebarCollapsed,
          sidebarWidth: workbenchCell.sidebarWidth,
        };
      }

      if (type === "chat") {
        const chatCell = cell as ChatCellData;
        // Only the reference is written. The conversation itself belongs to the CodeChat store,
        // so a snapshot can never carry a stale copy of it — and can never delete one either.
        return {
          id: cell.id,
          cwd: cell.cwd,
          type,
          runtimeStatus: "idle",
          sessionId: chatCell.sessionId,
          ...(chatCell.thread ? { thread: chatCell.thread } : {}),
        };
      }

      const terminalCell = cell as TerminalCellData;
      return {
        id: cell.id,
        cwd: cell.cwd,
        type,
        terminalCommand: null,
        runtimeSessionId: terminalCell.runtimeSessionId ?? null,
        runtimeStatus: terminalCell.runtimeStatus ?? "idle",
        agentCommand: terminalCell.agentCommand ?? null,
        claudeAccount: terminalCell.claudeAccount ?? null,
        // System-allocated name (slice 02) — must survive a restart unchanged, unlike
        // agentAddress (re-derived every render from the live provider), so it round-trips
        // here exactly like paneTitle does.
        agentName: terminalCell.agentName ?? null,
        // Persist auto-titles only when ready. Transient states
        // (`generating`, `failed`, `pending`) are runtime-only so a
        // crash mid-generation can't strand a pane in `generating`
        // forever after restart.
        paneTitle:
          terminalCell.titleStatus === "ready" && terminalCell.title
            ? terminalCell.title
            : null,
        paneTitleUpdatedAt:
          terminalCell.titleStatus === "ready" && terminalCell.titleUpdatedAt
            ? terminalCell.titleUpdatedAt
            : null,
        paneTitleSessionKey:
          terminalCell.titleStatus === "ready" && terminalCell.titleSessionKey
            ? terminalCell.titleSessionKey
            : null,
      };
    }),
  };
}

/**
 * A restored pane whose agent is gone (daemon idle-exited, reboot) starts its command again; a Claude
 * pane picks its last conversation back up instead of a blank one. Ignored when the pane reattaches
 * to a live session. The id comes from the conversation the pane's title follows.
 */
function restoredAgentCommand(agentCommand: string | undefined, titleSessionKey: string | null | undefined) {
  if (!agentCommand || providerFromAgentCommand(agentCommand) !== "claude") return agentCommand;
  return claudeResumeCommand(agentCommand, claudeSessionIdFromTranscript(titleSessionKey));
}

function fromStoredWorkspace(workspace: CodeSpaceStoredWorkspace): Workspace {
  const schemaVersion = workspace.schemaVersion ?? 1;
  const isLegacySchema = schemaVersion < 2;
  /*
    A Bridge pane written by an older build is dropped, not restored.

    The Bridge pane was retired with CodeSpace: nothing renders it any more, so a restored one
    could only be a card that does nothing. It is NOT user content — no text, no history, just a
    mount point for a feature that has gone — which is why it is dropped rather than kept as a
    tombstone. Falling through to the terminal branch would be worse than either: it would spawn a
    shell in a pane someone opened for something else.
  */
  const cells = workspace.cells
    .filter((cell) => cell.type !== "orchestrator")
    .map((cell) => {
    if (isLegacySchema) {
      return {
        id: cell.id,
        cwd: cell.cwd,
        type: "terminal" as const,
        terminalCommand: undefined,
        runtimeSessionId: null,
        runtimeStatus: cell.runtimeStatus === "failed" ? "failed" as const : "idle" as const,
        agentCommand: cell.agentCommand ?? undefined,
      };
    }

    if (cell.type === "browser") {
      return {
        id: cell.id,
        cwd: cell.cwd,
        type: "browser" as const,
        url: cell.url ?? "",
        zoom: cell.zoom ?? 1,
        title: cell.title ?? undefined,
        linkedPaneId: cell.linkedPaneId ?? undefined,
      };
    }

    if (cell.type === "workbench") {
      const { tabs, activeTabId } = removeLegacyMockWorkbenchTabs(cell);
      return {
        id: cell.id,
        cwd: cell.cwd,
        type: "workbench" as const,
        rootDir: cell.rootDir ?? cell.cwd,
        tabs,
        activeTabId,
        sidebarCollapsed: cell.sidebarCollapsed ?? false,
        sidebarWidth: cell.sidebarWidth ?? 206,
      };
    }

    // A chat pane needs the conversation it points at. Without a session id there is nothing to
    // show, so the pane degrades to a terminal instead of rendering an empty thread — the same
    // rule an older build applies to the whole `"chat"` type, which it has never heard of.
    if (cell.type === "chat" && (cell.sessionId || cell.thread)) {
      return {
        id: cell.id,
        cwd: cell.cwd,
        type: "chat" as const,
        sessionId: cell.sessionId ?? "",
        ...(cell.thread ? { thread: cell.thread } : {}),
      };
    }

    // A title without a conversation key on a pane with no agent came from the old
    // screen-reading titler, and nothing would ever replace it: titles now follow an agent
    // conversation, and a shell has none. Seen 2026-10-10 on a shell pane. A title with no
    // letter or digit ("---", 2026-11-15) is not a title either; the titler rejects it now.
    const title =
      cell.paneTitle && /[\p{L}\p{N}]/u.test(cell.paneTitle) && (cell.paneTitleSessionKey || cell.agentCommand)
        ? cell.paneTitle
        : undefined;

    return {
      id: cell.id,
      cwd: cell.cwd,
      type: "terminal" as const,
      terminalCommand: undefined,
      runtimeSessionId: null,
      runtimeStatus: cell.runtimeStatus === "failed" ? "failed" as const : "idle" as const,
      agentCommand: restoredAgentCommand(cell.agentCommand ?? undefined, cell.paneTitleSessionKey),
      claudeAccount: cell.claudeAccount ?? undefined,
      // A rename used to live beside the handle in `customDisplayName`; ADR-0068 made it the handle.
      agentName: cell.customDisplayName?.trim() || cell.agentName || undefined,
      title,
      titleStatus: title ? ("ready" as const) : undefined,
      titleUpdatedAt: title ? (cell.paneTitleUpdatedAt ?? undefined) : undefined,
      titleSessionKey: title ? (cell.paneTitleSessionKey ?? undefined) : undefined,
    };
  });

  return {
    id: workspace.id,
    label: workspace.label,
    name: workspace.name ?? undefined,
    color: workspace.color,
    cwd: workspace.cwd,
    schemaVersion: 3,
    location: workspace.location ?? { kind: "local", cwd: workspace.cwd },
    rows: workspace.rows,
    cols: workspace.cols,
    rowFractions: workspace.rowFractions,
    colFractions: workspace.colFractions,
    paneLayout: normalizePaneLayout(workspace.paneLayout, cells),
    cells,
  };
}
