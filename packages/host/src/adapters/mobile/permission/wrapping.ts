/**
 * How a wrapped prompt is put back together, and why each rule is allowed to exist.
 *
 * Claude's TUI draws rows, not paragraphs. A label too long for the pane arrives as two physical
 * lines and the separator that used to sit between them is **gone** — tmux agrees: `capture-pane
 * -J` refuses to join these, because they are hard rows, not soft wraps. So there is no hidden
 * original to recover, and every join is a reconstruction.
 *
 * That is uncomfortably close to the invention ADR-8 forbids, so the rules below were measured on
 * `devbox-vps` (2026-09-06, claude 2.1.263) rather than reasoned about, at two pane widths and
 * across two tools. What the captures show:
 *
 * - A continuation line is indented to **exactly the label column** of the option it belongs to
 *   (`   2. ` → column 6), deeper than any option line's own indent.
 * - Labels wrap at spaces. The **question** wraps mid-token
 *   (`…-pembung` / `kusan-…`), because the filename in it is longer than a whole line.
 *
 * So joining has to decide whether a space was eaten, and that decision cannot come from the text
 * alone. It comes from the pane width, and only when two independent signals agree (ADR-8's own
 * rule, applied one level down):
 *
 *  1. the upper line is filled to the edge, and
 *  2. the token straddling the break is too long to have fitted on a line of its own.
 *
 * Both hold for the wrapped question (59 of 60 columns; a 62-character token) and neither holds
 * for any wrapped label measured (56 of 60, 78 of 80; 9- and 13-character token pairs). The
 * margin is wide, not a tie-break.
 *
 * When the pane width is unknown, signal 1 is unavailable and every join keeps its space — the
 * behaviour that was already correct for every label we have seen.
 */

/** Columns of slack allowed when asking "was this line filled to the edge?". */
const EDGE_SLACK = 1;

/** How far under the pane width a straddling token still counts as "could have fitted". */
const FIT_SLACK = 4;

/**
 * The separator a wrapped break consumed: a space, or nothing when the break cut a token in half.
 *
 * Takes the **raw** physical lines, indentation included, because the edge test is about where
 * the row ended on screen. Callers concatenate their own trimmed content around the result.
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
