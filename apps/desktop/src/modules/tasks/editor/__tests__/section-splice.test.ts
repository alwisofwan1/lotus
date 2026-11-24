import { Editor, type JSONContent } from "@tiptap/core";
import { afterAll, describe, expect, it } from "vitest";
import { ticketEditorExtensions } from "@/modules/tasks/editor/ticket-editor-extensions";
import { editorCodec, snapshotSection, spliceSection } from "@/modules/tasks/editor/section-splice";

/**
 * The write-back contract, against the editor's real schema and serializer: untouched text comes
 * back byte for byte, and an edit changes the block it was made in and nothing else.
 */
const editor = new Editor({ extensions: ticketEditorExtensions("") });
const { parse, serialize } = editorCodec(editor);
afterAll(() => editor.destroy());

const roundTrip = (markdown: string) => spliceSection(snapshotSection(markdown, parse), parse(markdown), serialize);

function edit(markdown: string, change: (doc: JSONContent[]) => void) {
  const snapshot = snapshotSection(markdown, parse);
  const doc = structuredClone(parse(markdown));
  change(doc);
  return spliceSection(snapshot, doc, serialize);
}

function firstText(node: JSONContent): JSONContent {
  if (node.type === "text") return node;
  for (const child of node.content ?? []) {
    const hit = firstText(child);
    if (hit) return hit;
  }
  return undefined as never;
}

const MESSY = [
  "Hand-wrapped prose that the editor would otherwise join into one line,",
  "with `snake_case` and ~1 day and a < sign and [[TKT-836]].",
  "",
  "| Risk                           | Impact        |",
  "| ------------------------------ | ------------- |",
  "| padded                         | cells         |",
  "",
  "<!-- Gather before planning: parent epic + siblings. -->",
  "- Parent epic: [[TKT-599]]",
  "    ",
  "- [ ] first",
  "- [ ] second",
].join("\n");

describe("writing a section back", () => {
  it("returns untouched text byte for byte — padding, escapes, wraps, comments and all", () => {
    expect(roundTrip(MESSY)).toBe(MESSY);
  });

  it("changes only the paragraph that was edited", () => {
    const out = edit(MESSY, (doc) => {
      firstText(doc[0]).text = "Rewritten opening, ";
    });
    const [, rest] = [MESSY.split("\n\n")[0], MESSY.slice(MESSY.indexOf("\n\n"))];
    expect(out.endsWith(rest)).toBe(true);
    expect(out.startsWith("Rewritten opening, ")).toBe(true);
  });

  it("keeps an Obsidian [[link]] as brackets, never as escaped text", () => {
    const out = edit("See [[TKT-836]] now.", (doc) => {
      firstText(doc[0]).text = "Please see ";
    });
    expect(out).toBe("Please see [[TKT-836]] now.");
  });

  it("keeps a hand wrap in an edited paragraph as the newline it was", () => {
    const out = edit("line one\nline two", (doc) => {
      firstText(doc[0]).text = "LINE one";
    });
    expect(out).toBe("LINE one\nline two");
  });

  it("never drops an HTML comment, even when everything around it is deleted", () => {
    const out = edit("<!-- keep me -->\nSome prose.", (doc) => {
      doc.splice(0, doc.length);
    });
    expect(out).toContain("<!-- keep me -->");
  });

  it("writes a new paragraph between untouched blocks without disturbing them", () => {
    const source = "First.\n\nThird.";
    const out = edit(source, (doc) => {
      doc.splice(1, 0, { type: "paragraph", content: [{ type: "text", text: "Second." }] });
    });
    expect(out).toBe("First.\n\nSecond.\n\nThird.");
  });

  it("ticking a checkbox rewrites the checklist in the same tight shape", () => {
    const out = edit("- [ ] first\n- [ ] second\n\nAfter.", (doc) => {
      doc[0].content![0].attrs = { ...doc[0].content![0].attrs, checked: true };
    });
    expect(out).toBe("- [x] first\n- [ ] second\n\nAfter.");
  });

  it("and a LOOSE checklist stays loose", () => {
    const out = edit("- [ ] first\n\n- [ ] second", (doc) => {
      doc[0].content![1].attrs = { ...doc[0].content![1].attrs, checked: true };
    });
    expect(out).toBe("- [ ] first\n\n- [x] second");
  });
});
