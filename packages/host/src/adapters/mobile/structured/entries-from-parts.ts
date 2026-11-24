import type { Part } from "../../../types/conversation.js";
import type { TranscriptEntry } from "../../../types/transcript.js";

/**
 * Native parts → the hook vocabulary a phone in the field already renders.
 *
 * A structured session has no hooks and no ring, so nothing would ever reach
 * `/m/cell/:paneId/transcript` or a `{type: "notification"}` frame for it — and today's
 * Pocket draws Chat from exactly those. This is the bridge back: one entry per meaningful
 * transition, stamped with the **part's own `ts`**, so the entry a phone receives live and
 * the one it reads back over REST are the same entry under `LiveTranscript`'s composite key
 * (`timestamp|event|title|toolTarget|body.length`) and never drawn twice.
 *
 * Phase matters for prose: Codex says things *during* a turn (`commentary`) and *to end* it
 * (`final_answer`). The phone's converter treats `stop` as the end of a turn, so only the
 * closing text may be `stop`; the rest is `agent-response`, which draws as prose and ends
 * nothing. The caller says which is which — the part cannot tell on its own.
 */
export function entryFromPart(part: Part, opts: { closesTurn?: boolean } = {}): TranscriptEntry | undefined {
  const at = part.ts;
  switch (part.type) {
    case "user_message":
      return part.text === "" ? undefined : entry("prompt-submit", "running", "You", part.text, at, { userPrompt: part.text });
    case "assistant_text":
      if (part.state !== "done" || part.text === "") return undefined;
      return entry(opts.closesTurn ? "stop" : "agent-response", "idle", "Finished working", part.text, at, { truncated: part.truncated });
    case "tool_call": {
      if (part.status === "pending" || part.status === "in_progress") {
        return entry("tool-pre", "running", part.toolName, "", at, { target: part.title });
      }
      const event = part.status === "completed" ? "tool-post" : "tool-post-failed";
      const stat = diffTotals(part.diff?.files ?? []);
      return entry(event, "running", part.toolName, "", at, { target: part.title, ...stat });
    }
    case "permission":
      if (part.outcome !== undefined) return undefined;
      return entry("notification", "needs-input", "Needs input", part.title, at);
    case "error":
      return entry("error", "error", "Error", part.message, at);
    default:
      return undefined;
  }
}

/** Whole page → entries, oldest first. Only the last `assistant_text` of a closed turn is `stop`. */
export function entriesFromTurns(turns: Array<{ parts: Part[]; endedAt?: number }>): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const turn of turns) {
    const lastText = turn.endedAt === undefined ? -1 : turn.parts.map((p) => p.type).lastIndexOf("assistant_text");
    turn.parts.forEach((part, i) => {
      // A call that later completed is two entries — its start and its end — as the hook
      // pipeline would have recorded it.
      if (part.type === "tool_call" && part.status !== "pending" && part.status !== "in_progress") {
        const started = entryFromPart({ ...part, status: "in_progress" });
        if (started !== undefined) out.push(started);
      }
      const e = entryFromPart(part, { closesTurn: i === lastText });
      if (e !== undefined) out.push(e);
    });
  }
  return out;
}

function entry(
  event: string, status: string, title: string, body: string, at: number,
  extra: { userPrompt?: string; target?: string; truncated?: boolean; linesAdded?: number; linesRemoved?: number } = {},
): TranscriptEntry {
  const e: TranscriptEntry = {
    event, status, title, body, userPrompt: extra.userPrompt ?? "", toolTarget: extra.target ?? "", timestamp: at,
  };
  if (extra.truncated) e.bodyTruncated = true;
  if (extra.linesAdded !== undefined) e.linesAdded = extra.linesAdded;
  if (extra.linesRemoved !== undefined) e.linesRemoved = extra.linesRemoved;
  return e;
}

/** Absent, not zero, when no file carried a count. */
function diffTotals(files: Array<{ additions?: number; deletions?: number }>): { linesAdded?: number; linesRemoved?: number } {
  const counted = files.filter((f) => f.additions !== undefined || f.deletions !== undefined);
  if (counted.length === 0) return {};
  return {
    linesAdded: counted.reduce((n, f) => n + (f.additions ?? 0), 0),
    linesRemoved: counted.reduce((n, f) => n + (f.deletions ?? 0), 0),
  };
}
