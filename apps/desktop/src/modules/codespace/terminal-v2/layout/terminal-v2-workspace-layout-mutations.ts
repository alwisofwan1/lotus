import type { WorkspacePaneLayout } from "@/modules/codespace/components/types";
import { splitTerminalV2ActivePane } from "./terminal-v2-layout-controller";
import {
  closeTerminalV2LayoutPane,
  splitTerminalV2LayoutPane,
  type TerminalV2LayoutDirection,
} from "./terminal-v2-layout-tree";

export function shouldPreserveLegacyGridTracksForTerminalV2(
  paneLayout: WorkspacePaneLayout | undefined,
): boolean {
  return Boolean(paneLayout?.terminalV2Layout);
}

export function resolveTerminalV2SplitPaneLayout(
  paneLayout: WorkspacePaneLayout | undefined,
  sourcePaneId: string | undefined,
  newPaneId: string,
  direction: TerminalV2LayoutDirection,
): WorkspacePaneLayout | undefined {
  if (!paneLayout?.terminalV2Layout) return undefined;

  const terminalV2Layout = sourcePaneId
    ? splitTerminalV2LayoutPane(paneLayout.terminalV2Layout, sourcePaneId, newPaneId, direction)
    : splitTerminalV2ActivePane({ layout: paneLayout.terminalV2Layout, direction, newPaneId }).layout;

  return { ...paneLayout, terminalV2Layout };
}

export function resolveTerminalV2RemovePaneLayout(
  paneLayout: WorkspacePaneLayout | undefined,
  paneId: string,
): WorkspacePaneLayout | undefined {
  if (!paneLayout?.terminalV2Layout) return undefined;

  return {
    ...paneLayout,
    terminalV2Layout: closeTerminalV2LayoutPane(paneLayout.terminalV2Layout, paneId),
  };
}
