import { describe, it, expect } from "vitest";
import { planAgentChain } from "../plan-run";
import type { AgentRef } from "../plan-owner";
import type { CanvasPlanStep } from "../../types/canvas";

const roster: AgentRef[] = [
  { id: "b", name: "Backend Engineer" },
  { id: "f", name: "Frontend Engineer" },
];

describe("planAgentChain", () => {
  it("resolves step owners (short names) to a linear run chain in plan order", () => {
    const steps: CanvasPlanStep[] = [
      { title: "API", owner: "Backend" },
      { title: "manual step" },             // no owner — skipped
      { title: "UI", owner: "Frontend" },
      { title: "deploy", owner: "Ghost" },  // unresolvable — skipped
    ];
    expect(planAgentChain(steps, roster)).toEqual({
      nodeIds: ["b", "f"],
      deps: [{ from: "b", to: "f" }],
    });
  });

  it("runs each agent once even if it owns multiple steps", () => {
    const steps: CanvasPlanStep[] = [
      { title: "1", owner: "Backend" },
      { title: "2", owner: "Frontend" },
      { title: "3", owner: "Backend" },
    ];
    expect(planAgentChain(steps, roster).nodeIds).toEqual(["b", "f"]);
  });

  it("honors a manual binding when the name no longer resolves", () => {
    const renamed: AgentRef[] = [{ id: "b", name: "BE" }];
    expect(planAgentChain([{ title: "x", owner: "Backend" }], renamed).nodeIds).toEqual([]);
    expect(planAgentChain([{ title: "x", owner: "Backend" }], renamed, { Backend: "b" }).nodeIds).toEqual(["b"]);
  });

  it("returns an empty chain when no owner resolves", () => {
    expect(planAgentChain([{ title: "x" }], roster)).toEqual({ nodeIds: [], deps: [] });
  });
});
