export interface PaneVisibilityInput {
  focusMode: boolean;
  /** The pane that has focus — the one the rail, the composer and focus mode all point at. */
  focusedPaneId: string | null;
  paneId: string;
}

/**
 * Which panes are on screen.
 *
 * Focus mode is a MODE, not a pane. Storing "which pane is maximised" separately from "which
 * pane has focus" creates two answers to one question, and they drift the moment the rail moves
 * focus somewhere else: the screen keeps showing the pane that was maximised while everything
 * else — the composer target, the rail highlight — has moved on.
 *
 * Deriving visibility from focus makes that divergence impossible rather than merely unlikely.
 */
export function isPaneVisible({ focusMode, focusedPaneId, paneId }: PaneVisibilityInput): boolean {
  if (!focusMode) return true;
  // Focus mode with nothing focused would black out the grid; show everything instead.
  if (!focusedPaneId) return true;
  return paneId === focusedPaneId;
}

export interface PaneAttachmentInput extends PaneVisibilityInput {
  /** The pane's workspace is the one on screen. The others are stacked beneath it, `opacity: 0`. */
  workspaceActive: boolean;
  /** The Code surface is the mode being shown. Kept for callers; deliberately NOT consulted. */
  modeShown: boolean;
}

/**
 * Whether a pane keeps its renderer.
 *
 * "Not attached" is expensive to undo: it releases the pooled slot, snapshots and parks it, hands
 * the GPU context back AND disposes the pane's own xterm; coming back builds a fresh xterm,
 * re-attaches the PTY with no replay, resets the slot and writes the whole snapshot back.
 * Measured 2026-09-20: returning to Code cost p50 ~190 ms with two live terminals.
 *
 * It could also leave a pane blank. Seen 2026-09-24 in the native window: a pane the health
 * check had moved onto its own renderer (`waiting=1`, `SLOT unregister wanted=true`) came back
 * from a workspace switch as a new, EMPTY xterm, showing only the few cells the agent redrew
 * afterwards — until a drag resized it and the agent repainted.
 *
 * So neither a hidden mode nor a hidden WORKSPACE detaches: both keep their geometry (the mode
 * surfaces and the workspaces are stacked, the hidden ones at `opacity: 0`), so their terminals
 * stay fitted to a real box and have nothing to rebuild on return. The renderer pool is told
 * which panes are in the background, so they are the first to give up a slot if it runs out.
 *
 * The only case that detaches is the one where the box genuinely goes away: a pane that focus
 * mode hides (`display: none`) in the workspace on screen. A hidden workspace never has its focus
 * mode applied — the stylesheet only collapses it when the focused pane is inside it.
 *
 * The parameters stay in the signature because "is my mode/workspace shown?" is the obvious
 * thing to reach for here, and a caller should find the answer documented rather than absent.
 */
export function isPaneAttached({
  workspaceActive,
  focusMode,
  focusedPaneId,
  paneId,
}: PaneAttachmentInput): boolean {
  if (!workspaceActive) return true;
  return isPaneVisible({ focusMode, focusedPaneId, paneId });
}
