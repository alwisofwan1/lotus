import { stripAnsi } from "../../../core/ansi.js";
import type { PermissionPrompt, PromptOption } from "../../../types/index.js";
import { filledToEdge, indentOf, wrapSeparator } from "./wrapping.js";

/**
 * Port of `permission_prompt.rs`. **Hazard:** a wrong digit **approves what the operator meant
 * to refuse** (ADR-8), so options are read from the terminal and rendered verbatim, never
 * invented. **Fails closed:** anything unexpected yields `undefined` (no chips).
 */

/** Fewest options a real prompt offers. One numbered line is far more likely to be ordinary
 * output (`1. install deps`) than a prompt. */
const MIN_OPTIONS = 2;

/** Most options to accept. Real prompts offer three; a long numbered list is something else
 * being misread. */
const MAX_OPTIONS = 6;

/** Longest label kept, so a mangled line cannot become a giant button. */
const MAX_LABEL = 120;

/**
 * Physical lines a single label may span. Two is what claude's longest option needs at 60
 * columns; three leaves room without letting a run eat the output above it.
 */
const MAX_CONTINUATION_LINES = 3;

/** Physical lines the question may span, for the same reason. */
const MAX_QUESTION_LINES = 3;

/**
 * Longest label after its wrapped pieces are put back together. Larger than `MAX_LABEL`, which
 * guards a single mangled ROW: the longest real label measured is 111 characters and arrives in
 * two or three rows, so the per-row cap cannot also serve as the per-label one.
 */
const MAX_JOINED_LABEL = 200;

/**
 * The trailing permission prompt of a PTY tail; `undefined` is the safe answer for every
 * uncertainty (no question, bad numbering, wrong option count, scrolled away).
 */
export function parsePermissionPrompt(tail: string, columns?: number): PermissionPrompt | undefined {
  const lines = stripAnsi(tail).split("\n");

  // Search from the end: a long tail can hold several past prompts, and only the last one is
  // the one being asked now.
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (parseOptionLine(lines[i] ?? "") !== undefined) { end = i; break; }
  }
  if (end < 0) return undefined;

  const run = readOptionRun(lines, end, columns);
  if (run === undefined) return undefined;
  const { options, start } = run;

  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return undefined;

  // Numbering must be 1..=n with no gaps. A run like `2. b` / `3. c` means the first option
  // scrolled off, and sending a digit against a partial list is exactly the mistake this module
  // exists to prevent.
  for (const [index, option] of options.entries()) {
    if (option.key !== String(index + 1)) return undefined;
  }

  const question = readQuestion(lines, start, columns);
  if (question === undefined) return undefined;

  return { question, options };
}

/** An option line plus the wrapped remainder of its label, still in physical rows. */
interface RunEntry {
  option: PromptOption;
  labelColumn: number;
  /** The numbered row itself, kept raw because the wrap test measures where it ended on screen. */
  rawFirst: string;
  /** Rows of the label below the numbered one, top to bottom. */
  continuation: string[];
}

/**
 * Walks the option run upward, folding wrapped label rows into their option; returns the options
 * and the index above the run. A continuation row is held back until its option turns up
 * directly above, indented to exactly its label column; else it is output and the run ends.
 */
function readOptionRun(
  lines: string[],
  end: number,
  columns: number | undefined,
): { options: PromptOption[]; start: number } | undefined {
  const entries: RunEntry[] = [];
  let held: string[] = [];
  let lowestOptionIndent = Number.MAX_SAFE_INTEGER;
  let lastOption = end;
  let i = end;

  for (; i >= 0; i -= 1) {
    const raw = lines[i] ?? "";
    const option = parseOptionLine(raw);
    if (option !== undefined) {
      // Every held row must sit at this option's label column. One that does not means the rows
      // between belong to something else, so the run stops here rather than guessing.
      if (held.some((row) => indentOf(row) !== option.labelColumn)) break;
      entries.push({
        option: option.option,
        labelColumn: option.labelColumn,
        rawFirst: raw,
        continuation: held.slice().reverse(),
      });
      held = [];
      lastOption = i;
      lowestOptionIndent = Math.min(lowestOptionIndent, indentOf(raw));
      continue;
    }
    // Only a row indented deeper than the options themselves can be a wrapped label. The
    // question sits at or left of them, which is what stops the walk.
    if (
      held.length >= MAX_CONTINUATION_LINES
      || raw.trim().length === 0
      || indentOf(raw) <= lowestOptionIndent
    ) break;
    held.push(raw);
  }

  // Rows held with no option above them were never label rows. Rather than reject outright, the
  // run rewinds to the last option it did read — a prompt drawn inside a box has its question
  // indented too, and the checks above still have to pass for anything to come of it.
  if (held.length > 0) i = lastOption - 1;
  if (entries.length === 0) return undefined;
  entries.reverse();

  const options: PromptOption[] = [];
  for (const entry of entries) {
    const label = joinLabel(entry, columns);
    if (label === undefined) return undefined;
    options.push({ ...entry.option, label });
  }
  return { options, start: i };
}

