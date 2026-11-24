import hljs from "highlight.js/lib/common";

// shortcut: highlighting is synchronous on the main thread, so text past this size stays plain; move it to a worker if big files need colour.
const MAX_CHARS = 200_000;

// highlight.js already knows most extensions as aliases (ts, tsx, rs, yml…); these are the gaps.
const ALIASES: Record<string, string> = { vue: "xml", svelte: "xml" };

/** The highlight.js language for a path, or null when it has none (plain text then). */
export function languageOf(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (name === "makefile") return "makefile";
  const dot = name.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = name.slice(dot + 1);
  const lang = ALIASES[ext] ?? ext;
  return hljs.getLanguage(lang) ? lang : null;
}

/**
 * One HTML string per line. The text is highlighted as a whole, so a comment or string that spans
 * lines keeps its colour, then split at each newline: the spans still open there are closed at the
 * end of the line and opened again at the start of the next. highlight.js escapes the text itself.
 * Null when the text has no language or is too large; the caller shows it plain.
 */
export function highlightLines(text: string, language: string | null): string[] | null {
  if (!language || text.length > MAX_CHARS) return null;
  let html: string;
  try {
    html = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  const tag = /<span [^>]*>|<\/span>|\n/g;
  let at = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    line += html.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[0] === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (m[0] === "</span>") {
      open.pop();
      line += m[0];
    } else {
      open.push(m[0]);
      line += m[0];
    }
  }
  lines.push(line + html.slice(at));
  return lines;
}

/**
 * HTML per diff row (null for hunk headers, or every row when plain). Each hunk is highlighted as one
 * piece in display order; old and new lines are mixed there, which a block comment changed on one
 * side can colour wrongly for the rest of that hunk.
 */
export function highlightRows(rows: readonly { kind: string; text: string }[], language: string | null): (string | null)[] | null {
  if (!language) return null;
  const out: (string | null)[] = rows.map(() => null);
  let start = 0;
  const flush = (end: number) => {
    if (end <= start) return;
    const lines = highlightLines(rows.slice(start, end).map((r) => r.text).join("\n"), language);
    if (lines) lines.forEach((html, i) => (out[start + i] = html));
  };
  rows.forEach((row, i) => {
    if (row.kind !== "hunk") return;
    flush(i);
    start = i + 1;
  });
  flush(rows.length);
  return out;
}
