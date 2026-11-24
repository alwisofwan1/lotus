import { describe, expect, it } from "vitest";
import { EMPTY_DIALOGUE_STATE, lastMentionedIds, recordNlTurn, type NlTurnRecord } from "../canvas-nl-dialogue-state";

const turn = (utterance: string, ids: string[], outcome: "ok" | "error" = "ok"): NlTurnRecord => ({
  utterance,
  actions: ["open_browser"],
  resolvedNodeIds: ids,
  outcome,
});

describe("canvas-nl-dialogue-state", () => {
  it("records turns newest-first and caps the ring buffer at 5", () => {
    let state = EMPTY_DIALOGUE_STATE;
    for (let i = 1; i <= 7; i++) state = recordNlTurn(state, turn(`cmd ${i}`, [`n${i}`]));
    expect(state.recent).toHaveLength(5);
    expect(state.recent[0].utterance).toBe("cmd 7"); // newest first
    expect(state.recent.at(-1)!.utterance).toBe("cmd 3"); // oldest two dropped
  });

  it("does not mutate the previous state (pure)", () => {
    const s0 = EMPTY_DIALOGUE_STATE;
    const s1 = recordNlTurn(s0, turn("a", ["n1"]));
    expect(s0.recent).toHaveLength(0);
    expect(s1.recent).toHaveLength(1);
  });

  it("resolves lastMentioned to the most recent turn's still-alive node ids", () => {
    let state = EMPTY_DIALOGUE_STATE;
    state = recordNlTurn(state, turn("buka 2 browser", ["b1", "b2"]));
    expect(lastMentionedIds(state, new Set(["b1", "b2", "t1"]))).toEqual(["b1", "b2"]);
  });

  it("skips a turn whose nodes were all since closed, falling back to an earlier live turn", () => {
    let state = EMPTY_DIALOGUE_STATE;
    state = recordNlTurn(state, turn("buka browser", ["b1"]));
    state = recordNlTurn(state, turn("buka terminal", ["t1"])); // newest
    // t1 has since been closed → fall back to the browser turn.
    expect(lastMentionedIds(state, new Set(["b1"]))).toEqual(["b1"]);
  });

  it("returns nothing when there is no recent turn with a live node", () => {
    expect(lastMentionedIds(EMPTY_DIALOGUE_STATE, new Set(["b1"]))).toEqual([]);
    const state = recordNlTurn(EMPTY_DIALOGUE_STATE, turn("buka browser", ["b1"]));
    expect(lastMentionedIds(state, new Set(["other"]))).toEqual([]);
  });
});
