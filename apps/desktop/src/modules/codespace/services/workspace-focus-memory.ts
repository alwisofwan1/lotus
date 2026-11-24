import type { Workspace } from "@/modules/codespace/components/types";

/**
 * Which pane a workspace should come back to.
 *
 * A folder is a place you were working, and leaving one to look at another is not the same as
 * abandoning what you were doing in it. Returning used to land on `cells[0]` — the first pane in
 * creation order, which after a few splits is rarely the one anybody was on — so a trip to another
 * folder silently moved the caret, and the pane the rail marked as focused was not the pane that
 * had been focused a moment earlier.
 *
 * The memory itself is not new state: `terminalV2Layout.activePaneId` already records which pane
 * the workspace's own layout considers active, and it is already persisted with the snapshot. This
 * only reads it back, and only trusts it while the pane still exists — a remembered pane that was
 * closed while the folder was away would otherwise focus nothing at all.
 */
export function rememberedFocusCellId(
  workspace: Pick<Workspace, "cells" | "paneLayout"> | undefined | null,
): string | null {
  if (!workspace) return null;
  const remembered = workspace.paneLayout?.terminalV2Layout?.activePaneId ?? null;
  if (remembered && workspace.cells.some((cell) => cell.id === remembered)) return remembered;
  return workspace.cells[0]?.id ?? null;
}
