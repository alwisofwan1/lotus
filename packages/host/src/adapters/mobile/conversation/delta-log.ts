import type { ConversationUpdate } from "../../../types/conversation.js";

/**
 * The recent conversation deltas per cell, each stamped with a cursor a client can resume from.
 *
 * **Why this exists.** The conversation lane was fire-and-forget: a delta was broadcast and
 * forgotten. Every dropped socket therefore left the phone with a hole it could not name, and
 * the only repair was a manual refresh. On a phone that is not an edge case — the socket dies
 * when the screen locks, when the tailnet blinks, when the host restarts. Reported from a real
 * device on 2026-09-07 as "the conversation only updates if I refresh the page".
 *
 * The shape is taken from the lane that already solved this, PTY output: read from a byte
 * offset, and say `cell.truncated` when the ring cannot reach back that far. Same discipline
 * here — a cursor, and an explicit "you asked for further back than I hold" rather than a
 * silent gap. `bb` reaches the same conclusion from the other end, with a unique
 * `(thread_id, sequence)` on its `events` table; the difference is only that it keeps every
 * event on disk while this keeps a bounded tail in memory.
 *
 * The cursor is **per cell** and monotonic for the life of the host process. It is deliberately
 * not `Part.seq`: that counts arrivals inside one conversation object and restarts with it,
 * which is exactly what a resuming client cannot rely on.
 */
export interface LoggedDelta {
  cursor: number;
  agentType: string;
  update: ConversationUpdate;
}

export interface DeltasSince {
  deltas: LoggedDelta[];
  /**
   * True when the requested cursor is older than anything still held.
   *
   * The client must then refetch the page over REST. Handing it the oldest-held deltas instead
   * would look like success and leave a hole in the middle of the transcript.
   */
  truncated: boolean;
  /** The oldest cursor still held for this cell, so a client can say how much it lost. */
  oldestCursor: number;
}

export class ConversationDeltaLog {
  private readonly held = new Map<string, LoggedDelta[]>();
  private readonly nextCursor = new Map<string, number>();

  /**
   * 500 per cell, matching the page the host serves and the cap the phone holds
   * (`LiveConversation.maxParts`). One page can always be replayed whole.
   */
  constructor(private readonly maxPerPane = 500) {}

  /** Records one delta and returns the cursor it was given. */
  append(paneId: string, agentType: string, update: ConversationUpdate): number {
    const cursor = this.nextCursor.get(paneId) ?? 1;
    this.nextCursor.set(paneId, cursor + 1);
    const log = this.held.get(paneId) ?? [];
    log.push({ cursor, agentType, update });
    if (log.length > this.maxPerPane) log.splice(0, log.length - this.maxPerPane);
    this.held.set(paneId, log);
    return cursor;
  }

  /**
   * Everything after `cursor`, or a refusal.
   *
   * `cursor: 0` means *I have nothing* and is answered with whatever is held — never
   * `truncated`, because a client with nothing has no hole to fall into. A cell this host has
   * never seen answers empty and untruncated for the same reason.
   */
  since(paneId: string, cursor: number): DeltasSince {
    const log = this.held.get(paneId) ?? [];
    const oldestCursor = log[0]?.cursor ?? 0;
    if (log.length === 0) return { deltas: [], truncated: false, oldestCursor: 0 };
    // A gap: the client's last cursor fell off the front of the ring while it was away.
    if (cursor > 0 && cursor < oldestCursor - 1) {
      return { deltas: [], truncated: true, oldestCursor };
    }
    return { deltas: log.filter((d) => d.cursor > cursor), truncated: false, oldestCursor };
  }

  /** Keeps only the cells still in the fleet; a closed cell gains no more deltas. */
  retain(alive: ReadonlySet<string>): void {
    for (const paneId of [...this.held.keys()]) {
      if (alive.has(paneId)) continue;
      this.held.delete(paneId);
      // The cursor counter goes with it: a pane id is never reused, and holding the number
      // would only keep this map growing for the life of the process.
      this.nextCursor.delete(paneId);
    }
  }

  size(): number {
    return this.held.size;
  }
}
