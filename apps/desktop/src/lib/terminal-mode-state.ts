/**
 * Tracks DEC private-mode state (DECSET/DECRST, `ESC[?…h/l`) across a PTY's output stream so a
 * freshly-created xterm can be re-armed after a reattach.
 *
 * Agent CLIs enable modes like bracketed paste (?2004) exactly once at startup. The reattach
 * transcript replay is a bounded tail mirror, so those one-shot enables are long gone by the time
 * a node remounts — leaving the new xterm instance with bracketed paste OFF, which turns a pasted
 * newline into an instant prompt submit. Replaying the tracked mode state into the new terminal
 * (locally, never to the PTY) restores parity with the still-running CLI.
 *
 * Chunks arriving here are CSI-aligned: the Rust PTY flusher never splits an escape sequence
 * across emissions, so per-chunk scanning cannot miss a marker.
 */

/**
 * Modes worth re-arming on reattach. Deliberately conservative:
 *  - 2004 bracketed paste, 1004 focus reporting — one-shot enables (the reattach bug class)
 *  - 1 (DECCKM), 1000/1002/1003/1006 mouse tracking — set once by full-screen TUIs
 * Excluded: 25 (cursor visibility) and 2026 (synchronized output) toggle every frame and
 * self-heal from the transcript tail; 1049 (alt screen) would clear the replayed view.
 */
const REPLAYABLE_MODES = new Set([1, 1000, 1002, 1003, 1004, 1006, 2004]);

const DEC_PRIVATE_MODE_RE = /\x1b\[\?([0-9;]+)([hl])/g;

export interface TerminalModeTracker {
  /** Scan one raw PTY output chunk for DECSET/DECRST changes. */
  observe(chunk: string): void;
  /** Enable sequences for every tracked mode currently on — write into a fresh xterm before replay. */
  replaySequence(): string;
}

export function createTerminalModeTracker(): TerminalModeTracker {
  const enabled = new Set<number>();
  return {
    observe(chunk: string): void {
      for (const match of chunk.matchAll(DEC_PRIVATE_MODE_RE)) {
        for (const param of match[1].split(";")) {
          const mode = Number.parseInt(param, 10);
          if (!REPLAYABLE_MODES.has(mode)) continue;
          if (match[2] === "h") enabled.add(mode);
          else enabled.delete(mode);
        }
      }
    },
    replaySequence(): string {
      return [...enabled]
        .sort((a, b) => a - b)
        .map((mode) => `\x1b[?${mode}h`)
        .join("");
    },
  };
}
