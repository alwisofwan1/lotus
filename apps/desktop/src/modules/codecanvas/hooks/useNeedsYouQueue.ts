"use client";

/**
 * The triage queue, kept live (`plans/honest-agent-status/` Slice 4).
 *
 * Two things change under this list and neither is a render trigger on its own: turn facts arrive in
 * their own registry, and the *wait* grows with the clock. So the hook subscribes to the registry
 * and ticks — but only while something is actually waiting, which on most boards on most days is
 * never.
 *
 * The clock is held in state rather than read during render. Reading it inline made the render
 * output depend on when it ran (the `react-hooks/purity` rule catches exactly this), and it also
 * meant the age moved on renders that had nothing to do with time passing. Holding it makes the
 * tick the only thing that advances the wait, which is what the interval is for.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { agentTurnRegistry, type AgentTurnRegistry } from "../services/agent-turn-registry";
import { mergeNeedsYou, needsYouQueue, type NeedsYouAsk, type NeedsYouEntry } from "../services/needs-you-queue";
import { agentHeadlineStore, type AgentHeadlineStore } from "../services/agent-headline-store";
import type { AgentStatusSnapshot } from "../services/agent-status-registry";

/**
 * How often a waiting row's age is recomputed.
 *
 * 5s against a display that reads in seconds, then whole minutes: the visible number can sit up to
 * five seconds stale in its first minute and is exact from there on. A 1s tick would repaint the
 * panel sixty times a minute to move one digit nobody is reading that closely.
 */
export const NEEDS_YOU_TICK_MS = 5_000;

const NO_ASKS: readonly NeedsYouAsk[] = [];

export function useNeedsYouQueue(
  roster: readonly AgentStatusSnapshot[],
  registry: AgentTurnRegistry = agentTurnRegistry,
  headlines: AgentHeadlineStore = agentHeadlineStore,
  /** The Dock apps' asks (S5), merged in by the same oldest-first key. */
  asks: readonly NeedsYouAsk[] = NO_ASKS,
): NeedsYouEntry[] {
  // Subscribed for the re-render, not for the value: a new fact must reach this list, and the
  // store's version changing is what delivers it.
  useSyncExternalStore(
    (onChange) => registry.subscribe(onChange),
    () => registry.version(),
    () => 0,
  );
  const [now, setNow] = useState(() => Date.now());

  // The headline store version is read for its render trigger, the same way the turn registry's is:
  // a row's headline can change while its wait does not.
  useSyncExternalStore(
    (onChange) => headlines.subscribe(onChange),
    () => headlines.version(),
    () => 0,
  );

  const agents = needsYouQueue(roster, (paneId) => registry.get(paneId), now).map((entry) => {
    // Attached here rather than inside the pure queue, so that function keeps one responsibility.
    const headline = headlines.get(entry.paneId);
    return headline ? { ...entry, headline } : entry;
  });
  const entries = mergeNeedsYou(agents, asks, now);
  const waiting = entries.length > 0;

  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), NEEDS_YOU_TICK_MS);
    return () => clearInterval(id);
  }, [waiting]);

  return entries;
}
