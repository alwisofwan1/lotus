"use client";

/**
 * Read the current headline for any pane (`plans/agent-headlines/` Slice 4).
 *
 * Returns a reader FUNCTION rather than a single value, because both surfaces that need headlines
 * render N rows — the sidebar's process list and the needs-you lane — and a hook per row is not
 * allowed. One subscription per surface, then a synchronous read per row.
 *
 * The subscription is on the store's version, which advances only when a headline the operator can
 * see actually changed. That is what carries Slice 3's stability rule all the way through to the
 * render: the tense flip after every tool call is absorbed by the store and never repaints anything.
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  agentHeadlineStore,
  type AgentHeadlineStore,
} from "../services/agent-headline-store";

export function useAgentHeadlines(
  store: AgentHeadlineStore = agentHeadlineStore,
): (paneId: string) => string | undefined {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(onChange), [store]);
  // Subscribed for the re-render, not for the value. The reader below reads live state, so it needs
  // no identity change to return a fresh answer — the render is what delivers it.
  useSyncExternalStore(
    subscribe,
    () => store.version(),
    () => 0,
  );
  return useCallback((paneId: string) => store.get(paneId), [store]);
}
