import { stripAnsi } from "../../../core/ansi.js";

/**
 * What the terminal drew, for a prompt whose options could not be named.
 *
 * `parsePermissionPrompt` fails closed, and it is right to: a digit read from a half-understood
 * screen approves the thing the operator meant to refuse (ADR-8). But failing closed was
 * answered on the phone with one sentence — *"This agent is waiting, but its options could not
 * be read."* — and a button to the raw terminal. The words the terminal had already printed
 * never crossed.
 *
 * That is the gap this closes, and only that gap. **Reading is safe; answering is not.** The
 * digits still come from a successful parse alone, so nothing here can make a wrong button
 * appear — the worst it can do is show the operator a few lines of their own terminal.
 *
 * Measured 2026-09-08: the parser needs the question on the line directly above the options, so
 * a blank line or a box border defeats it. That is every `AskUserQuestion` and most gated tools
 * on a modern CLI, which is how a card came to be permanently unreadable.
 */

/** Lines kept. Enough for a boxed question with per-option descriptions, and no more. */
const MAX_LINES = 40;

/** And a hard cap in characters, because a line can be as wide as the pane. */
const MAX_CHARS = 4_000;

/**
 * The tail of `text` a client can render verbatim, or `undefined` when there is nothing to show.
 *
 * ANSI is stripped and trailing blanks dropped. Stripping is safe **here** because this is a
 * rendered screen rather than a stream: the emulator has already placed every character in its
 * column, so removing the colour leaves the layout standing. The same operation on a raw
 * `pipe-pane` log destroys it, which is the distinction `issues/17` was about.
 */
export function promptTail(text: string): string | undefined {
  const lines = stripAnsi(text).split("\n").map((line) => line.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length === 0) return undefined;

  const kept = lines.slice(Math.max(0, lines.length - MAX_LINES)).join("\n");
  const tail = kept.length > MAX_CHARS ? kept.slice(kept.length - MAX_CHARS) : kept;
  return tail.trim() === "" ? undefined : tail;
}
