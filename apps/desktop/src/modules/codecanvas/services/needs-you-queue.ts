/**
 * The triage queue: which agents are waiting for a human, oldest ask first
 * (`plans/honest-agent-status/` Slice 4).
 *
 * **Stability comes from the sort key, not from remembered state.** The design brief asked that
 * rows never reorder under the operator's cursor, and the obvious implementation — carry the
 * previous order and append newcomers — needs state, and state needs invalidating. Sorting by the
 * moment the ask landed gets it for free: an ask's timestamp never changes, so an existing row
 * cannot move when a new one arrives (the newcomer's timestamp is later, so it appends), and a row
 * only ever leaves by being answered. Pure function, no history parameter, provably stable.
 *
 * Oldest-first is also the order ⌘J walks (Slice 5), so the keyboard and the list agree without
 * either of them having to know about the other.
 */

import type { AgentStatusSnapshot } from "./agent-status-registry";
import type { AgentTurnFact } from "./agent-turn-registry";
import { canvasRuntimePaneId } from "./canvas-runtime-scope";

/** Where an ask comes from (`plans/canvas-dock/` S5): agents focus; the rest open in the Dock. */
export type NeedsYouSource = "agent" | "factory" | "automation" | "task";

export interface NeedsYouEntry {
  /** ReactFlow node id for an agent — what focus and ⌘J target; a prefixed item id otherwise. */
  id: string;
  /** Absent means `agent`, as every entry was before S5. */
  source?: NeedsYouSource;
  /** Opens a non-agent ask where it is answered (the Dock). Agents are focused instead. */
  onOpen?: () => void;
  /** The pane's LOTUS_PANE_ID, for reading its turn fact. */
  paneId: string;
  name: string;
  /** How long the ask has been waiting, in ms. `undefined` when no fact backs it. */
  waitingMs: number | undefined;
  /**
   * What the agent was doing when it stopped to ask (`plans/agent-headlines/` Slice 4).
   *
   * Absent when the composer had nothing factual to say. Filled by `useNeedsYouQueue`, not by this
   * pure function, so the queue keeps a single responsibility and stays trivially testable.
   */
  headline?: string;
}

/**
 * An ask from a Dock app, before it is placed in the queue: when it landed rather than how long it
 * has waited, so the queue's own clock ages it with the agents' asks.
 */
export interface NeedsYouAsk {
  id: string;
  source: Exclude<NeedsYouSource, "agent">;
  name: string;
  /** What it waits for, in a few words: shown where an agent shows its headline. */
  line: string;
  askedAtMs: number;
  onOpen: () => void;
}

/** "Factory", "Automation": the lane's source tag. */
export const NEEDS_YOU_SOURCE_LABEL: Record<NeedsYouSource, string> = { agent: "Agent", factory: "Factory", automation: "Automation", task: "Tasks" };

/** Oldest ask first; an entry with no known wait last (see {@link needsYouQueue}). */
function byOldestAsk(a: NeedsYouEntry, b: NeedsYouEntry): number {
  // An entry with no fact sorts last: `needs-you` is only ever produced BY a fact, so a missing
  // one means the two stores are momentarily out of step, not that the ask is new. Guessing it is
  // the oldest would put it at the top of the queue on the strength of an absence.
  if (a.waitingMs === undefined) return b.waitingMs === undefined ? 0 : 1;
  if (b.waitingMs === undefined) return -1;
  return b.waitingMs - a.waitingMs;
}

/**
 * One queue for agents and the Dock's apps (S5). The same sort key, so a Factory run that has
 * waited an hour sits above an agent that asked a minute ago, and no row moves when one arrives.
 */
export function mergeNeedsYou(agents: readonly NeedsYouEntry[], asks: readonly NeedsYouAsk[], now: number): NeedsYouEntry[] {
  if (asks.length === 0) return [...agents];
  const placed = asks.map((ask): NeedsYouEntry => ({
    id: ask.id,
    paneId: "",
    source: ask.source,
    name: ask.name,
    headline: ask.line || undefined,
    waitingMs: Math.max(0, now - ask.askedAtMs),
    onOpen: ask.onOpen,
  }));
  return [...agents, ...placed].sort(byOldestAsk);
}

export function needsYouQueue(
  roster: readonly AgentStatusSnapshot[],
  factFor: (paneId: string) => AgentTurnFact | undefined,
  now: number,
): NeedsYouEntry[] {
  const blocked = roster.filter((snapshot) => snapshot.status === "needs-you");

  const entries = blocked.map((snapshot): NeedsYouEntry => {
    // `hookPaneId` is the key the hook actually exported; fall back the way the registry does for
    // older callers that only ever set `id`.
    const paneId = snapshot.hookPaneId ?? canvasRuntimePaneId(snapshot.projectId, snapshot.id);
    const fact = factFor(paneId);
    return {
      id: snapshot.id,
      paneId,
      name: snapshot.name,
      waitingMs: fact === undefined ? undefined : Math.max(0, now - fact.atMs),
    };
  });

  return entries.sort(byOldestAsk);
}

/**
 * How long an ask has been waiting, as the lane prints it: `14s`, `2m`, `4h`.
 *
 * Floored, never rounded up: "1m" must not appear at 59.6s, because the number sits next to a
 * live-updating list and an operator reading it twice should never see it go backwards. Hours are
 * carried because {@link TURN_FRESH_MS} is four of them — an ask genuinely can be that old, and
 * that is precisely the one worth stating rather than flattening to "59m".
 */
export function formatWaiting(waitingMs: number | undefined): string {
  // Not "0s": that would claim the ask just landed, when the truth is we do not know.
  if (waitingMs === undefined) return "";
  const seconds = Math.floor(waitingMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

/**
 * Which waiting agent the jump chord should land on next (`plans/honest-agent-status/` Slice 5).
 *
 * Derived from the CURRENT focus rather than from a stored cursor, which is what keeps it pure and
 * keeps it honest: there is no hidden position to go stale when an ask is answered, a new one
 * arrives, or the operator clicks a row by hand. Press once and you are on the longest-waiting ask;
 * press again and you walk to the next; the end wraps.
 *
 * A single-entry queue returns that entry even when it is already focused — pressing the chord and
 * having the camera not move reads as a broken shortcut, and re-framing the node is the honest
 * answer to "take me to the thing that needs me".
 */
export function nextNeedsYouTarget(
  queue: readonly NeedsYouEntry[],
  focusedNodeId: string | null | undefined,
): string | null {
  if (queue.length === 0) return null;
  const at = queue.findIndex((entry) => entry.id === focusedNodeId);
  // Focus is usually on whatever the operator was last doing, which is not in the queue — start at
  // the oldest ask.
  if (at === -1) return queue[0].id;
  return queue[(at + 1) % queue.length].id;
}
