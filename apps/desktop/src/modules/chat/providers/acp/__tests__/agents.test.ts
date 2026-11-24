import { describe, expect, it } from "vitest";

import catalog from "@/agents.json";
import { ACP_AGENTS, acpAgent, type AcpRunner } from "../agents";

describe("ACP agents from agents.json", () => {
  it("lists exactly the agents the AcpRunner type names", () => {
    const typed: Record<AcpRunner, true> = { cursor: true, antigravity: true };
    expect(ACP_AGENTS.map((a) => a.id).sort()).toEqual(Object.keys(typed).sort());
    expect(catalog.agents.filter((a) => "acp" in a).length).toBe(ACP_AGENTS.length);
  });

  it("maps all four permission modes for every agent", () => {
    for (const agent of ACP_AGENTS) {
      expect(Object.keys(agent.modes).sort()).toEqual(["acceptEdits", "bypassPermissions", "default", "plan"]);
    }
  });

  it("keeps Antigravity's messages and system-prompt hint, and gives Cursor its own sign-in", () => {
    const agy = acpAgent("antigravity")!;
    expect(agy.binary).toBe("agy");
    expect(agy.systemPromptMeta).toBe("antigravity");
    expect(agy.notSignedIn).toContain("Run `agy`");
    const cursor = acpAgent("cursor")!;
    expect(cursor.binary).toBe("cursor-agent");
    expect(cursor.systemPromptMeta).toBeUndefined();
    expect(cursor.notSignedIn).toContain("`cursor-agent login`");
    // Cursor never asks: anything short of "Allow everything" must stay read-only.
    expect(cursor.modes).toEqual({ default: "plan", acceptEdits: "plan", plan: "plan", bypassPermissions: "agent" });
  });
});
