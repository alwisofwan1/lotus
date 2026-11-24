import { describe, it, expect } from "vitest";
import {
  createSpawnBudget,
  spawnBudgetExhaustedMessage,
  DEFAULT_MCP_SPAWN_BUDGET,
} from "../canvas-spawn-budget";

describe("createSpawnBudget", () => {
  it("allows spawns up to the limit, then refuses", () => {
    const budget = createSpawnBudget(3);
    expect([budget.tryConsume(), budget.tryConsume(), budget.tryConsume()]).toEqual([true, true, true]);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.spent()).toBe(3);
    expect(budget.remaining()).toBe(0);
  });

  it("keeps refusing once exhausted — a retrying agent cannot walk past the ceiling", () => {
    const budget = createSpawnBudget(1);
    budget.tryConsume();
    for (let i = 0; i < 10; i += 1) expect(budget.tryConsume()).toBe(false);
    expect(budget.spent()).toBe(1);
  });

  it("refuses everything at a zero limit", () => {
    const budget = createSpawnBudget(0);
    expect(budget.tryConsume()).toBe(false);
    expect(budget.remaining()).toBe(0);
  });

  it("restores the full budget on reset", () => {
    const budget = createSpawnBudget(2);
    budget.tryConsume();
    budget.tryConsume();
    expect(budget.tryConsume()).toBe(false);
    budget.reset();
    expect(budget.remaining()).toBe(2);
    expect(budget.tryConsume()).toBe(true);
  });

  it("falls back to the default for a nonsensical limit", () => {
    expect(createSpawnBudget(Number.NaN).limit()).toBe(DEFAULT_MCP_SPAWN_BUDGET);
    expect(createSpawnBudget(-5).limit()).toBe(DEFAULT_MCP_SPAWN_BUDGET);
  });

  it("names the ceiling in the refusal so the agent reports instead of retrying", () => {
    const message = spawnBudgetExhaustedMessage(createSpawnBudget(7));
    expect(message).toContain("7");
    expect(message).toMatch(/reuse an existing agent/i);
  });
});
