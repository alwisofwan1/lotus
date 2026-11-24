import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import {
  createTerminalV2LayoutWithPane,
  type TerminalV2LayoutTree,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import { frameOfPane, reconcileFrames } from "@/modules/workspace-shell/services/code-frames";

/**
 * What Code mode's split draws for one workspace: the panes and the tree that arranges them.
 *
 * The split reads this, never the workspace (plans/code-frames/SPEC.md). Once a workspace has been
 * migrated to Frames, the screen shows the focused pane's Frame, or that pane alone when it is
 * loose; before that, the whole workspace.
 */
export type ScreenView = {
  workspaceId: string;
  cells: GridCell[];
  /** null: never split, so the row/column grid draws it (or an empty Frame). */
  layout: TerminalV2LayoutTree | null;
} & ({ kind: "workspace" } | { kind: "frame"; frameId: string } | { kind: "pane"; paneId: string });

export function screenViewOf(
  workspace: Workspace,
  /** `openFrameId` only matters for an empty Frame: any other Frame is opened by focusing a pane in it. */
  { focusedPaneId = null, openFrameId = null }: { focusedPaneId?: string | null; openFrameId?: string | null } = {},
): ScreenView {
  const { id: workspaceId, cells, paneLayout } = workspace;
  const whole: ScreenView = { kind: "workspace", workspaceId, cells, layout: paneLayout?.terminalV2Layout ?? null };
  if (!paneLayout?.framesMigrated) return whole;

  const cellById = new Map(cells.map((cell) => [cell.id, cell]));
  const frames = reconcileFrames(paneLayout.frames ?? [], [...cellById.keys()]);
  const opened = frames.find((frame) => frame.id === openFrameId);
  if (opened && opened.paneIds.length === 0) {
    return { kind: "frame", frameId: opened.id, workspaceId, cells: [], layout: null };
  }
  if (cells.length === 0) return whole;

  const activePaneId = paneLayout.terminalV2Layout?.activePaneId;
  const focus = [focusedPaneId, activePaneId].find((id) => id && cellById.has(id)) ?? cells[0].id;
  const frame = frameOfPane(frames, focus);
  if (frame) {
    return {
      kind: "frame",
      frameId: frame.id,
      workspaceId,
      cells: frame.paneIds.flatMap((id) => cellById.get(id) ?? []),
      layout: frame.layout,
    };
  }
  return { kind: "pane", paneId: focus, workspaceId, cells: [cellById.get(focus)!], layout: createTerminalV2LayoutWithPane(focus) };
}
