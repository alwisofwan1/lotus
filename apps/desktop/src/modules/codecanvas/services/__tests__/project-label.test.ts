import { describe, it, expect } from "vitest";
import { headTrimProjectName } from "../project-label";

describe("headTrimProjectName", () => {
  it("passes a short name through unchanged", () => {
    expect(headTrimProjectName("orbit-vault")).toBe("orbit-vault");
  });

  it("passes a name exactly at the limit through unchanged (no ellipsis)", () => {
    const exact = "orchids-claude-agent"; // 20 chars, default max
    expect(exact).toHaveLength(20);
    expect(headTrimProjectName(exact)).toBe(exact);
  });

  it("head-trims the real slug to its informative tail on a segment boundary", () => {
    // The worked example from the plan: the head (which identifies nothing once cut) drops,
    // the tail (which does identify the project) survives behind a leading ellipsis.
    expect(headTrimProjectName("orchids-claude-agent-teams")).toBe("…claude-agent-teams");
  });

  it("never lets the cut land mid-segment, even when a segment boundary sits right at the budget edge", () => {
    // max=8 -> budget=7. "bar-baz" is exactly 7 chars, so it fits whole; one more segment
    // ("foo-bar-baz", 11 chars) would overrun. The "-" before "baz" must never become the
    // character immediately after the ellipsis.
    const result = headTrimProjectName("foo-bar-baz", 8);
    expect(result).toBe("…bar-baz");
    expect(result.startsWith("…-")).toBe(false);
  });

  it("falls back to a plain tail slice when the name has no separators at all", () => {
    const noSeparators = "verylongprojectnamewithoutanyseparators";
    const result = headTrimProjectName(noSeparators, 20);
    expect(result).toBe(`…${noSeparators.slice(noSeparators.length - 19)}`);
    expect(result).toHaveLength(20);
  });

  it("returns an empty string unchanged", () => {
    expect(headTrimProjectName("")).toBe("");
  });
});
