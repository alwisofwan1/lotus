import { describe, expect, it } from "vitest";
import {
  allocateAgentAddress,
  buildFleetAliases,
  resolveFleetTarget,
} from "../fleet-naming";

describe("fleet-naming", () => {
  it("allocates stable monotonic addresses per provider family", () => {
    let counters = {};
    const first = allocateAgentAddress(counters, "codex");
    counters = first.counters;
    const second = allocateAgentAddress(counters, "codex --model gpt-5.5");
    counters = second.counters;
    const third = allocateAgentAddress(counters, "claude");

    expect(first.agentAddress).toBe("codex-1");
    expect(second.agentAddress).toBe("codex-2");
    expect(third.agentAddress).toBe("claude-1");
  });

  it("resolves address and unique custom display aliases to pane ids", () => {
    const fleet = [
      {
        paneId: "pane-a",
        isAlive: true,
        agentAddress: "codex-1",
        displayName: "Reviewer",
        aliases: buildFleetAliases({
          paneId: "pane-a",
          agentAddress: "codex-1",
          displayName: "Reviewer",
        }),
      },
      {
        paneId: "pane-b",
        isAlive: true,
        agentAddress: "codex-2",
        displayName: "Codex",
        aliases: buildFleetAliases({
          paneId: "pane-b",
          agentAddress: "codex-2",
          displayName: "Codex",
        }),
      },
    ];

    expect(resolveFleetTarget(fleet, "@codex-1")?.paneId).toBe("pane-a");
    expect(resolveFleetTarget(fleet, "Reviewer")?.paneId).toBe("pane-a");
    expect(resolveFleetTarget(fleet, "pane-b")?.paneId).toBe("pane-b");
  });

  it("does not resolve ambiguous custom display aliases", () => {
    const fleet = [
      { paneId: "pane-a", isAlive: true, agentAddress: "codex-1", displayName: "Reviewer" },
      { paneId: "pane-b", isAlive: true, agentAddress: "codex-2", displayName: "Reviewer" },
    ];

    expect(resolveFleetTarget(fleet, "Reviewer")).toBeNull();
    expect(resolveFleetTarget(fleet, "codex-2")?.paneId).toBe("pane-b");
  });

  it("prioritizes stable agent addresses over custom aliases", () => {
    const fleet = [
      { paneId: "pane-a", isAlive: true, agentAddress: "codex-1", displayName: "Codex" },
      { paneId: "pane-b", isAlive: true, agentAddress: "codex-2", displayName: "codex-1" },
    ];

    expect(resolveFleetTarget(fleet, "codex-1")?.paneId).toBe("pane-a");
  });
});
