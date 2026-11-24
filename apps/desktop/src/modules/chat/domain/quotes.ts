import type { DiffRow } from "./changes";

/** A passage the user quoted from the chat; it rides along with the next message as `> ` lines. */
export interface Quote {
  id: string;
  text: string;
  /** When it was quoted, for the card's "From the reply · 22:11". */
  at: number;
  /** Set for a Review note: lines of the Changes diff with the user's note; `text` is `reviewNoteText` of it. */
  review?: ReviewNote;
}

/** Lines of a thread's Changes diff with the user's note on them (GLOSSARY: Review note). */
export interface ReviewNote {
  path: string;
  from: number;
  to: number;
  /** Every line is a removed one, so `from`/`to` are old line numbers. */
  removed: boolean;
  /** The lines as a unified diff: a sign, then the code. */
  code: string;
  note: string;
}

/** A Review note on `rows` (hunk headers ignored): new lines cited when there are any, else the removed ones. */
export function reviewNote(path: string, rows: readonly DiffRow[], note: string): ReviewNote {
  const lines = rows.filter((r) => r.kind !== "hunk" && r.line != null);
  const fresh = lines.filter((r) => r.kind !== "del");
  const cited = (fresh.length ? fresh : lines).map((r) => r.line!);
  const code = lines.map((r) => (r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ") + r.text).join("\n");
  return { path, from: Math.min(...cited), to: Math.max(...cited), removed: fresh.length === 0, code, note };
}

export function reviewNoteRef(n: Pick<ReviewNote, "path" | "from" | "to" | "removed">): string {
  return `${n.path}:L${n.from}${n.to > n.from ? `-${n.to}` : ""}${n.removed ? " (removed)" : ""}`;
}

/** What the agent reads: the reference, the lines as a diff, then the note. */
export function reviewNoteText(n: ReviewNote): string {
  const fence = n.code.includes("```") ? "````" : "```";
  return `\`${reviewNoteRef(n)}\`\n${fence}diff\n${n.code}\n${fence}\n${n.note.trim()}`;
}

const block = (text: string) => text.trim().replace(/^/gm, "> ");

/** The message as sent: each quote a markdown blockquote, then what the person typed. */
export function withQuotes(text: string, quotes: readonly Pick<Quote, "text">[]): string {
  const blocks = quotes.map((q) => q.text.trim()).filter(Boolean).map(block);
  if (blocks.length === 0) return text;
  return `${blocks.join("\n\n")}\n\n${text}`.trim();
}

/** A sent message split back into its leading quotes and what the person wrote. */
export function splitQuotes(text: string): { quotes: string[]; text: string } {
  const lines = text.split("\n");
  const quotes: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i].startsWith(">")) {
    const body: string[] = [];
    while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^> ?/, ""));
    quotes.push(body.join("\n").trim());
    while (i < lines.length && lines[i].trim() === "") i++;
  }
  if (quotes.length === 0) return { quotes, text };
  return { quotes: quotes.filter(Boolean), text: lines.slice(i).join("\n").trim() };
}

// Quotes and Review notes wait per thread in storage, like the composer draft, so a reload keeps a review in progress.
const STORED = "lotus.chat.quotes.";

export function readQuotes(threadId: string): Quote[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORED + threadId) ?? "[]");
    return Array.isArray(saved) ? (saved as Quote[]) : [];
  } catch {
    return [];
  }
}

/** Fired with the thread id when a thread's stored quotes change, so other surfaces re-read them. */
export const QUOTES_CHANGED = "lotus:quotes";

/** None left removes the entry. An unchanged list writes nothing and fires nothing. */
export function writeQuotes(threadId: string, quotes: readonly Quote[]): void {
  try {
    const next = quotes.length === 0 ? null : JSON.stringify(quotes);
    if (localStorage.getItem(STORED + threadId) === next) return;
    if (next === null) localStorage.removeItem(STORED + threadId);
    else localStorage.setItem(STORED + threadId, next);
    window.dispatchEvent(new CustomEvent(QUOTES_CHANGED, { detail: threadId }));
  } catch {
    // Storage full or off: the quotes live only in memory, as before.
  }
}

/** Drops the quotes of threads that are gone; `threadIds` must be the whole list. */
export function pruneQuotes(threadIds: readonly string[]): void {
  try {
    const keep = new Set(threadIds.map((id) => STORED + id));
    const gone: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(STORED) && !keep.has(key)) gone.push(key);
    }
    gone.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Storage off: nothing was kept.
  }
}
