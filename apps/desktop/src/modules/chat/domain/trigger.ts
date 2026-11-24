/**
 * The `@` or `/` being typed at the caret, anywhere in the message. Same rule as bb's
 * `find-active-trigger.ts`: the char starts the text or follows whitespace or `( [ {`, and the query
 * has no spaces — so `a@b.com`, `http://x/y` and `src/a` never open a picker.
 * Plan: plans/chat-inline-mentions/PLAN.md.
 */

export interface ActiveTrigger {
  char: "@" | "/";
  query: string;
  /** Index of the char in the text before the caret; 0 = the message starts with it. */
  from: number;
}

/** Only the end of a long draft is read, so every keystroke stays cheap. */
const WINDOW = 256;
const TRIGGER = /(^|[\s([{])([@/])(\S*)$/u;

export function activeTrigger(beforeCaret: string): ActiveTrigger | null {
  const windowed = beforeCaret.length > WINDOW;
  const m = TRIGGER.exec(windowed ? beforeCaret.slice(-WINDOW) : beforeCaret);
  // A match at the window's cut has no known boundary before it.
  if (!m || (windowed && m[1] === "")) return null;
  const query = m[3];
  return { char: m[2] as ActiveTrigger["char"], query, from: beforeCaret.length - query.length - 1 };
}
