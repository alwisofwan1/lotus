"use client";

import { useEffect, useState } from "react";

import type { AutomationClient, AutomationDraft, Subscribe } from "../services/automation-api";
import { waitingItems } from "../services/inbox-model";

const NONE: AutomationDraft[] = [];

/**
 * The rows that wait for a human, as the Inbox lists them (`waitingItems`: one row per PR, a
 * result counted once). Kept apart from `useAutomation` so a closed panel reads two lists, not
 * four. Results that fail to load count as none; any other failure reads as empty: a badge, or a
 * host's Needs-you queue, must never throw.
 */
export function usePendingDrafts(client: AutomationClient, subscribe: Subscribe): AutomationDraft[] {
  const [waiting, setWaiting] = useState<AutomationDraft[]>(NONE);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void Promise.all([client.drafts(), Promise.resolve(client.results?.()).catch(() => [])])
        .then(([drafts, results]) => {
          const list = (value: unknown) => (Array.isArray(value) ? (value as AutomationDraft[]) : []);
          if (alive) setWaiting(waitingItems(list(drafts), list(results)));
        })
        .catch(() => alive && setWaiting(NONE));
    read();
    const unsubscribe = subscribe(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [client, subscribe]);
  return waiting;
}

/** How many rows wait for a human, for the window-rail badge: the same count as the Inbox. */
export function usePendingDraftCount(client: AutomationClient, subscribe: Subscribe): number {
  return usePendingDrafts(client, subscribe).length;
}
