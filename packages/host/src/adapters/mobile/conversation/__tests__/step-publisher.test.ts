import { describe, expect, it } from "vitest";

import type { ConversationUpdate } from "../../../../types/conversation.js";
import type { AgentStopEvent, NotificationEvent } from "../../../../types/notifications.js";
import type { TranscriptEntry } from "../../../../types/transcript.js";
import { StepPublisher, transcriptEntriesOf } from "../step-publisher.js";

let stamp = 1_754_700_000_000;

function stop(over: Partial<AgentStopEvent> & { pane_id?: string | undefined }): AgentStopEvent {
  stamp += 1000;
  return {
    kind: "agent_stop",
    pane_id: "p-1",
    agent_type: "claude",
    event: "tool-pre",
    title: "Read",
    body: "",
    status: "",
    cwd: "/w",
    timestamp: stamp,
    ...over,
  };
}

function harness(structured: string[] = []) {
  const sent: Array<{ paneId: string; agentType: string; update: ConversationUpdate }> = [];
  const publisher = new StepPublisher({
    publishConversation: (paneId, agentType, update) => sent.push({ paneId, agentType, update }),
    isStructured: (paneId) => structured.includes(paneId),
  });
  return { publisher, sent };
}

describe("StepPublisher", () => {
  it("turns a hook event into conversation deltas under the cell it belongs to", () => {
    const { publisher, sent } = harness();
    publisher.publish(stop({ event: "prompt-submit", body: "run the tests" }));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]).toMatchObject({ paneId: "p-1", agentType: "claude" });
    expect(sent.some((s) => s.update.kind === "part" && s.update.part.type === "user_message")).toBe(true);
  });

  it("stays silent for a cell this host runs itself", () => {
    // It already published a native part for the same step; converting the entry too would
    // draw that step twice, under two different ids.
    const { publisher, sent } = harness(["ss-1"]);
    expect(publisher.publish(stop({ pane_id: "ss-1", event: "prompt-submit", body: "go" }))).toBe(0);
    expect(sent).toEqual([]);
  });

  it("ignores an event that names no pane", () => {
    const { publisher, sent } = harness();
    const anonymous = stop({});
    delete anonymous.pane_id;
    expect(publisher.publish(anonymous)).toBe(0);
    expect(publisher.publish(stop({ pane_id: "" }))).toBe(0);
    expect(sent).toEqual([]);
  });

  it("ignores a notification that is not a step", () => {
    const { publisher, sent } = harness();
    const stalled = { kind: "cell_stalled", pane_id: "p-1" } as unknown as NotificationEvent;
    expect(publisher.publish(stalled)).toBe(0);
    expect(sent).toEqual([]);
  });

  it("carries the diffstat through, and leaves absent absent", () => {
    const { publisher, sent } = harness();
    publisher.publish(stop({ event: "prompt-submit", body: "go" }));
    sent.length = 0;
    publisher.publish(stop({ event: "tool-post", title: "Edit", tool_target: "a.ts", lines_added: 3 }));
    const call = sent.map((s) => s.update).find((u) => u.kind === "part" && u.part.type === "tool_call");
    const diff = call?.kind === "part" && call.part.type === "tool_call" ? call.part.diff : undefined;
    expect(diff?.files[0]).toMatchObject({ additions: 3 });
    // `lines_removed` was never sent, so no deletion count is claimed.
    expect(diff?.files[0]).not.toHaveProperty("deletions");
  });

  it("drops a cell that has left the fleet", () => {
    const { publisher } = harness();
    publisher.publish(stop({ event: "prompt-submit", body: "go" }));
    expect(publisher.size()).toBe(1);
    publisher.retain(new Set(["p-other"]));
    expect(publisher.size()).toBe(0);
  });
});

