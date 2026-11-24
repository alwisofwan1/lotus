/**
 * Paste boundary for live agent terminals — defense-in-depth against the paste-auto-submit bug.
 *
 * Agent CLIs (Claude Code, Codex) protect pasted newlines purely via bracketed paste: a raw `\r`
 * on stdin submits the prompt instantly. xterm only bracket-wraps a clipboard paste when its own
 * `bracketedPasteMode` flag is set, and that flag lives in the xterm INSTANCE — recreated on every
 * remount. Rather than trust that per-instance state, the node intercepts the DOM paste event and
 * writes an explicitly bracketed paste to the PTY. The CLI side of the PTY always has bracketed
 * paste on (it enabled it at startup), so the wrap is always correct for a live agent runner.
 */

export interface LiveAgentPasteIntent {
  /** `clipboardData.types` of the paste event. */
  types: readonly string[];
  /** `clipboardData.getData("text/plain")`. */
  text: string;
}

/**
 * PTY bytes for a text paste, or null when the event should flow natively — image pastes are
 * owned by the canvas intake / the CLI's own clipboard attach, and empty text has nothing to send.
 */
export function planLiveAgentPaste(intent: LiveAgentPasteIntent): string | null {
  // An image on the clipboard wins over any text fallback riding along with it.
  if (intent.types.includes("Files")) return null;
  const body = intent.text.replace(/\r\n|\n/g, "\r");
  if (!body) return null;
  return `\x1b[200~${body}\x1b[201~`;
}
