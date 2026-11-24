import { reportRenderRedraw } from "../rendering/terminal-v2-render-probe";

/** Gap between the one-row step and the step back; see `resizeAndRedraw`. */
export const REDRAW_NUDGE_RESTORE_MS = 120;

/**
 * `pending`: a one-row step went out and the step back has not. `done`: the PTY is back at its
 * real size (or was resized for real), so whatever the agent draws next is the final repaint.
 * The shell's focus-mode veil waits on this instead of guessing how long a rebuild takes.
 */
export type TerminalV2RedrawPhase = "pending" | "done";
type RedrawListener = (paneId: string, phase: TerminalV2RedrawPhase) => void;
const redrawListeners = new Set<RedrawListener>();

export function subscribeTerminalV2Redraw(listener: RedrawListener): () => void {
  redrawListeners.add(listener);
  return () => {
    redrawListeners.delete(listener);
  };
}

function emitRedraw(paneId: string, phase: TerminalV2RedrawPhase): void {
  for (const listener of redrawListeners) listener(paneId, phase);
}

export interface TerminalV2RedrawTarget {
  /** The live session record, compared by identity so a replaced session is not touched. */
  current(): { geometry: { cols: number; rows: number } } | undefined;
  /** The ordinary deduped resize. */
  resize(cols: number, rows: number): void;
}

/**
 * Resize, and make sure the process repaints even when the size did not change.
 *
 * For a reattach: the pane's xterm was disposed and rebuilt empty, but the PTY kept its size, so
 * the deduped resize sends nothing and the agent never learns it has to redraw — the pane stays
 * black until a drag resizes it (seen 2026-10-02 after focus mode on/off). The kernel only raises
 * SIGWINCH on a real size change, so this steps one row away and back.
 *
 * The step back waits `REDRAW_NUDGE_RESTORE_MS`: a TUI's runtime compares the size it reads on
 * SIGWINCH with the last one it saw (Node's tty `_refreshSize`), so two resizes read only after
 * both landed look like no change at all. Not for drags — those keep the plain deduped resize.
 */
export function resizeAndRedraw(
  paneId: string,
  cols: number,
  rows: number,
  target: TerminalV2RedrawTarget,
): void {
  const record = target.current();
  if (!record) return;
  if (record.geometry.cols !== cols || record.geometry.rows !== rows) {
    target.resize(cols, rows);
    reportRenderRedraw(paneId, "resized", cols, rows);
    emitRedraw(paneId, "done");
    return;
  }
  if (cols <= 0 || rows <= 0) return;
  const stepRows = rows > 1 ? rows - 1 : rows + 1;
  target.resize(cols, stepRows);
  reportRenderRedraw(paneId, "nudge", cols, rows);
  emitRedraw(paneId, "pending");
  setTimeout(() => {
    // Closed, replaced, or resized by someone else meanwhile: their geometry wins.
    if (target.current() !== record) {
      emitRedraw(paneId, "done");
      return;
    }
    if (record.geometry.cols !== cols || record.geometry.rows !== stepRows) {
      reportRenderRedraw(paneId, "skip-restore", record.geometry.cols, record.geometry.rows);
      emitRedraw(paneId, "done");
      return;
    }
    target.resize(cols, rows);
    emitRedraw(paneId, "done");
  }, REDRAW_NUDGE_RESTORE_MS);
}
