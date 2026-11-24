/**
 * Short-term dialogue state for the NL command bar — the app-side "working memory" that lets a
 * stateless-per-call parser resolve anaphora across turns ("close them", "tutup yang tadi", "do it
 * again"). It is NOT model memory: the bar keeps this ring buffer and serializes it into each parse
 * call's prompt, and resolves `lastMentioned` targets against it. Deliberately tiny (last 5 turns) and
 * pure so it stays testable and cheap — see plan §Slice 4 and the ReALM/DST grounding rationale.
 */

export interface NlTurnRecord {
  /** The raw utterance, shown to the planner as "what the user just said". */
  utterance: string;
  /** The action names that ran this turn (e.g. ["open_browser","open_browser"]). */
  actions: string[];
  /** Real node ids this turn touched (created/opened/focused/closed) — the referents for "them". */
  resolvedNodeIds: string[];
  outcome: "ok" | "error";
}

export interface NlDialogueState {
  /** Most-recent-first, capped at {@link MAX_RECENT}. */
  recent: NlTurnRecord[];
}

export const EMPTY_DIALOGUE_STATE: NlDialogueState = { recent: [] };

/** How many recent turns to keep. Small on purpose — enough for anaphora, cheap in the prompt. */
const MAX_RECENT = 5;

/** Append a turn, newest-first, dropping the oldest beyond the cap. Pure (returns a new state). */
export function recordNlTurn(state: NlDialogueState, turn: NlTurnRecord): NlDialogueState {
  return { recent: [turn, ...state.recent].slice(0, MAX_RECENT) };
}

/**
 * The referents for "them"/"mereka"/"yang tadi": the most recent turn's node ids that are STILL alive
 * on the canvas. Skips turns whose nodes have all since been closed, falling back to an earlier live
 * turn. Returns [] when nothing recent still exists (the resolver then reports a friendly error).
 */
export function lastMentionedIds(state: NlDialogueState, aliveIds: ReadonlySet<string>): string[] {
  for (const turn of state.recent) {
    const alive = turn.resolvedNodeIds.filter((id) => aliveIds.has(id));
    if (alive.length > 0) return alive;
  }
  return [];
}
