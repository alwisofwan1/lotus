/**
 * The one decision in `plans/honest-agent-status/`: what an agent's status actually is.
 *
 * **The rule.** A hook fact outranks PTY inference for the state that hook actually reports. A
 * timer is consulted only where no hook fact for that state can exist.
 *
 * That inverts the old arrangement, where PTY inference was the only input and hook facts reached
 * the canvas as speech and nothing else. Pure on purpose: the same inputs always give the same
 * answer, which is what makes the whole table below testable.
 */

import type { AgentTurnFact } from "./agent-turn-registry";
import type { AgentNodeStatus } from "../types/canvas";

/**
 * How long a hook fact stays trustworthy.
 *
 * This is **not** "the agent has probably moved on" — the mid-turn states supersede each other
 * naturally, so that timer would have nothing to do. It guards exactly one thing: a fact that
 * outlived its session. Rust's `pane_turns` is in-memory but survives a frontend reload, and a
 * persisted pane keeps its id across one, so the cold hydrate can pull in a fact describing a pane
 * as it was hours ago — before the operator closed the window and came back.
 *
 * Observed live on 2026-08-24: a real `idle` fact sitting in the store with an age of 15,603,751 ms
 * (~4.3 h), left over from an earlier working session. That is the case this bound exists for, and
 * it is what the value is anchored to.
 *
 * Deliberately generous, because the two errors are not symmetric. Expiring a genuine unanswered
 * prompt hides the one state this whole plan was built to surface — a human can be away for hours,
 * and no further hook will fire while an agent is blocked. Honouring a stale one costs a badge that
 * self-corrects on the pane's next hook event.
 */
export const TURN_FRESH_MS = 4 * 60 * 60_000;

export interface ResolveAgentStatusInput {
  /** Today's PTY-derived status — `TONE_TO_FLEET[deriveTone(...)]`. The fallback, not the truth. */
  inferred: AgentNodeStatus;
  /** The pane's latest hook fact, if any has ever landed. */
  fact: AgentTurnFact | undefined;
  /** Does this runner report turn ENDS by hook? (`isHookCapableRunner` — true for Codex.) */
  reportsTurnEnd: boolean;
  /** Does it report per-STEP events — prompts, tools, notifications? (false for Codex.) */
  reportsSteps: boolean;
  /**
   * When a human last acted on this pane (a submit into its PTY), if ever.
   *
   * **A human action is a turn boundary.** Any hook fact older than it describes the past, not the
   * present — so the pane is reported as sitting at its prompt regardless of what that older fact
   * said. This exists because the rejection path fires NO hook at all: the tool never runs, so no
   * `tool-post`, and Claude ends the turn without a `Stop`. Observed live 2026-08-25 twice, and the
   * second time was the instructive one — the stuck fact was `running`, held for 80 seconds with
   * the terminal plainly back at its prompt, which RC-2 then escalated to `stalled`.
   *
   * A timestamp rather than a flag, because the agent can speak again the instant it is unblocked
   * and that newer fact must win.
   */
  answeredAtMs?: number;
  /**
   * Is the launch machine sitting this pane at its prompt, never having been handed a turn?
   *
   * `live-agent-launch.ts` is explicit about what that phase means — "auto-submit the initial task
   * if there is one, **else sit ready (idle)**" — and both transitions into it happen at launch;
   * nothing ever puts a pane back there once it has run. So this is not "quiet right now", it is
   * "has never been asked to do anything".
   *
   * It has to be passed in because {@link ResolveAgentStatusInput.inferred} cannot carry it:
   * `TONE_TO_STATUS` collapses the `ready` and `running` tones onto the same `running` status, on
   * purpose, as the input this resolver exists to correct.
   */
  atPrompt?: boolean;
  /**
   * When the PTY last settled at its prompt (ready footer, no working line), if it is there now.
   *
   * The one cross-check a `running` fact gets. A step-reporting runner's turn ENDS by hook too,
   * so a `running` fact followed by a PTY that settled afterwards means the end never arrived:
   * observed 2026-11-23, Claude moved a pane's session into its daemon, every later hook was
   * rejected upstream, and the pane read "working" for hours beside a plain prompt. The PTY flips
   * back the moment a spinner reappears, so a wrong call here lasts only while the pane is quiet.
   */
  ptyIdleSinceMs?: number;
  now: number;
}

