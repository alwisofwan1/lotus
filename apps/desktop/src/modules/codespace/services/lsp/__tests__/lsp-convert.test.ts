import { describe, expect, it } from "vitest";
import { applyTextEdits, toCompletionItem, toHover, toLocations, toMarker, workspaceEditFiles } from "../lsp-convert";

const Uri = {
  file: (path: string) => ({ scheme: "file", path }),
  parse: (value: string) => ({ value }),
} as never;

const range = (sl: number, sc: number, el: number, ec: number) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

describe("lsp-convert", () => {
  it("applies edits against the original text, back to front", () => {
    const text = "let a = 1;\nlet b = a;\n";
    const result = applyTextEdits(text, [
      { range: range(0, 4, 0, 5), newText: "count" },
      { range: range(1, 8, 1, 9), newText: "count" },
    ]);
    expect(result).toBe("let count = 1;\nlet b = count;\n");
  });

  it("keeps the order of inserts at the same place", () => {
    expect(applyTextEdits("x", [
      { range: range(0, 0, 0, 0), newText: "a" },
      { range: range(0, 0, 0, 0), newText: "b" },
    ])).toBe("abx");
  });

  it("turns a diagnostic into a marker (1-based, severity mapped)", () => {
    const marker = toMarker({ range: range(2, 4, 2, 9), severity: 2, message: "unused", source: "ts", code: 6133 }, { Uri });
    expect(marker).toMatchObject({ startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 10, severity: 4, message: "unused", code: "6133" });
  });

  it("reads locations and location links", () => {
    expect(toLocations({ uri: "file:///a%20b/x.ts", range: range(0, 0, 0, 1) }, { Uri })).toEqual([
      { uri: { scheme: "file", path: "/a b/x.ts" }, range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 } },
    ]);
    const links = toLocations([{ targetUri: "file:///y.ts", targetRange: range(0, 0, 9, 0), targetSelectionRange: range(4, 2, 4, 6) }], { Uri });
    expect(links[0].range).toEqual({ startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 7 });
    expect(toLocations([{ uri: "untitled:1", range: range(0, 0, 0, 0) }], { Uri })).toEqual([]);
  });

  it("builds completion items from text edits and defaults", () => {
    const fallback = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 };
    const item = toCompletionItem({ label: "map", kind: 2, textEdit: { range: range(0, 4, 0, 6), newText: "map($1)" }, insertTextFormat: 2 }, fallback);
    expect(item).toMatchObject({ label: "map", kind: 0, insertText: "map($1)", insertTextRules: 4, range: { startColumn: 5, endColumn: 7 } });
    const withDefault = toCompletionItem({ label: "x" }, fallback, { editRange: range(0, 0, 0, 1) });
    expect(withDefault.range).toMatchObject({ startColumn: 1, endColumn: 2 });
    expect(toCompletionItem({ label: "y", deprecated: true }, fallback)).toMatchObject({ insertText: "y", range: fallback, tags: [1] });
  });

  it("drops empty hovers", () => {
    expect(toHover(null)).toBeNull();
    expect(toHover({ contents: "" })).toBeNull();
    expect(toHover({ contents: { kind: "markdown", value: "**x**" } })?.contents).toEqual([{ value: "**x**" }]);
  });

  it("collects edits per file and flags file operations", () => {
    const edit = workspaceEditFiles({ changes: { "file:///a.ts": [{ range: range(0, 0, 0, 0), newText: "x" }] } });
    expect([...edit.files.keys()]).toEqual(["/a.ts"]);
    expect(edit.unsupported).toBe(false);
    expect(workspaceEditFiles({ documentChanges: [{ kind: "create", uri: "file:///b.ts" }] as never }).unsupported).toBe(true);
  });
});
