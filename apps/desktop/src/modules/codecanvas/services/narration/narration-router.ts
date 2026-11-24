/**
 * Layer 3 of the narration stack: who gets spoken, and when (Slice 5 of
 * `plans/voice-narration-layer/`).
 *
 * The problem this exists to solve: with four agents running, naive per-event narration is
 * incoherent — the listener hears half a sentence from each, bouncing. This module decides, per
 * event, whether to speak it now, drop it, or hold it for a batched summary.
 *
 * **Boundary rule.** A pure state machine: no I/O, no model, no speech. It returns a decision and
 * the caller renders it — to audio *and* to the canvas, which is why the decision is an object
 * rather than a speak() call.
 *
 * Adapted from `heardlabs/heard` (Apache-2.0) — `heard/multi_agent.py`.
 */

import type { NarrationEvent } from "./narration-event";

export type RoutingAction = "speak" | "drop" | "defer_to_digest";

export interface RoutingDecision {
  action: RoutingAction;
  /** `"Nova: "` when the listener needs to be told who is talking; empty otherwise. */
  labelPrefix: string;
}

export interface NarrationRouterOptions {
  /** Pane id → the agent's spoken name. */
  resolveName: (paneId: string) => string;
}

export interface NarrationRouter {
  classify(event: NarrationEvent, now: number): RoutingDecision;
  /** Pop every project whose channel is ready to drain. Empties what it returns. */
  collectFlushes(now: number): ProjectFlush[];
  /** Follow one agent exclusively. */
  pin(paneId: string): void;
  unpin(): void;
}

/**
 * Tags that always reach the listener, whatever else is going on — the "name called across the
 * room" signal.
 *
 * `prompt_intent` is on the list for a different reason than the failures: batching "you just asked
 * X" into a flush two seconds later is useless, because by then the agent has already started
 * answering.
 */
const PIERCE_TAGS: ReadonlySet<string> = new Set(["tool_post_failure", "tool_question", "prompt_intent"]);

/**
 * Whether this tag is one the listener must be reached with.
 *
 * Exported because urgency has to be read from the TAG, never from whether the router happened to
 * attach a name: with one agent working there is nobody to disambiguate from, so a failure is
 * spoken with no prefix at all. Inferring urgency from the prefix silently misses the single-agent
 * case, which is the common one.
 */
export function isPierceTag(tag: string): boolean {
  return PIERCE_TAGS.has(tag);
}

/** How long after its last event an agent still counts as active for the solo/swarm decision. */
export const AGENT_ACTIVE_MS = 30_000;

/**
 * How long a project must be quiet before its held-back events are spoken as one update. This is a
 * natural turn boundary — draining mid-burst would cut the agent off mid-thought.
 */
export const CHANNEL_IDLE_FLUSH_MS = 2_000;

/**
 * Backpressure cap. A project that never falls quiet would otherwise hold its own update hostage
 * indefinitely, so a big enough backlog forces a drain regardless of how busy it still is.
 */
export const CHANNEL_MAX_PENDING = 5;

/** One project's held-back events, ready to be spoken as a single update. */
export interface ProjectFlush {
  projectId: string;
  /** Panes that contributed — same-project agents collapse into one update, not one each. */
  paneIds: string[];
  events: NarrationEvent[];
}

/**
 * Group by PROJECT, not by pane. Two agents in one repo produce one coherent update; agents in
 * different repos stay separate streams. Falls back to the pane id for an unscoped pane so it gets
 * its own channel rather than colliding with every other unscoped pane under one empty key.
 */
function projectOf(paneId: string): string {
  return /^canvas:([^:]+):/.exec(paneId)?.[1] ?? paneId;
}

export function createNarrationRouter({ resolveName }: NarrationRouterOptions): NarrationRouter {
  const lastEventAt = new Map<string, number>();
  const pending = new Map<string, NarrationEvent[]>();
  let pinned: string | null = null;

  const defer = (event: NarrationEvent): RoutingDecision => {
    const key = projectOf(event.paneId);
    const bucket = pending.get(key);
    if (bucket) bucket.push(event);
    else pending.set(key, [event]);
    return { action: "defer_to_digest", labelPrefix: "" };
  };

  const activeCount = (now: number): number =>
    [...lastEventAt.values()].filter((ts) => now - ts <= AGENT_ACTIVE_MS).length;

  const named = (paneId: string): string => `${resolveName(paneId)}: `;

  return {
    classify(event, now) {
      lastEventAt.set(event.paneId, event.ts);
      const pierces = PIERCE_TAGS.has(event.tag);

      if (pinned !== null) {
        if (event.paneId === pinned) return { action: "speak", labelPrefix: "" };
        // Pinning means "narrate this one to me", not "hide everything else breaking".
        return pierces
          ? { action: "speak", labelPrefix: named(event.paneId) }
          : { action: "drop", labelPrefix: "" };
      }

      if (activeCount(now) < 2) return { action: "speak", labelPrefix: "" };

      return pierces ? { action: "speak", labelPrefix: named(event.paneId) } : defer(event);
    },

    collectFlushes(now) {
      const out: ProjectFlush[] = [];
      for (const [projectId, events] of pending) {
        if (events.length === 0) continue;
        const quietFor = now - Math.max(...events.map((e) => e.ts));
        if (quietFor < CHANNEL_IDLE_FLUSH_MS && events.length < CHANNEL_MAX_PENDING) continue;
        out.push({
          projectId,
          paneIds: [...new Set(events.map((e) => e.paneId))],
          events: [...events].sort((a, b) => a.ts - b.ts),
        });
        // Emptied as part of the same pass: an event arriving after this belongs to the NEXT
        // update, not to one already on its way to the speaker.
        pending.set(projectId, []);
      }
      return out;
    },

    pin(paneId) {
      pinned = paneId;
    },

    unpin() {
      pinned = null;
    },
  };
}
