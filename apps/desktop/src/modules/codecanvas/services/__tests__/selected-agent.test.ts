import { describe, it, expect } from "vitest";
import { selectedAgentNodeId } from "../canvas-agent-messaging";

describe("selectedAgentNodeId (Dictate target)", () => {
  it("returns the single selected agent's id", () => {
    expect(
      selectedAgentNodeId([
        { id: "a1", type: "agent", selected: false },
        { id: "a2", type: "agent", selected: true },
        { id: "t1", type: "terminal", selected: true },
      ]),
    ).toBe("a2");
  });

  it("returns null when no agent is selected", () => {
    expect(selectedAgentNodeId([{ id: "t1", type: "terminal", selected: true }])).toBeNull();
    expect(selectedAgentNodeId([{ id: "a1", type: "agent", selected: false }])).toBeNull();
  });

  it("returns null when the selection is ambiguous (more than one agent)", () => {
    expect(
      selectedAgentNodeId([
        { id: "a1", type: "agent", selected: true },
        { id: "a2", type: "agent", selected: true },
      ]),
    ).toBeNull();
  });
});
