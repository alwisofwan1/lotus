import type { AgentTurnFact } from "./agent-turn-registry";
import type { AgentNodeStatus } from "../types/canvas";

/**
 * A live (terminal) agent as a graph-run step (plans/canvas-graph-run, ticket #80).
 *
 * A headless agent runs its own prompt and reports a summary. A live agent is an interactive CLI
 * that is already running, so a run does two things instead: it SENDS the step as one message into
 * the terminal, and it WATCHES the turn signals to decide when that step is over. Both halves are
 * pure here so the policy is testable without a PTY.
 */

export interface LiveRunUpstream {
  name: string;
  /** The upstream's handoff summary, when it produced one (headless agents do). */
  summary?: string;
}

export interface LiveRunMessageInput {
  runTitle: string;
  brief: string;
  agentName: string;
  upstream: LiveRunUpstream[];
}

/** Upstream summaries are clipped so one long result cannot flood the next agent's prompt. */
const UPSTREAM_SUMMARY_MAX = 1200;

/** The single message a run types into a live agent's terminal for its step. */
export function buildLiveRunMessage({ runTitle, brief, agentName, upstream }: LiveRunMessageInput): string {
  // The message is one line, so a goal without its own full stop would run into the next sentence.
  const goal = brief.trim();
  const lines = [`[Lotus run "${runTitle}"] ${agentName}, this is your step.`, `Goal: ${/[.!?]$/.test(goal) ? goal : `${goal}.`}`];
  if (upstream.length > 0) {
    lines.push(`Done before you: ${upstream.map((u) => u.name).join(", ")}.`);
    for (const u of upstream) {
      const summary = u.summary?.trim();
      if (summary) {
        const clipped = summary.length > UPSTREAM_SUMMARY_MAX ? `${summary.slice(0, UPSTREAM_SUMMARY_MAX)}…` : summary;
        lines.push(`${u.name} reported: ${clipped}`);
      }
    }
    lines.push("If you need more from them, read their output with lotus_read_cell_output.");
  }
  lines.push("Do your part, then end your turn. The next step starts when you stop.");
  // One line per turn: a newline inside a PTY submit would send the message in pieces.
  return lines.join(" ");
}

export type LiveRunTurnOutcome = "pending" | "completed" | "error";

export interface LiveRunTurnInput {
  /** When the step message was handed to the terminal (epoch ms). */
  submittedAtMs: number;
  /** The pane's latest hook fact. */
  fact: AgentTurnFact | undefined;
  /** Whether this runner's hooks report the end of a turn (Claude, Codex). */
  reportsTurnEnd: boolean;
  /** The status the node publishes to the fleet (includes the byte-idle `stalled`). */
  status: AgentNodeStatus;
  /** The terminal process is gone. */
  ptyEnded: boolean;
  /** The agent was seen `running` after the submit — a stall before that belongs to an old turn. */
  sawBusy: boolean;
}

/**
 * Has the step's turn ended? Only a signal NEWER than the submit counts — the fact standing at
 * submit time belongs to the previous turn.
 *
 * - Hook-reporting runners: a hook `idle`/`ended` after the submit = done; a hook `error` = failed.
 * - Other runners (Cursor, custom): no turn-end hook exists, so the byte-idle `stalled` status is
 *   the only "it stopped" signal there is — and only after the agent was seen busy on this step.
 * - `needs-you` is never an end: the agent waits on a human, who answers in the terminal.
 */
export function liveRunTurnOutcome({ submittedAtMs, fact, reportsTurnEnd, status, ptyEnded, sawBusy }: LiveRunTurnInput): LiveRunTurnOutcome {
  if (ptyEnded || status === "error") return "error";
  if (reportsTurnEnd) {
    if (!fact || fact.atMs < submittedAtMs) return "pending";
    if (fact.turn === "idle" || fact.turn === "ended") return "completed";
    if (fact.turn === "error") return "error";
    return "pending";
  }
  return status === "stalled" && sawBusy ? "completed" : "pending";
}
