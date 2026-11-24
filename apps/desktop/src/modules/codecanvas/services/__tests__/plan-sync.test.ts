import { describe, expect, it } from "vitest";
import { classifyPlanSync } from "../plan-sync";

describe("classifyPlanSync", () => {
  it("reports a missing plan.md", () => {
    const status = classifyPlanSync({ found: false, steps: [] });
    expect(status.kind).toBe("missing");
    expect(status.message).toContain("not found");
  });

  it("flags a found-but-unparseable plan.md and names the required format", () => {
    const status = classifyPlanSync({ found: true, steps: [] });
    expect(status.kind).toBe("empty");
    expect(status.message).toContain("- [ ] task (owner: Name)");
  });

  it("counts loaded steps, pluralizing correctly", () => {
    expect(classifyPlanSync({ found: true, steps: [{ title: "a" }] })).toMatchObject({
      kind: "loaded",
      count: 1,
      message: "Loaded 1 step.",
    });
    expect(classifyPlanSync({ found: true, steps: [{ title: "a" }, { title: "b" }] })).toMatchObject({
      kind: "loaded",
      count: 2,
      message: "Loaded 2 steps.",
    });
  });
});
