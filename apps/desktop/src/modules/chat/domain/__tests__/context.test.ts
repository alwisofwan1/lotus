import { describe, expect, it } from "vitest";

import { compactCount, contextSummary } from "../context";
import { emptyThreadState, type InteractionState, type TurnState } from "../thread-state";

const turn = (usage: TurnState["usage"]): TurnState => ({ id: "t", input: null, status: "completed", error: null, usage, startedAt: 0, endedAt: 1, items: [] });
const ask = (resolved: boolean): InteractionState =>
  ({ interaction: { id: resolved ? "a" : "b" }, turnId: null, requestedAt: 0, resolution: resolved ? { decision: "allowed", message: null, answers: null, at: 1 } : null }) as InteractionState;

describe("contextSummary", () => {
  it("adds up the turns that reported usage and keeps the newest", () => {
    const state = {
      ...emptyThreadState("x"),
      turns: [
        turn({ inputTokens: 1000, outputTokens: 50, costUsd: 0.01, durationMs: 900 }),
        turn(null),
        turn({ inputTokens: 3000, outputTokens: 70, costUsd: null, durationMs: 1200 }),
      ],
      interactions: [ask(true), ask(false)],
    };
    const s = contextSummary(state);
    expect(s).toMatchObject({ turns: 3, inputTokens: 4000, outputTokens: 120, costUsd: 0.01 });
    expect(s.last?.inputTokens).toBe(3000);
    expect(s.waiting.map((w) => w.interaction.id)).toEqual(["b"]);
  });

  it("is empty for no thread, with no cost rather than zero", () => {
    expect(contextSummary(null)).toEqual({ turns: 0, last: null, inputTokens: 0, outputTokens: 0, costUsd: null, waiting: [], window: null });
  });
});

describe("compactCount", () => {
  it("shortens large counts", () => {
    expect([999, 1234, 12_345, 2_500_000, 3_000_000].map(compactCount)).toEqual(["999", "1.2k", "12k", "2.5M", "3M"]);
  });
});
