import type { ConversationUpdate, Part } from "../../../types/conversation.js";

/**
 * What every producer of conversation deltas must obey, checked rather than hoped for.
 *
 * Lotus has four of them — the Claude bridge, the ACP bridge, the codex app-server bridge, and
 * the hook lane that converts a TUI cell's transcript — and until this file each was trusted to
 * behave. The cost of that trust was measured on a phone on 2026-09-08: one exchange drawn
 * twice, because a part arrived under a second turn id and nothing anywhere said that was
 * impossible. A rule stated here fails a test; the same fact learned from a screenshot costs a
 * day.
 *
 * **Taken from `bb`'s `ThreadEventGrammar`**, whose rules are `item/opens-before-delta`,
 * `item/settles-once`, `turn/starts-once`, `turn/settles-once` and `turn/known`. The mapping is
 * not one-to-one because the vocabularies differ: bb's timeline is items keyed by `itemId` with
 * the turn as metadata, so "a part belongs to one turn" is true there by construction. Lotus
 * nests parts inside turns, so that one has to be a **rule** — and it is the rule that catches
 * the bug bb cannot have.
 *
 * Deliberately not a rule: *a settled turn gains no more parts*. Lotus's own hook lane closes a
 * turn and then sends the reply that closed it, in that order, because the diff emits headers
 * before parts. Harmless to a client that re-renders, and inventing a rule its own producers
 * break would only teach people to ignore the checker.
 */
export const CONVERSATION_GRAMMAR_RULES = {
  turnStartsOnce: "turn/starts-once",
  turnSettlesOnce: "turn/settles-once",
  turnKnown: "turn/known",
  partSettlesOnce: "part/settles-once",
  partOneTurn: "part/one-turn",
  /**
   * bb's `item/opens-before-delta`, which had nothing to bite on here until `ConversationUpdate`
   * gained a `text` kind. It is the rule that keeps that kind cheap: a client may apply a delta
   * blindly to the part it already holds, because a producer will never send one for a part it
   * never opened.
   */
  partOpensBeforeDelta: "part/opens-before-delta",
} as const;

export type ConversationGrammarRule =
  (typeof CONVERSATION_GRAMMAR_RULES)[keyof typeof CONVERSATION_GRAMMAR_RULES];

export interface GrammarViolation {
  rule: ConversationGrammarRule;
  reason: string;
}

/** Per pane, because a pane is what a conversation belongs to. Bounded like the lanes are. */
const MAX_IDS_PER_PANE = 512;

interface PaneState {
  openTurns: Set<string>;
  endedTurns: Set<string>;
  turnOfPart: Map<string, string>;
  settledParts: Set<string>;
}

export class ConversationGrammar {
  private readonly byPane = new Map<string, PaneState>();

  /** Checks one delta and remembers it. `undefined` means it was legal. */
  observe(paneId: string, update: ConversationUpdate): GrammarViolation | undefined {
    const state = this.stateFor(paneId);
    switch (update.kind) {
      case "turn":
        return this.observeTurn(state, update.turn.turnId, update.turn.endedAt !== undefined);
      case "part":
        return this.observePart(state, update.turnId, update.part);
      case "text":
        return this.observeText(state, update.turnId, update.partId);
    }
  }

  /** A pane that is gone keeps no state; a pane id is never reused. */
  forget(paneId: string): void {
    this.byPane.delete(paneId);
  }

  /** Keeps only the cells still in the fleet, like every other per-pane cache here. */
  retain(alive: ReadonlySet<string>): void {
    for (const paneId of [...this.byPane.keys()]) {
      if (!alive.has(paneId)) this.byPane.delete(paneId);
    }
  }

  size(): number {
    return this.byPane.size;
  }

  private observeTurn(state: PaneState, turnId: string, ended: boolean): GrammarViolation | undefined {
    if (!ended) {
      if (state.endedTurns.has(turnId)) {
        return { rule: CONVERSATION_GRAMMAR_RULES.turnStartsOnce, reason: `turn "${turnId}" reopened after it ended` };
      }
      // A header may be re-sent while the turn is open — a title arriving late, a plan
      // attached — so an already-open turn is not a second start.
      state.openTurns.add(turnId);
      trim(state.openTurns);
      return undefined;
    }
    if (state.endedTurns.has(turnId)) {
      return { rule: CONVERSATION_GRAMMAR_RULES.turnSettlesOnce, reason: `turn "${turnId}" ended twice` };
    }
    state.openTurns.delete(turnId);
    state.endedTurns.add(turnId);
    trim(state.endedTurns);
    return undefined;
  }

