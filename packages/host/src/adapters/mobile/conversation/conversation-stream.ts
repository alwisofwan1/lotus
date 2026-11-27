import type { ConversationUpdate, Part, Turn } from "../../../types/conversation.js";
import type { AgentStopEvent } from "../../../types/notifications.js";
import type { TranscriptEntry } from "../../../types/transcript.js";
import { turnsFromEntries } from "./parts-from-entries.js";

/**
 * Hook entries → `Part` deltas, so the phone need not convert (`conversation_builder.dart` is
 * a pinned port). **Re-converts the whole cell per entry** and diffs by part id, like
 * `TranscriptEmitter`: pure and small, unlike an incremental converter. A no-op entry emits nothing.
 */
export class ConversationStream {
  private readonly entries = new Map<string, TranscriptEntry[]>();
  /** The last converted shape per pane, to diff the next one against. */
  private readonly sent = new Map<string, Map<string, string>>();
  private readonly turns = new Map<string, Map<string, string>>();

  constructor(private readonly maxEntriesPerPane = 500) {}

  /**
   * Returns the deltas one more entry produced; turn deltas precede their parts, as in
   * [`AcpConversation`] and `NativeConversation`.
   */
  push(paneId: string, entry: TranscriptEntry): ConversationUpdate[] {
    const held = this.entries.get(paneId) ?? [];
    held.push(entry);
    if (held.length > this.maxEntriesPerPane) held.splice(0, held.length - this.maxEntriesPerPane);
    this.entries.set(paneId, held);
    return this.diff(paneId, turnsFromEntries(held, "hook"));
  }

  /**
   * The lane's copy is *replaced*, not appended to: a turn id derives from the entry that opened
   * it, so a drifted list files steps under another turn (exchange drawn twice).
   */
  replace(paneId: string, entries: readonly TranscriptEntry[]): ConversationUpdate[] {
    const held = entries.length > this.maxEntriesPerPane
      ? entries.slice(entries.length - this.maxEntriesPerPane)
      : [...entries];
    this.entries.set(paneId, held);
    return this.diff(paneId, turnsFromEntries(held, "hook"));
  }

  /** Keeps only the panes still in the fleet. A cell that is gone gains no more steps. */
  retain(alive: ReadonlySet<string>): void {
    for (const paneId of [...this.entries.keys()]) {
      if (!alive.has(paneId)) this.forget(paneId);
    }
  }

  /** A closed cell gains no more steps, and its cursor would otherwise be held forever. */
  forget(paneId: string): void {
    this.entries.delete(paneId);
    this.sent.delete(paneId);
    this.turns.delete(paneId);
  }

  size(): number {
    return this.entries.size;
  }

  private diff(paneId: string, turns: Turn[]): ConversationUpdate[] {
    const partsBefore = this.sent.get(paneId) ?? new Map<string, string>();
    const turnsBefore = this.turns.get(paneId) ?? new Map<string, string>();
    const partsAfter = new Map<string, string>();
    const turnsAfter = new Map<string, string>();
    const updates: ConversationUpdate[] = [];

    for (const turn of turns) {
      const { parts, ...header } = turn;
      const headerKey = JSON.stringify(header);
      turnsAfter.set(turn.turnId, headerKey);
      if (turnsBefore.get(turn.turnId) !== headerKey) {
        updates.push({ kind: "turn", turn: header });
      }
      for (const part of parts) {
        const key = stableKey(part);
        partsAfter.set(part.id, key);
        if (partsBefore.get(part.id) !== key) {
          updates.push({ kind: "part", turnId: turn.turnId, part });
        }
      }
    }

    this.sent.set(paneId, partsAfter);
    this.turns.set(paneId, turnsAfter);
    return updates;
  }
}

/**
 * "Same part as last time": id and content. `seq` is excluded as it is positional, so one new
 * entry would "change" everything after it.
 */
function stableKey(part: Part): string {
  const { seq: _seq, ...rest } = part;
  return JSON.stringify(rest);
}

/**
 * A broadcast hook event as a transcript entry (snake_case wire; mirrors the phone's
 * `toTranscriptEntry()`). Absent stays absent: "changed nothing" and "no diff applies" differ
 * (`contract/README.md`).
 */
export function entryFromStopEvent(event: AgentStopEvent): TranscriptEntry {
  // Every string is defaulted rather than trusted. The producer is a shell script on somebody
  // else's machine, and the type here describes what it *should* send: a missing `body` used to
  // reach the converter and throw on `body.length`, which on this path is a hook waiting on a
  // host that just died.
  return {
    event: text(event.event),
    status: text(event.status),
    title: text(event.title),
    body: text(event.body),
    userPrompt: text(event.user_prompt),
    toolTarget: text(event.tool_target),
    timestamp: typeof event.timestamp === "number" ? event.timestamp : 0,
    ...(event.lines_added === undefined ? {} : { linesAdded: event.lines_added }),
    ...(event.lines_removed === undefined ? {} : { linesRemoved: event.lines_removed }),
    ...(event.body_truncated === true ? { bodyTruncated: true } : {}),
  };
}

function text(value: string | undefined): string {
  return typeof value === "string" ? value : "";
}
