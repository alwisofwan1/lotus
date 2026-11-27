/**
 * Rejoins wrapped prompts; the TUI's hard rows lose the separator, so joins are reconstructions.
 * Continuations sit at **exactly the label column**; the **question** wraps mid-token. A space
 * was eaten only if the upper line fills the edge AND the token is too long to fit alone.
 */

/** Columns of slack allowed when asking "was this line filled to the edge?". */
const EDGE_SLACK = 1;

/** How far under the pane width a straddling token still counts as "could have fitted". */
const FIT_SLACK = 4;

/**
 * The separator a wrapped break consumed (a space, or nothing mid-token). Takes the **raw**
 * lines, indentation included: the edge test needs where the row ended on screen.
 */
export function wrapSeparator(upperRaw: string, lowerRaw: string, columns: number | undefined): string {
  return brokeMidToken(upperRaw, lowerRaw, columns) ? "" : " ";
}

/** Both signals must agree; either one alone is a guess. */
function brokeMidToken(upper: string, lower: string, columns: number | undefined): boolean {
  if (columns === undefined) return false;
  if (upper.length < columns - EDGE_SLACK) return false;

  const straddling = lastToken(upper).length + firstToken(lower).length;
  return straddling > columns - FIT_SLACK;
}

/** Filled to the edge — the shape a hard break leaves behind. */
export function filledToEdge(line: string, columns: number | undefined): boolean {
  return columns !== undefined && line.length >= columns - EDGE_SLACK;
}

function lastToken(line: string): string {
  const parts = line.trimEnd().split(" ");
  return parts[parts.length - 1] ?? "";
}

function firstToken(line: string): string {
  return line.trimStart().split(" ")[0] ?? "";
}

/** Leading spaces, which is the only thing separating a continuation from ordinary output. */
export function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}
