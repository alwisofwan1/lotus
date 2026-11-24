export interface ReattachTerminalPaintDeps {
  /** Fit the xterm grid to its container (FitAddon.fit()). */
  fit: () => void;
  /** Current xterm grid size — read AFTER fit so it reflects the fitted dimensions. */
  size: () => { cols: number; rows: number };
  /** Resize the PTY to match the grid so the running CLI's winsize agrees with what's rendered. */
  resizePty: (cols: number, rows: number) => void;
  /** Expose the terminal for direct writes (sets termRef) — only now that the grid is sized. */
  markReady: () => void;
  /** Paint buffered output (reattach transcript / pre-mount stream) into the now-sized grid. */
  flushPending: () => void;
}

/**
 * Bring a (re)mounted agent terminal to a correct initial view. A reattached full-screen TUI's
 * transcript uses absolute cursor positioning sized for the running PTY; painting it into xterm's
 * default 80×24 grid and then reflowing scrambles it (xterm reflow only re-wraps soft-wrapped
 * lines, not absolute-positioned redraws). So we size the grid (fit) and the PTY FIRST, expose the
 * terminal, and only THEN paint the buffered bytes — so the replay lands in a matching grid.
 */
export function paintReattachedTerminalView(deps: ReattachTerminalPaintDeps): void {
  deps.fit();
  const { cols, rows } = deps.size();
  deps.resizePty(cols, rows);
  deps.markReady();
  deps.flushPending();
}
