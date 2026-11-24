import { beforeEach, describe, expect, it } from "vitest";

import { pruneQuotes, readQuotes, reviewNote, reviewNoteRef, reviewNoteText, splitQuotes, withQuotes, writeQuotes } from "../quotes";

describe("withQuotes", () => {
  it("puts each quote before the typed text as a blockquote", () => {
    expect(withQuotes("why?", [{ text: " a\nb " }, { text: "c" }])).toBe("> a\n> b\n\n> c\n\nwhy?");
  });
  it("leaves the text alone without quotes, and sends quotes alone", () => {
    expect(withQuotes("hi", [])).toBe("hi");
    expect(withQuotes("", [{ text: "x" }])).toBe("> x");
  });
});

describe("splitQuotes", () => {
  it("round-trips what withQuotes made", () => {
    expect(splitQuotes(withQuotes("why?", [{ text: "a\nb" }, { text: "c" }]))).toEqual({ quotes: ["a\nb", "c"], text: "why?" });
  });
  it("reads older quote-in-reply text, and leaves plain text alone", () => {
    expect(splitQuotes("> a\n> \n> b\n\nok")).toEqual({ quotes: ["a\n\nb"], text: "ok" });
    expect(splitQuotes("a > b")).toEqual({ quotes: [], text: "a > b" });
  });
});

describe("reviewNote", () => {
  // @@ -9,3 +9,2 @@ — one context line, two removed, one added
  const rows = [
    { kind: "hunk" as const, line: null, text: "@@ -9,3 +9,2 @@" },
    { kind: "context" as const, line: 9, old: 9, text: "export function f() {" },
    { kind: "del" as const, line: 10, text: "  return withTimeout(p, 5000);" },
    { kind: "del" as const, line: 11, text: "  // old" },
    { kind: "add" as const, line: 10, text: "  return p;" },
  ];

  it("cites the new lines of a range, with the code as a diff", () => {
    const n = reviewNote("src/a.ts", rows.slice(1, 5), "why drop it?");
    expect(reviewNoteRef(n)).toBe("src/a.ts:L9-10");
    expect(n.code).toBe(" export function f() {\n-  return withTimeout(p, 5000);\n-  // old\n+  return p;");
  });

  it("cites removed lines by their old numbers", () => {
    expect(reviewNoteRef(reviewNote("src/a.ts", rows.slice(2, 4), "keep"))).toBe("src/a.ts:L10-11 (removed)");
    expect(reviewNoteRef(reviewNote("src/a.ts", rows.slice(3, 4), "keep"))).toBe("src/a.ts:L11 (removed)");
  });

  it("goes to the agent as the reference, the code and the note, ahead of the typed text", () => {
    const n = reviewNote("src/a.ts", rows.slice(4, 5), "use RETRY_LIMIT");
    expect(withQuotes("thanks", [{ text: reviewNoteText(n) }])).toBe(
      "> `src/a.ts:L10`\n> ```diff\n> +  return p;\n> ```\n> use RETRY_LIMIT\n\nthanks",
    );
  });
});

describe("stored quotes", () => {
  beforeEach(() => localStorage.clear());

  it("keeps a thread's waiting quotes across a reload, and forgets them once empty", () => {
    const q = { id: "q1", text: "a", at: 1, review: { path: "a.ts", from: 3, to: 3, removed: false, code: "+x", note: "n" } };
    writeQuotes("t1", [q]);
    expect(readQuotes("t1")).toEqual([q]);
    expect(readQuotes("t2")).toEqual([]);
    writeQuotes("t1", []);
    expect(localStorage.getItem("lotus.chat.quotes.t1")).toBeNull();
  });

  it("prunes quotes of threads that are gone", () => {
    writeQuotes("live", [{ id: "a", text: "a", at: 1 }]);
    writeQuotes("gone", [{ id: "b", text: "b", at: 1 }]);
    pruneQuotes(["live"]);
    expect(readQuotes("live")).toHaveLength(1);
    expect(localStorage.getItem("lotus.chat.quotes.gone")).toBeNull();
  });

  it("reads nothing from a broken entry", () => {
    localStorage.setItem("lotus.chat.quotes.t1", "{nope");
    expect(readQuotes("t1")).toEqual([]);
  });
});
