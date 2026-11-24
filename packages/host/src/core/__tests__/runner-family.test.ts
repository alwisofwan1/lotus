import { describe, expect, it } from "vitest";

import { runnerFamily, runnerProfileId } from "../runner-family.js";

describe("runnerFamily", () => {
  it("places the native runners as themselves", () => {
    expect(runnerFamily("claude")).toEqual({ provider: "claude" });
    expect(runnerFamily("codex")).toEqual({ provider: "codex" });
  });

  /**
   * The omission that cost a whole family its Chat page: `ccs work` is the claude binary under
   * another account's config dir, so the transcript, the hooks and the permission scale are all
   * claude's — but the session recorded no provider at all, the transcript route could not place
   * the pane, and the phone was told the machine records nothing (2026-09-08).
   */
  it("places a ccs account in the claude family, under its own name", () => {
    expect(runnerFamily("ccs:work")).toEqual({ provider: "claude", runnerLabel: "work" });
    expect(runnerFamily("ccs:initech")).toEqual({ provider: "claude", runnerLabel: "initech" });
  });

  it("places nothing for a command the operator invented", () => {
    // Lotus does not know what `opencode` writes or how it asks. Guessing `claude` would
    // promise a Chat page this host cannot read.
    expect(runnerFamily("custom-opencode")).toEqual({});
    expect(runnerFamily("gemini")).toEqual({});
    // A malformed id is not an account.
    expect(runnerFamily("ccs:")).toEqual({});
    expect(runnerFamily("ccs:   ")).toEqual({});
  });

  it("names the claude profile a ccs runner runs as, and nothing for the rest", () => {
    expect(runnerProfileId("ccs:acme")).toBe("acme");
    expect(runnerProfileId("claude")).toBeUndefined();
    expect(runnerProfileId("custom-opencode")).toBeUndefined();
  });
});
