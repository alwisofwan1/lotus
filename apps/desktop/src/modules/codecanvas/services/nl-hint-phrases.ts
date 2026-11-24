/**
 * Phrases for the NL bar's rotating hint (plan §3.3 "Motion", `plans/nl-command-bar-revamp/PLAN.md`).
 * Each phrase teaches a piece of the bar's real grammar using the board's own state — the agents on
 * it, whether another project is open — so the hint is never a fabricated example the bar can't
 * actually run. Pure function: no DOM, no randomness, same input always returns the same array (the
 * rotator hook depends on that determinism, and so do these tests).
 *
 * HARD INVARIANT — the bar must never advertise a capability it doesn't have. Enforced in the sibling
 * test against the REAL routing code, not a fixture list. Note it is NOT "everything matches the
 * fast path": the bar has two local routes and they have OPPOSITE requirements, so each phrase is
 * checked against the one that will actually carry it (see `voice-intent-router.ts` resolveVoiceOutcome):
 *
 *   - **command route** — {@link matchLocalIntent} (`canvas-nl-fastpath.ts`) must match. These run
 *     locally with zero model tokens.
 *   - **selection route** — {@link NL_HINT_SELECTION_PHRASES} must *deliberately* NOT match, because
 *     the router gates the transform outcome on `!hasCommandVerb(text)`: a fast-path hit always wins
 *     and would steal the utterance away from `runTransform`. A phrase here that started matching the
 *     fast path would silently stop rewriting the selection — which is exactly what the test guards.
 *
 * One phrase from the plan's example table is still dropped, deliberately:
 *   - "what is <Name> doing?" — no status-query action exists in the fast path, and unlike the
 *     selection phrases it has no verified alternative route either. It would fall through to the
 *     model as an unresolvable command. Agent status is read through other UI (fleet view / voice
 *     tools) for now. Do not add it back without a route to point at.
 *
 * Also note the plan's "switch to <Project>" shorthand does not match: `matchLocalIntent`'s
 * switch_project regex requires an explicit "project"/"canvas"/"workspace" noun before the name, so
 * this module emits "switch to project <Name>".
 */

export interface NlHintContext {
  /** Agent names present on the board. */
  agentNames: string[];
  /** Node count on the board. Zero means "empty board". */
  nodeCount: number;
  /**
   * Whether the focused note currently has a non-empty text selection. Gates the selection-route
   * phrases: suggesting "rewrite this shorter" with nothing selected would advertise an outcome the
   * router cannot reach.
   */
  hasNoteSelection: boolean;
  /** Names of other open projects (excludes the active one). */
  otherProjectNames: string[];
}

/** Longest a single phrase may be — keeps the hint from overflowing the 560px Slab bar (plan §3.1). */
export const NL_HINT_MAX_PHRASE_LENGTH = 42;

/**
 * Most phrases the rotator is ever handed at once. Keeps the cycle a quick, live readout of THIS
 * board rather than a scrolling manual — bounded independently of how many agents/projects exist.
 */
export const NL_HINT_MAX_PHRASES = 8;

/**
 * The bar's three most basic verbs, spelled out (plan §3.3). Valid on ANY board — creating a
 * terminal or spawning an agent never stops working — so these also serve as the floor whenever the
 * board-specific phrases come up empty.
 */
const ONBOARDING_PHRASES: readonly string[] = ["spawn a Claude agent", "create a terminal", "open a browser"];

/**
 * Phrases carried by the SELECTION route, not the fast path — see the invariant note in the file doc.
 * These must not match {@link matchLocalIntent}, or the router's `!hasCommandVerb` gate diverts them
 * away from `runTransform` and the selection is never rewritten.
 */
export const NL_HINT_SELECTION_PHRASES: readonly string[] = ["rewrite this shorter", "turn this into a task"];

/** How many other-project phrases to surface — more than this and the cycle stops teaching, it lists. */
const MAX_PROJECT_SWITCH_PHRASES = 2;

function withinBudget(phrase: string): boolean {
  return phrase.length <= NL_HINT_MAX_PHRASE_LENGTH;
}

export function buildNlHintPhrases(ctx: NlHintContext): string[] {
  const out: string[] = [];
  const add = (phrase: string) => {
    if (withinBudget(phrase) && !out.includes(phrase)) out.push(phrase);
  };

  // No agents to name yet — teach the verbs that create them. This covers an empty board AND the
  // very common "nodes but no agents" board (a lone terminal, a note, a browser): keying this off
  // nodeCount alone left that case with nothing to say, which blanked the hint entirely.
  if (ctx.agentNames.length === 0) {
    for (const phrase of ONBOARDING_PHRASES) add(phrase);
  }

  // Selection first among the board-specific phrases: when the user has text selected in a note,
  // rewriting it is the most immediately useful thing the bar can offer.
  if (ctx.hasNoteSelection) {
    for (const phrase of NL_HINT_SELECTION_PHRASES) add(phrase);
  }

  if (ctx.agentNames.length > 0) {
    // One phrase per grammar shape, not one pair per agent — a ten-agent board still teaches three
    // things, it just borrows two different names to say them with (matches the plan's own example,
    // which pairs "focus Skye" with "tell Rex to run the tests" rather than repeating one name twice).
    add(`focus ${ctx.agentNames[0]}`);
    const dispatchTarget = ctx.agentNames[1] ?? ctx.agentNames[0];
    add(`tell ${dispatchTarget} to run the tests`);
    add("arrange the canvas");
  }

  for (const name of ctx.otherProjectNames.slice(0, MAX_PROJECT_SWITCH_PHRASES)) {
    add(`switch to project ${name}`);
  }

  // Last-resort floor. Every branch above is conditional, so without this an unforeseen combination
  // hands the rotator an empty list and the bar shows no prompt at all — strictly worse than the
  // constant string this feature replaced.
  if (out.length === 0) for (const phrase of ONBOARDING_PHRASES) add(phrase);

  return out.slice(0, NL_HINT_MAX_PHRASES);
}
