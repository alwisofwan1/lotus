import { describe, expect, it } from "vitest";
import { computeLineChanges } from "../editor-line-diff";

describe("computeLineChanges", () => {
  it("finds nothing in equal text", () => {
    expect(computeLineChanges("a\nb\n", "a\nb\n")).toEqual([]);
  });

  it("marks added lines", () => {
    expect(computeLineChanges("a\nc\n", "a\nb1\nb2\nc\n")).toEqual([{ kind: "added", startLine: 2, endLine: 3 }]);
  });

  it("marks changed lines", () => {
    expect(computeLineChanges("a\nb\nc\n", "a\nB\nc\n")).toEqual([{ kind: "modified", startLine: 2, endLine: 2 }]);
  });

  it("marks a removal on the line above the gap", () => {
    expect(computeLineChanges("a\nb\nc\n", "a\nc\n")).toEqual([{ kind: "deleted", startLine: 1, endLine: 1 }]);
    expect(computeLineChanges("a\nb\n", "b\n")).toEqual([{ kind: "deleted", startLine: 0, endLine: 0 }]);
  });

  it("separates several hunks", () => {
    const base = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    const current = ["1", "x", "3", "4", "new", "5", "7"].join("\n");
    expect(computeLineChanges(base, current)).toEqual([
      { kind: "modified", startLine: 2, endLine: 2 },
      { kind: "added", startLine: 5, endLine: 5 },
      { kind: "deleted", startLine: 6, endLine: 6 },
    ]);
  });

  it("treats a new file as all added", () => {
    expect(computeLineChanges("", "a\nb")).toEqual([{ kind: "added", startLine: 1, endLine: 2 }]);
  });

  it("ignores a line ending change only in the break style", () => {
    expect(computeLineChanges("a\r\nb\r\n", "a\nb\n")).toEqual([]);
  });

  it("handles interleaved edits like a real diff", () => {
    const base = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n");
    const lines = base.split("\n");
    lines[10] = "changed";
    lines.splice(100, 0, "inserted");
    lines.splice(150, 2);
    const changes = computeLineChanges(base, lines.join("\n"));
    expect(changes).toEqual([
      { kind: "modified", startLine: 11, endLine: 11 },
      { kind: "added", startLine: 101, endLine: 101 },
      { kind: "deleted", startLine: 150, endLine: 150 },
    ]);
  });
});
