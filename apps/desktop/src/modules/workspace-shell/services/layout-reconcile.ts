import {
  getTerminalV2LayoutPaneIds,
  type TerminalV2LayoutTree,
} from "@/modules/codespace/terminal-v2/layout/terminal-v2-layout-tree";
import { balancedPaneLayout } from "@/modules/workspace-shell/services/pane-arrangement";

/**
 * Keeping the split tree honest about which panes exist.
 *
 * Panes arrive from several places — the add-pane menu, task execution, an MCP spawn — and only
 * the split action maintains the tree. Everything else appends to `workspace.cells` and leaves
 * the tree behind, so the pane exists in state, is counted by the rail, and is drawn by nobody.
 *
 * Reconciling here rather than at each creation site means a pane added by a path invented next
 * month still shows up.
 */
export function reconcileLayoutWithPanes(
  tree: TerminalV2LayoutTree | null | undefined,
  paneIds: string[],
): TerminalV2LayoutTree {
  const known = tree?.root ? getTerminalV2LayoutPaneIds(tree.root) : [];
  const sameSet =
    known.length === paneIds.length && known.every((paneId) => paneIds.includes(paneId));

  if (tree?.root && sameSet) return tree;

  /*
    Rebuilt from the pane order rather than patched: the sizes of a tree that no longer matches its
    panes are not worth preserving.

    Rebuilt as a GRID, not as a row. `createTerminalV2LayoutFromPaneIds` returns one horizontal
    split holding every pane, which is why a fifth terminal opened from anywhere arrived as a
    fifth column — narrow enough to wrap its own prompt. Same inputs, same rebuild trigger; only
    the shape changed.
  */
  return balancedPaneLayout(
    paneIds,
    tree?.activePaneId && paneIds.includes(tree.activePaneId) ? tree.activePaneId : paneIds[0] ?? null,
  );
}
