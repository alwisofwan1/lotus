import { describe, expect, it } from "vitest";
import { WIKI_HREF_PREFIX, linkWikiReferences } from "@/modules/tasks/services/wiki-links";

describe("Obsidian [[links]] in a brief", () => {
  it("turns a [[key]] into a link the renderer can draw as a reference", () => {
    expect(linkWikiReferences("QA revision of [[TKT-836]].")).toBe(
      `QA revision of [TKT-836](${WIKI_HREF_PREFIX}TKT-836).`,
    );
  });

  it("uses the alias as the label and the target as the reference", () => {
    expect(linkWikiReferences("see [[TKT-836|the parent]]")).toBe(
      `see [the parent](${WIKI_HREF_PREFIX}TKT-836)`,
    );
  });

  it("leaves code alone — a [[x]] inside backticks is literal text", () => {
    expect(linkWikiReferences("`[[TKT-1]]` and [[TKT-2]]")).toBe(
      `\`[[TKT-1]]\` and [TKT-2](${WIKI_HREF_PREFIX}TKT-2)`,
    );
    expect(linkWikiReferences("```\n[[TKT-1]]\n```")).toBe("```\n[[TKT-1]]\n```");
  });

  it("encodes a target with spaces so the link survives markdown parsing", () => {
    expect(linkWikiReferences("[[My Note]]")).toBe(`[My Note](${WIKI_HREF_PREFIX}My%20Note)`);
  });
});
