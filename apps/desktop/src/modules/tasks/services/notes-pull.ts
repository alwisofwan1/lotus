import { cleanNotionMarkdown, EMPTY_BLOCK } from "@/modules/tasks/services/notion-markdown";

/**
 * Pulling a Notion page into its vault note's `## From Notion` section (PLAN S38, the old plan's
 * N9–N13).
 *
 * Like `notesByKey`, this is registry code: the vault only knows it has an owned section and a
 * `notion_pulled:` line to write (`vault_ticket_edit.rs`), and the Notion source only knows how to
 * read a page. What a page becomes inside a note is decided here, between the two.
 */

/** The section a pull owns. Lotus writes it whole; the person's own words live in the others. */
export const PULLED_SECTION = "From Notion";

/**
 * A Notion page as the body of the note's `From Notion` section.
 *
 * Made plain the way the tracker draws it, then made safe for a vault section: a `#` or `##`
 * heading from the page would be read back as a new section of the NOTE — so every heading above
 * `###` is lowered to `###`. The vault cuts sections at EVERY `## ` line, code fences included, so
 * the one change made inside code is a space in front of a line that starts with `## `.
 */
export function pulledSectionBody(notionMarkdown: string): string {
  const plain = cleanNotionMarkdown(notionMarkdown).markdown;
  let fence: string | null = null;
  const lines = plain.split("\n").map((line) => {
    const opener = /^(```|~~~)/.exec(line);
    if (opener) {
      if (fence === null) fence = opener[1];
      else if (line.startsWith(fence)) fence = null;
      return line;
    }
    if (fence !== null) return line.startsWith("## ") ? ` ${line}` : line;
    if (line.trim() === EMPTY_BLOCK) return "";
    // A Notion callout, drawn by the tracker as `[!callout] <icon> <colour>`, is an Obsidian callout.
    const callout = /^(\s*>\s*)\[!callout\]\s*(\S*).*$/.exec(line);
    if (callout) return `${callout[1]}[!note]${callout[2] ? ` ${callout[2]}` : ""}`;
    return line.replace(/^#{1,2}(?=\s)/, "###");
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export type DiffLine = { kind: "same" | "removed" | "added"; text: string };

/** The lines of `before` and `after`, each kept, dropped or added — the longest common run kept. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  // Longest common subsequence, from the end, so the walk below reads front to back.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: "removed", text: a[i++] });
    } else {
      out.push({ kind: "added", text: b[j++] });
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++] });
  while (j < b.length) out.push({ kind: "added", text: b[j++] });
  return out;
}

/** "1 line changed, 1 added" — a removed line followed by an added one counts as one change. */
export function diffSummary(diff: readonly DiffLine[]): string {
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (let k = 0; k < diff.length; k++) {
    const line = diff[k];
    if (line.kind === "removed" && diff[k + 1]?.kind === "added") {
      changed++;
      k++;
    } else if (line.kind === "added") added++;
    else if (line.kind === "removed") removed++;
  }
  const parts = [
    changed && `${changed} line${changed === 1 ? "" : "s"} changed`,
    added && `${added} added`,
    removed && `${removed} removed`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "No changes";
}

/** The page id at the end of a Notion URL (its last 32 hex digits), dashed like the API's. */
export function notionPageIdOf(url: string | null | undefined): string | null {
  if (!url) return null;
  // The last path segment, dashes gone: `Title-Words-3e42…e1e2` or a dashed uuid both end in the id.
  const segment = url.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "";
  const hex = /([0-9a-f]{32})$/i.exec(segment.replace(/-/g, ""))?.[1]?.toLowerCase();
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Page ids compared as Notion means them: case and dashes do not matter. */
export function samePageId(a: string, b: string): boolean {
  return a.replace(/-/g, "").toLowerCase() === b.replace(/-/g, "").toLowerCase();
}

/**
 * Whether Notion holds a newer version than the one in the note. Never pulled counts as newer.
 * Both sides are Notion's own `last_edited_time`, so no clock but Notion's is compared.
 */
export function notionIsNewer(lastEditedTime: string, pulled: string | null | undefined): boolean {
  if (!pulled) return true;
  const edited = Date.parse(lastEditedTime);
  const was = Date.parse(pulled);
  if (Number.isNaN(edited) || Number.isNaN(was)) return false;
  return edited > was;
}

/** A Notion time as the page says it: `28 Sep, 13:12`, in the person's own time zone. */
export function pullTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const day = at.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day}, ${time}`;
}
