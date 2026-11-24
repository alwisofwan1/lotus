import type { GridCell, TerminalCellData } from "@/modules/codespace/components/types";
import {
  loadPersistedCodeSpaceSnapshot,
  type CodeSpaceWorkspaceSnapshot,
} from "@/modules/codespace/services/workspace-metadata";
import type {
  TerminalV2MetadataSnapshot,
  TerminalV2PaneMetadata,
  TerminalV2WorkspaceMetadata,
} from "../contracts/terminal-types";
import type { TerminalMetadataRepository } from "./terminal-metadata-repository";

type CodeSpaceSnapshotLoader = () => Promise<CodeSpaceWorkspaceSnapshot | null>;

export function createCodeSpaceTerminalMetadataRepository(
  loadSnapshot: CodeSpaceSnapshotLoader = loadPersistedCodeSpaceSnapshot,
): TerminalMetadataRepository {
  return {
    async loadSnapshot() {
      return toTerminalV2MetadataSnapshot(await loadSnapshot());
    },
  };
}

export function toTerminalV2MetadataSnapshot(
  snapshot: CodeSpaceWorkspaceSnapshot | null,
  loadedAt = Date.now(),
): TerminalV2MetadataSnapshot | null {
  if (!snapshot) return null;

  const workspaces = snapshot.workspaces.map<TerminalV2WorkspaceMetadata>((workspace) => ({
    workspaceId: workspace.id,
    label: workspace.label,
    cwd: workspace.cwd,
    location: workspace.location,
    terminalPanes: workspace.cells
      .filter(isTerminalCell)
      .map((cell) => toTerminalPaneMetadata(workspace.id, cell)),
  }));

  const focusedPaneId = workspaces
    .flatMap((workspace) => workspace.terminalPanes)
    .some((pane) => pane.paneId === snapshot.focusedCellId)
    ? snapshot.focusedCellId
    : null;

  return {
    persistenceMode: "metadata-only",
    source: "codespace-sqlite",
    loadedAt,
    activeWorkspaceId: snapshot.activeWorkspaceId,
    focusedPaneId,
    workspaces,
  };
}

function isTerminalCell(cell: GridCell): cell is TerminalCellData {
  return cell.type === "terminal";
}

function toTerminalPaneMetadata(
  workspaceId: string,
  cell: TerminalCellData,
): TerminalV2PaneMetadata {
  return {
    paneId: cell.id,
    workspaceId,
    launch: {
      kind: "local",
      cwd: cell.cwd,
      ...(cell.terminalCommand ? { command: cell.terminalCommand } : {}),
    },
    ...(cell.agentCommand ? { agentCommand: cell.agentCommand } : {}),
    ...(cell.title ? { title: cell.title } : {}),
    ...(cell.titleUpdatedAt ? { titleUpdatedAt: cell.titleUpdatedAt } : {}),
    restoredStatus: cell.runtimeStatus === "failed" ? "failed" : "cold",
  };
}
