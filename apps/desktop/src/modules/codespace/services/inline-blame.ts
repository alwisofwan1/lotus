import type { GitBlameEntry } from "@/lib/tauri/project-files";

/** Longer files are not blamed: `git blame` takes seconds on them (mockups/inline-blame.html). */
export const BLAME_MAX_LINES = 10_000;
/** The cursor rests this long before its line says who changed it. */
export const BLAME_DELAY_MS = 300;

const NOT_COMMITTED = "Not committed yet";

const pad = (n: number) => String(n).padStart(2, "0");
const day = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

/** "now", "5m ago", "3h ago", "2d ago", "4mo ago"; past a year, the date. */
export function blameAge(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp * 1000) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return day(new Date(timestamp * 1000));
}

const who = (entry: GitBlameEntry) => (entry.you ? "You" : entry.author);

/** The status bar's words: "You · 2h ago". */
export function blameStatus(entry: GitBlameEntry, now: number): string {
  return entry.committed ? `${who(entry)} · ${blameAge(entry.timestamp, now)}` : NOT_COMMITTED;
}

/** The ghost text at the line's end: "You · 2h ago · fix(chat): …". */
export function blameInline(entry: GitBlameEntry, now: number): string {
  return entry.committed ? `${blameStatus(entry, now)} · ${entry.summary}` : NOT_COMMITTED;
}

/** The hover card, as Markdown: full name, date and time, message, commit. Uncommitted lines have none. */
export function blameHover(entry: GitBlameEntry, now: number): string | null {
  if (!entry.committed) return null;
  const at = new Date(entry.timestamp * 1000);
  const escape = (text: string) => text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
  return [
    `**${escape(entry.author)}** · ${day(at)} ${pad(at.getHours())}:${pad(at.getMinutes())}`,
    escape(entry.summary),
    `\`${entry.commit}\` · ${blameAge(entry.timestamp, now)}`,
  ].join("\n\n");
}

/** The entry for a 1-based line, if blame covers it. */
export function blameAt(entries: readonly GitBlameEntry[], line: number): GitBlameEntry | null {
  const entry = entries[line - 1];
  return entry?.lineNumber === line ? entry : (entries.find((candidate) => candidate.lineNumber === line) ?? null);
}
