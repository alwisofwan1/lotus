import { describe, expect, it } from "vitest";
import {
  EMPTY_RUN_VIEW,
  agentRunViewReducer,
  runViewActions,
  runViewActivity,
  runViewFinalMessage,
  runViewMessages,
} from "../agent-run-view";
import type { AgentStreamEvent } from "../agent-stream-parser";

function fold(events: AgentStreamEvent[]) {
  return events.reduce(agentRunViewReducer, EMPTY_RUN_VIEW);
}

describe("agentRunViewReducer", () => {
  it("keeps messages and tool activity as distinct, ordered entries", () => {
    const view = fold([
      { kind: "text", text: "Planning" },
      { kind: "tool", label: "Reading a.ts" },
      { kind: "text", text: "Done" },
    ]);
    expect(view.entries).toEqual([
      { kind: "message", text: "Planning" },
      { kind: "tool", label: "Reading a.ts" },
      { kind: "message", text: "Done" },
    ]);
  });

  it("ignores non-content events (session/result/exit)", () => {
    const view = fold([
      { kind: "session", sessionId: "s1" },
      { kind: "text", text: "Hi" },
      { kind: "result", ok: true },
      { kind: "exit", code: 0 },
    ]);
    expect(view.entries).toEqual([{ kind: "message", text: "Hi" }]);
  });

  it("derives messages, activity, final message, and a flat action trace", () => {
    const view = fold([
      { kind: "text", text: "Planning" },
      { kind: "tool", label: "Reading a.ts" },
      { kind: "text", text: "Shipped" },
    ]);
    expect(runViewMessages(view)).toEqual(["Planning", "Shipped"]);
    expect(runViewActivity(view)).toEqual(["Reading a.ts"]);
    expect(runViewFinalMessage(view)).toBe("Shipped");
    expect(runViewActions(view)).toEqual(["Planning", "Reading a.ts", "Shipped"]);
  });

  it("reports an empty final message before any prose arrives", () => {
    expect(runViewFinalMessage(EMPTY_RUN_VIEW)).toBe("");
  });
});
