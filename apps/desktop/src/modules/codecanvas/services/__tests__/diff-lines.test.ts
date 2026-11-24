import { describe, it, expect } from "vitest";
import { parseDiffLines } from "../diff-lines";

describe("parseDiffLines", () => {
  it("returns an empty list for an empty diff", () => {
    expect(parseDiffLines("")).toEqual([]);
    expect(parseDiffLines("   \n  ")).toEqual([]);
  });

  it("classifies added and removed lines, not the file markers", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "index 111..222 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n");
    const lines = parseDiffLines(diff);
    expect(lines.map((l) => l.kind)).toEqual([
      "meta", "meta", "meta", "meta", "hunk", "context", "del", "add",
    ]);
  });

  it("does not mistake the +++/--- file headers for add/del lines", () => {
    const lines = parseDiffLines("--- a/x.ts\n+++ b/x.ts");
    expect(lines.every((l) => l.kind === "meta")).toBe(true);
  });

  it("preserves the original text of each line", () => {
    const lines = parseDiffLines("+const b = 3;");
    expect(lines[0]).toEqual({ kind: "add", text: "+const b = 3;" });
  });
});
