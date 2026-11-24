import { describe, expect, it } from "vitest";
import { createAgentDeliveryQueue, deliverToAgent, deliveryReceipt, wireDeliveryQueueFlush, MAX_QUEUED_PER_NODE } from "../canvas-agent-delivery";
import type { AgentReplyHandle } from "../agent-reply-registry";
import type { AgentStatusSnapshot } from "../agent-status-registry";

/** A handle whose readiness we flip at will, recording what it received. */
function fakeHandle(state: { ready: boolean }) {
  const sent: string[] = [];
  const handle: AgentReplyHandle = {
    canReply: () => state.ready,
    accepts: () => state.ready,
    sendReply: (text) => { sent.push(text); },
  };
  return { handle, sent };
}

describe("createAgentDeliveryQueue — flush-on-register", () => {
  it("delivers a queued message once the node's handle becomes ready", () => {
    const q = createAgentDeliveryQueue();
    const state = { ready: false };
    const { handle, sent } = fakeHandle(state);
    const deps = { getHandle: (id: string) => (id === "nova" ? handle : undefined) };

    q.enqueue("nova", "hello", { now: 0, ttlMs: 45_000 });
    // Handle not ready yet → nothing delivered on a flush attempt.
    expect(q.flush("nova", deps, { now: 1_000 })).toMatchObject({ delivered: [], stillQueued: 1 });
    expect(sent).toEqual([]);

    // Handle registers/becomes ready → flush delivers the buffered message.
    state.ready = true;
    expect(q.flush("nova", deps, { now: 2_000 })).toMatchObject({ delivered: ["hello"], stillQueued: 0 });
    expect(sent).toEqual(["hello"]);
    expect(q.pending("nova")).toEqual([]);
  });

  it("drops a message whose TTL elapsed before the handle became ready (never delivers stale)", () => {
    const q = createAgentDeliveryQueue();
    const { handle, sent } = fakeHandle({ ready: true }); // ready, but message is already expired
    const deps = { getHandle: () => handle };

    q.enqueue("nova", "stale", { now: 0, ttlMs: 30_000 });
    const res = q.flush("nova", deps, { now: 30_000 }); // now === expiresAt → expired
    expect(res).toEqual({ delivered: [], expired: ["stale"], stillQueued: 0 });
    expect(sent).toEqual([]);
    expect(q.size()).toBe(0);
  });

  it("delivers multiple buffered messages FIFO on flush", () => {
    const q = createAgentDeliveryQueue();
    const { handle, sent } = fakeHandle({ ready: true });
    const deps = { getHandle: () => handle };

    q.enqueue("nova", "first", { now: 0 });
    q.enqueue("nova", "second", { now: 10 });
    const res = q.flush("nova", deps, { now: 100 });
    expect(res.delivered).toEqual(["first", "second"]);
    expect(sent).toEqual(["first", "second"]);
  });

  it("sweep() prunes expired entries across all nodes and returns them", () => {
    const q = createAgentDeliveryQueue();
    q.enqueue("nova", "old", { now: 0, ttlMs: 10 });
    q.enqueue("atlas", "fresh", { now: 0, ttlMs: 100_000 });
    const dropped = q.sweep({ now: 50 });
    expect(dropped.map((d) => d.text)).toEqual(["old"]);
    expect(q.pending("nova")).toEqual([]);
    expect(q.pending("atlas").map((e) => e.text)).toEqual(["fresh"]);
  });

  it("caps buffered messages per node, dropping the oldest beyond the cap", () => {
    const q = createAgentDeliveryQueue();
    for (let i = 0; i < MAX_QUEUED_PER_NODE + 5; i++) {
      q.enqueue("nova", `msg-${i}`, { now: i });
    }
    const pending = q.pending("nova");
    expect(pending.length).toBe(MAX_QUEUED_PER_NODE);
    // Oldest 5 were evicted; the newest survives.
    expect(pending[0].text).toBe("msg-5");
    expect(pending[pending.length - 1].text).toBe(`msg-${MAX_QUEUED_PER_NODE + 4}`);
  });
});

