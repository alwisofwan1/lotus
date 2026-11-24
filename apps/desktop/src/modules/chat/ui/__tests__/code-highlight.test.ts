import { describe, expect, it } from "vitest";

import { highlightLines, highlightRows, languageOf } from "../code-highlight";

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe("code-highlight", () => {
  it("knows a language by extension, alias or file name", () => {
    expect(languageOf("src/a.ts")).toBe("ts");
    expect(languageOf("src/App.TSX")).toBe("tsx");
    expect(languageOf("crates/x/lib.rs")).toBe("rs");
    expect(languageOf("web/App.vue")).toBe("xml");
    expect(languageOf("Makefile")).toBe("makefile");
    expect(languageOf("notes.unknownext")).toBeNull();
    expect(languageOf("LICENSE")).toBeNull();
  });

  it("gives one balanced line per source line, with the text unchanged", () => {
    const src = 'const a = "x";\n/* one\n   two */\nlet b = a < 2 && true;';
    const lines = highlightLines(src, "typescript")!;
    expect(lines).toHaveLength(4);
    expect(lines.map(text)).toEqual(src.split("\n"));
    for (const l of lines) expect(l.match(/<span/g)?.length ?? 0).toBe(l.match(/<\/span>/g)?.length ?? 0);
    // The comment's second line is still inside the comment span.
    expect(lines[2]).toContain("hljs-comment");
  });

  it("escapes markup in the source", () => {
    const [line] = highlightLines('const s = "<img onerror=x>";', "typescript")!;
    expect(line).not.toContain("<img");
  });

  it("stays plain without a language or past the size cap", () => {
    expect(highlightLines("abc", null)).toBeNull();
    expect(highlightLines("x".repeat(200_001), "typescript")).toBeNull();
  });
});

describe("highlightRows", () => {
  it("colours each hunk and leaves the headers alone", () => {
    const rows = [
      { kind: "hunk", text: "@@ -1 +1 @@" },
      { kind: "del", text: 'const a = "x";' },
      { kind: "add", text: 'const a = "y";' },
      { kind: "hunk", text: "@@ -9 +9 @@" },
      { kind: "context", text: "return a;" },
    ];
    const html = highlightRows(rows, "ts")!;
    expect(html[0]).toBeNull();
    expect(html[3]).toBeNull();
    expect(html.slice(1).filter(Boolean).map((h) => text(h!))).toEqual(['const a = "x";', 'const a = "y";', "return a;"]);
    expect(html[2]).toContain("hljs-string");
  });

  it("is null without a language", () => {
    expect(highlightRows([{ kind: "add", text: "x" }], null)).toBeNull();
  });
});
