import { describe, it, expect } from "vitest";
import { parseSkillNames, cleanNames } from "../agent-skill-prompt";

describe("cleanNames", () => {
  it("trims, drops blanks, and de-duplicates preserving order", () => {
    expect(cleanNames([" tdd ", "tdd", "", "  ", "qa"])).toEqual(["tdd", "qa"]);
  });
});

describe("parseSkillNames", () => {
  it("splits a comma-separated string into clean names", () => {
    expect(parseSkillNames(" tdd, frontend-design ,, qa ")).toEqual(["tdd", "frontend-design", "qa"]);
  });

  it("returns empty array for blank input", () => {
    expect(parseSkillNames("   ")).toEqual([]);
  });
});
