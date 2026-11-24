import { describe, expect, it } from "vitest";

import { latestPlan } from "../plan";
import type { ThreadEvent, ThreadEventEnvelope } from "../thread-event";
import { applyThreadEvents, emptyThreadState } from "../thread-state";
import { buildTimelineRows } from "../timeline";

const stateOf = (events: ThreadEvent[]) =>
  applyThreadEvents(
    emptyThreadState("t"),
    events.map((event, i): ThreadEventEnvelope => ({ threadId: "t", seq: i + 1, at: 1000 + i, event })),
  );

const todo = (id: string, todos: unknown): ThreadEvent => ({
  type: "item/started",
  turnId: "u1",
  item: { id, kind: "tool", status: "completed", name: "TodoWrite", input: { todos }, output: null },
});

describe("latestPlan", () => {
  it("reads the newest TodoWrite of the last turn", () => {
    const state = stateOf([
      { type: "turn/started", turnId: "u1", input: null },
      todo("p1", [{ content: "Read", activeForm: "Reading", status: "in_progress" }]),
      todo("p2", [
        { content: "Read", activeForm: "Reading", status: "completed" },
        { content: "Test", activeForm: "Testing", status: "in_progress" },
        { content: "Fix", status: "pending" },
        "junk",
      ]),
    ]);
    expect(latestPlan(state)).toEqual([
      { content: "Read", activeForm: "Reading", status: "done" },
      { content: "Test", activeForm: "Testing", status: "active" },
      { content: "Fix", activeForm: "Fix", status: "pending" },
    ]);
  });

  it("is null without a plan, and the plan never shows as a step", () => {
    const state = stateOf([{ type: "turn/started", turnId: "u1", input: null }, todo("p1", "not a list")]);
    expect(latestPlan(state)).toBeNull();
    expect(latestPlan(null)).toBeNull();
    expect(buildTimelineRows(state)).toEqual([]);
  });
});
