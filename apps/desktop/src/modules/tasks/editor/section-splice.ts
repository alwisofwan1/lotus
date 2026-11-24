import type { Editor, JSONContent } from "@tiptap/core";
import { DOMParser as PmDOMParser } from "@tiptap/pm/model";
import { markdownToHtml, nodesToMarkdown, ticketMarkdownIt } from "@/modules/tasks/editor/ticket-markdown";
import { inertSanitizedElement } from "@/lib/safe-html";

/**
 * Writing a section back WITHOUT rewriting the parts nobody touched.
 *
 * A WYSIWYG editor serializes a whole document in its own style: tables lose their column
 * padding, `~` becomes `\~`, task items gain blank lines, `<` becomes `&lt;`. Measured on the real
 * vault, serializing every section of every ticket reproduced only 341 of 644 exactly. The vault's
 * rule is "never overwrite the human's prose — edit surgically", so a one-word edit may not
 * reformat the section around it.
 *
 * So a section is cut into its top-level markdown BLOCKS (a paragraph, a list, a table, a fence),
 * each remembered as its source text AND as the editor nodes it parses into. On save, every
 * top-level node that still equals an original block is written back as that block's ORIGINAL
 * text, byte for byte; only nodes that changed are serialized. An edit to one paragraph changes
 * that paragraph and nothing else in the file.
 */

export interface SourceBlock {
  /** The block's lines exactly as they were in the file. */
  src: string;
  /** The top-level editor nodes this block parses into, as JSON — the identity it is matched by. */
  nodes: string[];
  /** What separated this block from the next one in the file (usually one blank line). */
  gapAfter: string;
  /**
   * An HTML comment — the template's `<!-- Gather before planning … -->` guidance. The editor has
   * no node for it and silently DROPS it, so it is never matched against the document: it is
   * carried along and written back in place, always. Losing it on a save would delete the
   * human's writing, which is the one thing this module exists to prevent.
   */
  hidden: boolean;
}

export interface SectionSnapshot {
  original: string;
  blocks: SourceBlock[];
  /**
   * False when the blocks, parsed one by one, do not add up to the section parsed whole (a
   * reference-style link defined in another block, say). The splice cannot then be trusted, and
   * the section falls back to being serialized whole — correct, just less surgical.
   */
  spliceable: boolean;
  /** The section parsed whole — what "nothing changed" is compared against when not spliceable. */
  whole: string[];
}

// The very instance the editor reads with, so blocks are cut the way the editor parses them.
const md = ticketMarkdownIt;

/** Top-level block line ranges, `[start, end)`, from markdown-it's own token map. */
function blockRanges(markdown: string): Array<{ range: [number, number]; comment: boolean }> {
  const ranges: Array<{ range: [number, number]; comment: boolean }> = [];
  for (const token of md.parse(markdown, {})) {
    if (token.level === 0 && token.map && token.nesting !== -1) {
      const comment = token.type === "html_block" && token.content.trim().startsWith("<!--");
      ranges.push({ range: [token.map[0], token.map[1]], comment });
    }
  }
  return ranges;
}

type Parse = (markdown: string) => JSONContent[];

/**
 * An editor document is never empty — ProseMirror keeps one empty paragraph. A section that is
 * only a comment (or nothing) must compare equal to that, or it would count as "changed".
 */
const EMPTY_PARAGRAPH = JSON.stringify({ type: "paragraph" });
function contentNodes(list: string[]): string[] {
  return list.length === 1 && list[0] === EMPTY_PARAGRAPH ? [] : list;
}
type Serialize = (nodes: JSONContent[]) => string;

