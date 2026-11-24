import { describe, expect, it } from "vitest";
import { parseCriticVerdict } from "../critic-verdict";

describe("parseCriticVerdict", () => {
  it("reads an explicit PASS verdict", () => {
    expect(parseCriticVerdict("Looks correct.\nVERDICT: PASS")).toBe("pass");
  });

  it("reads an explicit FAIL verdict, case-insensitively", () => {
    expect(parseCriticVerdict("found a bug\nverdict: fail")).toBe("fail");
  });

  it("takes the last verdict when several appear (the agent's final call)", () => {
    expect(parseCriticVerdict("VERDICT: FAIL early\n...reconsidered...\nVERDICT: PASS")).toBe("pass");
  });

  it("defaults to FAIL when no verdict is present (default-deny, gate stays closed)", () => {
    expect(parseCriticVerdict("I reviewed it and have thoughts.")).toBe("fail");
    expect(parseCriticVerdict("")).toBe("fail");
  });

  it("tolerates surrounding markup and punctuation", () => {
    expect(parseCriticVerdict("**VERDICT:** PASS.")).toBe("pass");
    expect(parseCriticVerdict("- verdict = FAIL")).toBe("fail");
  });
});
