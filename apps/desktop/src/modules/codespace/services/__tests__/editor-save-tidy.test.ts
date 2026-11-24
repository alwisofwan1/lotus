import { describe, expect, it } from "vitest";
import { resolveSaveTidy, tidyEdits } from "../editor-save-tidy";

function apply(text: string, tidy: { trimTrailingWhitespace: boolean; insertFinalNewline: boolean }): string {
  const lines = text.split("\n");
  const edits = tidyEdits(lines, "\n", tidy);
  // Apply bottom-up so earlier positions stay valid.
  const out = [...lines];
  for (const edit of [...edits].reverse()) {
    const line = out[edit.startLine - 1];
    out[edit.startLine - 1] = line.slice(0, edit.startColumn - 1) + edit.text + line.slice(edit.endColumn - 1);
  }
  return out.join("\n");
}

describe("tidyEdits", () => {
  const both = { trimTrailingWhitespace: true, insertFinalNewline: true };

  it("trims line ends and adds the final break", () => {
    expect(apply("a  \nb\t\nc ", both)).toBe("a\nb\nc\n");
  });

  it("does nothing to a tidy file", () => {
    expect(tidyEdits("a\nb\n".split("\n"), "\n", both)).toEqual([]);
  });

  it("does not add a break to an empty file", () => {
    expect(tidyEdits([""], "\n", both)).toEqual([]);
  });

  it("keeps whitespace when only the final break is asked for", () => {
    expect(apply("a  ", { trimTrailingWhitespace: false, insertFinalNewline: true })).toBe("a  \n");
  });

  it("gives one edit for the last line, never two that touch", () => {
    const edits = tidyEdits(["x  "], "\n", both);
    expect(edits).toEqual([{ startLine: 1, startColumn: 2, endLine: 1, endColumn: 4, text: "\n" }]);
  });
});

describe("resolveSaveTidy", () => {
  const off = { trimTrailingWhitespace: false, insertFinalNewline: false };
  const on = { trimTrailingWhitespace: true, insertFinalNewline: true };

  it("lets .editorconfig win over Settings", () => {
    expect(resolveSaveTidy(off, { trimTrailingWhitespace: true, insertFinalNewline: true }, "typescript")).toEqual(on);
    expect(resolveSaveTidy(on, { insertFinalNewline: false }, "typescript")).toEqual({ trimTrailingWhitespace: true, insertFinalNewline: false });
  });

  it("never trims Markdown, where two spaces are a line break", () => {
    expect(resolveSaveTidy(on, null, "markdown").trimTrailingWhitespace).toBe(false);
    expect(resolveSaveTidy(off, { trimTrailingWhitespace: true }, "markdown").trimTrailingWhitespace).toBe(false);
    expect(resolveSaveTidy(on, null, "markdown").insertFinalNewline).toBe(true);
  });
});
