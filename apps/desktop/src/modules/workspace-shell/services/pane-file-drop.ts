/**
 * Which shell panes can be dropped a file on, and how each one says so.
 *
 * A native OS drop arrives from Tauri as COORDINATES, not as a DOM target — the webview's own
 * `ondrop` never sees the files, because `dragDropEnabled` is on. `useTerminalFileDrop` therefore
 * hit-tests the point with `document.elementFromPoint` and reads the answer off the element's
 * dataset, which is why the markup here IS the contract: the element under the cursor is the only
 * thing that decides where a file lands.
 *
 * Both halves are pure, and both exist so that decision can be tested without a PTY, a window or
 * a drag: one names the panes that may be targets, the other writes their markup.
 */
import type { GridCell, Workspace } from "@/modules/codespace/components/types";
import { isPaneVisible } from "@/modules/workspace-shell/services/pane-visibility";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";

/** The shape `useTerminalFileDrop` reads a droppable pane as. */
export interface ShellDropCell {
  id: string;
  type: string;
  cwd: string;
  runtimeStatus?: TerminalRuntimeStatus;
}

export interface ShellTerminalDropCellsInput {
  workspace: Workspace | null | undefined;
  focusMode: boolean;
  focusedPaneId: string | null;
}

/** Which panes of the shown workspace may receive an OS file drop. */
export function shellTerminalDropCells({
  workspace,
  focusMode,
  focusedPaneId,
}: ShellTerminalDropCellsInput): ShellDropCell[] {
  const cells: GridCell[] = workspace?.cells ?? [];
  return cells
    .filter((cell) => cell.type === "terminal")
    .filter((cell) => isPaneVisible({ focusMode, focusedPaneId, paneId: cell.id }))
    .map((cell) => ({ id: cell.id, type: cell.type, cwd: cell.cwd, runtimeStatus: cell.runtimeStatus }));
}

/** The dataset `useTerminalFileDrop` reads off the element under a native drop. */
export interface PaneFileDropAttributes {
  "data-terminal-file-drop-target": "true";
  "data-terminal-file-drop-cell-id": string;
  "data-terminal-file-drop-cwd": string;
  "data-terminal-file-drop-status": TerminalRuntimeStatus;
  "data-terminal-file-drop-location": "local" | "ssh";
}

/** Mark one pane as a drop target, or return null when it cannot take a file. */
export function paneFileDropAttributes(
  cell: GridCell,
  workspace: Workspace | null | undefined,
): PaneFileDropAttributes | null {
  if (cell.type !== "terminal") return null;
  return {
    "data-terminal-file-drop-target": "true",
    "data-terminal-file-drop-cell-id": cell.id,
    "data-terminal-file-drop-cwd": cell.cwd,
    "data-terminal-file-drop-status": cell.runtimeStatus ?? "idle",
    "data-terminal-file-drop-location": workspace?.location?.kind === "ssh" ? "ssh" : "local",
  };
}
