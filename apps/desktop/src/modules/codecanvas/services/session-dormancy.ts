/**
 * Whether an agent node should come up asleep (`plans/codecanvas-session-widget/`, Slice 04).
 *
 * **The measured reason this exists.** A cold `claude` spawn on this machine takes about 110
 * seconds, and the heat RCA behind `services/idle-session-reclaim.ts` recorded 19 agent CLIs alive
 * for 9–13 hours holding ~1.07 GB — the largest heat source on the machine, bigger than the webview
 * render path. Opening a board with eight agents used to start eight CLIs at once, so the app
 * appeared to hang for two minutes while spending memory on conversations nobody had asked to
 * continue.
 *
 * A dormant node costs nothing: no PTY, no process, no memory. It shows what the conversation was
 * and waits to be asked.
 */

import type { ResumeCapability } from "./session-resume-capability";

export interface DormancyFacts {
  /**
   * True when a PTY for this node is already pooled — the agent survived a project switch and is
   * still running. **Checked first and it always wins**: a live conversation must never be hidden
   * behind a Resume button, and the button would kill it to start it again.
   */
  hasPooledPty: boolean;
  /** The conversation this node would continue. Empty/absent = nothing to be dormant about. */
  resumeSessionId?: string | null;
  /**
   * What this runner can actually do about continuing a conversation
   * (`services/session-resume-capability.ts`).
   *
   * Deliberately the capability itself and not a boolean: dormancy once answered this question with
   * a looser predicate than launch did, so a node could sleep, be woken, and then be launched with
   * no resume descriptor at all — the conversation gone without a message. Taking the same value
   * launch takes makes that disagreement impossible to write
   * (`plans/codecanvas-session-refactor/issues/01`).
   */
  capability: ResumeCapability;
}

/**
 * Decide at mount time only.
 *
 * A node that has been woken stays awake for the rest of its life on the board — waking is a
 * deliberate act, and nothing that happens afterwards should put it back to sleep behind the user's
 * back.
 */
export function shouldStartDormant(facts: DormancyFacts): boolean {
  if (facts.hasPooledPty) return false;
  if (facts.capability.kind !== "resume") return false;
  return Boolean(facts.resumeSessionId);
}
