import { describe, it, expect } from "vitest";
import { fileNodeNames, gutterMarksByLine, lineWindow, MAX_HIGHLIGHT_LINES } from "../file-node/file-node-view";

describe("file node naming", () => {
  it("splits a path into name and the folder relative to the root", () => {
    expect(fileNodeNames("/repo/src/auth/session.ts", "/repo")).toEqual({ name: "session.ts", dir: "src/auth" });
  });
  it("shows no dir for a file at the root, and the absolute folder for a file outside it", () => {
    expect(fileNodeNames("/repo/package.json", "/repo/")).toEqual({ name: "package.json", dir: "" });
    expect(fileNodeNames("/other/x.ts", "/repo")).toEqual({ name: "x.ts", dir: "/other" });
  });
});

describe("git marks beside the line numbers", () => {
  it("marks added and modified lines across their whole range", () => {
    const marks = gutterMarksByLine([
      { kind: "added", startLine: 2, endLine: 3 },
      { kind: "modified", startLine: 7, endLine: 7 },
    ]);
    expect([...marks.entries()]).toEqual([[2, "added"], [3, "added"], [7, "modified"]]);
  });
  it("puts a deletion on the line above the gap, and on line 1 when it was before the first line", () => {
    expect(gutterMarksByLine([{ kind: "deleted", startLine: 4, endLine: 4 }]).get(4)).toBe("deleted");
    expect(gutterMarksByLine([{ kind: "deleted", startLine: 0, endLine: 0 }]).get(1)).toBe("deleted-top");
  });
  it("lets an added or modified mark win over a deletion on the same line", () => {
    const marks = gutterMarksByLine([
      { kind: "added", startLine: 4, endLine: 4 },
      { kind: "deleted", startLine: 4, endLine: 4 },
    ]);
    expect(marks.get(4)).toBe("added");
  });
});

describe("which lines a scrolled body draws", () => {
  it("draws the viewport plus overscan, not the whole file", () => {
    const w = lineWindow({ scrollTop: 1000, viewportHeight: 200, lineHeight: 20, total: 5000, overscan: 5 });
    expect(w).toEqual({ start: 45, end: 65 });
  });
  it("clamps at both ends", () => {
    expect(lineWindow({ scrollTop: 0, viewportHeight: 200, lineHeight: 20, total: 5000, overscan: 5 }).start).toBe(0);
    expect(lineWindow({ scrollTop: 99_000, viewportHeight: 200, lineHeight: 20, total: 100, overscan: 5 })).toEqual({ start: 94, end: 100 });
  });
  it("highlights a bounded number of lines", () => {
    expect(MAX_HIGHLIGHT_LINES).toBeGreaterThan(0);
  });
});
