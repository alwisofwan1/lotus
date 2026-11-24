/*
 * What a selection in the Editor becomes when it is handed to an agent's composer (⌘L).
 *
 * Pure and mode-agnostic on purpose: the Editor pane builds this text the same way whichever
 * surface ends up receiving it — a Thread in Code mode today, an AgentNode on the Canvas later.
 * Only the target resolver differs per mode (`selection-send.ts`), never the payload.
 */

/** `src/x.ts:10-12`, or `src/x.ts:10` for one line. */
export function formatPathRange(path: string, startLine: number, endLine: number): string {
  const start = Math.min(startLine, endLine);
  const end = Math.max(startLine, endLine);
  return start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
}

/** A Monaco selection, 1-based; the shape of `ISelection` / `IRange`. */
export interface EditorSelectionRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * The whole lines a selection covers. As in VS Code, a selection that ends at column 1 of a line
 * does not include that line — dragging to the start of the next line selects the lines above.
 */
export function selectedLineRange(selection: EditorSelectionRange): { startLine: number; endLine: number } {
  const forward = selection.startLineNumber < selection.endLineNumber
    || (selection.startLineNumber === selection.endLineNumber && selection.startColumn <= selection.endColumn);
  const start = forward
    ? { line: selection.startLineNumber }
    : { line: selection.endLineNumber };
  const end = forward
    ? { line: selection.endLineNumber, column: selection.endColumn }
    : { line: selection.startLineNumber, column: selection.startColumn };
  const endLine = end.line > start.line && end.column === 1 ? end.line - 1 : end.line;
  return { startLine: start.line, endLine };
}

/**
 * A fence the body cannot close early: one backtick longer than the longest run inside it.
 * Markdown files are the usual case — a selection that itself contains a ``` fence.
 */
function fenceFor(body: string): string {
  const longest = Math.max(0, ...Array.from(body.matchAll(/`{3,}/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function fenced(body: string, language: string): string {
  const fence = fenceFor(body);
  const tag = language === "plaintext" ? "" : language;
  return `${fence}${tag}\n${body.replace(/\n$/, "")}\n${fence}`;
}

export interface CodeSelection {
  /** Relative to the workspace root when the file is inside it. */
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  /** An editor language id (`resolveEditorLanguage`); `plaintext` gives an untagged fence. */
  language: string;
}

/** `path:start-end` on its own line, then the code in a fence tagged with its language. */
export function buildCodeSelectionPayload(selection: CodeSelection): string {
  return `${formatPathRange(selection.path, selection.startLine, selection.endLine)}\n${fenced(selection.code, selection.language)}`;
}

/** The popover's "Ask about this": the same payload behind an opening line the user can edit. */
export const ASK_ABOUT_LINE = "Explain these lines:";

export function withAskAboutLine(payload: string): string {
  return `${ASK_ABOUT_LINE}\n\n${payload}`;
}

/*
 * ── Diff selections ─────────────────────────────────────────────────────────────────────────
 *
 * A selection in the diff view sends only the changes it touches, as a small unified patch.
 * The change list is Monaco's own (`IDiffEditor.getLineChanges()`), so what is sent is exactly
 * what the view drew — and it works for every diff tab, including "disk vs edits", which has no
 * git text to cut from.
 */

/**
 * Monaco's `ILineChange`, line numbers 1-based. An `*EndLineNumber` of 0 means that side has no
 * lines in the change, and its start is then the line the other side's lines sit after.
 */
export interface DiffLineChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export type DiffSide = "original" | "modified";

export interface DiffSelection {
  path: string;
  /** Which editor of the diff the selection was made in. */
  side: DiffSide;
  startLine: number;
  endLine: number;
  original: string;
  modified: string;
  changes: readonly DiffLineChange[];
  /** The code on the selected side, sent as plain code when no change is touched. */
  selectedCode: string;
  language: string;
}

function sideRange(change: DiffLineChange, side: DiffSide): { start: number; end: number } {
  const start = side === "original" ? change.originalStartLineNumber : change.modifiedStartLineNumber;
  const end = side === "original" ? change.originalEndLineNumber : change.modifiedEndLineNumber;
  // No lines on this side: the change sits between `start` and `start + 1`, so touching either
  // of those lines touches it.
  return end === 0 ? { start, end: start + 1 } : { start, end };
}

function touches(change: DiffLineChange, side: DiffSide, startLine: number, endLine: number): boolean {
  const range = sideRange(change, side);
  return range.start <= endLine && range.end >= startLine;
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

function hunk(change: DiffLineChange, originalLines: string[], modifiedLines: string[]): string {
  const originalCount = change.originalEndLineNumber === 0
    ? 0
    : change.originalEndLineNumber - change.originalStartLineNumber + 1;
  const modifiedCount = change.modifiedEndLineNumber === 0
    ? 0
    : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
  const removed = originalLines
    .slice(change.originalStartLineNumber - 1, change.originalStartLineNumber - 1 + originalCount)
    .map((line) => `-${line}`);
  const added = modifiedLines
    .slice(change.modifiedStartLineNumber - 1, change.modifiedStartLineNumber - 1 + modifiedCount)
    .map((line) => `+${line}`);
  const header = `@@ -${change.originalStartLineNumber},${originalCount} +${change.modifiedStartLineNumber},${modifiedCount} @@`;
  return [header, ...removed, ...added].join("\n");
}

/**
 * The changes the selection touches, as a patch in a `diff` fence under `path:start-end`.
 * When it touches none, the selected lines are sent as ordinary code — a selection of unchanged
 * context is still a question about those lines.
 */
export function buildDiffSelectionPayload(selection: DiffSelection): string {
  const startLine = Math.min(selection.startLine, selection.endLine);
  const endLine = Math.max(selection.startLine, selection.endLine);
  const touched = selection.changes.filter((change) => touches(change, selection.side, startLine, endLine));
  if (touched.length === 0) {
    return buildCodeSelectionPayload({
      path: selection.path,
      startLine,
      endLine,
      code: selection.selectedCode,
      language: selection.language,
    });
  }
  const originalLines = splitLines(selection.original);
  const modifiedLines = splitLines(selection.modified);
  const patch = touched.map((change) => hunk(change, originalLines, modifiedLines)).join("\n");
  return `${formatPathRange(selection.path, startLine, endLine)}\n${fenced(patch, "diff")}`;
}

/** The file tree's "Send to Thread": the file or folder named, not pasted; a folder ends in `/`. */
export function buildPathPayload(path: string, kind: "file" | "directory" = "file"): string {
  const bare = path.replace(/\/+$/, "");
  return kind === "directory" ? `${bare}/` : bare;
}
