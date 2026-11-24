import type { CanvasSessionRecord } from "./session-record";

/**
 * Deciding whether a node may be relaunched against a different conversation
 * (`plans/codecanvas-session-widget/`, Slice 04).
 *
 * **The mechanism, established by reading the runtime rather than guessing.** Switching a node to
 * another session and starting a new one are the same move: kill the CLI this node is running and
 * launch it again with different arguments. Three facts constrain how that can be done:
 *
 * 1. `usePtySession`'s connect effect re-runs on
 *    `[cols, cwd, rows, locationKey, paneId, canvasTerminalId, commandKey, hold, persistKey, persistScope]`
 *    (`hooks/usePtySession.ts:239`).
 * 2. When it re-runs and the pool still holds the key, it **reattaches** to the live process rather
 *    than spawning (`usePtySession.ts:116`). So changing the argv alone would hand the node a new
 *    command and then quietly connect it to the old CLI.
 * 3. `persistKey` is `canvas:<project>:<node>` (`canvas-runtime-scope.ts:7`) — the same address
 *    dispatch, MCP and the hook pipeline use — so it must never change per session.
 *
 * The safe sequence is therefore: **destroy the pooled PTY first, then re-run the effect** (a
 * `hold` toggle is the documented lever), and reset the launch guard so the runner is launched
 * again. This module owns the *decision*; the effect sequencing lives in the node.
 */

export type RelaunchIntent =
  /** Continue an existing conversation: launch with the runner's resume flag. */
  | { kind: "resume"; session: CanvasSessionRecord }
  /** Start a fresh conversation on the same node, keeping its identity. */
  | { kind: "new" };

export type RelaunchVerdict =
  | { allowed: true; intent: RelaunchIntent }
  /** Blocked outright — acting would lose or duplicate work. */
  | { allowed: false; reason: "already-active" | "dead-session" | "no-project" }
  /**
   * Allowed, but the user must say so first. The pane is mid-question: relaunching would throw away
   * a turn that is waiting on them, and they are the only one who knows whether that matters.
   */
  | { allowed: true; intent: RelaunchIntent; confirm: "needs-you" };

export interface RelaunchFacts {
  projectId: string | null | undefined;
  /** The session the node is in right now, if any. */
  activeSessionId?: string | null;
  /** True when the pane is waiting on a human answer (`needs-you`). */
  awaitingAnswer?: boolean;
}

/**
 * Judge one relaunch request.
 *
 * Deliberately pure and separate from the runtime: every rule that protects someone's conversation
 * is stated once, here, and tested — the same shape `idle-session-reclaim.ts` uses for the same
 * reason.
 */
export function judgeRelaunch(intent: RelaunchIntent, facts: RelaunchFacts): RelaunchVerdict {
  if (!facts.projectId) return { allowed: false, reason: "no-project" };

  if (intent.kind === "resume") {
    // Re-entering the conversation the node is already having would kill a healthy CLI to start an
    // identical one. The caller should focus the node instead.
    if (intent.session.id === facts.activeSessionId) {
      return { allowed: false, reason: "already-active" };
    }
    // The CLI no longer knows this conversation; a resume would fail and drop the user into a bare
    // pane, which reads as "my session was destroyed".
    if (intent.session.status === "dead") return { allowed: false, reason: "dead-session" };
  }

  if (facts.awaitingAnswer) return { allowed: true, intent, confirm: "needs-you" };
  return { allowed: true, intent };
}