export function resolveAgentStatus(input: ResolveAgentStatusInput): AgentNodeStatus {
  const { inferred, fact, reportsTurnEnd, reportsSteps, now } = input;

  // A dead pane is dead whatever the last hook said. Checked before the fact is even read: without
  // it, a pane that crashed while blocked would sit on the board asking for input forever.
  if (inferred === "error" || inferred === "completed") return inferred;

  /**
   * No hook fact has ever described this pane — or the only one that did has expired.
   *
   * `inferred` is `running` here for any pane the launch machine left at its prompt, and the note
   * on `TONE_TO_STATUS` calls that "the false-'working' state ... left in place here on purpose —
   * this map is the *input* the resolver corrects". The correction was only ever written for panes
   * that HAVE a fact, so a freshly spawned agent nobody has used sat on the board reporting
   * "working" for as long as it lived. Observed live 2026-08-27: three agents spawned five minutes
   * earlier, never given a task, all reading `working · 5m`, on the one panel whose whole purpose
   * is honest status.
   *
   * Gated on `reportsSteps`, and the gate is the whole safety argument. For a runner that reports
   * every step by hook, a real turn announces itself within milliseconds — typing fires
   * `UserPromptSubmit` → `running` — so the worst case is a flicker. For a step-silent runner no
   * hook will ever describe a mid-turn state, PTY bytes are the only signal there is, and
   * `inferred` must be left alone.
   *
   * The trade-off is the same one this file already made a few lines below, in the same words:
   * understating a working agent is recoverable and quiet; overstating a finished one is the bug.
   */
  const atPromptIsIdle = input.atPrompt === true && reportsSteps;

  if (!fact) return atPromptIsIdle ? "idle" : inferred;
  if (now - fact.atMs > TURN_FRESH_MS) return atPromptIsIdle ? "idle" : inferred;

  // A human acted after this fact was recorded, so the fact describes the past. `idle` rather than
  // `inferred`: falling back to the PTY guess would return `running` (TONE_TO_STATUS maps a settled
  // `ready` pane to busy on purpose, as the INPUT this resolver corrects), reinstating the exact
  // false-"working" state the plan exists to remove — and permanently, since no further hook comes.
  //
  // The trade-off, stated: if the agent DOES resume, this understates it for a few milliseconds
  // until its next hook event lands (typing fires UserPromptSubmit → `running`, approving a tool
  // fires `tool-post`). Understating a working agent is recoverable and quiet; overstating a
  // finished one is the bug being fixed.
  if (input.answeredAtMs !== undefined && input.answeredAtMs > fact.atMs) return "idle";

  switch (fact.turn) {
    // A turn END. Codex qualifies for these two: its whole surface into Lotus is one
    // `agent-turn-complete` notify, and that is exactly what they represent.
    case "idle":
      return reportsTurnEnd ? "idle" : inferred;
    case "ended":
      return reportsTurnEnd ? "completed" : inferred;

    // Mid-turn states. These need a runner that reports per-STEP events; a runner that only
    // signals turn-end can never produce them, so seeing one means the fact is not what it claims.
    // An ask that survived the staleness check above is still live: no human has acted since it
    // landed. Ties go to the ask — equal timestamps mean it is at least as recent as the action,
    // and hiding a live prompt on a coincidence is the worse error.
    case "needs-input":
      return reportsSteps ? "needs-you" : inferred;
    case "running":
      if (!reportsSteps) return inferred;
      return input.ptyIdleSinceMs !== undefined && input.ptyIdleSinceMs > fact.atMs
        ? "idle"
        : "running";
    case "error":
      return reportsSteps ? "error" : inferred;

    // A value this build has never heard of. The vocabulary lives in a hook script that can grow
    // without a desktop rebuild, so the honest answer is to decline it and keep inferring rather
    // than guess at what a future state means.
    default:
      return inferred;
  }
}