/** Puts a wrapped label back together, or `undefined` when the result is too long to trust. */
function joinLabel(entry: RunEntry, columns: number | undefined): string | undefined {
  let label = entry.option.label;
  let previousRaw = entry.rawFirst;
  for (const row of entry.continuation) {
    label += wrapSeparator(previousRaw, row, columns) + row.trim();
    previousRaw = row;
  }
  return label.length > MAX_JOINED_LABEL ? undefined : label;
}

/**
 * Reads the question above the run. It wraps mid-token on a long filename, so the row above is
 * taken only when **filled to the edge**; with no known pane width it stays one row.
 */
function readQuestion(lines: string[], start: number, columns: number | undefined): string | undefined {
  const first = lines[start];
  // A run with no line above it is a numbered list, not a prompt.
  if (start < 0 || first === undefined || parseOptionLine(first) !== undefined) return undefined;

  const rows = [first];
  const indent = indentOf(first);
  for (let i = start - 1; i >= 0 && rows.length < MAX_QUESTION_LINES; i -= 1) {
    const above = lines[i] ?? "";
    if (!filledToEdge(above, columns) || indentOf(above) !== indent) break;
    if (above.trim().length === 0 || parseOptionLine(above) !== undefined) break;
    rows.unshift(above);
  }

  let question = rows[0]?.trim() ?? "";
  for (let i = 1; i < rows.length; i += 1) {
    question += wrapSeparator(rows[i - 1] ?? "", rows[i] ?? "", columns) + (rows[i] ?? "").trim();
  }
  return question.endsWith("?") ? question : undefined;
}

/** `❯ 1. Yes` / `  2. Yes, allow all edits during this session (shift+tab)` */
function parseOptionLine(line: string): { option: PromptOption; labelColumn: number } | undefined {
  const trimmed = line.trim();
  const selected = trimmed.startsWith("❯");
  const rest = selected ? trimmed.slice("❯".length).trimStart() : trimmed;

  const dot = rest.indexOf(".");
  if (dot < 0) return undefined;
  const key = rest.slice(0, dot).trim();
  if (key.length === 0 || key.length > 2 || !/^\d+$/.test(key)) return undefined;

  const label = rest.slice(dot + 1).trim();
  if (label.length === 0 || label.length > MAX_LABEL) return undefined;

  // Where the label starts on screen. Wrapped rows line up with it exactly, which is the only
  // thing separating them from ordinary output.
  const afterDot = rest.slice(dot + 1);
  const labelColumn = indentOf(line)
    + (trimmed.length - rest.length)
    + dot + 1
    + (afterDot.length - afterDot.trimStart().length);

  return { option: { key, label, selected }, labelColumn };
}

/**
 * A sentence to act on without the screen. **Nothing is paraphrased** (what you hear is what
 * you approve); only parenthesised hints like `(shift+tab)` are dropped as noise.
 */
export function spokenReadback(prompt: PermissionPrompt): string {
  let out = prompt.question;
  for (const option of prompt.options) {
    out += ` Option ${option.key}: ${stripKeyHints(option.label)}.`;
  }
  return out;
}

/**
 * Drops `(shift+tab)`-style hints. Only parentheses whose contents look like a key chord: a
 * parenthetical that is prose ("(this cannot be undone)") is part of what the operator is
 * agreeing to and must survive.
 */
function stripKeyHints(label: string): string {
  let out = "";
  let rest = label;
  for (;;) {
    const open = rest.indexOf("(");
    if (open < 0) break;
    const close = rest.indexOf(")", open);
    if (close < 0) break;
    out += looksLikeKeyChord(rest.slice(open + 1, close))
      ? rest.slice(0, open)
      : rest.slice(0, close + 1);
    rest = rest.slice(close + 1);
  }
  out += rest;
  return out.trim().replace(/,+$/, "");
}

/** `shift+tab`, `esc`, `ctrl-c`: short, no spaces around words, chord-shaped. */
function looksLikeKeyChord(inner: string): boolean {
  const trimmed = inner.trim();
  if (trimmed.length === 0 || trimmed.length > 20 || trimmed.includes(" ")) return false;
  const KEYS = ["shift", "ctrl", "cmd", "alt", "opt", "tab", "esc", "enter", "return", "space"];
  return trimmed.split(/[+-]/).every((part) => KEYS.includes(part.trim().toLowerCase()));
}
