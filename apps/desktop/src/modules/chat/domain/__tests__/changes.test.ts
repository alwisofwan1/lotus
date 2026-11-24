import { describe, expect, it } from "vitest";

import { defaultPicks, diffstatSquares, fileRevision, filterChangedFiles, parseDiff, splitRows, undoCandidates, undoDefault, type ChangedFile } from "../changes";

const file = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  added: 1,
  removed: 0,
  agent: true,
  yoursBefore: false,
  yoursAfter: false,
  undoable: true,
  ...over,
});

describe("changes", () => {
  it("ticks the agent's files for commit and never the user's own", () => {
    expect([...defaultPicks([file("a"), file("b", { agent: false })])]).toEqual(["a"]);
  });

  it("offers undo only for the agent's files, unticked where it would lose the user's work", () => {
    const files = [file("a"), file("b", { yoursAfter: true }), file("c", { undoable: false }), file("d", { agent: false })];
    expect(undoCandidates(files).map((f) => [f.path, undoDefault(f)])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
  });

  it("draws the diffstat in proportion, keeping one square for a small side", () => {
    expect(diffstatSquares({ files: 3, added: 42, removed: 7 })).toEqual(["add", "add", "add", "add", "del"]);
    expect(diffstatSquares({ files: 1, added: 100, removed: 1 })).toEqual(["add", "add", "add", "add", "del"]);
    expect(diffstatSquares({ files: 1, added: 0, removed: 3 })).toEqual(["del", "del", "del", "del", "del"]);
    expect(diffstatSquares({ files: 0, added: 0, removed: 0 })).toEqual(Array(5).fill("none"));
  });

  it("numbers diff rows from the hunk header and drops the file headers", () => {
    const diff = [
      "diff --git a/f b/f",
      "index 1..2 100644",
      "--- a/f",
      "+++ b/f",
      "@@ -18,3 +18,3 @@ export function LoginForm",
      " return (",
      "-  <div className=\"relative\">",
      "+  <div className=\"flex\">",
      "   <Input />",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parseDiff(diff)).toEqual([
      { kind: "hunk", line: null, text: "@@ -18,3 +18,3 @@ export function LoginForm" },
      { kind: "context", line: 18, old: 18, text: "return (" },
      { kind: "del", line: 19, text: "  <div className=\"relative\">" },
      { kind: "add", line: 19, text: "  <div className=\"flex\">" },
      { kind: "context", line: 20, old: 20, text: "  <Input />" },
    ]);
  });
});

describe("review helpers", () => {
  it("moves a file's revision when its counts or status change", () => {
    const base = { added: 3, removed: 1, status: "modified" as const };
    expect(fileRevision(base)).toBe(fileRevision({ ...base }));
    expect(fileRevision(base)).not.toBe(fileRevision({ ...base, added: 4 }));
    expect(fileRevision(base)).not.toBe(fileRevision({ ...base, status: "deleted" }));
  });

  it("filters files by a piece of their path", () => {
    const files = [{ path: "src/Login.tsx" }, { path: "src/login.css" }, { path: "README.md" }];
    expect(filterChangedFiles(files, " LOGIN ").map((f) => f.path)).toEqual(["src/Login.tsx", "src/login.css"]);
    expect(filterChangedFiles(files, "")).toHaveLength(3);
  });

  it("pairs deletions with the additions after them, side by side", () => {
    const rows = parseDiff("@@ -1,4 +1,4 @@\n a\n-b\n-c\n+B\n d\n+e");
    const split = splitRows(rows);
    const text = split.map((r) => (r.kind === "hunk" ? "@@" : `${r.left?.text ?? "·"}|${r.right?.text ?? "·"}`));
    expect(text).toEqual(["@@", "a|a", "b|B", "c|·", "d|d", "·|e"]);
  });
});
