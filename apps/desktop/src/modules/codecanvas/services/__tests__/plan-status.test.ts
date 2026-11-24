import { describe, it, expect } from "vitest";
import { stepStatus, planProgress } from "../plan-status";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const roster: AgentStatusSnapshot[] = [
  { id: "be", name: "Backend Engineer", status: "running" },
  { id: "fe", name: "Frontend Engineer", status: "completed" },
  { id: "qa", name: "QA / Test Engineer", status: "error" },
];

describe("stepStatus", () => {
  it("reflects the resolved owner agent's live status (short owner → full name)", () => {
    expect(stepStatus({ title: "x", owner: "Backend" }, roster)).toBe("running");
    expect(stepStatus({ title: "x", owner: "Frontend" }, roster)).toBe("done");
    expect(stepStatus({ title: "x", owner: "QA" }, roster)).toBe("failed");
  });

  it("falls back to manual done / pending without a resolvable owner", () => {
    expect(stepStatus({ title: "x", owner: "Ghost" }, roster)).toBe("pending");
    expect(stepStatus({ title: "x", done: true }, roster)).toBe("done");
    expect(stepStatus({ title: "x" }, roster)).toBe("pending");
  });

  it("uses a manual binding so a renamed agent still resolves", () => {
    const renamed: AgentStatusSnapshot[] = [{ id: "be", name: "BE", status: "completed" }];
    expect(stepStatus({ title: "x", owner: "Backend" }, renamed)).toBe("pending"); // name miss
    expect(stepStatus({ title: "x", owner: "Backend" }, renamed, { Backend: "be" })).toBe("done");
  });
});

describe("planProgress", () => {
  it("counts done steps against the total", () => {
    const steps = [
      { title: "a", owner: "Frontend" }, // done (completed)
      { title: "b", done: true },        // done (manual)
      { title: "c", owner: "Backend" },  // running
      { title: "d" },                    // pending
    ];
    expect(planProgress(steps, roster)).toEqual({ done: 2, total: 4, ratio: 0.5 });
  });

  it("is zero-safe for an empty plan", () => {
    expect(planProgress([], roster)).toEqual({ done: 0, total: 0, ratio: 0 });
  });

  // Regression: short owners ("Backend") + full agent names ("Backend Engineer") + ownerless gates.
  it("credits owned steps after agents complete; ownerless gates stay pending", () => {
    const done = roster.map((r) => ({ ...r, status: "completed" as const }));
    const steps = [
      { title: "All tasks pass acceptance criteria" }, // ownerless gate
      { title: "Reviewer PASS verdict" },              // ownerless gate
      { title: "Add search store methods", owner: "Backend" },
      { title: "Extend router", owner: "Backend" },
      { title: "Build search UI", owner: "Frontend" },
      { title: "QA sign-off", owner: "QA" },
    ];
    expect(planProgress(steps, done)).toMatchObject({ done: 4, total: 6 });
  });
});
