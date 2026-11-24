/**
 * Notion's page markdown, turned into the plain GFM the tracker's reader draws (PLAN S31).
 *
 * Notion's markdown API extends markdown with its own markup — `<callout>`, `<details>`,
 * `<columns>`, `<table>`, `<page url>`, `<file src>`, `<unknown …/>` and more
 * (https://developers.notion.com/guides/data-apis/working-with-markdown-content). The reader
 * (`TaskMarkdown`) never renders HTML, so none of it could ever become markup on the page; left
 * alone it would show as literal tags. This file turns each into its nearest plain markdown, and
 * any tag it does not know into its text.
 *
 * Code is left exactly as written: a fenced block or an inline `code` span may well contain `<div>`
 * on purpose.
 */

export interface CleanedNotionMarkdown {
  markdown: string;
  /** Blocks Notion could not express, each drawn as a link to itself in Notion. */
  unknownBlocks: number;
}

/** An empty block, as its own paragraph: the reader draws it as the gap Notion leaves. */
export const EMPTY_BLOCK = "\uE010";

/** Stand-ins for code while the rest is rewritten. Private-use characters never appear in pages. */
const CODE_OPEN = "";
const CODE_CLOSE = "";

export function cleanNotionMarkdown(input: string): CleanedNotionMarkdown {
  const kept: string[] = [];
  const keep = (code: string) => `${CODE_OPEN}${kept.push(code) - 1}${CODE_CLOSE}`;

  // Fenced blocks first (``` or ~~~, to the matching fence), then inline code spans.
  let text = input.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, keep);
  text = text.replace(/(`+)[^`\n][\s\S]*?\1/g, keep);

  let unknownBlocks = 0;

  text = text
    // Notion's colour and style annotations on a block or span.
    .replace(/\s*\{(?:color|underline|bg)="?[\w-]*"?\}/g, "")
    .replace(/<table_of_contents\s*\/?>/gi, "")
    // Blocks Notion could not express: a link to the block, so it is one click away.
    .replace(/<unknown\b([^>]*)\/?>(?:<\/unknown>)?/gi, (_, attrs: string) => {
      unknownBlocks += 1;
      const url = attr(attrs, "url");
      const kind = attr(attrs, "alt") ?? "block";
      return url ? `[${kind} — open in Notion](${url})` : `*(${kind} not shown)*`;
    })
    // Child pages and databases: a link with their title.
    .replace(/<(page|database)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (_, kind: string, attrs: string, title: string) => {
      const url = attr(attrs, "url");
      const label = inline(title) || kind;
      return url ? `[${label}](${url})` : label;
    })
    // Files and media: a link, captioned by what Notion wrote, else by kind.
    .replace(/<(file|video|audio|pdf|image)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi, (_, kind: string, attrs: string, caption?: string) => {
      const url = attr(attrs, "src") ?? attr(attrs, "url");
      const label = inline(caption ?? "") || kind;
      // Notion sends an empty block (`<pdf src="">`) when nothing was uploaded to it yet.
      return url ? `[${label}](${url})` : `*(empty ${kind} block)*`;
    })
    /*
      A toggle: its summary as one bold line, its body below. Notion's summaries carry their own
      bold markers around code, with spaces inside them (`QA **Checklist ****`x`**** **`), which
      markdown cannot close — so the summary's markers are dropped and the whole line is bold.
      Its children come indented by four spaces, which would nest them one level too deep.
    */
    .replace(/<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gi, (_, summary: string, body: string) =>
      // Blank lines around it, so the title is its own paragraph and not the end of the one above.
      `\n\n**${inline(summary).replace(/\*+/g, "").replace(/\s+/g, " ").trim()}**\n\n${dedent(body).trim()}\n\n`,
    )
    /*
      A callout: a quote whose first line names it — `[!callout] <icon> <colour>` — so the reader
      draws it as Notion does, a tinted box with its icon (`notion-blocks.ts`). Each of its lines is a
      block of its own, like every line of Notion's markdown, so they are kept apart.
    */
    .replace(/<callout\b([^>]*)>([\s\S]*?)<\/callout>/gi, (_, attrs: string, body: string) => {
      const head = ["[!callout]", attr(attrs, "icon") ?? "", attr(attrs, "color") ?? ""].filter(Boolean).join(" ");
      const lines = dedent(body).trim().split("\n").filter((line) => line.trim());
      return `\n\n${quote([head, ...lines].join("\n\n"))}\n\n`;
    })
    // An empty block: the space Notion leaves for it (drawn by `notion-blocks.ts`).
    .replace(/<empty-block\s*\/?>(?:<\/empty-block>)?/gi, `\n\n${EMPTY_BLOCK}\n\n`)
    .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, body: string) => `${tableToGfm(body)}\n`);

  // `<br>` inside a block is a line break INSIDE it, not a new block (see `breakLines`).
  text = breakLines(text);
  text = tidyEmphasis(text);
  // A to-do with nothing written in it yet is still a to-do: markdown only draws a checkbox when
  // the item has text, so it is given an invisible one.
  text = text.replace(/^(\s*[-*+] \[[ xX]\])[ \t]*$/gm, "$1 \u00A0");

  // Anything left that looks like a tag — columns, synced blocks, mentions, meeting notes, a newer
  // tag Notion adds — keeps its text and loses its markup.
  text = text.replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>/g, "");
  text = separateBlocks(text);
  // Trimmed of whitespace only — `trim()` would also take the no-break space an empty to-do ends in.
  text = text.replace(/\n{3,}/g, "\n\n").replace(/^[ \t\n]+|[ \t\n]+$/g, "");

  const restored = text.replace(new RegExp(`${CODE_OPEN}(\\d+)${CODE_CLOSE}`, "g"), (_, i: string) => kept[Number(i)]);
  return { markdown: restored, unknownBlocks };
}

