/**
 * Whether byte-silence is allowed to mean "this agent has hung"
 * (`plans/honest-agent-status/` Slice 7).
 *
 * RC-2 marks a pane `stalled` after 30s with no PTY output. Its premise — silence means
 * unresponsive — holds for a runner whose bytes are the only liveness signal there is. It is simply
 * **false** for a step-reporting runner: a blocked agent emits no bytes because that is what being
 * blocked means, and an agent settled at the prompt emits none either. The hook stream, not the byte
 * stream, is that runner's liveness.
 *
 * So the question is not "is this runner hook-capable" but "does the last hook fact describe an
 * agent that should be PRODUCING right now". Only `running` does. That keeps the hang detection RC-2
 * was written for — a hung pane stops producing hook events too, so its last fact stays `running`
 * while the bytes stop — and removes the false `stalled`.
 *
 * Concretely, the bug this closes: an agent stopped at a permission prompt went `needs-you`, then
 * 30 seconds later RC-2 overwrote it with `stalled`, emptying the triage lane and leaving the jump
 * chord with nowhere to land — 30s after the one state the whole plan exists to surface.
 */

import type { AgentTurnFact } from "./agent-turn-registry";

/** Turn values that mean "silence is expected here, indefinitely". */
const DELIBERATELY_QUIET: ReadonlySet<string> = new Set([
  // Waiting for a human. Could be hours; the operator decides.
  "needs-input",
  // Turn over, sitting at the prompt.
  "idle",
  "ended",
  // The hook already gave a more specific verdict than `stalled`, and it is the one that knows.
  "error",
]);

export interface ShouldPublishStalledInput {
  /** The pane's latest hook fact, if any has ever landed. */
  fact: AgentTurnFact | undefined;
  /** When a human last acted on this pane. A fact older than this describes the past. */
  answeredAtMs?: number;
}

export function shouldPublishStalled({ fact, answeredAtMs }: ShouldPublishStalledInput): boolean {
  // No hook has ever fired for this pane: bytes are all we have, so today's behaviour stands.
  // This is what keeps `cursor` and non-claude custom runners working exactly as before.
  if (!fact) return true;
  // A human action is a turn boundary, so a fact older than one describes the past and the silence
  // after it is expected rather than suspicious. Observed live 2026-08-25: rejecting a tool ended
  // the turn with no hook at all, the last fact stayed `running`, and 30s later this guard let RC-2
  // escalate a finished pane to `stalled` — correctly by its own rule, which is what made the rule
  // incomplete rather than wrong.
  if (answeredAtMs !== undefined && answeredAtMs > fact.atMs) return false;
  // An unrecognised value is not a licence to suppress the only other liveness signal — the wire
  // vocabulary can grow without a desktop rebuild, so the guard defers rather than assuming safety.
  return !DELIBERATELY_QUIET.has(fact.turn);
}
