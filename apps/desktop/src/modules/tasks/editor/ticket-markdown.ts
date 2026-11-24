import MarkdownIt from "markdown-it";
import {
  defaultMarkdownSerializer,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import type { Node as TiptapNode } from "@tiptap/pm/model";
import { inertSanitizedElement } from "@/lib/safe-html";

/**
 * The node type as prosemirror-markdown sees it. The package carries its own copy of
 * prosemirror-model, so TypeScript sees two `Node` classes; the serializer only reads a node's
 * type name, attrs and children, which both copies share. The one conversion is at the boundary.
 */
type PmNode = Parameters<MarkdownSerializer["serialize"]>[0];

/**
 * Markdown in and out of the ticket editor — owned here rather than borrowed from a plugin.
 *
 * `bb` uses `tiptap-markdown`, which only runs on TipTap 2. This app is on TipTap 3 (the canvas
 * note editor), and two majors side by side broke the production build: `@tiptap/react@3`
 * imported `MarkView` from a `@tiptap/core@2`. So the two halves are built from pieces with no
 * TipTap major of their own:
 *
 * - READ: markdown-it → HTML → the schema's DOM parser (what `setContent(html)` does). GFM task
 *   items, which markdown-it does not know, are rewritten into TipTap's task markup first.
 * - WRITE: prosemirror-markdown's serializer (shipped inside `@tiptap/pm`), with specs for the
 *   nodes the vault needs: GFM tables, task lists, `[[wiki links]]`, and line breaks written back
 *   as the plain newline they were.
 *
 * Whatever this writes is only ever used for blocks somebody CHANGED — `section-splice.ts` keeps
 * every untouched block as the file's own text.
 */

// `breaks: true`: a single newline is a line break, as Obsidian shows it and as the vault's
// hand-wrapped tickets are written. `html: true` only so the wiki-link span below parses.
export const ticketMarkdownIt = new MarkdownIt({ html: true, linkify: false, breaks: true });

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** `[[x]]` → a span the WikiLink node parses. Code spans and fences are left alone. */
export function wikiToHtml(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((piece, index) =>
      index % 2 === 1
        ? piece
        : piece.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (_, target: string, alias?: string) => {
            const t = target.trim();
            const a = alias?.trim();
            return `<span data-wiki="${escapeAttr(t)}"${a ? ` data-alias="${escapeAttr(a)}"` : ""}>${escapeAttr(a ?? t)}</span>`;
          }),
    )
    .join("");
}

/** GFM `- [ ]` items as TipTap's task markup: `ul[data-type=taskList] > li[data-type=taskItem]`. */
function markTaskLists(root: HTMLElement) {
  for (const item of Array.from(root.querySelectorAll("li"))) {
    // The marker sits in the item's first text — directly (tight list) or in its first <p> (loose).
    const host = item.firstElementChild?.tagName === "P" ? item.firstElementChild : item;
    const first = host.firstChild;
    if (!first || first.nodeType !== 3) continue;
    const match = /^\[( |x|X)\][ \t]?/.exec(first.textContent ?? "");
    if (!match) continue;
    first.textContent = (first.textContent ?? "").slice(match[0].length);
    item.setAttribute("data-type", "taskItem");
    item.setAttribute("data-checked", match[1] === " " ? "false" : "true");
    item.parentElement?.setAttribute("data-type", "taskList");
  }
}

/** Markdown as the HTML the editor's schema parses. */
export function markdownToHtml(markdown: string): string {
  // `html: true` lets raw HTML in the note through, so it is parsed inert and cleaned (`safe-html.ts`).
  const element = inertSanitizedElement(ticketMarkdownIt.render(wikiToHtml(markdown)));
  markTaskLists(element);
  return element.innerHTML;
}

// ── write ─────────────────────────────────────────────────────────────────

const base = defaultMarkdownSerializer.nodes;

function renderOrderedList(state: MarkdownSerializerState, node: PmNode) {
  const start = (node.attrs.start as number) ?? 1;
  const maxWidth = String(start + node.childCount - 1).length;
  const space = " ".repeat(maxWidth + 2);
  state.renderList(node, space, (i: number) => {
    const n = String(start + i);
    return " ".repeat(maxWidth - n.length) + n + ". ";
  });
}

function renderTable(state: MarkdownSerializerState, node: PmNode) {
  const rows: string[][] = [];
  node.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      // A cell is one line in GFM: its paragraphs are joined, and a pipe would end the cell.
      const text: string[] = [];
      cell.forEach((block) => text.push(inlineMarkdown(state, block)));
      cells.push(text.join("<br>").replace(/\|/g, "\\|").trim());
    });
    rows.push(cells);
  });
  if (rows.length === 0) return;
  const width = Math.max(...rows.map((cells) => cells.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  state.write(line(rows[0]));
  state.ensureNewLine();
  state.write(`| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
  for (const cells of rows.slice(1)) {
    state.ensureNewLine();
    state.write(line(cells));
  }
  state.closeBlock(node);
}

/** One cell block's content as markdown, by the same serializer, flagged as inside a table. */
function inlineMarkdown(_state: MarkdownSerializerState, block: PmNode): string {
  const doc = block.type.schema.topNodeType.create(null, [block]);
  return ticketMarkdownSerializer.serialize(doc, { tightLists: true, inTable: true } as never).trim();
}

export const ticketMarkdownSerializer = new MarkdownSerializer(
  {
    paragraph: base.paragraph,
    text: base.text,
    blockquote: base.blockquote,
    heading: base.heading,
    horizontalRule: base.horizontal_rule,
    image: base.image,
    bulletList: (state: MarkdownSerializerState, node: PmNode) => state.renderList(node, "  ", () => "- "),
    orderedList: renderOrderedList,
    listItem: base.list_item,
    taskList: (state: MarkdownSerializerState, node: PmNode) => state.renderList(node, "  ", () => "- "),
    taskItem: (state: MarkdownSerializerState, node: PmNode) => {
      state.write(node.attrs.checked ? "[x] " : "[ ] ");
      state.renderContent(node);
    },
    codeBlock: (state: MarkdownSerializerState, node: PmNode) => {
      const fence = node.textContent.includes("```") ? "````" : "```";
      state.write(`${fence}${(node.attrs.language as string | null) ?? ""}\n`);
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    // The newline it was — `write` re-applies a list's indentation on the next line.
    hardBreak: (state: MarkdownSerializerState) => state.write((state.options as { inTable?: boolean }).inTable ? "<br>" : "\n"),
    wikiLink: (state: MarkdownSerializerState, node: PmNode) => {
      const { target, alias } = node.attrs as { target: string; alias: string | null };
      state.write(alias && alias !== target ? `[[${target}|${alias}]]` : `[[${target}]]`);
    },
    table: renderTable,
    tableRow: () => {},
    tableCell: () => {},
    tableHeader: () => {},
  },
  {
    bold: defaultMarkdownSerializer.marks.strong,
    italic: defaultMarkdownSerializer.marks.em,
    code: defaultMarkdownSerializer.marks.code,
    link: defaultMarkdownSerializer.marks.link,
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    // Markdown has no underline; the mark is disabled in the editor, this only guards a paste.
    underline: { open: "", close: "" },
  },
);

/** A TipTap document as markdown. Lists are tight or loose as each list node says. */
export function nodesToMarkdown(doc: TiptapNode): string {
  return ticketMarkdownSerializer.serialize(doc as unknown as PmNode, { tightLists: false });
}

