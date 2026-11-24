import { describe, expect, it } from "vitest";
import { buildS2sCanvasLiveVoiceContext } from "../s2s-canvas-live-context";

describe("buildS2sCanvasLiveVoiceContext", () => {
  it("keeps visible names primary while merging runner aliases into resolver roster", () => {
    const ctx = buildS2sCanvasLiveVoiceContext(
      [
        { id: "sena", type: "agent", data: { name: "Sena", runner: "claude" } },
        { id: "nara", type: "agent", data: { name: "Nara", runner: "claude" } },
        { id: "bima", type: "agent", data: { name: "Bima", runner: "claude" } },
        { id: "bayu", type: "agent", data: { name: "Bayu", runner: "codex" } },
      ],
      [
        { id: "sena", name: "Sena", status: "running" },
        { id: "nara", name: "Nara", status: "running" },
        { id: "bima", name: "Bima", status: "running" },
        { id: "bayu", name: "Bayu", status: "running" },
      ],
    );

    expect(ctx.agentNames).toEqual(["Sena", "Nara", "Bima", "Bayu"]);
    expect(ctx.agentTargetHints).toContain("Bima (Claude / Claude agent / Cloud agent / Claude 3 / Claude three / Claude agent 3)");
    expect(ctx.roster.find((agent) => agent.id === "bima")?.aliases).toContain("Claude 3");
    expect(ctx.roster.find((agent) => agent.id === "bima")?.aliases).toContain("Cloud three");
  });
});