describe("deliverToAgent — per-node delivery decision (precondition: nodeId is a resolved, visible agent)", () => {
  it("delivers immediately to a ready agent (no queueing)", () => {
    const q = createAgentDeliveryQueue();
    const sent: string[] = [];
    const handle: AgentReplyHandle = { canReply: () => true, accepts: () => true, sendReply: (t) => { sent.push(t); } };
    const out = deliverToAgent("nova", "  go  ", { getHandle: () => handle }, q, { now: 0 });
    expect(out).toEqual({ outcome: "delivered", reason: "delivered" });
    expect(sent).toEqual(["go"]); // trimmed
    expect(q.size()).toBe(0);
  });

  it("marks a starting agent (live PTY, node buffers) as queued/buffered-by-node without using the TTL queue", () => {
    const q = createAgentDeliveryQueue();
    const sent: string[] = [];
    const handle: AgentReplyHandle = { canReply: () => false, accepts: () => true, sendReply: (t) => { sent.push(t); } };
    const out = deliverToAgent("nova", "go", { getHandle: () => handle }, q, { now: 0 });
    expect(out).toEqual({ outcome: "queued", reason: "buffered-by-node" });
    expect(sent).toEqual(["go"]); // node-level buffer accepts it now
    expect(q.size()).toBe(0);
  });

  it("buffers into the TTL queue when the agent has no reply handle yet (agent-starting)", () => {
    const q = createAgentDeliveryQueue();
    const out = deliverToAgent("nova", "go", { getHandle: () => undefined }, q, { now: 0, ttlMs: 45_000 });
    expect(out).toEqual({ outcome: "queued", reason: "agent-starting" });
    expect(q.pending("nova").map((e) => e.text)).toEqual(["go"]);
  });

  it("ignores empty text (skipped, nothing buffered)", () => {
    const q = createAgentDeliveryQueue();
    const out = deliverToAgent("nova", "   ", { getHandle: () => undefined }, q, { now: 0 });
    expect(out).toEqual({ outcome: "skipped", reason: "empty" });
    expect(q.size()).toBe(0);
  });
});

describe("wireDeliveryQueueFlush — flush buffered messages when an agent's status flips to ready", () => {
  /** Minimal fake of agentStatusRegistry's subscribe surface. */
  function fakeStatusSource() {
    let listener: ((s: AgentStatusSnapshot[]) => void) | null = null;
    return {
      subscribe(l: (s: AgentStatusSnapshot[]) => void) {
        listener = l;
        return () => { listener = null; };
      },
      emit(snapshots: AgentStatusSnapshot[]) { listener?.(snapshots); },
      get active() { return listener !== null; },
    };
  }

  it("flushes a node's queued messages on the status emit after its handle becomes ready", () => {
    const q = createAgentDeliveryQueue();
    const status = fakeStatusSource();
    const state = { ready: false };
    const sent: string[] = [];
    const handle: AgentReplyHandle = { canReply: () => state.ready, accepts: () => state.ready, sendReply: (t) => { sent.push(t); } };
    const deps = { getHandle: (id: string) => (id === "nova" ? handle : undefined) };

    // Message arrives before Nova is ready → buffered in the TTL queue.
    deliverToAgent("nova", "hello", { getHandle: () => undefined }, q, { now: 0 });
    expect(q.pending("nova").length).toBe(1);

    const stop = wireDeliveryQueueFlush(q, status, deps, { now: () => 1_000 });

    // Status emit while still not ready → nothing delivered, message stays queued.
    status.emit([{ id: "nova", name: "Nova", status: "connecting" }]);
    expect(sent).toEqual([]);
    expect(q.pending("nova").length).toBe(1);

    // Nova becomes ready and status re-emits → buffered message flushes.
    state.ready = true;
    status.emit([{ id: "nova", name: "Nova", status: "idle" }]);
    expect(sent).toEqual(["hello"]);
    expect(q.size()).toBe(0);

    stop();
    expect(status.active).toBe(false);
  });
});

describe("deliveryReceipt — actionable receipt for the dispatching agent (never a silent 404)", () => {
  it("reports delivered with the target's display name", () => {
    expect(deliveryReceipt("node-nova", "Nova", { outcome: "delivered", reason: "delivered" })).toEqual({
      delivered: ["node-nova"],
      queued: [],
      skipped: [],
      note: "Delivered to Nova.",
    });
  });

  it("reports a starting agent as queued with the world-class 'is starting; message queued' note", () => {
    expect(deliveryReceipt("node-nova", "Nova", { outcome: "queued", reason: "agent-starting" })).toEqual({
      delivered: [],
      queued: ["node-nova"],
      skipped: [],
      note: "Nova is starting; message queued and will be delivered when it's ready.",
    });
  });

  it("reports a node-buffered message as queued", () => {
    const r = deliveryReceipt("node-nova", "Nova", { outcome: "queued", reason: "buffered-by-node" });
    expect(r.queued).toEqual(["node-nova"]);
    expect(r.note).toContain("Nova");
  });

  it("reports empty text as skipped", () => {
    expect(deliveryReceipt("node-nova", "Nova", { outcome: "skipped", reason: "empty" })).toEqual({
      delivered: [],
      queued: [],
      skipped: ["node-nova"],
      note: "Nothing to deliver (empty message).",
    });
  });
});
