/**
 * Layer 2 of the narration stack: the per-agent scoreboard (Slice 4 of
 * `plans/voice-narration-layer/`).
 *
 * **Boundary rule.** This module reports facts and clearly-labelled heuristic *hints*. It never
 * calls a model and never makes a decision. If it cannot be computed by a pure function from the
 * events already observed, it does not belong here — it belongs to the narrator (L5).
 *
 * Adapted from `heardlabs/heard` (Apache-2.0) — `heard/agent_state.py`.
 */

import type { NarrationEvent } from "./narration-event";

/** Per-agent record. Every field is a fact or a labelled hint — nothing model-derived. */
export interface AgentState {
  paneId: string;
  /** The tool running right now, or `null` between calls. */
  currentTool: string | null;
  /** The last tool that finished. */
  lastTool: string | null;
  /** Absolute paths this agent has touched, in first-seen order. */
  filesTouched: string[];
  errorCount: number;
  /**
   * When the most recent tool failure happened, or `null` if none has.
   *
   * Added for `plans/agent-headlines/`: `salienceOf` measures the freshness of the LAST EVENT, not of
   * the error, so `errorCount > 0` plus any recent activity reads as `blocked`. That is right for
   * narration — it decides what to say right now, and a recent failure should pierce — and wrong for
   * a persistent title, where one early error would read "something failed" for the rest of a long
   * session while the agent worked on happily.
   */
  lastErrorAt: number | null;
  /**
   * The ask the current turn started from — the operator's own words, verbatim and untrimmed of
   * meaning.
   *
   * Stored raw. Shortening it for a card is presentation, and belongs to the composer; this layer
   * keeps the fact. The size is bounded upstream (`drop-file.mjs` caps a prompt at 4000 characters),
   * so a pane cannot grow one without limit the way `filesTouched` could.
   *
   * It was flowing past this store from the very first version — `toNarrationEvent` puts it in
   * `neutral` for a prompt drop — and `observe` discarded it while the headline was assembled out of
   * tool names instead. See the header of `agent-headline.ts` for why that was the wrong material.
   */
  lastPrompt: string | null;
  /**
   * Whether a turn is in flight right now — opened by a prompt or a tool, closed by the turn end.
   *
   * `currentTool` cannot answer this. It is `null` both BETWEEN two tools of a live turn and after
   * the turn is over, and those two states want opposite words: the first is "still working", the
   * second is "done". Without this flag the headline composer had to guess, guessed "working" for
   * both, and left a finished agent titled in the present tense (`plans/agent-headlines/`, defect
   * found live 2026-08-26).
   *
   * A hint by the boundary rule above, not a verdict on whether the agent needs a human — that is
   * `agent-turn-registry.ts`'s job, sourced from the hook's own `turn` field. This one says only
   * whether the tool stream is mid-flight, derived purely from events already observed.
   */
  turnActive: boolean;
  eventCount: number;
  lastEventAt: number;
}

/**
 * How urgently this agent wants the user's attention. A **hint**, not a decision: the narrator (L5)
 * may override it with context this layer cannot see.
 */
export type AgentSalience = "blocked" | "active-decision" | "routine";

/**
 * How long a failure keeps an agent `blocked`. Without an expiry, one error an hour ago would
 * out-rank every live agent for the rest of the session.
 */
export const STALE_AFTER_MS = 30_000;

/**
 * Rank an agent's claim on the user's attention. Pure, so the same state always yields the same
 * hint and the whole table is testable.
 *
 * `blocked` deliberately outranks `active-decision`: an agent that failed and immediately started
 * another tool is still the one that needs a human, and ranking the in-flight tool higher would
 * bury the failure under routine chatter.
 */
export function salienceOf(state: AgentState, now: number): AgentSalience {
  const fresh = now - state.lastEventAt <= STALE_AFTER_MS;
  if (state.errorCount > 0 && fresh) return "blocked";
  if (state.currentTool !== null) return "active-decision";
  return "routine";
}

