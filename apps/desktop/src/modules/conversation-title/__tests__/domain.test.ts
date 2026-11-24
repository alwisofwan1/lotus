import { describe, expect, it } from "vitest";
import { MAX_TITLE_CHARS, renameRequest, titleSourceLabel } from "@/modules/conversation-title/domain";

describe("renameRequest", () => {
  it("tidies what was typed", () => {
    expect(renameRequest("  fix   the\ttest ", "Old")).toBe("fix the test");
  });

  it("is nothing when the title did not change", () => {
    expect(renameRequest(" Old ", "Old")).toBeNull();
  });

  it("asks for the automatic title when cleared", () => {
    expect(renameRequest("   ", "Old")).toBe("");
  });

  it("caps a title too long for a header", () => {
    expect(renameRequest("a".repeat(200), "Old")).toHaveLength(MAX_TITLE_CHARS);
  });
});

describe("titleSourceLabel", () => {
  it("names every source", () => {
    for (const source of ["prompt", "auto", "manual"] as const) expect(titleSourceLabel(source)).toBeTruthy();
  });
});
