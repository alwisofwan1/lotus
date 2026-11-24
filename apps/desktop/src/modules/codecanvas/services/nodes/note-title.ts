/**
 * Derived identity for a Note node.
 *
 * A note is named after its own first line (the serif title in the body, ADR-0046), never "Note 4"
 * unless it is still empty. Deriving it here (rather than inline in NoteNode) is what keeps the
 * zoomed-out glyph, the header tooltip and the body title naming the same thing.
 *
 * Every function reads the FIRST LINE ONLY where it can: a note can hold a very large markdown
 * document and these run on render, so nothing here may allocate a full split() of the content.
 */

/** Hard cap on the derived title. A header is a label, never a paragraph. */
const TITLE_MAX = 120;

/** Leading block markers: heading hashes, list bullets, task boxes, block quotes. */
const LEADING_MARKERS = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?)/;
/** Inline emphasis / code marks that would otherwise show up as punctuation in the header. */
const INLINE_MARKS = /[*_`~]/g;
/** A token counts as a word when it carries at least one letter or digit (so `#` and `-` don't). */
const WORD = /[\p{L}\p{N}]/u;

/** First line of `content`, without allocating an array for the whole document. */
function firstMeaningfulLine(content: string): string {
  let from = 0;
  while (from <= content.length) {
    const newline = content.indexOf("\n", from);
    const end = newline === -1 ? content.length : newline;
    const line = content.slice(from, end).trim();
    if (line) return line;
    if (newline === -1) return "";
    from = newline + 1;
  }
  return "";
}

/**
 * The note's display title: its first line with Markdown syntax stripped, or `Note N` when the
 * note has no usable text yet.
 */
export function deriveNoteTitle(content: string, noteNumber?: number): string {
  const cleaned = firstMeaningfulLine(content)
    .replace(LEADING_MARKERS, "")
    .replace(INLINE_MARKS, "")
    .trim();
  // A line made only of markers ("###", "---", ">>>") derives no title — require real text.
  if (!WORD.test(cleaned)) return noteNumber ? `Note ${noteNumber}` : "Note";
  return cleaned.slice(0, TITLE_MAX);
}

/** Task list items, counted in a single pass over the content. */
const TASK_ITEM = /^[ \t]*[-*+][ \t]+\[([ xX])\]/gm;

/** Checklist progress, counted in a single pass over the content. `total` is 0 when there are none. */
export function noteTaskProgress(content: string): { done: number; total: number } {
  let total = 0;
  let done = 0;
  TASK_ITEM.lastIndex = 0;
  for (const match of content.matchAll(TASK_ITEM)) {
    total += 1;
    if (match[1] !== " ") done += 1;
  }
  return { done, total };
}

const TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const DAY_YEAR = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function startOfDay(ms: number): number {
  const day = new Date(ms);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * The footer's "Edited …" line. Absolute on purpose ("today at 9:12 PM", not "2m ago"): a relative
 * time goes stale unless every note on the canvas runs a timer, and this one only changes at midnight.
 */
export function formatNoteEditedAt(editedAt: number, now: number = Date.now(), editedBy?: string): string {
  // An agent's write names the agent (ADR-0047): "Edited by Ivo · today at 15:42".
  const lead = editedBy?.trim() ? `Edited by ${editedBy.trim()} ·` : "Edited";
  const today = startOfDay(now);
  const day = startOfDay(editedAt);
  if (day === today) return `${lead} today at ${TIME.format(editedAt)}`;
  if (day === startOfDay(today - 1)) return `${lead} yesterday at ${TIME.format(editedAt)}`;
  const sameYear = new Date(editedAt).getFullYear() === new Date(now).getFullYear();
  return `${lead} ${(sameYear ? DAY : DAY_YEAR).format(editedAt)}`;
}
