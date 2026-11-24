import { describe, expect, it } from "vitest";

import { agentPromptFor } from "../templates";

describe("agentPromptFor", () => {
  it("asks for the same summary the skill does, preset and full prompt included", () => {
    const prompt = agentPromptFor("  Every weekday at 9, a PR brief.  ");
    expect(prompt.startsWith("Every weekday at 9, a PR brief.\n\n")).toBe(true);
    expect(prompt).toContain("lotus-automation skill");
    expect(prompt).toContain("preset");
    expect(prompt).toContain("full prompt");
    expect(prompt).toContain("wait for my yes");
  });
});