/**
 * The lane derives its turns from the same list `/transcript` serves, so a client that
 * seeded from REST and a client following the live lane cannot disagree about a turn id.
 *
 * The alternative — the lane keeping its own copy of entries as they were when first
 * published — is what put one exchange on a phone's screen twice on 2026-09-08: the same
 * two parts arrived under a second turn id, and nothing downstream could tell they were
 * the same steps. `bb` avoids the class entirely by having one writer own the timeline;
 * this is the same idea against a file somebody else owns.
 */
describe("StepPublisher, against the authoritative entries", () => {
  const entry = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
    event: "prompt-submit",
    status: "running",
    title: "You",
    body: "Halo",
    userPrompt: "Halo",
    toolTarget: "",
    timestamp: 1_788_822_241_733,
    ...over,
  });

  const reply = entry({
    event: "stop",
    status: "idle",
    title: "Finished working",
    body: "Halo! Ada yang bisa dibantu?",
    userPrompt: "",
    timestamp: 1_788_822_244_447,
  });

  function authoritative(pages: Array<readonly TranscriptEntry[] | undefined>) {
    const sent: Array<{ paneId: string; agentType: string; update: ConversationUpdate }> = [];
    let call = 0;
    const publisher = new StepPublisher({
      publishConversation: (paneId, agentType, update) => sent.push({ paneId, agentType, update }),
      isStructured: () => false,
      entriesOf: async (_paneId) => pages[Math.min(call++, pages.length - 1)],
    });
    return { publisher, sent, calls: () => call };
  }

  it("converts the whole list the host holds, not the events it happened to see", async () => {
    // The lane never saw the prompt — only the reply arrives as an event — and still files
    // both under the turn the prompt opened.
    const { publisher, sent } = authoritative([[entry(), reply]]);
    await publisher.refresh("p-1", "claude");
    const turnIds = new Set(sent.map((s) => (s.update.kind === "turn" ? s.update.turn.turnId : s.update.turnId)));
    expect(turnIds.size).toBe(1);
    expect(sent.filter((s) => s.update.kind === "part")).toHaveLength(2);
  });

  it("emits only what changed on the next read", async () => {
    const { publisher, sent } = authoritative([[entry()], [entry(), reply]]);
    await publisher.refresh("p-1", "claude");
    sent.length = 0;
    await publisher.refresh("p-1", "claude");
    const parts = sent.filter((s) => s.update.kind === "part");
    expect(parts).toHaveLength(1);
    expect(parts[0]?.update.kind === "part" && parts[0].update.part.type).toBe("assistant_text");
  });

  it("falls back to the event itself when the host has nothing to read", async () => {
    // A runner with no transcript file still has steps; losing them would be worse than
    // deriving them from the one event in hand.
    const { publisher, sent } = authoritative([undefined]);
    publisher.publish(stop({ event: "prompt-submit", body: "go" }));
    await Promise.resolve();
    expect(sent.some((s) => s.update.kind === "part")).toBe(true);
  });

  it("reads once at a time per cell, and once more for what arrived meanwhile", async () => {
    const { publisher, calls } = authoritative([[entry()], [entry(), reply]]);
    await Promise.all([
      publisher.refresh("p-1", "claude"),
      publisher.refresh("p-1", "claude"),
      publisher.refresh("p-1", "claude"),
    ]);
    // Not three reads: the two that arrived while the first was in flight collapse into one.
    expect(calls()).toBe(2);
  });
});

describe("transcriptEntriesOf", () => {
  it("hands back the entries the host serves", async () => {
    const read = transcriptEntriesOf({ readCellTranscript: async () => ({ entries: [] }) });
    expect(await read("p-1")).toEqual([]);
  });

  it("reads an answer without entries as nothing to derive from", async () => {
    // A host that answers a shape this build does not know must not throw on the
    // notification path — losing a Chat line is not worth failing a hook.
    const read = transcriptEntriesOf({ readCellTranscript: async () => ({}) });
    expect(await read("p-1")).toBeUndefined();
  });

  it("reads a refusal the same way", async () => {
    const read = transcriptEntriesOf({
      readCellTranscript: async () => { throw new Error("upstream is down"); },
    });
    expect(await read("p-1")).toBeUndefined();
  });
});

