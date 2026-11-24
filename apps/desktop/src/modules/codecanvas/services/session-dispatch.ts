import type { CanvasSessionRecord } from "./session-record";

/**
 * What pressing a session row should do (`plans/codecanvas-session-refactor/issues/03`).
 *
 * **Why one owner.** Three surfaces — the corner popover, the ⌘K rows, the cycle hotkeys — each
 * reached into the control registry with their own idea of what a row meant, and each dropped the
 * answer. A row whose node was not mounted on this canvas therefore did nothing at all: no launch,
 * no message. This module answers the question once, from facts about the board, and the surfaces
 * only render what it decides.
 */

export type SessionDispatchPlan =
  /** The conversation is running on a node in front of you: take them there. */
  | { kind: "focus"; nodeId: string }
  /** The node is here and asleep on this very conversation: it only needs waking. */
  | { kind: "wake"; nodeId: string }
  /** The node is here but in another conversation: kill its CLI and launch against this one. */
  | { kind: "relaunch"; nodeId: string }
  /** No node on this board owns it: make one, point it here, and run it — as one move. */
  | { kind: "adopt" }
  | { kind: "blocked"; reason: SessionBlockedReason };

/** Why a row cannot be acted on. Shared with the copy so no reason can exist without a sentence. */
export type SessionBlockedReason = "dead-session" | "no-project" | "no-runner-command";

export interface SessionBoardFacts {
  projectId: string | null | undefined;
  /** Whether a node with this id has published controls on the canvas being looked at. */
  isRegistered: (nodeId: string) => boolean;
  isDormant: (nodeId: string) => boolean;
  /** The conversation that node is pointed at right now. */
  activeSessionId: (nodeId: string) => string | null;
}

export function planSessionDispatch(
  session: CanvasSessionRecord,
  board: SessionBoardFacts,
): SessionDispatchPlan {
  if (!board.projectId) return { kind: "blocked", reason: "no-project" };
  // Checked before adoption: making a node for a conversation nobody can re-enter would leave an
  // empty pane and the impression the session was lost.
  if (session.status === "dead") return { kind: "blocked", reason: "dead-session" };
  if (!session.nodeId || !board.isRegistered(session.nodeId)) {
    // A node rebuilt from a row needs everything the row remembers. For a custom runner that
    // includes the command itself — the row records the TYPE ("custom"), and grok, opencode and a
    // second-account Claude all arrive under that one word. Without it `resolveRunnerCommand`
    // throws during render, which is what pressing "pasang" actually did on 2026-09-12. Rows
    // written before `runnerCommand` existed can never have one, so this is a verdict, not an
    // assertion.
    if (session.runner === "custom" && !session.runnerCommand?.trim()) {
      return { kind: "blocked", reason: "no-runner-command" };
    }
    return { kind: "adopt" };
  }

  const nodeId = session.nodeId;
  const alreadyHere = board.activeSessionId(nodeId) === session.id;
  if (alreadyHere) return board.isDormant(nodeId) ? { kind: "wake", nodeId } : { kind: "focus", nodeId };
  return { kind: "relaunch", nodeId };
}

/**
 * The word on a session row's button.
 *
 * One word for every pressable row. The dispatcher already decides whether a press focuses, wakes,
 * relaunches or adopts; asking a person to learn four verbs for "take me to this conversation" was
 * the old panel's main source of hesitation (2026-11-13 refactor). Null means the row cannot be
 * acted on, which is still derived from the plan so the label and the click never disagree.
 */
export function dispatchActionLabel(plan: SessionDispatchPlan): string | null {
  return plan.kind === "blocked" ? null : "Open";
}
