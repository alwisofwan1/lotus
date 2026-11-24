/** Bytes of a pane's output kept: enough for Live Voice to summarise what an agent just said. */
const DEFAULT_LIMIT = 8_192;

export interface PaneOutputTail {
  append: (paneId: string, data: string) => void;
  /** The pane's recent output, raw (control sequences included); null before any. */
  read: (paneId: string) => string | null;
  /** Drop the panes not in `paneIds`. */
  retain: (paneIds: ReadonlySet<string>) => void;
}

/**
 * The last few kilobytes each terminal pane printed, for Live Voice's `read_agent_output` in Code
 * (plans/composer-voice-ux ticket 10). Kept in the webview from the panes' output stream: the PTY's
 * own ring buffer in Rust is not exposed to the webview (`read_scrollback` is deliberately unpermitted).
 */
export function createPaneOutputTail(limit = DEFAULT_LIMIT): PaneOutputTail {
  const tails = new Map<string, string>();
  return {
    append(paneId, data) {
      const next = (tails.get(paneId) ?? "") + data;
      tails.set(paneId, next.length > limit ? next.slice(next.length - limit) : next);
    },
    read: (paneId) => tails.get(paneId) ?? null,
    retain(paneIds) {
      for (const paneId of tails.keys()) if (!paneIds.has(paneId)) tails.delete(paneId);
    },
  };
}
