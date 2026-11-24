import { describe, expect, it } from "vitest";
import { htmlToMarkdown, markdownToHtml, tiptapJsonToMarkdown } from "../note-markdown-codec";

describe("Rich Markdown Note codec", () => {
  it("converts supported pasted HTML into canonical Markdown", async () => {
    await expect(htmlToMarkdown("<h1>Title</h1><p><strong>Bold</strong> <em>em</em></p><ul><li>one</li><li><input type='checkbox' checked>done</li></ul>")).resolves.toBe("# Title\n\n**Bold** *em*\n\n- one\n- [x] done");
  });

  it("strips unsafe HTML and preserves remote image references", async () => {
    await expect(htmlToMarkdown("<script>alert(1)</script><p onclick='x()'>Safe</p><img src='https://example.com/a.png' alt='shot'><img src='javascript:alert(1)' alt='bad'>")).resolves.toBe("Safe\n\n![shot](https://example.com/a.png)");
  });

  it("resolves pasted HTML data images through the durable Note Asset path", async () => {
    await expect(htmlToMarkdown("<img src='data:image/png;base64,QUJD' alt='paste'>", {
      resolveDataImage: async ({ dataUrl, alt }) => dataUrl === "data:image/png;base64,QUJD" && alt === "paste" ? "lotus-note-asset://asset_1" : null,
    })).resolves.toBe("![paste](lotus-note-asset://asset_1)");
  });

  it("renders supported Markdown blocks into editor HTML", () => {
    expect(markdownToHtml("# Title\n\n## Part\n- item\n- [ ] todo\n- [x] done")).toContain("<h1>Title</h1>");
    expect(markdownToHtml("# Title\n\n## Part\n- item\n- [ ] todo\n- [x] done")).toContain("<ul data-type=\"taskList\">");
    expect(markdownToHtml("- [ ]")).toContain("<ul data-type=\"taskList\">");
    expect(markdownToHtml("![shot](lotus-note-asset://asset_1){align=right size=s}")).toContain("data-align=\"right\" data-size=\"s\"");
  });

  it("keeps literal punctuation clean through paste → render (no stray backslashes)", async () => {
    const md = await htmlToMarkdown("<p>[DUNG-022] EC-29 Part C: charge (final) #1!</p>");
    expect(md).toBe("[DUNG-022] EC-29 Part C: charge (final) #1!");
    expect(markdownToHtml(md)).toBe("<p>[DUNG-022] EC-29 Part C: charge (final) #1!</p>");
  });

  it("unescapes legacy over-escaped content on render", () => {
    expect(markdownToHtml("\\[DUNG\\-022\\] EC\\-29")).toBe("<p>[DUNG-022] EC-29</p>");
  });

  it("round-trips a literal asterisk without turning it into emphasis", () => {
    const stored = tiptapJsonToMarkdown({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "use a * b and *c*" }] }],
    });
    expect(markdownToHtml(stored)).toBe("<p>use a * b and *c*</p>");
  });

  it("guards a paragraph that starts with a block marker from reparsing", () => {
    const stored = tiptapJsonToMarkdown({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "- not a list" }] }],
    });
    expect(markdownToHtml(stored)).toBe("<p>- not a list</p>");
  });

  it("serializes supported editor JSON back to canonical Markdown", () => {
    expect(tiptapJsonToMarkdown({
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
        { type: "paragraph", content: [{ type: "text", text: "Make ", }, { type: "text", text: "bold", marks: [{ type: "bold" }] }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [{ type: "paragraph", content: [{ type: "text", text: "Done" }] }] }] },
        { type: "image", attrs: { src: "lotus-note-asset://asset_1", alt: "shot", align: "right", size: "s" } },
      ],
    })).toBe("# Title\n\nMake **bold**\n\n- [x] Done\n\n![shot](lotus-note-asset://asset_1){align=right size=s}");
  });

  describe("S0 — pasted HTML the codec previously flattened or merged", () => {
    it("degrades an ordered list to bullets without merging item text", async () => {
      await expect(htmlToMarkdown("<ol><li>first</li><li>second</li></ol>")).resolves.toBe("- first\n- second");
    });

    it("keeps nested list text as sibling bullets instead of dropping it", async () => {
      await expect(htmlToMarkdown("<ul><li>a<ul><li>nested</li></ul></li><li>b</li></ul>")).resolves.toBe("- a\n- nested\n- b");
    });

    it("preserves newlines inside a pasted code block", async () => {
      await expect(htmlToMarkdown("<pre><code>const a = 1;\nconst b = 2;</code></pre>")).resolves.toBe("const a = 1;\nconst b = 2;");
    });

    it("degrades a table to one row per line instead of gluing every cell together", async () => {
      await expect(htmlToMarkdown("<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>")).resolves.toBe("a b\nc d");
    });

    it("keeps a link's URL as Markdown link syntax instead of dropping it", async () => {
      await expect(htmlToMarkdown("<p>see <a href=\"https://example.com\">the docs</a> now</p>")).resolves.toBe("see [the docs](https://example.com) now");
    });

    it("clamps deep headings (h3-h6) to h2 instead of losing the heading marker", async () => {
      await expect(htmlToMarkdown("<h3>Deep heading</h3>")).resolves.toBe("## Deep heading");
    });

    it("drops the blockquote marker but keeps the quoted text", async () => {
      await expect(htmlToMarkdown("<blockquote><p>quoted</p></blockquote>")).resolves.toBe("quoted");
    });

    it("joins sibling paragraphs inside one list item with a space instead of gluing them", async () => {
      await expect(htmlToMarkdown("<ul><li><p>alpha</p><p>beta</p></li></ul>")).resolves.toBe("- alpha beta");
    });

    it("joins sibling divs inside one list item with a space instead of gluing them", async () => {
      await expect(htmlToMarkdown("<ul><li><div>alpha</div><div>beta</div></li></ul>")).resolves.toBe("- alpha beta");
    });

    it("joins sibling paragraphs inside one table cell with a space instead of gluing them", async () => {
      await expect(htmlToMarkdown("<table><tr><td><p>x</p><p>y</p></td></tr></table>")).resolves.toBe("x y");
    });

    it("resolves a table nested inside a cell without duplicating the inner row", async () => {
      await expect(htmlToMarkdown("<table><tr><td>outer</td><td><table><tr><td>inner</td></tr></table></td></tr></table>")).resolves.toBe("outer inner");
    });

    it("keeps multi-paragraph blocks (div, blockquote) as separate lines — control, must not regress", async () => {
      await expect(htmlToMarkdown("<div><p>satu</p><p>dua</p></div>")).resolves.toBe("satu\n\ndua");
      await expect(htmlToMarkdown("<blockquote><p>satu</p><p>dua</p></blockquote>")).resolves.toBe("satu\n\ndua");
    });

    it("never silently drops or merges text from unsupported pasted HTML", async () => {
      // Generic guard for this whole bug class, not just the seven cases above: every "word" the
      // browser would show for the pasted HTML must survive as its own word in the Markdown output.
      // Tokens are taken per text-leaf (not from the whole subtree's .textContent) so an element
      // boundary — e.g. adjacent <td>s with no whitespace between them — can't quietly glue two
      // words into one token on the input side; and tokens are compared as contiguous alnum runs
      // (not a naive `/\s+/` split) so Markdown syntax that's legitimately attached without a space
      // — `[the docs](url)`, `## Heading` — doesn't produce a false failure.
      const fixtures = [
        "<h1>Title</h1><p><strong>Bold</strong> <em>em</em></p><ul><li>one</li><li><input type='checkbox' checked>done</li></ul>",
        "<ol><li>first</li><li>second</li></ol>",
        "<ul><li>a<ul><li>nested</li></ul></li><li>b</li></ul>",
        "<pre><code>const a = 1;\nconst b = 2;</code></pre>",
        "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>",
        "<p>see <a href=\"https://example.com\">the docs</a> now</p>",
        "<h3>Deep heading</h3>",
        "<blockquote><p>quoted</p></blockquote>",
        "<ul><li><p>alpha</p><p>beta</p></li></ul>",
        "<ul><li><div>alpha</div><div>beta</div></li></ul>",
        "<table><tr><td><p>x</p><p>y</p></td></tr></table>",
        "<table><tr><td>outer</td><td><table><tr><td>inner</td></tr></table></td></tr></table>",
        // A list or table nested one level INSIDE a cell / list item. These three are what make
        // LINE_BLOCK_TAGS load-bearing: without that branch htmlLineOf falls back to htmlInline,
        // whose unknown-tag path concatenates children with no separator, and these collapse to
        // "ab" / "- mn" / "pq". Found by mutation-testing the constant to `[]` and watching the
        // whole suite stay green — the fix was correct, the net around it had a hole.
        "<table><tr><td><ul><li>a</li><li>b</li></ul></td></tr></table>",
        "<ul><li><table><tr><td>m</td><td>n</td></tr></table></li></ul>",
        "<table><tr><td><table><tr><td>p</td><td>q</td></tr></table></td></tr></table>",
      ];
      const alnumTokens = (s: string) => new Set((s.match(/[A-Za-z0-9]+/g) ?? []));
      const leafWords = (html: string): string[] => {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const words: string[] = [];
        const walk = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) { words.push(...(node.textContent ?? "").match(/[A-Za-z0-9]+/g) ?? []); return; }
          node.childNodes.forEach(walk);
        };
        doc.body.childNodes.forEach(walk);
        return words;
      };
      for (const html of fixtures) {
        const output = await htmlToMarkdown(html);
        const outputTokens = alnumTokens(output);
        for (const word of leafWords(html)) {
          expect(outputTokens.has(word), `expected "${word}" (from ${html}) to survive as its own token in "${output}"`).toBe(true);
        }
      }
    });
  });
});
