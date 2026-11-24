import { describe, expect, it } from "vitest";
import type { AgentStatusSnapshot } from "../../services/agent-status-registry";
import { askingAgentIds } from "../useAutomationAgentWatch";

const snap = (id: string, status: AgentStatusSnapshot["status"]): AgentStatusSnapshot => ({ id, name: id, status });

describe("askingAgentIds", () => {
  it("counts a permission prompt, and an idle only after the agent ran", () => {
    const ran = new Set<string>();
    expect([...askingAgentIds([snap("a", "needs-you"), snap("b", "idle")], ran)]).toEqual(["a"]);
    expect([...askingAgentIds([snap("b", "running")], ran)]).toEqual([]);
    expect([...askingAgentIds([snap("b", "idle")], ran)]).toEqual(["b"]);
  });
});
