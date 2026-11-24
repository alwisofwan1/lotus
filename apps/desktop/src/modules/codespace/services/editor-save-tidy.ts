/*
 * What a save tidies before it writes: trailing whitespace and the final line break. The project's
 * `.editorconfig` wins over Settings. Markdown is never trimmed, whatever asks for it: two spaces
 * at a line's end are a line break there (VS Code ships the same exception).
 */

import type { EditorConfig } from "./editor-config";

export type SaveTidy = { trimTrailingWhitespace: boolean; insertFinalNewline: boolean };

const NO_TRIM_LANGUAGES = new Set(["markdown", "mdx"]);

export function resolveSaveTidy(
  preferences: SaveTidy,
  config: EditorConfig | null,
  language: string | null | undefined,
): SaveTidy {
  const trim = config?.trimTrailingWhitespace ?? preferences.trimTrailingWhitespace;
  return {
    trimTrailingWhitespace: trim && !NO_TRIM_LANGUAGES.has(language ?? ""),
    insertFinalNewline: config?.insertFinalNewline ?? preferences.insertFinalNewline,
  };
}

/** A replacement in Monaco's 1-based line and column terms. */
export type TidyEdit = { startLine: number; startColumn: number; endLine: number; endColumn: number; text: string };

/** The edits that tidy `lines` (the model's lines, without breaks); none when it is tidy already. */
export function tidyEdits(lines: readonly string[], eol: string, tidy: SaveTidy): TidyEdit[] {
  const edits: TidyEdit[] = [];
  if (tidy.trimTrailingWhitespace) {
    lines.forEach((line, index) => {
      const trailing = /[ \t]+$/.exec(line);
      if (!trailing) return;
      edits.push({
        startLine: index + 1,
        startColumn: trailing.index + 1,
        endLine: index + 1,
        endColumn: line.length + 1,
        text: "",
      });
    });
  }
  if (tidy.insertFinalNewline && lines.length > 0) {
    const lastIndex = lines.length - 1;
    const last = lines[lastIndex];
    // The last line as it will be after the trim above.
    const lastAfterTrim = tidy.trimTrailingWhitespace ? last.replace(/[ \t]+$/, "") : last;
    if (lastAfterTrim.length > 0) {
      // One edit for the last line: Monaco refuses two that touch.
      const trimEdit = edits.at(-1);
      if (trimEdit && trimEdit.startLine === lastIndex + 1) trimEdit.text = eol;
      else edits.push({ startLine: lastIndex + 1, startColumn: last.length + 1, endLine: lastIndex + 1, endColumn: last.length + 1, text: eol });
    }
  }
  return edits;
}