export function snapshotSection(original: string, parse: Parse): SectionSnapshot {
  const lines = original.split("\n");
  const ranges = blockRanges(original);
  const blocks: SourceBlock[] = ranges.map(({ range: [start, end], comment }, index) => {
    // A range may swallow trailing blank lines (a loose list does); those belong to the gap.
    let last = end;
    while (last > start + 1 && lines[last - 1].trim() === "") last -= 1;
    const src = lines.slice(start, last).join("\n");
    const nextStart = ranges[index + 1]?.range[0] ?? last;
    // The newline ending the block, then the in-between lines EXACTLY — a line of four spaces is
    // not an empty line, and rewriting it as one is a change nobody made.
    const gapAfter = "\n" + lines.slice(last, Math.max(last, nextStart)).map((line) => `${line}\n`).join("");
    const nodes = comment ? [] : parse(src).map((node) => JSON.stringify(node));
    return { src, nodes, gapAfter, hidden: comment };
  });

  const whole = contentNodes(parse(original).map((node) => JSON.stringify(node)));
  const pieces = blocks.flatMap((block) => block.nodes);
  const spliceable = whole.length === pieces.length && whole.every((node, i) => node === pieces[i]);
  return { original, blocks, spliceable, whole };
}

/**
 * The section's new markdown: original text for every block still intact, serialized text for
 * whatever changed. Returns the ORIGINAL string itself when nothing changed at all, so a caller
 * can compare by identity and skip the write.
 */
export function spliceSection(snapshot: SectionSnapshot, doc: JSONContent[], serialize: Serialize): string {
  const current = contentNodes(doc.map((node) => JSON.stringify(node)));
  if (!snapshot.spliceable) {
    // Untouched is still untouched: only an actual change may reach the serializer.
    if (sameList(snapshot.whole, current)) return snapshot.original;
    // Serialized whole, but a comment is still never dropped: they lead, as the template puts them.
    const comments = snapshot.blocks.filter((block) => block.hidden).map((block) => block.src);
    return [...comments, serialize(doc).replace(/\n+$/, "")].join("\n");
  }

  const out: string[] = [];
  let lastVerbatim: SourceBlock | null = null;
  let at = 0;
  let blockIndex = 0;

  const emit = (text: string, verbatimBlock: SourceBlock | null) => {
    if (out.length > 0) out.push(lastVerbatim && verbatimBlock && lastVerbatim === previousOf(verbatimBlock) ? lastVerbatim.gapAfter : "\n\n");
    out.push(text);
    lastVerbatim = verbatimBlock;
  };
  const previousOf = (block: SourceBlock) => snapshot.blocks[snapshot.blocks.indexOf(block) - 1];

  while (at < current.length) {
    // The next original block still standing here, allowing for blocks deleted before it.
    const match = findBlockAt(snapshot.blocks, blockIndex, current, at);
    if (match) {
      // Comments that sat before this block in the file are written back before it, in order.
      for (let k = blockIndex; k < match.index; k++) {
        if (snapshot.blocks[k].hidden) emit(snapshot.blocks[k].src, snapshot.blocks[k]);
      }
      emit(match.block.src, match.block);
      at += match.block.nodes.length;
      blockIndex = match.index + 1;
      continue;
    }
    emit(serialize([doc[at]]).replace(/\n+$/, ""), null);
    at += 1;
  }
  // Comments after the last surviving block — and every comment, if all the prose was deleted.
  for (let k = blockIndex; k < snapshot.blocks.length; k++) {
    if (snapshot.blocks[k].hidden) emit(snapshot.blocks[k].src, snapshot.blocks[k]);
  }

  const result = out.join("");
  return result === snapshot.original ? snapshot.original : result;
}

function findBlockAt(blocks: SourceBlock[], from: number, current: string[], at: number) {
  for (let index = from; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block.hidden && block.nodes.length > 0 && block.nodes.every((node, k) => current[at + k] === node)) return { block, index };
  }
  return null;
}

function sameList(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Parse and serialize with a live editor's own schema — the same code path the page uses. */
export function editorCodec(editor: Editor): { parse: Parse; serialize: Serialize } {
  const domParser = PmDOMParser.fromSchema(editor.schema);
  return {
    parse: (markdown) => {
      // markdown → HTML (`ticket-markdown.ts`) → the schema's DOM parser: exactly the path
      // `setContent(html)` takes, so a block is matched against what the editor really holds.
      // Parsed in an inert document: HTML set on a live element loads (and runs) at once.
      const element = inertSanitizedElement(markdownToHtml(markdown));
      return (domParser.parse(element).toJSON().content ?? []) as JSONContent[];
    },
    serialize: (nodes) =>
      nodesToMarkdown(editor.schema.nodeFromJSON({ type: "doc", content: nodes })).replace(/\n+$/, ""),
  };
}
