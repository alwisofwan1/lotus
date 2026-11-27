import type { AgentStopEvent } from "../../../types/notifications.js";
import type { TranscriptEntry } from "../../../types/transcript.js";

/**
 * A hook fire → new entries as `notification` frames, read from the file `/transcript` serves
 * so live and fetched copies dedupe (`contract/README.md`). Re-reads the whole file per fire:
 * a few MB, simpler than a streaming reader (slice 3.6).
 */

export interface TranscriptEmitterDeps {
  /** The pane's whole transcript, oldest first, or empty when there is nothing to read. */
  entriesOf(paneId: string): TranscriptEntry[];
  /** Where the runner is working — the one field an entry does not carry. */
  cwdOf?(paneId: string): string | undefined;
  publish(event: AgentStopEvent): void;
}

export class TranscriptEmitter {
  /** How many entries each pane has already been told about. */
  private readonly sent = new Map<string, number>();

  constructor(private readonly deps: TranscriptEmitterDeps) {}

  onTurn(paneId: string, agentType: string): void {
    const entries = this.deps.entriesOf(paneId);
    const already = this.sent.get(paneId) ?? 0;
    // A file that shrank is a resumed session writing a new one. Holding a count the file can no
    // longer reach would make this pane silent forever, so the cursor drops back instead.
    const from = already > entries.length ? 0 : already;
    const cwd = this.deps.cwdOf?.(paneId) ?? "";
    for (const entry of entries.slice(from)) {
      this.deps.publish(wire(paneId, agentType, cwd, entry));
    }
    this.sent.set(paneId, entries.length);
  }

  /** Called when a cell closes: a closed cell gains no more steps. */
  forget(paneId: string): void {
    this.sent.delete(paneId);
  }

  size(): number {
    return this.sent.size;
  }
}

function wire(
  paneId: string,
  agentType: string,
  cwd: string,
  entry: TranscriptEntry,
): AgentStopEvent {
  return {
    // The kind the phone's relay already understands. These are steps, not attention: a push is
    // decided elsewhere, from the turn's status, and must not be fired once per tool call.
    kind: "agent_stop",
    pane_id: paneId,
    agent_type: agentType,
    event: entry.event,
    status: entry.status,
    title: entry.title,
    body: entry.body,
    user_prompt: entry.userPrompt,
    tool_target: entry.toolTarget,
    cwd,
    // Absent rather than 0: "changed nothing" and "no diff applies" are different claims, and a
    // `Read` step must not render "+0 -0".
    ...(entry.linesAdded === undefined ? {} : { lines_added: entry.linesAdded }),
    ...(entry.linesRemoved === undefined ? {} : { lines_removed: entry.linesRemoved }),
    timestamp: entry.timestamp,
  };
}
