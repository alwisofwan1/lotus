import { describe, expect, it } from "vitest";
import {
  diffSummary,
  lineDiff,
  notionIsNewer,
  notionPageIdOf,
  pulledSectionBody,
  samePageId,
} from "@/modules/tasks/services/notes-pull";

describe("a Notion page as the note's From Notion section", () => {
  it("lowers headings that would start a new section of the note, even a line in code", () => {
    const body = pulledSectionBody("# Title\n## Acceptance\n### Kept\n```\n## in code\nx = 1\n```");
    // The vault cuts at every `## ` line, fences or not; code only gains a space in front of one.
    expect(body).toBe("### Title\n\n### Acceptance\n\n### Kept\n\n```\n ## in code\nx = 1\n```");
    expect(body.split("\n").some((line) => line.startsWith("## "))).toBe(false);
  });

  it("makes Notion's own markup plain, and a callout an Obsidian callout", () => {
    const body = pulledSectionBody('<callout icon="💡" color="blue_bg">Shared endpoint.</callout>\n<empty-block/>\n- AC1 one');
    expect(body).toContain("> [!note] 💡");
    expect(body).toContain("Shared endpoint.");
    expect(body).not.toMatch(/<|/);
    expect(body).toContain("- AC1 one");
  });
});

describe("the change a pull would make", () => {
  it("keeps common lines and marks what went and what came", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("says it in one line, a replaced line counting as one change", () => {
    expect(diffSummary(lineDiff("a\nb\nc", "a\nB\nc\nd"))).toBe("1 line changed, 1 added");
    expect(diffSummary(lineDiff("", "x\ny"))).toBe("2 added");
    expect(diffSummary(lineDiff("same", "same"))).toBe("No changes");
  });
});

describe("which Notion page a note points at", () => {
  it("reads the id at the end of a page URL, with or without the title and query", () => {
    const url =
      "https://app.notion.com/p/acme/Stripe-webhooks-stop-t02-d01-processing-each-other-s-events-3e42eae039e480ccb605c8e01836e1e2?v=1cf2&source=copy_link";
    expect(notionPageIdOf(url)).toBe("3e42eae0-39e4-80cc-b605-c8e01836e1e2");
    expect(notionPageIdOf("https://www.notion.so/3e42eae0-39e4-80cc-b605-c8e01836e1e2")).toBe("3e42eae0-39e4-80cc-b605-c8e01836e1e2");
    expect(notionPageIdOf("https://app.notion.com/p/acme/TKT-987")).toBeNull();
    expect(notionPageIdOf(null)).toBeNull();
  });

  it("compares ids without caring for dashes or case", () => {
    expect(samePageId("3E42EAE039E480CCB605C8E01836E1E2", "3e42eae0-39e4-80cc-b605-c8e01836e1e2")).toBe(true);
  });
});

describe("whether Notion is newer than the note", () => {
  it("compares Notion's edit time with the one the note was pulled at", () => {
    expect(notionIsNewer("2026-09-28T13:12:00.000Z", "2026-09-26T09:40:00.000Z")).toBe(true);
    expect(notionIsNewer("2026-09-26T09:40:00.000Z", "2026-09-26T09:40:00.000Z")).toBe(false);
    expect(notionIsNewer("2026-09-26T09:40:00.000Z", null)).toBe(true);
  });
});
