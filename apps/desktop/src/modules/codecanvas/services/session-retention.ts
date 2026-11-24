import type { CanvasSessionRecord } from "./session-record";

/**
 * Which of a node's sessions are worth keeping (`plans/codecanvas-session-widget/`, Slice 03).
 *
 * Opening a node to many conversations means the list would otherwise grow without end. The cost of
 * a session on our side is one database row — the transcript itself belongs to the CLI, under
 * `~/.claude/projects` and its equivalents — so this policy trims a **list**, it never deletes
 * anyone's conversation. That asymmetry is why the cap can be generous and the rules blunt.
 *
 * Stated once, here, and tested here, because every rule below is protecting someone's work.
 */

/** How many sessions a node keeps. Enough for a month of normal work, and it still fits a popover. */
export const MAX_SESSIONS_PER_NODE = 8;

/** A session with no turns and more than this behind it was a "New session" nobody used. */
export const EMPTY_SESSION_TTL_MS = 24 * 60 * 60_000;

export interface RetentionPlan {
  keep: CanvasSessionRecord[];
  /** Rows to delete, with the reason, so a caller can explain itself in a log or a test. */
  drop: Array<{ session: CanvasSessionRecord; reason: "empty" | "over-cap" }>;
}

/**
 * Decide what to keep for ONE node.
 *
 * Order matters and is deliberate:
 *
 * 1. **A pinned session is never dropped.** Pinning is an explicit "this one matters"; any cap must
 *    yield to it. It is checked first so no later rule can reach a pinned row.
 * 2. **An empty, day-old session goes immediately** — that is a "New session" click that was never
 *    used, and waiting for the cap to evict it would push out real conversations meanwhile.
 * 3. **A graph run's sessions yield before a manual one.** They are execution artefacts — nobody
 *    comes back to the third agent of a run the way they come back to a conversation they had.
 * 4. **The most recently active survivors fill the cap.** Recency, not creation order: the session
 *    you spoke to this morning outranks one you opened last week and abandoned.
 *
 * The currently active session is never dropped either, whatever its age or turn count — evicting
 * the conversation a node is having would be absurd. Callers pass it as `activeSessionId`.
 */
export function planSessionRetention(
  sessions: readonly CanvasSessionRecord[],
  options: { now?: number; activeSessionId?: string | null; max?: number } = {},
): RetentionPlan {
  const now = options.now ?? Date.now();
  const max = options.max ?? MAX_SESSIONS_PER_NODE;
  const activeId = options.activeSessionId ?? null;

  const protectedRow = (s: CanvasSessionRecord) => Boolean(s.pinned) || s.id === activeId;

  const keep: CanvasSessionRecord[] = [];
  const drop: RetentionPlan["drop"] = [];

  const survivors: CanvasSessionRecord[] = [];
  for (const session of sessions) {
    if (protectedRow(session)) {
      keep.push(session);
      continue;
    }
    const empty = !session.turnCount && now - session.createdAt > EMPTY_SESSION_TTL_MS;
    if (empty) {
      drop.push({ session, reason: "empty" });
      continue;
    }
    survivors.push(session);
  }

  // The cap counts protected rows too — the popover has one length, not one per category.
  const room = Math.max(0, max - keep.length);
  const ranked = [...survivors].sort((a, b) => {
    // Machine-started conversations lose to human-started ones regardless of recency; within a
    // class, recency decides.
    const machine = (s: CanvasSessionRecord) => (s.origin === "graph-run" ? 1 : 0);
    return machine(a) - machine(b) || b.lastActivityAt - a.lastActivityAt;
  });
  keep.push(...ranked.slice(0, room));
  for (const session of ranked.slice(room)) drop.push({ session, reason: "over-cap" });

  keep.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return { keep, drop };
}
