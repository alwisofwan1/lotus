import { describe, expect, it } from "vitest";

import { normalizeAgentReply, renderMobileReplyMarkdown } from "../mobile-reply.js";

describe("normalizeAgentReply", () => {
  it("compacts agent summary bullets into mobile sections", () => {
    const reply = normalizeAgentReply([
      "Done. Here's a summary of what changed:",
      "",
      "- **Title**: `Orchids` → `Lotus`",
      "- **Intro**: mentions Bridge, MCP sidecar, and Telegram bot",
      "- **Next step**: run tests before publishing",
    ].join("\n"));

    expect(reply).toEqual({
      title: "✅ Done",
      sections: [{
        title: "Changed",
        bullets: [
          "Title: Orchids → Lotus",
          "Intro: mentions Bridge, MCP sidecar, and Telegram bot",
        ],
      }],
      nextActions: ["run tests before publishing"],
      rawDetail: expect.any(String),
    });
  });
});

describe("renderMobileReplyMarkdown", () => {
  it("renders compact mobile markdown", () => {
    const markdown = renderMobileReplyMarkdown({
      title: "✅ Done",
      sections: [{ title: "Changed", bullets: ["Title: Orchids → Lotus"] }],
      nextActions: ["run tests"],
    });

    expect(markdown).toBe("✅ Done\n\n**Changed**\n- Title: Orchids → Lotus\n\n**Next**\n- run tests");
  });
});
