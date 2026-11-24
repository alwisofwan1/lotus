import { describe, expect, it } from "vitest";

import { formatElapsed, rowTime, stepKind, traceRows } from "../run-trace";

describe("stepKind", () => {
  it("reads each kind from the words activity.rs writes", () => {
    expect(stepKind("Read GitHub acme-docs#388 files")).toBe("github");
    expect(stepKind("Read Notion TKT-1234")).toBe("notion");
    expect(stepKind("Read a Notion page")).toBe("notion");
    expect(stepKind("Read src/app.ts")).toBe("file");
    expect(stepKind("Searched for `eval`")).toBe("search");
    expect(stepKind("Looked for files `**/*.ts`")).toBe("search");
    expect(stepKind("Searched the web for `x`")).toBe("web");
    expect(stepKind("Opened https://example.com")).toBe("web");
    expect(stepKind("Used the skill code-review")).toBe("skill");
    expect(stepKind("Used context7: query-docs")).toBe("tool");
    expect(stepKind("Handed the result to Lotus")).toBe("result");
    expect(stepKind("Not allowed: Write (the run only reads)")).toBe("refused");
    expect(stepKind("Ran `git log -5`")).toBe("command");
    // A Bash call's own description.
    expect(stepKind("Check backend access helper")).toBe("command");
    expect(stepKind("Search docs for shared_users mentions")).toBe("search");
  });
});

describe("traceRows", () => {
  it("folds a step repeated back to back and times each row until the next began", () => {
    const rows = traceRows([
      { atMs: 1_000, text: "Read a.md" },
      { atMs: 4_000, text: "Read a.md" },
      { atMs: 9_000, text: "Read b.md" },
      { atMs: 9_500, text: "Read a.md" },
    ]);
    expect(rows.map((r) => [r.text, r.times, r.tookMs])).toEqual([
      ["Read a.md", 2, 8_000],
      ["Read b.md", 1, 500],
      ["Read a.md", 1, null],
    ]);
  });

  it("is empty before the first step", () => {
    expect(traceRows([])).toEqual([]);
  });
});

describe("rowTime", () => {
  it("hides a row under a second, and times the newest row against the clock", () => {
    const [quick, live] = traceRows([
      { atMs: 0, text: "Read a.md" },
      { atMs: 400, text: "Read b.md" },
    ]);
    expect(rowTime(quick, 99_999)).toBeNull();
    expect(rowTime(live, 4_400)).toBe("4s");
  });
});

describe("formatElapsed", () => {
  it("reads like a ticking clock", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(4_900)).toBe("4s");
    expect(formatElapsed(134_000)).toBe("2m 14s");
    expect(formatElapsed(62_000)).toBe("1m 02s");
    expect(formatElapsed(3_900_000)).toBe("1h 05m");
  });
});
