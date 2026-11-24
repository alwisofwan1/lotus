import { describe, expect, it } from "vitest";
import { DIFF_SPLIT_MIN_WIDTH, resolveDiffLayout } from "../diff-layout";

describe("resolveDiffLayout", () => {
  it("splits a pane at least 760px wide", () => {
    expect(DIFF_SPLIT_MIN_WIDTH).toBe(760);
    expect(resolveDiffLayout(760, null)).toBe("split");
    expect(resolveDiffLayout(1200, null)).toBe("split");
  });

  it("goes inline below 760px", () => {
    expect(resolveDiffLayout(759, null)).toBe("inline");
    expect(resolveDiffLayout(320, null)).toBe("inline");
  });

  it("goes inline until the pane has been measured", () => {
    expect(resolveDiffLayout(null, null)).toBe("inline");
  });

  it("lets a manual choice win over the width", () => {
    expect(resolveDiffLayout(320, "split")).toBe("split");
    expect(resolveDiffLayout(1200, "inline")).toBe("inline");
  });
});
