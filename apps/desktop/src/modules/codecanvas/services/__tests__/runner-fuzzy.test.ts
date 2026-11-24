import { describe, expect, it } from "vitest";
import { fuzzyMatchName, levenshtein, resolveRunnerAlias } from "../runner-fuzzy";

describe("levenshtein", () => {
  it("counts edits", () => {
    expect(levenshtein("wesley", "wesley")).toBe(0);
    expect(levenshtein("wesley", "weasley")).toBe(1); // +a
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("resolveRunnerAlias", () => {
  it("maps common spoken synonyms to a runner (case/space-insensitive)", () => {
    expect(resolveRunnerAlias("cloud")).toBe("claude");
    expect(resolveRunnerAlias("Cloud Agent")).toBe("claude");
    expect(resolveRunnerAlias("  cloud   agent ")).toBe("claude");
    expect(resolveRunnerAlias("openai")).toBe("codex");
    expect(resolveRunnerAlias("banana")).toBeNull();
  });
});

describe("fuzzyMatchName", () => {
  const runners = ["claude", "codex", "cursor", "ccs", "csp", "wesley"];

  it("matches a mis-transcribed custom name to the closest runner", () => {
    expect(fuzzyMatchName("Weasley", runners)).toBe("wesley"); // classic voice slip
    expect(fuzzyMatchName("wesly", runners)).toBe("wesley");
  });

  it("returns an exact/near match and prefers the closest", () => {
    expect(fuzzyMatchName("claude", runners)).toBe("claude");
    expect(fuzzyMatchName("claud", runners)).toBe("claude");
  });

  it("does NOT match unrelated words (tight threshold so 'focus' never becomes 'codex')", () => {
    expect(fuzzyMatchName("focus", runners)).toBeNull();
    expect(fuzzyMatchName("terminal", runners)).toBeNull();
    // Short names demand near-exact: "css" vs "ccs" is 1 edit (ok), "abc" is not.
    expect(fuzzyMatchName("abc", runners)).toBeNull();
  });
});
