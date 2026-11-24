/**
 * Handing a prompt to a TUI without it being mistaken for a paste.
 *
 * A terminal agent's input box treats text arriving WITH its newline in one write as pasted
 * content: the prompt lands in the box and simply sits there, unsent, and the pane looks like an
 * agent that is thinking. The fix is to send the text, let the TUI settle, and send the carriage
 * return on its own — which is what a person typing looks like.
 */

/**
 * How quiet the pane must go before the return is pressed.
 *
 * A fixed wait was tried first and was not enough: a fresh `claude` is still drawing its banner
 * and loading AGENTS.md when the prompt lands, so a return sent 60 ms later arrives at a composer
 * that is not listening yet — the text sat in the input box, unsent, exactly as if it had never
 * been split. Waiting for the pane to STOP producing output asks the real question instead of
 * guessing how long a TUI takes to start.
 */
export const PROMPT_QUIET_MS = 350;
/** Never wait forever for quiet: an agent that streams continuously would hold the prompt hostage. */
export const PROMPT_QUIET_TIMEOUT_MS = 8_000;
const POLL_MS = 80;

export type WriteToSession = (sessionId: string, data: string) => Promise<void>;

/** Resolves once the pane has settled enough to be typed at. */
export type Settle = (sessionId: string) => Promise<void>;

export interface QuietMetrics {
  /** Milliseconds since this session last produced output. */
  idleMs: number;
}

/**
 * A settler that waits for the pane to go quiet.
 *
 * Gives up at `timeoutMs` and lets the return go anyway: a worse outcome than a late submit is no
 * submit at all, and an agent that never stops printing is not a reason to hold the prompt.
 */
export function quietSettler(
  getMetrics: (sessionId: string) => Promise<QuietMetrics | null>,
  { quietMs = PROMPT_QUIET_MS, timeoutMs = PROMPT_QUIET_TIMEOUT_MS, pollMs = POLL_MS } = {},
): Settle {
  return async (sessionId) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const metrics = await getMetrics(sessionId).catch(() => null);
      if (metrics && metrics.idleMs >= quietMs) return;
      if (Date.now() >= deadline) return;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  };
}

export async function writePromptToPty(
  sessionId: string,
  prompt: string,
  write: WriteToSession,
  settle: Settle = async () => {},
): Promise<void> {
  // Trailing newlines are stripped rather than kept: whatever built the prompt ended it tidily,
  // and that tidiness is exactly what turns the whole thing into a paste.
  const text = prompt.replace(/[\r\n\s]+$/, "");
  if (!text) return;

  await write(sessionId, text);
  // The pane has to finish drawing what it was just handed before it will accept a return.
  await settle(sessionId);
  await write(sessionId, "\r");
}
