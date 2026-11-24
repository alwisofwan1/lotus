import type { AgentSessionControlHandle } from "./session-control-registry";
import type { CanvasSessionRecord } from "./session-record";
import { judgeRelaunch, type RelaunchFacts, type RelaunchIntent, type RelaunchVerdict } from "./session-relaunch";

/**
 * The node's session controls, built from its effects rather than written inside the node
 * (`plans/codecanvas-session-refactor/issues/02`).
 *
 * **Why this is a module and not thirty lines in `LiveAgentNode`.** The old handle judged and
 * executed in the same breath: `relaunchSession` destroyed the pooled PTY and only then returned
 * the verdict. That made `confirm: "needs-you"` unenforceable by construction — the pane waiting on
 * a human was already dead by the time anyone could ask. Splitting judgement from commitment is the
 * fix, and it is only testable if the destructive half arrives as an injected function.
 *
 * The node still owns the effects (PTY hold, pooled process, launch guards); this owns the order.
 */

export interface SessionControlEffects {
  sessions: () => CanvasSessionRecord[];
  activeSessionId: () => string | null;
  /** Everything `judgeRelaunch` needs, read fresh at the moment of asking. */
  facts: () => RelaunchFacts;
  isDormant: () => boolean;
  /** Wake a sleeping node. No process is killed; there is none. */
  wake: () => void;
  /** The destructive half: kill the pooled CLI and launch again against `intent`. */
  relaunch: (intent: RelaunchIntent) => void;
}

export function createSessionControlHandle(
  effects: SessionControlEffects,
): AgentSessionControlHandle {
  const judge = (intent: RelaunchIntent): RelaunchVerdict =>
    judgeRelaunch(intent, effects.facts());

  const commit = (intent: RelaunchIntent): void => {
    if (effects.isDormant()) effects.wake();
    effects.relaunch(intent);
  };

  const request = (intent: RelaunchIntent): RelaunchVerdict => {
    // A sleeping node already pointed at this conversation only needs waking. Judged first because
    // the judge would call it `already-active` — true of the pointer, wrong about the node, and it
    // would leave the one thing the user asked for undone.
    if (
      intent.kind === "resume" &&
      effects.isDormant() &&
      intent.session.id === effects.activeSessionId()
    ) {
      effects.wake();
      return { allowed: true, intent };
    }
    const verdict = judge(intent);
    if (!verdict.allowed) return verdict;
    // A question is not a yes. The caller confirms and calls `commit` itself.
    if ("confirm" in verdict) return verdict;
    commit(intent);
    return verdict;
  };

  const wake = (): void => {
    if (effects.isDormant()) effects.wake();
  };

  return {
    sessions: effects.sessions,
    activeSessionId: effects.activeSessionId,
    isDormant: effects.isDormant,
    wake,
    judge,
    commit,
    request,
    resume: (session) => request({ kind: "resume", session }),
    startNew: () => request({ kind: "new" }),
  };
}
