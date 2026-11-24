import { describe, expect, it } from "vitest";
import {
  bareSkillName,
  formatSkillInvocation,
  skillDisplayToken,
  skillInvocationStyleFor,
} from "../skill-invocation";

const SKILL = { name: "teach", path: "/Users/me/.claude/skills/teach/SKILL.md" };

describe("skillInvocationStyleFor", () => {
  it("gives every Claude-family runner the slash sigil", () => {
    for (const runner of ["claude", "ccs", "csp"]) {
      expect(skillInvocationStyleFor(runner)).toEqual({ kind: "sigil", sigil: "/" });
    }
  });

  it("defaults an unknown/absent runner to Claude", () => {
    expect(skillInvocationStyleFor(undefined)).toEqual({ kind: "sigil", sigil: "/" });
  });

  it("gives codex the dollar sigil", () => {
    expect(skillInvocationStyleFor("codex")).toEqual({ kind: "sigil", sigil: "$" });
  });

  it("falls back to a file reference rather than guessing a sigil", () => {
    expect(skillInvocationStyleFor("cursor")).toEqual({ kind: "file-reference" });
    expect(skillInvocationStyleFor("custom")).toEqual({ kind: "file-reference" });
  });

  it("honours the Runner Registry claudeFamily override on a custom runner", () => {
    expect(skillInvocationStyleFor("custom", true)).toEqual({ kind: "sigil", sigil: "/" });
  });
});

describe("formatSkillInvocation", () => {
  it("emits the runner's own token, trailing space included", () => {
    expect(formatSkillInvocation(skillInvocationStyleFor("claude"), SKILL)).toBe("/teach ");
    expect(formatSkillInvocation(skillInvocationStyleFor("codex"), SKILL)).toBe("$teach ");
  });

  it("points a registry-less runner at the SKILL.md instead", () => {
    expect(formatSkillInvocation(skillInvocationStyleFor("cursor"), SKILL))
      .toBe(`Read and apply the skill at ${SKILL.path} `);
  });

  it("falls back to the slash form when a registry-less runner has no path", () => {
    expect(formatSkillInvocation(skillInvocationStyleFor("cursor"), { name: "teach" })).toBe("/teach ");
  });

  it("never doubles a sigil the caller already added", () => {
    expect(formatSkillInvocation(skillInvocationStyleFor("codex"), { name: "/teach" })).toBe("$teach ");
    expect(formatSkillInvocation(skillInvocationStyleFor("claude"), { name: "$teach" })).toBe("/teach ");
  });

  it("emits nothing for a blank name", () => {
    expect(formatSkillInvocation(skillInvocationStyleFor("claude"), { name: "  " })).toBe("");
  });
});

describe("skillDisplayToken", () => {
  it("prints exactly what will be inserted", () => {
    expect(skillDisplayToken(skillInvocationStyleFor("claude"), "teach")).toBe("/teach");
    expect(skillDisplayToken(skillInvocationStyleFor("codex"), "teach")).toBe("$teach");
  });

  it("prints a bare name when there is no token to promise", () => {
    expect(skillDisplayToken(skillInvocationStyleFor("cursor"), "teach")).toBe("teach");
  });
});

describe("bareSkillName", () => {
  it("strips leading sigils and surrounding space", () => {
    expect(bareSkillName("  /teach ")).toBe("teach");
    expect(bareSkillName("$teach")).toBe("teach");
  });
});
