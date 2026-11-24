import { describe, it, expect } from "vitest";
import { capActions, buildRunRecord, MAX_RUN_ACTIONS } from "../agent-run-record";

describe("capActions", () => {
  it("keeps short action lists untouched", () => {
    expect(capActions(["a", "b"])).toEqual(["a", "b"]);
  });

  it("retains the most recent actions with a truncation marker", () => {
    const many = Array.from({ length: MAX_RUN_ACTIONS + 5 }, (_, i) => `act-${i}`);
    const capped = capActions(many);
    expect(capped).toHaveLength(MAX_RUN_ACTIONS + 1);
    expect(capped[0]).toMatch(/earlier/);
    expect(capped[capped.length - 1]).toBe(`act-${many.length - 1}`);
  });
});

describe("buildRunRecord", () => {
  it("assembles a record with a duration-ready shape and capped actions", () => {
    const rec = buildRunRecord({
      agentId: "node-1", kind: "run", outcome: "completed",
      startedAt: 100, endedAt: 2100, sessionId: "s1",
      actions: ["Reading a.ts", "Running: npm test"], summary: "done",
    });
    expect(rec).toMatchObject({
      agentId: "node-1", kind: "run", outcome: "completed",
      startedAt: 100, endedAt: 2100, sessionId: "s1", summary: "done",
      actions: ["Reading a.ts", "Running: npm test"],
    });
    expect(typeof rec.id).toBe("string");
    expect(rec.id.length).toBeGreaterThan(0);
  });
});
