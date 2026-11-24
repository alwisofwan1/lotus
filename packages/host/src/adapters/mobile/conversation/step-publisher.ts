import type { ConversationUpdate } from "../../../types/conversation.js";
import type { NotificationEvent } from "../../../types/notifications.js";
import type { TranscriptEntry } from "../../../types/transcript.js";
import { ConversationStream, entryFromStopEvent } from "./conversation-stream.js";

/**
 * One step, on both lanes.
 *
 * A hook event is broadcast as a `notification` — the vocabulary every shipped phone reads —
 * and, since Fase 4, as the `Part` deltas it amounts to. Keeping the decision here rather than
 * in the adapter is what makes it testable without a socket, and keeps the one rule that is
 * easy to get wrong in a place it can be read: **a cell this host runs itself is skipped**,
 * because it already published a native part for the same step, and converting its entry as
 * well would put that step on the wire twice under two different ids.
 *
 * **What an event means, since 2026-09-08: "this cell is worth reading again".** The deltas
 * are derived from the pane's whole entry list — the same list `/transcript` serves — and not
 * from the events this lane happened to see. Two derivations of one conversation is what drew
 * an exchange twice on a phone: the lane's accumulated copy drifted from the file, so the same
 * two steps arrived under a second turn id. `bb` never has that class of bug because one
 * writer owns its timeline; this is the same discipline against a file somebody else owns.
 */
export interface StepPublisherDeps {
  publishConversation: (paneId: string, agentType: string, update: ConversationUpdate) => void;
  /** Whether this host runs the cell itself, and has therefore already said its piece. */
  isStructured: (paneId: string) => boolean;
  /**
   * The pane's whole entry list, exactly as `/transcript` serves it. Absent for a host that
   * cannot be asked, and `undefined` for a pane it holds nothing for — both fall back to
   * converting the event in hand, because a step derived from one event beats no step.
   */
  entriesOf?: (paneId: string) => Promise<readonly TranscriptEntry[] | undefined>;
}

export class StepPublisher {
  private readonly stream: ConversationStream;
  /** One read per cell at a time; what arrives during a read is collapsed into one more. */
  private readonly reading = new Map<string, Promise<number>>();
  private readonly again = new Set<string>();
  /** The last event per cell, for a host that turns out to hold no list for it. */
  private readonly fallback = new Map<string, TranscriptEntry>();

  constructor(private readonly deps: StepPublisherDeps, maxEntriesPerPane?: number) {
    this.stream = new ConversationStream(maxEntriesPerPane);
  }

  /**
   * Publishes the conversation deltas this event produced, and reports how many there were.
   *
   * The count is what the event alone accounts for. With an authoritative list available the
   * read is asynchronous, so the deltas land just after this returns — the caller broadcasts
   * a `notification` for the same step either way, and neither lane waits on the other.
   */
  publish(event: NotificationEvent): number {
    if (event.kind !== "agent_stop") return 0;
    const paneId = event.pane_id;
    if (paneId === undefined || paneId === "" || this.deps.isStructured(paneId)) return 0;
    if (this.deps.entriesOf !== undefined) {
      // Held so a read that comes back with nothing still has the step in hand.
      this.fallback.set(paneId, entryFromStopEvent(event));
      // Never allowed to reject: this runs on the notification path, and an unhandled
      // rejection there takes the host down over a Chat line.
      void this.refresh(paneId, event.agent_type).catch(() => undefined);
      return 0;
    }
    return this.send(paneId, event.agent_type, this.stream.push(paneId, entryFromStopEvent(event)));
  }

  /** Re-reads this cell and publishes what changed. Safe to call while one is in flight. */
  async refresh(paneId: string, agentType: string): Promise<number> {
    const running = this.reading.get(paneId);
    if (running !== undefined) {
      this.again.add(paneId);
      return running;
    }
    const run = this.read(paneId, agentType);
    this.reading.set(paneId, run);
    try {
      return await run;
    } finally {
      this.reading.delete(paneId);
      if (this.again.delete(paneId)) await this.refresh(paneId, agentType);
    }
  }

  /** Keeps only the cells still in the fleet. */
  retain(alive: ReadonlySet<string>): void {
    this.stream.retain(alive);
  }

  size(): number {
    return this.stream.size();
  }

  private async read(paneId: string, agentType: string): Promise<number> {
    const entries = await this.deps.entriesOf?.(paneId);
    if (entries === undefined || entries.length === 0) {
      // A runner with no transcript file still has steps, and one derived from the event in
      // hand beats none. The lane then accumulates for this cell, as it always did.
      const held = this.fallback.get(paneId);
      if (held === undefined) return 0;
      this.fallback.delete(paneId);
      return this.send(paneId, agentType, this.stream.push(paneId, held));
    }
    this.fallback.delete(paneId);
    return this.send(paneId, agentType, this.stream.replace(paneId, entries));
  }

  private send(paneId: string, agentType: string, updates: ConversationUpdate[]): number {
    for (const update of updates) this.deps.publishConversation(paneId, agentType, update);
    return updates.length;
  }
}

/** Enough of `ApiClient` to read one cell's transcript. */
export interface TranscriptReader {
  readCellTranscript(paneId: string): Promise<{ entries?: TranscriptEntry[] }>;
}

/**
 * The pane's entries for the conversation lane — the same call the phone seeds Chat with.
 *
 * One list, one derivation: a lane that kept its own copy drifted from the file and filed the
 * same steps under a second turn id, which a phone drew as the exchange happening twice
 * (2026-09-08). Asking for exactly what `/transcript` serves is what makes the two agree.
 *
 * Nothing here is fatal. A host that cannot be asked, an answer without entries, a pane it
 * holds nothing for — all read as *nothing to derive from*, and the step is published from the
 * event in hand instead. Losing a Chat line is not worth an exception on the notification path.
 */
export function transcriptEntriesOf(
  api: TranscriptReader,
): (paneId: string) => Promise<readonly TranscriptEntry[] | undefined> {
  return async (paneId) => {
    try {
      const { entries } = await api.readCellTranscript(paneId);
      return Array.isArray(entries) ? entries : undefined;
    } catch {
      return undefined;
    }
  };
}