/**
 * Every line of Notion's markdown is a block of its own, one newline apart; plain markdown reads one
 * newline as the same paragraph, and a line after a list item as part of that item. So a blank line
 * goes between two lines — except where markdown itself joins them: a line break (`\` or two spaces)
 * inside one block, list items and what is indented under them, table rows, and a quote's lines.
 */
function separateBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  const isItem = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line);
  const isRow = (line: string) => /^\s*\|/.test(line);
  const isQuote = (line: string) => /^\s*>/.test(line);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.trim() && line.trim()) {
      const joined =
        /(\\|\s{2})$/.test(prev) ||
        (isItem(prev) && (isItem(line) || /^\s/.test(line))) ||
        (/^\s/.test(prev) && /^\s/.test(line)) ||
        (isRow(prev) && isRow(line)) ||
        (isQuote(prev) && isQuote(line));
      if (!joined) out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
  return match ? match[1] : null;
}

/** Text meant for one line: tags gone, whitespace folded. */
function inline(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function quote(body: string): string {
  return body
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
}

/** `<tr><td>…</td></tr>` rows as a GFM table, the first row as its header. */
function tableToGfm(body: string): string {
  const rows = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
    [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => inline(cell[1]).replace(/\|/g, "\\|")),
  );
  if (rows.length === 0) return inline(body);
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

/** Removes the indentation every non-blank line shares. */
function dedent(body: string): string {
  const lines = body.split("\n");
  const indents = lines.filter((line) => line.trim()).map((line) => /^[ \t]*/.exec(line)![0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(Math.min(common, /^[ \t]*/.exec(line)![0].length))).join("\n");
}

/*
  `<br>` is a line break within one block. As a plain newline it would end a list item — and a
  following "- email:" would become a bullet of its own. So each break becomes a markdown hard
  break (`\` at the end of the line), the next line is indented to stay inside the same item, and
  a marker that would start a new block there is escaped.
*/
function breakLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!/<br\s*\/?>/i.test(line)) return line;
      const prefix = /^(\s*(?:[-*+] (?:\[[ xX]\] )?|\d+[.)] |> )?)/.exec(line)![0];
      const indent = " ".repeat(prefix.length);
      const [first, ...rest] = line.split(/<br\s*\/?>/i);
      return [first.trimEnd(), ...rest.map((part) => indent + escapeBlockStart(part.trim()))]
        .map((part, i, all) => (i < all.length - 1 ? `${part}\\` : part))
        .join("\n");
    })
    .join("\n");
}

function escapeBlockStart(text: string): string {
  return text.replace(/^([-*+>#]|\d+[.)])(?=\s)/, "\\$1");
}

/*
  Notion writes bold whose markers touch spaces — `**Account: **`, `** Note**` — and back-to-back
  bold (`****`) where two bold runs meet. Markdown reads none of those as bold and prints the
  stars. Empty runs are dropped, and the spaces are moved outside the markers.
*/
function tidyEmphasis(text: string): string {
  // Line by line: a bold run may span `<br>` lines (it is still one paragraph), but a fix applied
  // across lines would pair the stars of two different runs.
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/\*{4,}/g, "")
        .replace(/\*\*[ \t]*\*\*/g, "")
        .replace(/\*\*([ \t]+)([^*\n]*?\S)\*\*/g, "$1**$2**")
        .replace(/\*\*(\S[^*\n]*?)([ \t]+)\*\*/g, "**$1**$2")
        // The close of a run that began on an earlier line, with a space before it.
        .replace(/(\S)[ \t]+\*\*(\\?)$/, "$1**$2"),
    )
    .join("\n");
}
