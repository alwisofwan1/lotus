import { describe, expect, it } from "vitest";

import { composerStatus, unreadMessages } from "../composer";
import type { ThreadEvent, ThreadEventEnvelope } from "../thread-event";
import { applyThreadEvents, emptyThreadState } from "../thread-state";

function envelopes(events: ThreadEvent[]): ThreadEventEnvelope[] {
  return events.map((event, i) => ({ threadId: "t", seq: i + 1, at: 1000 + i, event }));
}

const stateOf = (events: ThreadEvent[]) => applyThreadEvents(emptyThreadState("t"), envelopes(events));

const started: ThreadEvent = { type: "turn/started", turnId: "u1", input: { text: "go", clientRequestId: "r1" } };

describe("composerStatus", () => {
  it("is a plain send with no turn running", () => {
    expect(composerStatus(null)).toEqual({ mode: "send", activity: null });
    expect(composerStatus(stateOf([started, { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null }]))).toEqual({
      mode: "send",
      activity: null,
    });
  });

  it("queues while the running turn has only written text", () => {
    const state = stateOf([
      started,
      { type: "item/started", turnId: "u1", item: { id: "a", kind: "agentMessage", status: "running", text: "" } },
    ]);
    expect(composerStatus(state)).toEqual({ mode: "queue", activity: "Writing a reply" });
  });

  it("says Finishing, not Writing, once the reply is done but the turn is still open", () => {
    const state = stateOf([
      started,
      { type: "item/started", turnId: "u1", item: { id: "a", kind: "agentMessage", status: "running", text: "" } },
      { type: "item/completed", turnId: "u1", item: { id: "a", kind: "agentMessage", status: "completed", text: "Done." } },
    ]);
    expect(composerStatus(state).activity).toBe("Finishing");
  });

  it("steers once the running turn has used a tool, and names the step in flight", () => {
    const state = stateOf([
      { type: "session/configured", providerSessionId: "s", model: "m", authSource: "accountLogin", cwd: "/w" },
      started,
      { type: "item/started", turnId: "u1", item: { id: "c", kind: "command", status: "running", command: "sleep 3 && echo step2", description: null, output: null } },
    ]);
    expect(composerStatus(state)).toEqual({ mode: "steer", activity: "Ran sleep 3 && echo step2" });
  });

  it("says Starting before the turn has any item", () => {
    expect(composerStatus(stateOf([started]))).toEqual({ mode: "queue", activity: "Starting" });
  });
});

describe("unreadMessages", () => {
  const sent = [
    { clientRequestId: "r1", text: "go", mode: "queue" as const },
    { clientRequestId: "r2", text: "stop", mode: "steer" as const },
  ];

  it("drops a message once a turn opened with it", () => {
    expect(unreadMessages(sent, stateOf([started]))).toEqual([sent[1]]);
  });

  it("drops a message once it was taken in mid-turn", () => {
    const state = stateOf([
      started,
      {
        type: "item/completed",
        turnId: "u1",
        item: { id: "m", kind: "userMessage", status: "completed", text: "stop", clientRequestId: "r2" },
      },
    ]);
    expect(unreadMessages(sent, state)).toEqual([]);
  });

  it("drops queued and steered messages once the session ended, since nothing will read them", () => {
    const state = stateOf([{ type: "session/ended", error: "bridge exited" }]);
    expect(unreadMessages(sent, state)).toEqual([]);
  });

  it("keeps a new send after an ended session: it starts the next one, and shows until its echo", () => {
    const send = { clientRequestId: "r3", text: "hello again", mode: "send" as const };
    expect(unreadMessages([...sent, send], stateOf([{ type: "session/ended", error: null }]))).toEqual([send]);
  });
});
