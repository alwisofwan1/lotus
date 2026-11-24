import { describe, expect, it } from "vitest";
import { notionTicketBody } from "../factory-notion";

describe("notionTicketBody", () => {
  it("lists the properties before the page", () => {
    const body = notionTicketBody({
      properties: [
        ["Priority", "High"],
        ["Sprint", "S12"],
      ],
      markdown: "## Steps\n\n1. Open the form\n",
      truncated: false,
    });
    expect(body).toBe("Properties:\n- Priority: High\n- Sprint: S12\n\n## Steps\n\n1. Open the form");
  });

  it("says when the page was cut, and has no empty parts", () => {
    expect(notionTicketBody({ properties: [], markdown: "Text", truncated: true })).toBe(
      "Text\n\n(The page is longer than this. Open it in Notion for the rest.)",
    );
    expect(notionTicketBody({ properties: [], markdown: "  ", truncated: false })).toBe("");
  });
});
