import { stripAnsi } from "../../../core/ansi.js";

/**
 * The terminal's own words for a prompt whose options could not be named (the parser fails
 * closed, ADR-8, and a blank line or box border defeats it). **Reading is safe; answering is
 * not**: digits still come only from a successful parse, so no wrong button can appear.
 */

/** Lines kept. Enough for a boxed question with per-option descriptions, and no more. */
const MAX_LINES = 40;

/** And a hard cap in characters, because a line can be as wide as the pane. */
const MAX_CHARS = 4_000;

/**
 * The tail a client can render verbatim. Stripping ANSI is safe **here** because this is a
 * rendered screen (characters already in columns); on a raw `pipe-pane` log it destroys layout
 * (`issues/17`).
 */
export function promptTail(text: string): string | undefined {
  const lines = stripAnsi(text).split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;

  const kept = lines.slice(Math.max(0, lines.length - MAX_LINES)).join("\n");
  const tail = kept.length > MAX_CHARS ? kept.slice(kept.length - MAX_CHARS) : kept;
  return tail.trim() === "" ? undefined : tail;
}
