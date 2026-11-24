import { describe, expect, it } from "vitest";
import {
  buildCodeSelectionPayload,
  buildDiffSelectionPayload,
  buildPathPayload,
  formatPathRange,
  selectedLineRange,
  withAskAboutLine,
} from "@/modules/codespace/services/selection-payload";

describe("formatPathRange", () => {
  it("names a range, or one line on its own", () => {
    expect(formatPathRange("src/x.ts", 10, 12)).toBe("src/x.ts:10-12");
    expect(formatPathRange("src/x.ts", 7, 7)).toBe("src/x.ts:7");
    expect(formatPathRange("src/x.ts", 12, 10)).toBe("src/x.ts:10-12");
  });
});

describe("selectedLineRange", () => {
  it("drops the last line when the selection ends at its first column", () => {
    expect(selectedLineRange({ startLineNumber: 10, startColumn: 1, endLineNumber: 13, endColumn: 1 }))
      .toEqual({ startLine: 10, endLine: 12 });
  });

  it("keeps a line the selection reaches into, and reads a backwards drag forwards", () => {
    expect(selectedLineRange({ startLineNumber: 13, startColumn: 4, endLineNumber: 10, endColumn: 2 }))
      .toEqual({ startLine: 10, endLine: 13 });
  });

  it("a bare cursor is its own line", () => {
    expect(selectedLineRange({ startLineNumber: 5, startColumn: 3, endLineNumber: 5, endColumn: 3 }))
      .toEqual({ startLine: 5, endLine: 5 });
  });
});

describe("buildCodeSelectionPayload", () => {
  it("is path:start-end, then the code in a fence tagged with its language", () => {
    expect(buildCodeSelectionPayload({
      path: "src/x.ts",
      startLine: 10,
      endLine: 12,
      code: "const a = 1;\nconst b = 2;\nconst c = a + b;",
      language: "typescript",
    })).toBe("src/x.ts:10-12\n```typescript\nconst a = 1;\nconst b = 2;\nconst c = a + b;\n```");
  });

  it("leaves plain text untagged", () => {
    expect(buildCodeSelectionPayload({ path: "notes.txt", startLine: 1, endLine: 1, code: "hi", language: "plaintext" }))
      .toBe("notes.txt:1\n```\nhi\n```");
  });

  it("uses a longer fence when the code holds one", () => {
    const payload = buildCodeSelectionPayload({
      path: "README.md",
      startLine: 3,
      endLine: 5,
      code: "```sh\nbun run test\n```",
      language: "markdown",
    });
    expect(payload).toBe("README.md:3-5\n````markdown\n```sh\nbun run test\n```\n````");
  });

  it("Ask about this puts an editable opening line first", () => {
    expect(withAskAboutLine("src/x.ts:1\n```\nx\n```")).toBe("Explain these lines:\n\nsrc/x.ts:1\n```\nx\n```");
  });
});

describe("buildDiffSelectionPayload", () => {
  const original = ["a", "b", "c", "d", "e", "f"].join("\n");
  // b → B (line 2), e deleted (was line 5), a line added after f.
  const modified = ["a", "B", "c", "d", "f", "g"].join("\n");
  const changes = [
    { originalStartLineNumber: 2, originalEndLineNumber: 2, modifiedStartLineNumber: 2, modifiedEndLineNumber: 2 },
    { originalStartLineNumber: 5, originalEndLineNumber: 5, modifiedStartLineNumber: 4, modifiedEndLineNumber: 0 },
    { originalStartLineNumber: 6, originalEndLineNumber: 0, modifiedStartLineNumber: 6, modifiedEndLineNumber: 6 },
  ];
  const base = { path: "src/x.ts", original, modified, changes, language: "typescript" };

  it("sends only the change the selected lines touch, as a small patch", () => {
    expect(buildDiffSelectionPayload({ ...base, side: "modified", startLine: 1, endLine: 2, selectedCode: "a\nB" }))
      .toBe("src/x.ts:1-2\n```diff\n@@ -2,1 +2,1 @@\n-b\n+B\n```");
  });

  it("keeps a deletion when the selection sits next to where it was", () => {
    expect(buildDiffSelectionPayload({ ...base, side: "modified", startLine: 5, endLine: 6, selectedCode: "f\ng" }))
      .toBe("src/x.ts:5-6\n```diff\n@@ -5,1 +4,0 @@\n-e\n@@ -6,0 +6,1 @@\n+g\n```");
  });

  it("reads the original side's line numbers when the selection is there", () => {
    expect(buildDiffSelectionPayload({ ...base, side: "original", startLine: 5, endLine: 5, selectedCode: "e" }))
      .toBe("src/x.ts:5\n```diff\n@@ -5,1 +4,0 @@\n-e\n```");
  });

  it("sends plain code when no change is touched", () => {
    expect(buildDiffSelectionPayload({ ...base, changes: [changes[0]], side: "modified", startLine: 4, endLine: 4, selectedCode: "d" }))
      .toBe("src/x.ts:4\n```typescript\nd\n```");
  });
});

describe("buildPathPayload", () => {
  it("names a file as it is and a folder with a trailing slash", () => {
    expect(buildPathPayload("src/x.ts")).toBe("src/x.ts");
    expect(buildPathPayload("src/lib", "directory")).toBe("src/lib/");
  });
});
