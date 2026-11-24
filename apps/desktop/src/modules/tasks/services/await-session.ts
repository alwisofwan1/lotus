/**
 * Waiting for a freshly opened pane to have a PTY behind it.
 *
 * `addPane` returns a pane id immediately; the session is created by the pane once it mounts, so
 * for a beat the pane exists and has nothing to write to. Everything about delegation depends on
 * not writing during that beat.
 */

export interface AwaitSessionDeps {
  /** The pane's session id right now, or null while it has none. */
  peek: (paneId: string) => string | null;
  /** Called back whenever the pane's runtime status moves. Returns an unsubscribe. */
  subscribe: (paneId: string, onChange: () => void) => () => void;
}

export interface AwaitSessionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function awaitSessionId(
  paneId: string,
  deps: AwaitSessionDeps,
  { timeoutMs = 6_000, signal }: AwaitSessionOptions = {},
): Promise<string | null> {
  const now = deps.peek(paneId);
  if (now) return now;
  if (signal?.aborted) return null;

  return new Promise<string | null>((resolve) => {
    let settled = false;

    // One exit for every ending — resolved, timed out, aborted. A listener left on a pane that
    // never started outlives the pane it was waiting for.
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);
    const unsubscribe = deps.subscribe(paneId, () => {
      const id = deps.peek(paneId);
      if (id) finish(id);
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    // The session may have arrived between the first peek and the subscription.
    const raced = deps.peek(paneId);
    if (raced) finish(raced);
  });
}