  private observePart(state: PaneState, turnId: string, part: Part): GrammarViolation | undefined {
    if (!state.openTurns.has(turnId) && !state.endedTurns.has(turnId)) {
      return {
        rule: CONVERSATION_GRAMMAR_RULES.turnKnown,
        reason: `part "${part.id}" arrived for turn "${turnId}", which was never opened`,
      };
    }
    const filedUnder = state.turnOfPart.get(part.id);
    if (filedUnder !== undefined && filedUnder !== turnId) {
      return {
        rule: CONVERSATION_GRAMMAR_RULES.partOneTurn,
        reason: `part "${part.id}" moved from turn "${filedUnder}" to "${turnId}"`,
      };
    }
    if (state.settledParts.has(part.id) && !settled(part)) {
      return {
        rule: CONVERSATION_GRAMMAR_RULES.partSettlesOnce,
        reason: `part "${part.id}" went back to unsettled after it had settled`,
      };
    }
    state.turnOfPart.set(part.id, turnId);
    trimMap(state.turnOfPart);
    if (settled(part)) {
      state.settledParts.add(part.id);
      trim(state.settledParts);
    }
    return undefined;
  }

  /**
   * A `text` delta, which is held to everything a part update is and one rule more.
   *
   * It carries no `Part`, so there is nothing here to settle *with* — a delta can only ever
   * be the wrong thing to send, never a legal way to finish a part. That asymmetry is the
   * point: the settled set is written by `part` updates alone, and a delta is checked against
   * it.
   */
  private observeText(state: PaneState, turnId: string, partId: string): GrammarViolation | undefined {
    if (!state.openTurns.has(turnId) && !state.endedTurns.has(turnId)) {
      return {
        rule: CONVERSATION_GRAMMAR_RULES.turnKnown,
        reason: `text delta for part "${partId}" arrived for turn "${turnId}", which was never opened`,
      };
    }
    const filedUnder = state.turnOfPart.get(partId);
    if (filedUnder === undefined) {
      return {
        rule: CONVERSATION_GRAMMAR_RULES.partOpensBeforeDelta,
        reason: `text delta for part "${partId}", which was never sent as a part`,
      };
    }
    if (filedUnder !== turnId) {
      return {
        rule: CONVERSATION_GRAMMAR_RULES.partOneTurn,
        reason: `text delta moved part "${partId}" from turn "${filedUnder}" to "${turnId}"`,
      };
    }
    if (state.settledParts.has(partId)) {
      return {
        rule: CONVERSATION_GRAMMAR_RULES.partSettlesOnce,
        reason: `part "${partId}" grew by a text delta after it had settled`,
      };
    }
    return undefined;
  }

  private stateFor(paneId: string): PaneState {
    const held = this.byPane.get(paneId);
    if (held !== undefined) return held;
    const made: PaneState = {
      openTurns: new Set(),
      endedTurns: new Set(),
      turnOfPart: new Map(),
      settledParts: new Set(),
    };
    this.byPane.set(paneId, made);
    return made;
  }
}

/**
 * Whether this part is finished changing.
 *
 * Only the kinds that stream have an unsettled state at all; everything else — a
 * `user_message`, an `error`, a `result` — arrives whole and is settled on arrival.
 */
function settled(part: Part): boolean {
  switch (part.type) {
    case "assistant_text":
      return part.state === "done";
    case "tool_call":
      return part.status === "completed" || part.status === "failed" || part.status === "cancelled";
    case "permission":
      return part.outcome !== undefined;
    case "question":
      return part.answered !== undefined;
    // `reasoning` carries no state of its own and is re-sent as it grows, and a `status` part
    // is a running commentary. Neither can settle, so neither can un-settle.
    case "reasoning":
    case "status":
      return false;
    default:
      return true;
  }
}

function trim(ids: Set<string>): void {
  while (ids.size > MAX_IDS_PER_PANE) {
    const oldest = ids.values().next().value;
    if (oldest === undefined) return;
    ids.delete(oldest);
  }
}

function trimMap(ids: Map<string, string>): void {
  while (ids.size > MAX_IDS_PER_PANE) {
    const oldest = ids.keys().next().value;
    if (oldest === undefined) return;
    ids.delete(oldest);
  }
}

/**
 * How a host says a rule was broken: one warning, with the rule as a field.
 *
 * Here rather than at the wiring site so the event name and the fields are decided once — a
 * violation is a thing you go looking for in a log weeks later, and it has to be greppable by
 * rule (`conversation.grammar`, `rule=part/one-turn`).
 */
export function reportGrammarViolation(
  warn: (event: string, fields: Record<string, string>) => void,
): (paneId: string, violation: GrammarViolation) => void {
  return (paneId, violation) =>
    warn("conversation.grammar", { paneId, rule: violation.rule, reason: violation.reason });
}