/**
 * A label finer than the repo: the directory this agent is actually working in.
 *
 * Two agents in one project both answer to the project name, which makes "On Lotus…" useless for
 * telling them apart. The dominant parent directory of the files they have touched is a zero-config
 * label that does: "on the analytics side", "over on the frontend".
 *
 * Ties break alphabetically rather than by recency — a label that flaps between bursts reads as two
 * different agents.
 */
export function areaOf(state: AgentState): string | null {
  const counts = new Map<string, number>();
  for (const filePath of state.filesTouched) {
    const parent = filePath.replace(/\/+$/, "").split("/").slice(-2, -1)[0];
    if (parent) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export interface AgentStateRegistry {
  observe(event: NarrationEvent): AgentState;
  get(paneId: string): AgentState | undefined;
  all(): AgentState[];
  /**
   * Record an ask made against this pane by a human or a dispatch, creating the pane if unseen.
   *
   * A sibling of {@link observe} rather than part of it, because the input is not a hook drop and
   * must not be treated as one. It sets `lastPrompt` and opens the turn, and deliberately leaves
   * `eventCount` and `lastEventAt` alone — those rank the voice narrator's attention and are fed by
   * the drop stream, so an operator's keystroke moving them would make a pane sound freshly active
   * on a channel narration never observed.
   *
   * This is what gives a headline to runners with no prompt hook at all — codex, cursor, custom.
   * See `pane-ask-buffer.ts` for where the text comes from.
   */
  noteAsk(paneId: string, ask: string): AgentState;
  /**
   * Drop everything known about a pane. Called when its node closes
   * (`plans/agent-headlines/` Slice 1).
   *
   * Not optional housekeeping: `filesTouched` grows without bound per pane and `areaOf` walks the
   * whole list, so a board that opens and closes agents all day would otherwise carry every path
   * any of them ever touched — and hand a reopened pane the previous occupant's area label.
   */
  clear(paneId: string): void;
  /**
   * Listener for any observable change. Returns an unsubscribe.
   *
   * This store did not need either of the two members below while its only consumer was the voice
   * narrator, which reads it synchronously inside an event handler. A rendered headline needs to
   * know when to repaint.
   */
  subscribe(listener: () => void): () => void;
  /**
   * A counter that advances on every observable change, for `useSyncExternalStore`.
   *
   * Load-bearing here in a way it would not be for an immutable store: `observe` MUTATES the stored
   * `AgentState` and returns the same reference, so a snapshot of `get(paneId)` is always
   * reference-identical and React would correctly skip every render. The counter is the comparable
   * snapshot. (`plans/honest-agent-status/` Slice 8 hit the same wall with its answered mark.)
   */
  version(): number;
}

/**
 * Pull the tool name out of a routing tag: `tool_bash` → `bash`, `tool_post_edit` → `edit`.
 * Returns `null` for tags that name no tool — the generic failure marker, prose, turn ends.
 */
function toolNameFromTag(tag: string): string | null {
  const parts = tag.split("_");
  if (parts[0] !== "tool") return null;
  const rest = parts[1] === "post" || parts[1] === "pre" ? parts.slice(2) : parts.slice(1);
  if (rest.length === 0) return null;
  // `tool_post_failure` names an outcome, not a tool; letting it through would set
  // `lastTool = "failure"`.
  if (rest[0] === "failure" || rest[0] === "unknown") return null;
  return rest.join("_");
}

/**
 * Whether a tool target is a file path rather than a command line.
 *
 * `NarrationEvent.filePath` is the drop payload's `body`, and for Bash that body is the COMMAND —
 * `cd /Users/me/workspace/experiments/Lotus && bun run test`. Nothing reaches here today because a
 * Bash `tool-post` carries no target at all (measured 2026-08-26 against a real transcript ring),
 * but if a runner ever populates it, `areaOf` would split that command on "/" and report
 * "experiments" as the agent's area — confidently and wrongly.
 *
 * A path has no whitespace and no shell punctuation. Deliberately a shape test rather than a
 * filesystem check: this runs per event, and the file may already be gone.
 */
function looksLikePath(target: string): boolean {
  return target.length > 0 && !/[\s&|;><]/.test(target);
}

function blankState(paneId: string, ts: number): AgentState {
  return {
    paneId,
    currentTool: null,
    lastTool: null,
    filesTouched: [],
    errorCount: 0,
    lastErrorAt: null,
    lastPrompt: null,
    // Closed until an event proves otherwise: a lone `tool_post` says a tool finished, not that the
    // turn continues, and the past tense is the honest reading of an unknown.
    turnActive: false,
    eventCount: 0,
    lastEventAt: ts,
  };
}

export function createAgentStateRegistry(): AgentStateRegistry {
  const agents = new Map<string, AgentState>();
  const listeners = new Set<() => void>();
  let version = 0;
  const emit = () => {
    version += 1;
    listeners.forEach((listener) => listener());
  };

  return {
    observe(event: NarrationEvent): AgentState {
      const existing = agents.get(event.paneId);
      const state = existing ?? blankState(event.paneId, event.ts);
      if (!existing) agents.set(event.paneId, state);

      state.eventCount += 1;
      state.lastEventAt = event.ts;

      const toolName = toolNameFromTag(event.tag);
      if (event.kind === "prompt_intent") {
        state.turnActive = true;
        // Guarded rather than assigned: a runner that fires the prompt hook with no payload would
        // otherwise erase a perfectly good headline and leave the card blank for the whole turn.
        const asked = event.neutral.trim();
        if (asked) state.lastPrompt = asked;
      } else if (event.kind === "final") {
        state.turnActive = false;
      }

      if (event.kind === "tool_pre") {
        // A tool cannot run outside a turn, so this is proof of a live one — and it is the only such
        // proof for a pane Lotus began watching mid-turn, whose `prompt_intent` it never saw.
        state.turnActive = true;
        state.currentTool = toolName;
        // Also the last tool, because `tool_pre` is the only event that reliably NAMES one.
        // Measured 2026-08-26 against a real 60-entry ring: every `tool-pre` carried `Bash` and
        // every `tool-post` carried the literal default `"Tool"` — `extractToolName` reads
        // `tool_name`, which a PostToolUse payload does not supply. Deriving `lastTool` from the
        // post alone recorded "tool" for every call, which is in no phrase table.
        if (toolName) state.lastTool = toolName;
      } else if (event.kind === "tool_post") {
        if (event.tag === "tool_post_failure") {
          state.errorCount += 1;
          state.lastErrorAt = event.ts;
        }
        // A named post still wins — Codex and future runners may populate it — but an unnamed one
        // no longer overwrites what the pre established.
        if (toolName && toolName !== "tool") state.lastTool = toolName;
        state.currentTool = null;
        if (
          event.filePath
          && looksLikePath(event.filePath)
          && !state.filesTouched.includes(event.filePath)
        ) {
          state.filesTouched.push(event.filePath);
        }
      }

      emit();
      return state;
    },

    noteAsk(paneId: string, ask: string): AgentState {
      const existing = agents.get(paneId);
      // `lastEventAt` seeds to 0, not to now: this path must not look like a narration event, and a
      // pane whose only activity is a typed ask has no observed event to date.
      const state = existing ?? blankState(paneId, 0);
      if (!existing) agents.set(paneId, state);
      const asked = ask.trim();
      if (asked) state.lastPrompt = asked;
      state.turnActive = true;
      emit();
      return state;
    },

    get(paneId) {
      return agents.get(paneId);
    },

    clear(paneId) {
      if (agents.delete(paneId)) emit();
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

    all() {
      return [...agents.values()];
    },
  };
}

/**
 * Process-wide facts store, shared by the headline feed (producer) and every headline reader.
 *
 * The narration stack builds its own instance per session (its router owns the lifetime), so this
 * export is for the always-on path in `plans/agent-headlines/` — one subscriber, many cheap readers,
 * the same shape `agentStatusRegistry` and `agentTurnRegistry` use.
 */
export const agentStateRegistry: AgentStateRegistry = createAgentStateRegistry();
