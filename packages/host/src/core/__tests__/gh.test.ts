import { describe, it, expect } from "vitest";

import { verdictLine } from "../gh.js";

/**
 * Measured against the real CLI on 2026-09-11, after a live clone failure came back reading
 * `gh auth status → github.com` — the hostname, which tells an operator nothing.
 */
describe("verdictLine", () => {
  it("skips the hostname line gh prints first and takes the verdict under it", () => {
    const real = [
      "github.com",
      "  ✓ Logged in to github.com account alwisofwan1 (keyring)",
      "  - Active account: true",
      "  - Token scopes: 'gist', 'repo'",
    ].join("\n");

    expect(verdictLine(real)).toBe("Logged in to github.com account alwisofwan1 (keyring)");
  });

  it("finds the verdict when gh is not logged in", () => {
    expect(verdictLine("github.com\n  X You are not logged into any GitHub hosts."))
      .toBe("You are not logged into any GitHub hosts.");
  });

  it("answers empty when nothing in the output is a verdict, so the caller can say so", () => {
    expect(verdictLine("command not found: gh")).toBe("");
  });
});
