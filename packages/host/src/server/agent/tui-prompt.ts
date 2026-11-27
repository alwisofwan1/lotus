/** Wait for terminal mode changes before typing so input reaches the TUI after shell handoff. */
// Send Enter separately so it is treated as a keypress rather than pasted text.
export interface TuiPane {
  /** The pane's most recent raw bytes, escapes intact. May throw when there is no session. */
  tail(bytes: number): string;
  write(data: string): void;
}

/** The terminal handover a full-screen TUI performs on startup. */
export const TUI_READY = /\u001b\[\?(?:1049|2004)h/;

export interface TypePromptDeps {
  sleep(ms: number): Promise<void>;
  /** How long to wait for the handover. Past this the cell is left alone. */
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Between the handover and the first keystroke: the TUI is still drawing. */
  settleMs?: number;
  /** Between the text and Enter, so the two are separate keystrokes. */
  enterMs?: number;
  /**
   * How many times to press Enter, spaced further apart each time. One is enough for a runner
   * that hands over cleanly; a wrapper that is still settling swallows the first.
   */
  enterAttempts?: number;
}

const TAIL_BYTES = 4096;

export async function typeInitialPrompt(
  pane: TuiPane,
  prompt: string,
  deps: TypePromptDeps,
): Promise<"sent" | "not-ready" | "empty"> {
  if (prompt.trim().length === 0) return "empty";
  const timeout = deps.readyTimeoutMs ?? 20_000;
  const poll = deps.pollMs ?? 150;
  const attempts = Math.max(1, Math.ceil(timeout / poll));

  for (let i = 0; i < attempts; i++) {
    if (ready(pane)) {
      await deps.sleep(deps.settleMs ?? 250);
      pane.write(prompt);
      const gap = deps.enterMs ?? 150;
      for (let attempt = 0; attempt < (deps.enterAttempts ?? 3); attempt++) {
        // 150ms, then 600, then 1350: each wait is longer than the last, so a TUI that was
        // busy on the first press has had time to finish by the next.
        await deps.sleep(gap * (attempt * 3 + 1));
        pane.write("\r");
      }
      return "sent";
    }
    await deps.sleep(poll);
  }
  // Nothing typed on purpose. A prompt written into a shell that never handed over runs as a
  // command, and the operator can still see the cell and send it themselves.
  return "not-ready";
}

/** Enough of `PtyManager` to type into one pane and read what it drew back. */
export interface TuiPanes {
  getSession(sessionId: string): { getBufferTail(bytes: number): string };
  write(sessionId: string, data: string): void;
}

export function paneOf(panes: TuiPanes, sessionId: string): TuiPane {
  return {
    tail: (bytes) => panes.getSession(sessionId).getBufferTail(bytes),
    write: (data) => { panes.write(sessionId, data); },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function ready(pane: TuiPane): boolean {
  try {
    return TUI_READY.test(pane.tail(TAIL_BYTES));
  } catch {
    return false; // no session yet, or gone
  }
}
