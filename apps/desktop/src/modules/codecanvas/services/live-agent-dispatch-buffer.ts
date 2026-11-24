export const MAX_LIVE_AGENT_STARTUP_DISPATCHES = 50;

/** Add one startup dispatch with bounded backpressure. Returns the rejected newest turn, if full. */
export function enqueueLiveAgentStartupDispatch(
  pending: string[],
  text: string,
  maxPending = MAX_LIVE_AGENT_STARTUP_DISPATCHES,
): string | undefined {
  const limit = Math.max(1, Math.floor(maxPending));
  if (pending.length >= limit) return text;
  pending.push(text);
  return undefined;
}

/**
 * Flush startup-buffered prompts as independent turns. Each submit waits for its receipt before the
 * next prompt starts, preserving FIFO order without merging user intents into one synthetic prompt.
 */
export interface LiveAgentDispatchFlushResult {
  written: string[];
  failed: string[];
}

export async function flushLiveAgentDispatchBuffer(
  messages: readonly string[],
  submit: (text: string) => Promise<void>,
): Promise<LiveAgentDispatchFlushResult> {
  const result: LiveAgentDispatchFlushResult = { written: [], failed: [] };
  for (const text of messages) {
    try {
      await submit(text);
      result.written.push(text);
    } catch {
      result.failed.push(text);
    }
  }
  return result;
}
