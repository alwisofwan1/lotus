import type { CanvasSessionRecord, CanvasSessionOrigin } from "./session-record";
import { buildSessionRecord } from "./session-record";
import type { CanvasSessionStore } from "./session-store";

/**
 * Dual-write: keep `codecanvas_sessions` in step with the `resumeSessionId` pointer that already
 * lives on the node (`plans/codecanvas-session-widget/`, Slice 01).
 *
 * The pointer stays for now — it is what `LiveAgentNode` still reads to decide whether to relaunch
 * with `--resume`. This module writes the same fact to the table beside it, so a list can exist
 * before anything depends on it. The pointer is only demoted to a cache once detach/attach lands
 * (Slice 05).
 */

export interface CaptureInput {
  store: CanvasSessionStore;
  projectId: string;
  nodeId: string;
  /**
   * The id the CLI created. An **empty string** is the clear signal `LiveAgentNode` already sends
   * through `onPersistSession(id, "")` when a `--resume` launch reports the session is gone; it
   * marks the row dead rather than deleting it, so the list can say what happened.
   */
  providerSessionId: string;
  runner?: string;
  /** The launch command, so a `custom` runner's session can rebuild a node later. */
  runnerCommand?: string | null;
  account?: string | null;
  cwd: string;
  worktreePath?: string | null;
  agentName?: string;
  origin?: CanvasSessionOrigin;
  graphRunId?: string | null;
  now?: number;
}

export type CaptureOutcome =
  | { kind: "recorded"; session: CanvasSessionRecord }
  | { kind: "unchanged"; session: CanvasSessionRecord }
  | { kind: "marked-dead"; session: CanvasSessionRecord }
  /** Another node in this project already owns that CLI session id (issue 07). */
  | { kind: "claimed-elsewhere"; providerSessionId: string }
  | { kind: "noop" };

/**
 * Record a captured session id, idempotently.
 *
 * Called from the one-shot capture effect, so it must be safe to run twice with the same id: the
 * second call reports `unchanged` instead of writing a duplicate.
 */
export async function recordCapturedSession(input: CaptureInput): Promise<CaptureOutcome> {
  const { store, projectId, nodeId, providerSessionId } = input;
  if (!projectId || !nodeId) return { kind: "noop" };

  const sessions = await store.list(projectId);
  const forNode = sessions.filter((s) => s.nodeId === nodeId);

  // The clear signal: a resume that found nothing to resume.
  if (providerSessionId === "") {
    const stale = forNode.find((s) => s.status !== "dead" && s.providerSessionId);
    if (!stale) return { kind: "noop" };
    const dead: CanvasSessionRecord = { ...stale, status: "dead", lastActivityAt: input.now ?? Date.now() };
    await store.upsert(dead);
    return { kind: "marked-dead", session: dead };
  }

  const alreadyMine = forNode.find((s) => s.providerSessionId === providerSessionId);
  if (alreadyMine) return { kind: "unchanged", session: alreadyMine };

  const ownedByAnother = sessions.find(
    (s) => s.nodeId !== nodeId && s.providerSessionId === providerSessionId,
  );
  if (ownedByAnother) return { kind: "claimed-elsewhere", providerSessionId };

  // Reuse the row this node is already working in when it is still waiting for an id; otherwise
  // start one. A node that has been given a fresh conversation gets a fresh row.
  const waiting = forNode.find((s) => !s.providerSessionId && s.status !== "dead");
  const base =
    waiting ??
    buildSessionRecord({
      projectId,
      nodeId,
      runner: input.runner,
      runnerCommand: input.runnerCommand,
      account: input.account,
      cwd: input.cwd,
      worktreePath: input.worktreePath,
      agentName: input.agentName,
      origin: input.origin,
      graphRunId: input.graphRunId,
      now: input.now,
    });

  const session: CanvasSessionRecord = {
    ...base,
    providerSessionId,
    status: "live",
    lastActivityAt: input.now ?? Date.now(),
  };

  try {
    await store.upsert(session);
  } catch {
    // The unique index refused the claim — another node won the race between our read and write.
    return { kind: "claimed-elsewhere", providerSessionId };
  }
  return { kind: "recorded", session };
}
