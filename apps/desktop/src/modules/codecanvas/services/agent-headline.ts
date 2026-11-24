/**
 * One short line saying what an agent is working on (`plans/agent-headlines/` Slice 2).
 *
 * **Facts only, and no model.** Everything here comes from hook events the agent's CLI already
 * fires. An agent's own summary of its work is prose, prose needs a model, and the model paths
 * available here are BYOK or a ~117s cold CLI (`nl-model-transport.ts:18`) — neither is payable per
 * agent per turn.
 *
 * **The headline is the ask.** This module first built the line out of tool names — "running a
 * command", "editing · auth" — reasoning that *what it is doing and where* was a long way ahead of a
 * name and a dot. On screen it was not. Two measurements, taken after an operator called the result
 * useless on 2026-08-26:
 *
 * - `extractToolFilePath` (`payload-extractors.mjs:299`) reads only `file_path`, and Bash carries
 *   none, so a Bash-heavy agent accumulates no `filesTouched` and the area label never resolves.
 * - With no area and no tool variety, every headline it can produce is the one constant string
 *   `ran a command` — identical across agents and across a whole session. That is not a title.
 *
 * The material that works was already arriving and being thrown away: `toNarrationEvent` puts the
 * operator's own prompt in `neutral` on a prompt drop. It is goal-shaped by construction, stable for
 * a whole turn, and different for every agent on the board — which is exactly the job. Free, with no
 * model and no change to the hook.
 *
 * Tool phrases remain as the fallback for a pane Lotus attached to mid-turn, whose ask it never saw.
 *
 * Verbs come from `narration-line.ts`'s table rather than a second copy, so an agent's spoken line
 * and its card title can never disagree about the same tool.
 */

import {
  TOOL_PHRASES,
  UNKNOWN_TOOL_PHRASE,
} from "./narration/narration-line";
import {
  areaOf,
  STALE_AFTER_MS,
  type AgentState,
} from "./narration/agent-state-registry";

/** The separator between what and where. A middle dot, matching the runner suffix on the card. */
const JOIN = " · ";

/**
 * A headline plus the key that decides whether it is worth REPLACING the one on screen.
 *
 * The key exists because of a measurement, not a preference. A real 60-entry transcript ring
 * (2026-08-26) showed turns of 1-5 tool calls seconds apart, each firing a `tool-pre` then a
 * `tool-post` — so the composed text flips present → past → present twice per call. A title that
 * changes every second or two is unreadable.
 *
 * No timer is needed to fix that, because that flip carries no new information: between two tools
 * of a live turn the agent is still working, so the present tense simply holds. A different tool, a
 * different area, or the TURN ENDING all change the key; the pre/post flip inside a turn does not.
 * The store (Slice 3) replaces only on a key change.
 *
 * The turn end had to be part of the key, and was not at first. Keying both branches on the present
 * form made the past form unreachable, so a finished agent kept a present-tense title — reported
 * live on 2026-08-26 as a card reading "running a command" beside an IDLE badge.
 */
export interface Headline {
  /** What to render, or `null` when there is nothing factual to say. */
  text: string | null;
  /** Identity for stability comparison, or `null` alongside a null text. */
  key: string | null;
}

/**
 * The headline for one agent, or `null` when there is nothing factual to say.
 *
 * `null` is a real answer, not a failure: a freshly-spawned agent that has run no tools has done
 * nothing worth titling, and rendering the name alone is honest. Inventing "getting started" would
 * be claiming more than a fact.
 */
export function composeHeadline(state: AgentState | undefined, now: number): string | null {
  return headlineOf(state, now).text;
}

