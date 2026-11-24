import { optimalGrid } from "@/modules/codespace/components/constants";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import { createEqualFractions } from "@/modules/codespace/services/terminal-grid-layout";
import { focusTerminalV2LayoutPane } from "./terminal-v2-layout-tree";
import {
  resolveTerminalV2RemovePaneLayout,
  resolveTerminalV2SplitPaneLayout,
  shouldPreserveLegacyGridTracksForTerminalV2,
} from "./terminal-v2-workspace-layout-mutations";

export type TerminalV2WorkspaceSplitOptions = {
  sourcePaneId?: string;
  newCell: GridCell;
  direction: "horizontal" | "vertical";
};

export function applyTerminalV2WorkspaceSplit(
  workspace: Workspace,
  { sourcePaneId, newCell, direction }: TerminalV2WorkspaceSplitOptions,
): Workspace {
  const paneLayout = resolveTerminalV2SplitPaneLayout(
    workspace.paneLayout,
    sourcePaneId,
    newCell.id,
    direction,
  );
  const nextCells = [...workspace.cells, newCell];
  const preserveLegacyTracks = shouldPreserveLegacyGridTracksForTerminalV2(paneLayout);

  if (direction === "horizontal") {
    const nextCols = workspace.cols + 1;
    return {
      ...workspace,
      cells: nextCells,
      ...(preserveLegacyTracks ? {} : { cols: nextCols, colFractions: createEqualFractions(nextCols) }),
      paneLayout: paneLayout ?? workspace.paneLayout,
    };
  }

  const nextRows = workspace.rows + 1;
  return {
    ...workspace,
    cells: nextCells,
    ...(preserveLegacyTracks ? {} : { rows: nextRows, rowFractions: createEqualFractions(nextRows) }),
    paneLayout: paneLayout ?? workspace.paneLayout,
  };
}

export function applyTerminalV2WorkspaceRemove(workspace: Workspace, paneId: string): Workspace {
  const nextCells = workspace.cells.filter((cell) => cell.id !== paneId);
  if (nextCells.length === workspace.cells.length) return workspace;

  const paneLayout = resolveTerminalV2RemovePaneLayout(workspace.paneLayout, paneId);
  const preserveLegacyTracks = shouldPreserveLegacyGridTracksForTerminalV2(paneLayout);
  const { rows, cols } = optimalGrid(nextCells.length);

  return {
    ...workspace,
    cells: nextCells,
    ...(preserveLegacyTracks ? {} : {
      rows,
      cols,
      rowFractions: createEqualFractions(rows),
      colFractions: createEqualFractions(cols),
    }),
    paneLayout: paneLayout ?? workspace.paneLayout,
  };
}

export function applyTerminalV2WorkspaceFocus(workspace: Workspace, paneId: string): Workspace {
  const paneLayout = workspace.paneLayout;
  if (!paneLayout?.terminalV2Layout) return workspace;
  const terminalV2Layout = focusTerminalV2LayoutPane(paneLayout.terminalV2Layout, paneId);
  if (terminalV2Layout === paneLayout.terminalV2Layout) return workspace;
  return {
    ...workspace,
    paneLayout: {
      ...paneLayout,
      terminalV2Layout,
    },
  };
}
