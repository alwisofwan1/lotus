// What the Context tab shows about a thread: what it cost so far and what still waits on the user. Pure.
// Claude's `result.usage` sums every model call in a turn, so these are spend figures; how full the
// context window is comes separately, from the turn's last main-agent call (`contextTokens`).

import type { TurnUsage } from "./thread-event";
import type { InteractionState, ThreadState } from "./thread-state";

export interface ContextSummary {
  turns: number;
  /** The newest turn that reported usage. */
  last: TurnUsage | null;
  inputTokens: number;
  outputTokens: number;
  /** null when no turn reported a cost (a login, or Codex). */
  costUsd: number | null;
  waiting: InteractionState[];
  /** How full the context window was after the newest turn that reported it. */
  window: { used: number; size: number } | null;
}

export function contextSummary(state: ThreadState | null): ContextSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let last: TurnUsage | null = null;
  let window: ContextSummary["window"] = null;
  for (const turn of state?.turns ?? []) {
    if (!turn.usage) continue;
    last = turn.usage;
    if (turn.usage.contextTokens && turn.usage.contextWindow) window = { used: turn.usage.contextTokens, size: turn.usage.contextWindow };
    inputTokens += turn.usage.inputTokens;
    outputTokens += turn.usage.outputTokens;
    if (turn.usage.costUsd !== null) costUsd = (costUsd ?? 0) + turn.usage.costUsd;
  }
  return {
    turns: state?.turns.length ?? 0,
    last,
    inputTokens,
    outputTokens,
    costUsd,
    waiting: state?.interactions.filter((i) => i.resolution === null) ?? [],
    window,
  };
}

/** 1234 → "1.2k", 2_500_000 → "2.5M". */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
