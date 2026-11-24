import { describe, expect, it } from "vitest";
import { foldForMatch, normalizeNameQuery } from "../canvas-name-match";

describe("normalizeNameQuery", () => {
  it("lowercases, trims, and strips surrounding quotes + trailing punctuation", () => {
    expect(normalizeNameQuery("  'Browser 2' ")).toBe("browser 2");
    expect(normalizeNameQuery("Skye!")).toBe("skye");
    expect(normalizeNameQuery('"Fix auth bug"')).toBe("fix auth bug");
  });
});

describe("foldForMatch (STT number/homophone folding)", () => {
  it("folds spoken number words to digits so 'Browser two' matches 'Browser 2'", () => {
    expect(foldForMatch("Browser two")).toBe("browser 2");
    expect(foldForMatch("Browser 2")).toBe("browser 2");
  });

  it("folds the common STT slip 'too' → 2", () => {
    expect(foldForMatch("browser too")).toBe("browser 2");
  });

  it("folds Indonesian number words (the user speaks Indonesian)", () => {
    expect(foldForMatch("terminal satu")).toBe("terminal 1");
    expect(foldForMatch("browser tiga")).toBe("browser 3");
  });

  it("leaves non-number names unchanged (beyond normalization)", () => {
    expect(foldForMatch("Shopping list")).toBe("shopping list");
  });
});
