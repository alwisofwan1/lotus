/**
 * Obsidian `[[links]]`, which vault tickets use to point at each other.
 *
 * Markdown does not know them, so they arrived on the page as literal brackets. They are rewritten
 * into ordinary links under a private scheme before rendering; the renderer draws that scheme as
 * a reference chip, and opens it inside the tracker when the target is a ticket it holds.
 *
 * Code is left untouched — a `[[x]]` inside backticks is something someone meant literally.
 */
export const WIKI_HREF_PREFIX = "lotus-wiki:";

const WIKI = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;

export function linkWikiReferences(markdown: string): string {
  // Split on fenced blocks and inline code spans; only the prose between them is rewritten.
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((piece, index) =>
      index % 2 === 1
        ? piece
        : piece.replace(WIKI, (_, target: string, alias?: string) => {
            const ref = target.trim();
            const label = (alias ?? target).trim();
            return `[${label}](${WIKI_HREF_PREFIX}${encodeURIComponent(ref)})`;
          }),
    )
    .join("");
}

/** The reference a rewritten link points at, or null for any other href. */
export function wikiTarget(href: string | undefined): string | null {
  if (!href?.startsWith(WIKI_HREF_PREFIX)) return null;
  return decodeURIComponent(href.slice(WIKI_HREF_PREFIX.length));
}
