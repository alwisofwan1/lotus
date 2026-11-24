/**
 * Which pane a focus key lands on.
 *
 * Pure, and the whole point of it: "what would ⌘⌥→ do from here" is a question the tests can ask
 * without a window, a PTY or a layout that has been through the browser.
 */
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import {
  focusTerminalV2PaneByDirection,
  getVisualTerminalV2LayoutPaneIds,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-controller";
import type { TerminalV2LayoutNode, TerminalV2LayoutTree } from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import { toGridRows } from "@/modules/workspace-shell/services/grid-layout";
import type { PaneFocusCommand } from "@/modules/workspace-shell/services/shortcuts";

/**
 * A row/column workspace, written as a split tree.
 *
 * Not a second geometry engine: the rows become one vertical split of horizontal splits, which is
 * exactly the shape a workspace of the same panes would have if it HAD been split that way. So
 * both layouts are answered by the one function CodeSpace already binds to these keys, and
 * "which pane is to my right" cannot mean two different things in one app.
 */
function gridAsLayoutTree(workspace: Workspace): TerminalV2LayoutTree | null {
  const rows = toGridRows(workspace.cells, workspace.rows, workspace.cols);
  if (rows.length === 0) return null;

  const rowNodes: TerminalV2LayoutNode[] = rows.map((row) => {
    const leaves: TerminalV2LayoutNode[] = row.cells.map((cell) => ({ kind: "leaf", paneId: cell.id }));
    if (leaves.length === 1) return leaves[0];
    return { kind: "split", direction: "horizontal", children: leaves, sizes: evenSizes(leaves.length) };
  });

  const root = rowNodes.length === 1
    ? rowNodes[0]
    : { kind: "split" as const, direction: "vertical" as const, children: rowNodes, sizes: evenSizes(rowNodes.length) };
  return { root, activePaneId: null };
}

/**
 * Equal shares, not the workspace's saved fractions.
 *
 * A seam someone dragged changes how WIDE a pane is, never which pane is to its right. Feeding the
 * real fractions in would only let an extreme drag turn the honest answer into a near-tie.
 */
function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}

export interface PaneFocusMoveInput {
  workspace: Workspace | null | undefined;
  focusedPaneId: string | null;
  command: PaneFocusCommand;
}

/** The pane to focus next, or null when the key names nowhere to go. */
export function nextFocusedPaneId({
  workspace,
  focusedPaneId,
  command,
}: PaneFocusMoveInput): string | null {
  const cells: GridCell[] = workspace?.cells ?? [];
  if (cells.length === 0) return null;

  const layout = workspace?.paneLayout?.terminalV2Layout?.root
    ? workspace.paneLayout.terminalV2Layout
    : workspace ? gridAsLayoutTree(workspace) : null;
  if (command.kind === "direction" && layout?.root) {
    /*
      The tree is the geometry, and CodeSpace already knows how to read it — the same function the
      terminal grid binds to the same keys. It reads `activePaneId`, which in this shell is NOT
      the truth: the shell's focus lives in `focusedCellId` and the persisted tree's own field
      goes stale. Patching it here is what keeps one answer to "which pane has focus".
    */
    const moved = focusTerminalV2PaneByDirection({ ...layout, activePaneId: focusedPaneId }, command.direction);
    return moved.activePaneId !== focusedPaneId ? moved.activePaneId : null;
  }

  // Reading order, never the stored cell order: splitting appends the new pane to that list, so
  // after two splits ⌘1 would land somewhere in the middle of the screen.
  const visualOrder = getVisualTerminalV2LayoutPaneIds(layout?.root ?? null);
  if (command.kind === "index") return visualOrder[command.index] ?? null;

  if (command.kind === "cycle") {
    // Wrapping is the difference from a direction key: "show me the next one" always has an answer
    // while there is more than one pane, where "what is to my right" can honestly be nothing.
    if (visualOrder.length <= 1) return null;
    const from = focusedPaneId ? visualOrder.indexOf(focusedPaneId) : -1;
    // Focus can honestly be nowhere — a workspace just opened, or the pane that held it was closed
    // and the id was left behind. Then "next" means the first pane and "previous" the last, rather
    // than counting from a pane that is not there. Same rule as the canvas (`stepInOrder`).
    if (from < 0) return (command.direction === "next" ? visualOrder[0] : visualOrder.at(-1)) ?? null;
    const step = command.direction === "next" ? 1 : -1;
    return visualOrder[(from + step + visualOrder.length) % visualOrder.length] ?? null;
  }

  return null;
}
