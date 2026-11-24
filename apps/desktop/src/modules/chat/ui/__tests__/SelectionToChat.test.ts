import { describe, expect, it } from "vitest";

import { selectionMention } from "../SelectionToChat";

describe("selectionMention", () => {
  it("cites the lines and fences the code", () => {
    expect(selectionMention("src/a.ts", 3, 5, "a\nb\nc\n\n")).toBe("`src/a.ts:L3-5`\n```\na\nb\nc\n```\n");
    expect(selectionMention("a.md", 7, 7, "x")).toBe("`a.md:L7`\n```\nx\n```\n");
  });

  it("uses a longer fence when the code holds one", () => {
    expect(selectionMention("a.md", 1, 2, "```js\n```")).toContain("````\n```js\n```\n````");
  });
});
