import type { ConversationUpdate, Part } from "../../../types/conversation.js";

/**
 * Rules every delta producer must obey, so a violation fails a test instead of drawing an
 * exchange twice. From `bb`'s `ThreadEventGrammar`, plus "a part belongs to one turn" (parts
 * nest in turns here). Not a rule: *a settled turn gains no parts* — the hook lane does that.
 */
export const CONVERSATION_GRAMMAR_RULES = {
  turnStartsOnce: "turn/starts-once",
  turnSettlesOnce: "turn/settles-once",
  turnKnown: "turn/known",
  partSettlesOnce: "part/settles-once",
  partOneTurn: "part/one-turn",
  /**
   * bb's `item/opens-before-delta`: lets a client apply a `text` delta blindly to the part it
   * holds, since a producer never sends one for a part it never opened.
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
   * A `text` delta carries no `Part`, so it can never legally finish one: the settled set is
   * written by `part` updates alone, and a delta is checked against it.
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
 * Only streaming kinds have an unsettled state; `user_message`, `error`, `result` arrive whole.
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
 * One warning with the rule as a field; fixed here so logs stay greppable by rule
 * (`conversation.grammar`, `rule=part/one-turn`).
 */
export function reportGrammarViolation(
  warn: (event: string, fields: Record<string, string>) => void,
): (paneId: string, violation: GrammarViolation) => void {
  return (paneId, violation) =>
    warn("conversation.grammar", { paneId, rule: violation.rule, reason: violation.reason });
}

