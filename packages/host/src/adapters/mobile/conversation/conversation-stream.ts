import type { ConversationUpdate, Part, Turn } from "../../../types/conversation.js";
import type { AgentStopEvent } from "../../../types/notifications.js";
import type { TranscriptEntry } from "../../../types/transcript.js";
import { turnsFromEntries } from "./parts-from-entries.js";

/**
 * A stream of hook entries, turned into a stream of `Part` deltas.
 *
 * The host already knows how to turn a whole transcript into turns
 * (`turnsFromEntries`). What it could not do was say *what changed* when one more entry
 * arrived — so the live channel carried entries and the phone converted them itself
 * (`conversation_builder.dart`, a Dart port pinned equal to the TS one by a test). Two
 * implementations of one rule. This is the piece that lets the host send the answer.
 *
 * **Re-converts the whole cell on each entry**, then diffs by part id. The same trade
 * `TranscriptEmitter` makes and for the same reason: the conversion is a pure function of
 * the entries, a cell holds a few hundred of them, and an incremental converter would have
 * to re-derive turn boundaries and tool pairing against a list being appended to — the
 * place every bug in this area has come from. A cursor over a converted list is obviously
 * correct.
 *
 * Emits nothing for an entry that changes nothing, so a hook that fires twice for the same
 * step does not put a duplicate on the wire.
 */
export class ConversationStream {
  private readonly entries = new Map<string, TranscriptEntry[]>();
  /** The last converted shape per pane, to diff the next one against. */
  private readonly sent = new Map<string, Map<string, string>>();
  private readonly turns = new Map<string, Map<string, string>>();

  constructor(private readonly maxEntriesPerPane = 500) {}

  /**
   * One more entry for a pane. Returns the deltas it produced, oldest first.
   *
   * Turn deltas come before the parts inside them, which is the order a reader that opens
   * turns on demand needs — and the order [`AcpConversation`] and `NativeConversation`
   * already emit in.
   */
  push(paneId: string, entry: TranscriptEntry): ConversationUpdate[] {
    const held = this.entries.get(paneId) ?? [];
    held.push(entry);
    if (held.length > this.maxEntriesPerPane) held.splice(0, held.length - this.maxEntriesPerPane);
    this.entries.set(paneId, held);
    return this.diff(paneId, turnsFromEntries(held, "hook"));
  }

  /**
   * The pane's whole entry list, as the host holds it — and the deltas that amounts to.
   *
   * The lane's own accumulated copy is *replaced* rather than appended to, which is the
   * whole point: a turn id is derived from the entry that opened the turn, so a lane
   * converting a list that has drifted from the one `/transcript` serves files the same
   * steps under a different turn. Measured on a phone on 2026-09-08 as one exchange drawn
   * twice. One list, one derivation, and the two cannot disagree.
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
 * What makes a part "the same part as last time".
 *
 * `seq` is deliberately excluded: `turnsFromEntries` numbers parts by position, so one new
 * entry in the middle would renumber everything after it and every part would look changed.
 * The id and the content are what a client dedupes on.
 */
function stableKey(part: Part): string {
  const { seq: _seq, ...rest } = part;
  return JSON.stringify(rest);
}

/**
 * A broadcast hook event, read back as the transcript entry it describes.
 *
 * The two shapes are the same facts in two casings — the wire uses snake_case because the
 * hook scripts write it — and the phone has been doing this conversion since Chat existed
 * (`live_transcript.dart` → `toTranscriptEntry()`). Doing it here is what lets the host
 * answer in parts.
 *
 * Absent stays absent: `lines_added` and `body_truncated` are omitted rather than defaulted,
 * because "changed nothing" and "no diff applies" are different claims (`contract/README.md`).
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