/** {@link composeHeadline} plus its stability key. See {@link Headline}. */
export function headlineOf(state: AgentState | undefined, now: number): Headline {
  if (!state) return { text: null, key: null };

  const area = areaOf(state);
  const place = area ? `${JOIN}${area}` : "";
  // Keyed on the PHRASE rather than the tool name: `grep` and `glob` both read "searching", and two
  // keys for one visible string would let the store churn on a change nobody can see.
  const keyed = (verbKey: string, text: string): Headline => ({
    text,
    key: `${verbKey}|${area ?? ""}`,
  });

  // A fresh failure outranks whatever the agent has moved on to — it is the thing a human most needs
  // to know at a glance.
  //
  // Keyed on the ERROR's own recency, not `salienceOf`. That predicate measures the freshness of the
  // last EVENT, so `errorCount > 0` plus any activity reads as `blocked` — correct for narration,
  // which decides what to say right now, and wrong here: one early failure would title a long
  // session "something failed" for its entire duration while the agent worked on happily.
  //
  // The window itself is borrowed rather than invented: STALE_AFTER_MS is the same 30s the narration
  // layer already decided a failure stays urgent for.
  if (state.lastErrorAt !== null && now - state.lastErrorAt <= STALE_AFTER_MS) {
    // Its own key, so a failure always displaces the work line rather than being suppressed as
    // "the same verb in a different tense".
    return keyed("failed", `something failed${place}`);
  }

  // The ask outranks the tool line: it says what this agent is FOR, which is what a glance across a
  // board is asking. No key trick is needed here — a goal does not flicker, so the churn the key was
  // invented for cannot arise on this branch.
  const asked = summarizePrompt(state.lastPrompt);
  if (asked) return { text: asked, key: `prompt|${asked}` };

  // Present tense while a tool is in flight, past once it is done. The tense IS the signal that the
  // work finished, which is why the shared table carries both forms.
  if (state.currentTool) {
    const phrase = phraseFor(state.currentTool);
    return keyed(phrase.present, `${phrase.present}${place}`);
  }
  if (state.lastTool) {
    const phrase = phraseFor(state.lastTool);
    // Between two tools of a LIVE turn, the agent has not finished anything a title should announce
    // — it is still working, and saying so in the present is both truer and perfectly steady. This
    // is what the churn measurement was actually about: `tool_post` clears `currentTool` seconds
    // before the next `tool_pre` sets it again, and rendering the past in that gap flipped the tense
    // twice per tool call.
    //
    // Once the turn has ENDED the tense is the entire signal, and it must reach the screen. The key
    // carries the turn state for exactly that reason: an earlier version keyed both branches on the
    // present form, so the past could never displace it and a finished agent kept a present-tense
    // title indefinitely — reported live on 2026-08-26 as a card reading "running a command" beside
    // an IDLE badge.
    return state.turnActive
      ? keyed(phrase.present, `${phrase.present}${place}`)
      : keyed(`${phrase.present}|done`, `${phrase.past}${place}`);
  }

  // Events have been seen but no tool has run — a prompt submitted, a turn ended. Nothing to title.
  return { text: null, key: null };
}

/**
 * How much of an ask a headline carries.
 *
 * Not a visual limit — the card is `white-space: nowrap` with a CSS ellipsis
 * (`agent-node-persona-nl.css:464`), so it trims itself at whatever width it happens to have. This
 * cap keeps the headline store small against a producer that allows 4000 characters, and stops the
 * triage lane, which wraps, from turning one row into a paragraph.
 */
export const PROMPT_MAX = 100;

/**
 * An ask reduced to one line fit for a card, or `null` when there is nothing in it.
 *
 * The first non-blank line, because that is where a person puts the request and everything after it
 * is context. Interior whitespace collapses so a pasted line cannot smuggle in a tab or a newline.
 *
 * Deliberately no cleverness beyond that: no stripping of slash commands, no dropping of politeness,
 * no attempt to extract a "real" intent. Every one of those is a guess about what the operator meant,
 * and the whole point of this module is that it does not guess.
 */
export function summarizePrompt(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const firstLine = raw.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (!firstLine) return null;
  const line = firstLine.replace(/\s+/g, " ");
  if (line.length <= PROMPT_MAX) return line;
  // The ellipsis is part of the budget, so the result is never longer than the cap promises.
  return `${line.slice(0, PROMPT_MAX - 1).trimEnd()}\u2026`;
}

/** The shared vocabulary, falling back to the honest phrase for a tool this build does not know. */
function phraseFor(tool: string): { present: string; past: string } {
  return TOOL_PHRASES[tool] ?? UNKNOWN_TOOL_PHRASE;
}
