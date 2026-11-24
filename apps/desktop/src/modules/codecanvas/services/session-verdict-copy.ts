import type { RelaunchVerdict } from "./session-relaunch";
import type { SessionBlockedReason } from "./session-dispatch";

/**
 * Everything a surface may have to explain: a relaunch verdict, plus the refusals only the
 * dispatcher can reach (a row whose node has to be rebuilt first).
 */
export type SessionVerdict = RelaunchVerdict | { allowed: false; reason: SessionBlockedReason };

/**
 * One place that turns a relaunch verdict into a sentence a person can read
 * (`plans/codecanvas-session-refactor/issues/02`).
 *
 * `judgeRelaunch` has always decided correctly; nobody read the answer, so a refusal arrived as a
 * button that did nothing. Keeping the wording here — pure, and in English like the rest of the
 * canvas — means every surface says the same thing about the same refusal.
 */

export interface SessionNotice {
  kind: "info" | "error";
  text: string;
}

export function verdictNotice(verdict: SessionVerdict): SessionNotice | null {
  // An allowed relaunch needs no sentence — the pane restarting in front of you is the feedback.
  // A `needs-you` question is asked inline by the list that was pressed (`needsYouConfirmText`).
  if (verdict.allowed) return null;
  switch (verdict.reason) {
    case "already-active":
      return { kind: "info", text: "This node is already in that conversation." };
    case "dead-session":
      return {
        kind: "error",
        text: "The runner no longer has this conversation — start a new one.",
      };
    case "no-runner-command":
      return {
        kind: "error",
        text: "This conversation came from a custom runner whose command was not saved — start that agent first, then open the conversation from its node.",
      };
    case "no-project":
      return { kind: "error", text: "Open a project to run this conversation." };
  }
}

/** The inline question asked before a switch ends a turn that is waiting on a human. */
export function needsYouConfirmText(agentName?: string, headline?: string): string {
  const what = headline ? ` to “${headline}”` : "";
  return `${agentName || "This agent"} is waiting for your answer${what}. Opening this ends that turn.`;
}
