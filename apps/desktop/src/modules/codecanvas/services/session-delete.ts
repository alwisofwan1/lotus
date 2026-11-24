import type { CanvasSessionRecord } from "./session-record";

/**
 * Whether a session row may be removed from Lotus's list, and what to say when it may not.
 *
 * **What delete means here.** Only Lotus's own bookkeeping — the row in `codecanvas_sessions`. The
 * runner's transcript on disk is untouched, so the conversation itself survives and `claude
 * --resume <id>` still finds it. The UI says so, because a delete button that looks like it burns
 * the conversation is a delete button people are afraid to press.
 *
 * Copy is English by request (2026-09-13); the surrounding panel labels are still Indonesian.
 */

export type DeleteVerdict = { allowed: true } | { allowed: false; text: string };

export function deleteDecision(session: CanvasSessionRecord): DeleteVerdict {
  // A row whose CLI is still running must not vanish from the list: the process would keep its
  // memory and stay reachable while Lotus forgot it existed — the ghost row, from the other side.
  if (session.status === "live") {
    return { allowed: false, text: "Stop the agent before deleting this session." };
  }
  return { allowed: true };
}

/** What the undo bar says after a row is removed. */
export function deletedNoticeText(session: CanvasSessionRecord): string {
  const title = session.title?.trim();
  return title ? `Deleted “${title}”` : "Session deleted";
}
