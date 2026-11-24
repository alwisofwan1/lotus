import { describe, expect, it } from "vitest";

import type { Git } from "../../../core/git.js";
import { isSafeRelativePath, listChanges, parseNumstat, parsePorcelain, readDiff, MAX_DIFF_BYTES } from "../git-changes.js";

describe("parsePorcelain", () => {
  it("reads -z records, renames with their second record, and untracked files", () => {
    const out = parsePorcelain(" M a.ts\0 D b.ts\0R  new.ts\0old.ts\0?? c.md\0A  d.ts\0");
    expect(out).toEqual([
      { path: "a.ts", status: "modified" },
      { path: "b.ts", status: "deleted" },
      { path: "new.ts", status: "renamed" },
      { path: "c.md", status: "untracked" },
      { path: "d.ts", status: "added" },
    ]);
  });
});

describe("parseNumstat", () => {
  it("keeps a binary file's stat null rather than zero", () => {
    expect(parseNumstat("3\t1\ta.ts\n-\t-\tlogo.png\n")).toEqual([
      { path: "a.ts", added: 3, removed: 1 },
      { path: "logo.png", added: null, removed: null },
    ]);
  });
});

describe("isSafeRelativePath", () => {
  it("refuses anything that could leave the tree", () => {
    expect(isSafeRelativePath("src/a.ts")).toBe(true);
    expect(isSafeRelativePath("../x")).toBe(false);
    expect(isSafeRelativePath("a/../../x")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("")).toBe(false);
    expect(isSafeRelativePath("a\0b")).toBe(false);
  });
});

const scripted =
  (answers: Record<string, { code: number; stdout: string }>): Git =>
  async (_cwd, args) =>
    ({ stderr: "", ...(answers[args.join(" ")] ?? { code: 128, stdout: "" }) });

describe("listChanges", () => {
  it("names a directory that is not a repository instead of an empty list", async () => {
    const git = scripted({ "rev-parse --is-inside-work-tree": { code: 128, stdout: "" } });
    expect(await listChanges(git, "/tmp/x")).toEqual({ reason: "not_a_repo" });
  });

  it("joins status with numstat and measures untracked files against nothing", async () => {
    const git = scripted({
      "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
      "status --porcelain=v1 -z --untracked-files=all": { code: 0, stdout: " M a.ts\0?? new.md\0" },
      "diff --numstat HEAD --": { code: 0, stdout: "5\t2\ta.ts\n" },
      "diff --no-index --numstat -- /dev/null new.md": { code: 1, stdout: "7\t0\tnew.md\n" },
    });
    expect(await listChanges(git, "/repo")).toEqual({
      files: [
        { path: "a.ts", status: "modified", added: 5, removed: 2 },
        { path: "new.md", status: "untracked", added: 7, removed: 0 },
      ],
    });
  });
});

describe("readDiff", () => {
  it("falls back to a no-index diff for an untracked file, and caps the size", async () => {
    const big = "+".repeat(MAX_DIFF_BYTES + 10);
    const git = scripted({
      "diff HEAD -- new.md": { code: 0, stdout: "" },
      "diff --no-index -- /dev/null new.md": { code: 1, stdout: big },
    });
    const out = await readDiff(git, "/repo", "new.md");
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.diff, "utf8")).toBe(MAX_DIFF_BYTES);
  });
});
