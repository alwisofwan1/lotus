import type { CanvasSessionRecord, CanvasSessionStatus } from "./session-record";

/**
 * Bringing `status` back in line with reality when a canvas loads
 * (`plans/codecanvas-session-widget/`, Slice 08).
 *
 * **`live` is a cache about a process, never a durable fact.** Closing the app normally kills every
 * PTY through the shutdown policy, and the node writes the row back to `resumable` on the way out.
 * A force-quit, a crash, or a `kill -9` writes nothing at all — so the rows still say `live` while
 * nothing is running.
 *
 * That combination is the worst one available, and it is created by a rule from Slice 04 that is
 * otherwise correct: a `live` row does not offer resume, it offers to take you to the process. So a
 * stale row is a conversation you can neither open (there is nothing there) nor continue (the UI
 * thinks it is already running). Hence: reconcile before the list is ever shown.
 */

export interface ReconcileInput {
  sessions: readonly CanvasSessionRecord[];
  /** Pane ids of the PTYs that actually exist right now. */
  livePaneIds: readonly string[];
  /** Maps a node id to its runtime pane id, so the two vocabularies can be compared. */
  paneIdForNode: (nodeId: string) => string;
  /** False for a runner with no resume mechanism — its rows fall back to `no-resume`, not `resumable`. */
  canResume?: (session: CanvasSessionRecord) => boolean;
}

export interface ReconcileChange {
  session: CanvasSessionRecord;
  from: CanvasSessionStatus;
  to: CanvasSessionStatus;
}

/**
 * Work out which rows are lying, without touching anything.
 *
 * Only ever demotes: a row that claims to be running and has no process behind it drops to
 * resumable. Nothing here promotes a row to `live` — a process that exists is claimed by the node
 * that owns it, and guessing from the outside would race that.
 */
export function planSessionReconciliation(input: ReconcileInput): ReconcileChange[] {
  const alive = new Set(input.livePaneIds);
  const changes: ReconcileChange[] = [];

  for (const session of input.sessions) {
    if (session.status !== "live") continue;
    // A live row with no node cannot have a process: the node that ran it is gone.
    const stillRunning = session.nodeId ? alive.has(input.paneIdForNode(session.nodeId)) : false;
    if (stillRunning) continue;

    const to: CanvasSessionStatus =
      input.canResume?.(session) === false ? "no-resume" : "resumable";
    changes.push({ session, from: session.status, to });
  }

  return changes;
}
