import { describe, expect, it } from "vitest";

import { savedBy, sentAgo, watchSteps, type Watch } from "../agent-watch";
import type { Automation } from "../automation-api";

const watch: Watch = { request: "r", agent: { id: "n1", name: "Rex" }, sentAtMs: 0, before: ["a"] };
const old = { id: "a", name: "Old", enabled: true } as Automation;
const made = { id: "b", name: "New one", enabled: false } as Automation;

describe("agent watch (16e v2)", () => {
  it("counts as saved only an automation that was not there before", () => {
    expect(savedBy(watch, [old])).toBeNull();
    expect(savedBy(watch, [old, made])).toBe(made);
  });
  it("makes the next step the only active one", () => {
    expect(watchSteps(watch, { alive: true, saved: null }).map((s) => s.state)).toEqual(["done", "active", "todo"]);
    expect(watchSteps(watch, { alive: false, saved: null })[1]).toMatchObject({ state: "failed", title: "Terminal closed" });
    const saved = watchSteps(watch, { alive: false, saved: made });
    expect(saved.map((s) => s.state)).toEqual(["done", "done", "active"]);
    expect(saved[2]).toMatchObject({ title: "New one · saved", sub: "Switched off" });
  });
  it("says the agent is asking only while it is alive and nothing is saved", () => {
    expect(watchSteps(watch, { alive: true, saved: null, asking: true })[1]).toMatchObject({ state: "active", title: "Rex is asking you" });
    expect(watchSteps(watch, { alive: false, saved: null, asking: true })[1]).toMatchObject({ state: "failed" });
    expect(watchSteps(watch, { alive: true, saved: made, asking: true })[1]).toMatchObject({ state: "done" });
  });
  it("says how long ago it was sent", () => {
    expect(sentAgo(0, 12_000)).toBe("12s ago");
    expect(sentAgo(0, 180_000)).toBe("3m ago");
  });
});
