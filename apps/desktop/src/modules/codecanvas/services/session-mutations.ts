import type { CanvasSessionRecord } from "./session-record";
import { buildSessionRecord } from "./session-record";
import { planSessionRetention } from "./session-retention";
import type { CanvasSessionStore } from "./session-store";

/**
 * The writes a node's session list can make (`plans/codecanvas-session-widget/`, Slice 03).
 *
 * Everything here is durable bookkeeping only. **Nothing in this module starts, stops, or switches a
 * CLI** — that machinery is shared with resume and lands in Slice 04. Keeping the two apart means a
 * rename or a pin can never disturb a running agent.
 */

export interface NodeSessionContext {
  store: CanvasSessionStore;
  projectId: string;
  nodeId: string;
  /** The session the node is currently in, protected from retention whatever its age. */
  activeSessionId?: string | null;
  now?: number;
}

/** A node's own sessions, most recently active first. */
export async function listNodeSessions(
  store: CanvasSessionStore,
  projectId: string,
  nodeId: string,
): Promise<CanvasSessionRecord[]> {
  const rows = await store.list(projectId);
  return rows.filter((s) => s.nodeId === nodeId);
}

/**
 * Record a new, empty conversation for a node.
 *
 * The row is created with no `providerSessionId`: the CLI has not been asked for one yet, and for
 * Claude it cannot be asked at all — the id is discovered after the fact. The capture path in
 * `session-sync.ts` fills it in, and reuses this waiting row rather than adding a second one.
 */
export async function createNodeSession(
  context: NodeSessionContext & {
    runner?: string;
    cwd: string;
    worktreePath?: string | null;
    agentName?: string;
  },
): Promise<CanvasSessionRecord> {
  const record = buildSessionRecord({
    projectId: context.projectId,
    nodeId: context.nodeId,
    runner: context.runner,
    cwd: context.cwd,
    worktreePath: context.worktreePath,
    agentName: context.agentName,
    now: context.now,
    // Nothing is running for it yet; the node adopts it when the runtime work of Slice 04 lands.
    status: "resumable",
  });
  await context.store.upsert(record);
  await applyNodeRetention({ ...context, activeSessionId: record.id });
  return record;
}

/** Rename a session, marking the title as a human's choice so nothing overwrites it later. */
export async function renameNodeSession(
  store: CanvasSessionStore,
  session: CanvasSessionRecord,
  title: string,
): Promise<CanvasSessionRecord | null> {
  const trimmed = title.trim();
  if (!trimmed || trimmed === session.title) return null;
  const renamed: CanvasSessionRecord = { ...session, title: trimmed, titleSource: "manual" };
  await store.upsert(renamed);
  return renamed;
}

/**
 * Pin or unpin a session.
 *
 * A pinned session outranks every retention rule, so this is the one control that decides what
 * survives a busy month.
 */
export async function setNodeSessionPinned(
  store: CanvasSessionStore,
  session: CanvasSessionRecord,
  pinned: boolean,
): Promise<CanvasSessionRecord> {
  const next: CanvasSessionRecord = { ...session, pinned };
  await store.upsert(next);
  return next;
}

/**
 * Trim a node's list to the retention policy.
 *
 * Returns the sessions that were removed, so a caller can say what happened rather than have rows
 * vanish silently.
 */
export async function applyNodeRetention(
  context: NodeSessionContext,
): Promise<CanvasSessionRecord[]> {
  const sessions = await listNodeSessions(context.store, context.projectId, context.nodeId);
  const plan = planSessionRetention(sessions, {
    now: context.now,
    activeSessionId: context.activeSessionId,
  });
  for (const { session } of plan.drop) {
    await context.store.remove(session.id);
  }
  return plan.drop.map((d) => d.session);
}

/**
 * Let a node's conversations outlive the node (`plans/codecanvas-session-widget/`, Slice 05).
 *
 * Deleting a node used to be the end of everything it had said, because the session id lived on the
 * node itself. Tidying a board should never feel like throwing work away, so the rows survive with
 * `nodeId` cleared and surface under "Lepas dari node", where they can be attached to a new node.
 *
 * Returns how many were detached, so a caller can say what happened.
 */
export async function detachNodeSessions(
  store: CanvasSessionStore,
  projectId: string,
  nodeId: string,
): Promise<number> {
  const sessions = await listNodeSessions(store, projectId, nodeId);
  for (const session of sessions) {
    // A conversation with no process is what a detached session is by definition: the node that ran
    // it is gone, so `live` would be a lie the moment the row is written.
    await store.upsert({
      ...session,
      nodeId: null,
      status: session.status === "live" ? "resumable" : session.status,
    });
  }
  return sessions.length;
}

/** Bind a detached conversation to a node that will run it. */
export async function attachSessionToNode(
  store: CanvasSessionStore,
  session: CanvasSessionRecord,
  nodeId: string,
  now?: number,
): Promise<CanvasSessionRecord> {
  const attached: CanvasSessionRecord = {
    ...session,
    nodeId,
    lastActivityAt: now ?? Date.now(),
  };
  await store.upsert(attached);
  return attached;
}
