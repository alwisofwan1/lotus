/**
 * What a live agent node shows and publishes, as one pure function
 * (`plans/honest-agent-status/` Slice 3).
 *
 * This logic used to sit inline in `LiveAgentNode` — a ~900-line component — as `deriveTone` plus
 * a `TONE_TO_FLEET` lookup. Slice 3 has to change it in two places at once (the status the fleet
 * receives AND the tone the header renders), and getting only one of them right is its own bug:
 * publishing `needs-you` while the badge still says `run` fixes the fleet and leaves the operator
 * looking at the same white "working" dot. Keeping both answers in one function is what makes that
 * pair testable, and what stops the two drifting apart later.
 */

import { resolveAgentStatus } from "./agent-status-resolve";
import type { AgentTurnFact } from "./agent-turn-registry";
import type { RunnerTurnCapability } from "./runner-capability";
import type { LiveAgentPhaseTone } from "../components/nodes/AgentPersonaHeader";
import type { AgentNodeStatus } from "../types/canvas";

export interface LiveAgentPresentationInput {
  /** The launch controller's phase (`idle`, `awaiting-ready`, `ready`, `running`, `failed`). */
  phase: string;
  ptyEnded: boolean;
  ptyError: boolean;
  /** This pane's latest hook fact, from the turn registry. */
  fact: AgentTurnFact | undefined;
  capability: RunnerTurnCapability;
  /** When a human last acted on this pane. Suppresses an ask raised before it — see the resolver. */
  answeredAtMs?: number;
  now: number;
}

export interface LiveAgentPresentation {
  /** Published to `agentStatusRegistry`, and from there to the card, sidebar and fleet. */
  status: AgentNodeStatus;
  /** Rendered by `AgentPersonaHeader`. */
  tone: LiveAgentPhaseTone;
}

/** Map the live launch phase + PTY status to a header tone. Launch-phase truth only. */
export function deriveLaunchTone(
  phase: string,
  ptyEnded: boolean,
  ptyError: boolean,
): LiveAgentPhaseTone {
  if (ptyError) return "error";
  if (ptyEnded) return "ended";
  if (phase === "running") return "running";
  if (phase === "ready") return "ready";
  if (phase === "failed") return "error";
  if (phase === "idle") return "idle";
  return "starting";
}

/**
 * The PTY-inferred status, before any hook fact is consulted.
 *
 * Note `ready` → `running`: a pane settled at the prompt has always published itself as busy. That
 * is the false-"working" state, and it is left in place here on purpose — this map is the *input*
 * the resolver corrects, not the answer. A pane with no hook fact keeps exactly this behaviour.
 */
const TONE_TO_STATUS: Record<LiveAgentPhaseTone, AgentNodeStatus> = {
  idle: "idle",
  starting: "connecting",
  ready: "running",
  running: "running",
  // Only reachable if a caller hands back a resolved tone as a launch tone. Mapped for
  // completeness so the Record stays exhaustive rather than needing a cast.
  "needs-you": "needs-you",
  ended: "completed",
  error: "error",
};

/** The tone that states a resolved status, when the resolver disagreed with the launch tone. */
const STATUS_TO_TONE: Partial<Record<AgentNodeStatus, LiveAgentPhaseTone>> = {
  "needs-you": "needs-you",
  idle: "idle",
  running: "running",
  error: "error",
  completed: "ended",
};

export function liveAgentPresentation(input: LiveAgentPresentationInput): LiveAgentPresentation {
  const launchTone = deriveLaunchTone(input.phase, input.ptyEnded, input.ptyError);
  const inferred = TONE_TO_STATUS[launchTone];

  // `connecting` is launch-phase truth the hook stream cannot speak to, and it is load-bearing for
  // ROUTING, not just for looks: LiveAgentNode publishes no explicit `canReply`/`canQueue`, so
  // `canvas-fleet` derives them from this status, and `canReceiveNow("connecting")` is false while
  // `canReceiveNow("idle")` is true. Letting an `idle` fact through here would advertise a pane
  // whose runner has not yet shown a prompt as ready to receive right now — and a fact is only
  // proof the runner finished a turn at some point inside the freshness window, never proof that
  // it is ready this instant. The pane's own dispatch buffer already owns the boot window.
  if (inferred === "connecting") return { status: inferred, tone: launchTone };

  const status = resolveAgentStatus({
    inferred,
    fact: input.fact,
    reportsTurnEnd: input.capability.reportsTurnEnd,
    reportsSteps: input.capability.reportsSteps,
    answeredAtMs: input.answeredAtMs,
    // The distinction `TONE_TO_STATUS` deliberately throws away: `ready` and `running` both become
    // the `running` status, so the resolver cannot tell "at its prompt, never asked anything" from
    // "mid-turn" without being told. Handed over separately rather than by widening that map,
    // which every other reader depends on collapsing.
    atPrompt: launchTone === "ready",
    now: input.now,
  });

  // Unchanged status keeps the launch tone verbatim, so `ready` still reads as `ready` and the
  // boot/connected distinction the header draws is preserved. Only a resolver DISAGREEMENT
  // restates the tone — that is the case where the launch phase is no longer the whole story.
  const tone = status === inferred ? launchTone : (STATUS_TO_TONE[status] ?? launchTone);
  return { status, tone };
}
