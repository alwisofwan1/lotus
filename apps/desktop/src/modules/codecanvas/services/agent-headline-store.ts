/**
 * What headline each pane is currently SHOWING (`plans/agent-headlines/` Slice 3).
 *
 * The composer is pure and recomputes on every event; this is the memory that decides whether a
 * newly composed line is worth putting on screen. That decision needs state, which is why it is a
 * store and not another pure function.
 *
 * **The rule came from a measurement.** A real 60-entry transcript ring (2026-08-26) showed turns of
 * 1-5 tool calls seconds apart, each firing `tool-pre` then `tool-post` — so the composed text flips
 * present → past → present twice per call. A title changing every second or two is unreadable.
 *
 * The fix is not a timer. That flip carries no new information — between two tools of a live turn
 * the agent is still working — so a headline is replaced only when its {@link Headline.key} changes:
 * a different tool, a different area, a failure, or the turn ending. The composer holds the present
 * tense across the whole turn, and this store does not even notify while it does.
 *
 * The turn end must be in the key, and once was not: with both branches keyed on the present form
 * this store was guaranteed to discard the past form, and a finished agent kept a present-tense
 * title. Caught live on 2026-08-26 — a card reading "running a command" beside an IDLE badge.
 */

import type { Headline } from "./agent-headline";

export interface AgentHeadlineStore {
  /** Offer a freshly composed headline. Accepted only if its key differs from the displayed one. */
  record(paneId: string, headline: Headline): void;
  /** The line to render for this pane, or `undefined` when there is nothing to show. */
  get(paneId: string): string | undefined;
  clear(paneId: string): void;
  subscribe(listener: () => void): () => void;
  /** Advances only on a change the operator can see — the snapshot for `useSyncExternalStore`. */
  version(): number;
}

export function createAgentHeadlineStore(): AgentHeadlineStore {
  const shown = new Map<string, { text: string; key: string }>();
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = () => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  return {
    record(paneId, headline) {
      const current = shown.get(paneId);

      // The composer found nothing factual to say. Drop the line rather than leaving a stale one —
      // a reopened pane with no tools yet must not wear the previous occupant's title.
      if (headline.text === null || headline.key === null) {
        if (current && shown.delete(paneId)) emit();
        return;
      }

      // Same key: the composer has nothing new to say. Holding here is the whole point — it is
      // also what keeps a board of eight agents from repainting on every tool-post.
      if (current?.key === headline.key) return;

      shown.set(paneId, { text: headline.text, key: headline.key });
      emit();
    },

    get(paneId) {
      return shown.get(paneId)?.text;
    },

    clear(paneId) {
      // Deleting takes the KEY with it, which is what lets a reopened pane doing identical work show
      // its headline again instead of being suppressed as "unchanged".
      if (shown.delete(paneId)) emit();
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

/** Process-wide store: the feed writes, every reader subscribes. */
export const agentHeadlineStore: AgentHeadlineStore = createAgentHeadlineStore();
