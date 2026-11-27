import type { ConversationUpdate } from "../../../types/conversation.js";

/**
 * Recent deltas per cell with a resumable cursor, so a dropped socket leaves no silent hole.
 * Like PTY output: an explicit `truncated` when the bounded tail cannot reach back. The cursor
 * is **per cell**, monotonic per process; not `Part.seq`, which restarts with its conversation.
 */
export interface LoggedDelta {
  cursor: number;
  agentType: string;
  update: ConversationUpdate;
}

export interface DeltasSince {
  deltas: LoggedDelta[];
  /**
   * True when the cursor is older than anything held; the client must refetch over REST, as the
   * oldest-held deltas would leave a hole mid-transcript.
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
   * Everything after `cursor`, or a refusal. `cursor: 0` means *I have nothing*: never
   * `truncated`, nor for a cell never seen (no hole to fall into).
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
