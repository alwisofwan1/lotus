import { describe, expect, it } from "vitest";
import { CRITIC_ROLE_PROMPT, CRITIC_DEFAULT_MODEL } from "../critic-prompt";
import { parseCriticVerdict } from "../critic-verdict";

describe("critic-prompt", () => {
  it("instructs the exact VERDICT tokens the parser reads, and fails closed", () => {
    expect(CRITIC_ROLE_PROMPT).toContain("VERDICT: PASS");
    expect(CRITIC_ROLE_PROMPT).toContain("VERDICT: FAIL");
    expect(CRITIC_ROLE_PROMPT).toMatch(/when in doubt, fail/i);
    // The instructed format round-trips through the parser.
    expect(parseCriticVerdict("ok\nVERDICT: PASS")).toBe("pass");
  });

  it("has a concrete default model", () => {
    expect(CRITIC_DEFAULT_MODEL).toBeTruthy();
  });
});
