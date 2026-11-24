// The thread's prompt index: one entry per thing the user said, for the history rail beside the
// timeline (mockups/chat-history-rail.html). Pure, derived from the same rows the timeline renders,
// so it costs nothing to keep in sync and never reads the DOM (the timeline is virtualized: most
// rows are not mounted).

import { splitHandoff } from "./handoff";
import { splitPicks } from "./preview";
import { splitQuotes } from "./quotes";
import type { TimelineRow } from "./timeline";

export interface PromptEntry {
  /** Index of the user row in the timeline rows, what the virtualizer scrolls to. */
  rowIndex: number;
  prompt: string;
  /** The start of the first reply in the same turn; empty while none has arrived. */
  reply: string;
}

/** One mark on the rail. Past MAX_TICKS prompts, a mark stands for a run of them. */
export interface RailTick {
  first: PromptEntry;
  /** 1-based prompt numbers this tick covers, inclusive. */
  from: number;
  to: number;
}

/** The rail appears from this many prompts; below it there is nothing to navigate. */
export const MIN_PROMPTS = 3;
/** Marks used before the timeline has been measured. */
export const MAX_TICKS = 60;
/** Room the rail leaves above and below itself (styles: max-height calc(100% - 96px)). */
const RAIL_INSET_PX = 96;
/** The closest two marks may sit and still be told apart under a pointer. */
const TICK_PITCH_PX = 6;
const SNIPPET = 160;

export function snippet(text: string, max = SNIPPET): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[#>*_`~]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

export function buildPromptIndex(rows: readonly TimelineRow[]): PromptEntry[] {
  const entries: PromptEntry[] = [];
  const byTurn = new Map<string, PromptEntry>();
  rows.forEach((row, rowIndex) => {
    if (row.kind === "user") {
      const split = splitQuotes(splitPicks(splitHandoff(row.text).text).text);
      const entry = { rowIndex, prompt: snippet(split.text) || snippet(split.quotes[0] ?? "") || "Attachment", reply: "" };
      entries.push(entry);
      byTurn.set(row.turnId, entry);
    } else if (row.kind === "assistant") {
      const entry = byTurn.get(row.turnId);
      if (entry && !entry.reply) entry.reply = snippet(row.text);
    }
  });
  return entries;
}

export function railTicks(entries: readonly PromptEntry[], max = MAX_TICKS): RailTick[] {
  const n = entries.length;
  const count = Math.min(n, max);
  return Array.from({ length: count }, (_, i) => {
    const start = Math.floor((i * n) / count);
    const end = Math.floor(((i + 1) * n) / count) - 1;
    return { first: entries[start], from: start + 1, to: end + 1 };
  });
}

/** How many marks fit a timeline this tall; unmeasured (0) keeps the default. */
export function railFit(timelineHeight: number): number {
  if (timelineHeight <= 0) return MAX_TICKS;
  return Math.max(MIN_PROMPTS, Math.floor((timelineHeight - RAIL_INSET_PX) / TICK_PITCH_PX));
}

/** The tick whose prompts hold the row at the top of the viewport; -1 above the first prompt. */
export function activeTick(ticks: readonly RailTick[], topRowIndex: number): number {
  let active = -1;
  for (let i = 0; i < ticks.length && ticks[i].first.rowIndex <= topRowIndex; i++) active = i;
  return active;
}
