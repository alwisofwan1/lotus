/**
 * What a runner can actually tell us about a turn (`plans/honest-agent-status/` Slice 2).
 *
 * **There are two questions here, not one, and conflating them breaks Codex.** They lived in two
 * different files — one in `services/voice/agent-done-callout.ts`, one private to
 * `canvas-fleet.ts` — which is how a first draft of this plan came to gate everything on the wrong
 * one. They sit together now so the next reader compares them instead of picking whichever import
 * was closer to hand.
 *
 * | Predicate | Asks | Codex |
 * |---|---|---|
 * | `reportsTurnEnd` | is a turn END reported by a hook? | **true** |
 * | `reportsSteps` | are per-STEP events reported — prompt, tools, stop? | **true** since 2026-08-13 |
 *
 * The table used to read `false` for Codex, and the reason was true when written: its entire
 * surface into Lotus was a single `agent-turn-complete` notify. `codex_hooks.rs` then registered
 * `PreToolUse` / `PostToolUse` / `Stop` / `UserPromptSubmit` in `~/.codex/hooks.json`, so a Codex
 * pane now reports the same per-step events a Claude pane does — the desktop's
 * `session-history.jsonl` diagnostics carry `agent: codex, event: prompt-submit` to prove it. The
 * predicate was left at `false` for two weeks and this file is the second place that had to be
 * corrected (the first is `runnerReportsSteps` in `canvas-fleet.ts`); the Rust fallback
 * `provider_reports_steps` had said `codex` all along.
 *
 * What Codex still does **not** send is `notification`: `packages/host` classifies it
 * `gating: "runner_cannot"` — it cannot prompt a human at all — so `needs-you` will simply never be
 * asserted for it. `reportsSteps` is the predicate that licenses trusting `running` and
 * `needs-you`, and the only one that may license demoting the PTY timers.
 *
 * `canvas-fleet.ts` keeps its own tri-state `runnerReportsSteps` for the wire, where `undefined`
 * means "this host cannot say" and the fleet contract reads it as such. This module is the
 * resolver's view of the same facts, and it collapses unknown to `false`: an unstated capability
 * must not license trusting a fact, and returning `false` lands the pane on today's PTY behaviour
 * rather than on a guess.
 */

import { isClaudeFamilyRunner, type AgentRunnerType } from "@/lib/agent-runtime";
import { agentTurnReports } from "@/modules/codespace/services/bridge/agent-registry";

export interface RunnerTurnCapability {
  /** May a `turn` of `idle` / `ended` be believed for this runner? */
  reportsTurnEnd: boolean;
  /** May a `turn` of `running` / `needs-input` / `error` be believed for this runner? */
  reportsSteps: boolean;
}

const NOTHING: RunnerTurnCapability = { reportsTurnEnd: false, reportsSteps: false };

export function runnerTurnCapability(
  runner: AgentRunnerType | undefined,
  claudeFamily?: boolean,
): RunnerTurnCapability {
  // `custom` without the claude-family flag is an arbitrary command; `undefined` means the
  // frontend has not reported a runner yet. Neither can be said to report anything.
  if (!claudeFamily && (runner === undefined || runner === "custom")) return NOTHING;
  // ccs / csp and a claude-family custom runner drive the same global hooks as claude.
  // The rest — what each runner's hooks report — is agents.json `hooks`.
  return agentTurnReports(isClaudeFamilyRunner(runner, claudeFamily) ? "claude" : runner);
}
