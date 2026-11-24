import type { RectLike } from "./dispatch-comet";

/**
 * Where the dispatch landing anchor should sit inside a live-agent node body.
 *
 * A live agent is an xterm terminal, and TUIs (Claude Code, Codex) draw a multi-line status footer
 * BELOW the prompt — so the node's bottom edge is not the prompt. The real input is the terminal
 * cursor. This computes the caret row's offset within the node body so the delivery target span tracks
 * the actual prompt line, not a fixed bottom guess.
 */
export interface CaretAnchorInput {
  /** The xterm cursor element's rect (DOM renderer), or null when it can't be measured. */
  cursor: RectLike | null;
  /** The node body's rect — offsets are returned relative to it. */
  body: RectLike;
  /** Fallback when the cursor element isn't measurable: cursor row index + cell height. */
  fallback: { cursorY: number; cellHeight: number };
}

export interface CaretAnchorOffset {
  /** Top offset of the caret row, relative to the node body. */
  top: number;
  /** Height of the caret row. */
  height: number;
}

const MIN_ROW_HEIGHT = 12;

export function caretAnchorOffset({ cursor, body, fallback }: CaretAnchorInput): CaretAnchorOffset {
  // Prefer the real cursor element — exact and renderer-accurate (DOM renderer is in use).
  if (cursor && cursor.height > 0) {
    return {
      top: Math.max(0, cursor.top - body.top),
      height: cursor.height,
    };
  }
  // Fallback: derive the row from the cursor index and cell height.
  const height = fallback.cellHeight > 0 ? fallback.cellHeight : MIN_ROW_HEIGHT;
  return {
    top: Math.max(0, fallback.cursorY * height),
    height,
  };
}
