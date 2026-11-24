/**
 * Which conversations are generating a reply right now.
 *
 * `ChatView` has always known — `status === "streaming" || "submitted"` — and has always offered
 * it (`onStreamingChange`). Nothing listened, so a thread pane in the workspace looked exactly the
 * same whether its agent was mid-answer or had been finished for an hour.
 *
 * A module-level registry rather than a context, deliberately, and it is the same shape
 * `terminal-activity-registry` uses for the same reason: the producer (a mounted `ChatView`) and
 * the consumers (a rail row, a pane header, the chrome's count) are in different subtrees and can
 * mount in either order. A context would force them under one provider, which is exactly what the
 * `/codechat` route is not.
 *
 * It holds LIVE state only. Nothing here is persisted, and a reload starts empty — a stored
 * "streaming" would be a claim about a process that no longer exists.
 */

export type ThreadActivityListener = () => void;

export interface ThreadActivityRegistry {
  /**
   * Report a conversation's streaming state.
   *
   * Idempotent: repeating the current value notifies nobody. `ChatView` reports from an effect
   * that runs on every render of its status, so this is the guard that keeps a long reply from
   * repainting every rail row on every token.
   */
  setStreaming(sessionId: string, streaming: boolean): void;
  isStreaming(sessionId: string): boolean;
  /** New Chat (beta, 07d): a turn is held on an approval or a question. Same idempotence. */
  setWaiting(sessionId: string, waiting: boolean): void;
  isWaiting(sessionId: string): boolean;
  /** Drop a conversation entirely — its view unmounted, so nothing can be said about it. */
  clear(sessionId: string): void;
  subscribe(listener: ThreadActivityListener): () => void;
  /** A primitive, monotonic snapshot for `useSyncExternalStore`. */
  version(): number;
}

export function createThreadActivityRegistry(): ThreadActivityRegistry {
  const streaming = new Set<string>();
  const waiting = new Set<string>();
  const listeners = new Set<ThreadActivityListener>();
  let version = 0;

  const emit = () => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    setStreaming(sessionId, isStreaming) {
      if (!sessionId) return;
      const known = streaming.has(sessionId);
      if (known === isStreaming) return;
      if (isStreaming) streaming.add(sessionId);
      else streaming.delete(sessionId);
      emit();
    },
    isStreaming(sessionId) {
      return streaming.has(sessionId);
    },
    setWaiting(sessionId, isWaiting) {
      if (!sessionId || waiting.has(sessionId) === isWaiting) return;
      if (isWaiting) waiting.add(sessionId);
      else waiting.delete(sessionId);
      emit();
    },
    isWaiting(sessionId) {
      return waiting.has(sessionId);
    },
    clear(sessionId) {
      // An unmount while a reply was still arriving must not leave the badge on forever: the view
      // that was reporting it is gone, so the honest state is "nothing known".
      const dropped = streaming.delete(sessionId);
      if (!waiting.delete(sessionId) && !dropped) return;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version() {
      return version;
    },
  };
}

/** Process-wide instance: one producer per conversation, any number of readers. */
export const threadActivityRegistry: ThreadActivityRegistry = createThreadActivityRegistry();

/** Code pane id → the chat thread it shows. Code mode already alerts for these, so Chat's alert skips them. */
export const chatPaneThreads = new Map<string, string>();
