import { describe, it, expect, vi } from "vitest";
import { startGraphRunSession } from "../graph-run-session";
import { createAgentRunRegistry } from "../agent-run-registry";
import { createInMemoryGraphRunStore } from "../graph-run-store";
import { initCheckpoint, applyNodeCompletion } from "../graph-run-record";
import { createRunSlotPool } from "../graph-run-slots";

const graph = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] };
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startGraphRunSession", () => {
  it("dispatches roots first, then releases dependents on completion", () => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    reg.register("b", { run: () => ran.push("b") });
    const onSettled = vi.fn();

    const session = startGraphRunSession(graph, reg, { onSettled });
    expect(ran).toEqual(["a"]);
    reg.reportResult("a", true);
    expect(ran).toEqual(["a", "b"]);
    reg.reportResult("b", true);
    expect(onSettled).toHaveBeenCalledOnce();
    session?.dispose();
  });

  it("pauses at a human gate until the gate reports approval", () => {
    const gateGraph = { nodeIds: ["a", "g", "b"], deps: [{ from: "a", to: "g" }, { from: "g", to: "b" }] };
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of ["a", "g", "b"]) reg.register(id, { run: () => ran.push(id) });
    const onSettled = vi.fn();

    const session = startGraphRunSession(gateGraph, reg, { onSettled });
    expect(ran).toEqual(["a"]);
    reg.reportResult("a", true);
    expect(ran).toEqual(["a", "g"]);
    expect(onSettled).not.toHaveBeenCalled();

    reg.reportResult("g", true, { outcome: "completed", sessionId: null, nodeRunId: "human-gate-g", gate: "pass" });
    expect(ran).toEqual(["a", "g", "b"]);
    reg.reportResult("b", true);
    expect(onSettled).toHaveBeenCalledOnce();
    session?.dispose();
  });

  it("gates downstream when a critic reports gate=fail, then settles", () => {
    const gateGraph = { nodeIds: ["a", "c", "b"], deps: [{ from: "a", to: "c" }, { from: "c", to: "b" }] };
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of ["a", "c", "b"]) reg.register(id, { run: () => ran.push(id) });
    const onSettled = vi.fn();

    const session = startGraphRunSession(gateGraph, reg, { onSettled });
    expect(ran).toEqual(["a"]);
    reg.reportResult("a", true);
    expect(ran).toEqual(["a", "c"]); // critic released
    // Critic fails its verdict → b must never dispatch, and the run settles.
    reg.reportResult("c", false, { outcome: "error", sessionId: null, nodeRunId: "rc", gate: "fail" });
    expect(ran).toEqual(["a", "c"]); // b gated off
    expect(onSettled).toHaveBeenCalledOnce();
    session?.dispose();
  });

  it("persists the gate: descendants move to blocked, status becomes error", async () => {
    const gateGraph = { nodeIds: ["a", "c", "b"], deps: [{ from: "a", to: "c" }, { from: "c", to: "b" }] };
    const reg = createAgentRunRegistry();
    for (const id of ["a", "c", "b"]) reg.register(id, { run: () => {} });
    const store = createInMemoryGraphRunStore();
    const session = startGraphRunSession(gateGraph, reg, {}, { store, projectId: "p", now: () => 1 });
    reg.reportResult("a", true, { outcome: "completed", sessionId: null, nodeRunId: "ra" });
    reg.reportResult("c", false, { outcome: "error", sessionId: null, nodeRunId: "rc", gate: "fail" });
    await flush();
    const rec = await store.get(session?.graphRunId ?? "");
    expect(rec?.checkpoint.blocked).toEqual(["b"]);
    expect(rec?.status).toBe("error");
    session?.dispose();
  });

  it("threads the graphRunId into each dispatch context", () => {
    const reg = createAgentRunRegistry();
    const store = createInMemoryGraphRunStore();
    const ctxs: unknown[] = [];
    reg.register("a", { run: (ctx) => ctxs.push(ctx) });
    const session = startGraphRunSession({ nodeIds: ["a"], deps: [] }, reg, {}, {
      store, projectId: "p1", now: () => 1, idGen: () => "g1",
    });
    expect(ctxs).toEqual([{ graphRunId: "g1", upstreamIds: [] }]);
    session?.dispose();
  });

  it("settles only after the final write, so a reload reads the finished run", async () => {
    // A real store write is two IPC round trips. A reload fired on settle used to race it and
    // read the run back as still running — the Run Node card showed "Interrupted 1/2".
    const inner = createInMemoryGraphRunStore();
    const slow = { ...inner, update: async (...args: Parameters<typeof inner.update>) => { await flush(); await inner.update(...args); } };
    const reg = createAgentRunRegistry();
    for (const id of ["a", "b"]) reg.register(id, { run: () => {} });
    let seenOnSettle: string | undefined;
    const onSettled = vi.fn(() => { void inner.get("g1").then((r) => { seenOnSettle = r?.status; }); });

    startGraphRunSession({ nodeIds: ["a", "b"], deps: [] }, reg, { onSettled }, { store: slow, projectId: "p1", now: () => 1, idGen: () => "g1" });
    reg.reportResult("a", true, { outcome: "completed", sessionId: null, nodeRunId: "ra" });
    reg.reportResult("b", true, { outcome: "completed", sessionId: null, nodeRunId: "rb" });
    expect(onSettled).not.toHaveBeenCalled();
    await flush(); await flush(); await flush();

    expect(onSettled).toHaveBeenCalledOnce();
    expect(seenOnSettle).toBe("completed");
  });

  it("persists a running record on start and checkpoints each completion", async () => {
    const reg = createAgentRunRegistry();
    const store = createInMemoryGraphRunStore();
    reg.register("a", { run: () => {} });
    reg.register("b", { run: () => {} });
    startGraphRunSession(graph, reg, {}, { store, projectId: "p1", now: () => 5, idGen: () => "g1" });
    await flush();
    expect((await store.get("g1"))?.status).toBe("running");

    reg.reportResult("a", true, { outcome: "completed", sessionId: "sa", nodeRunId: "ra" });
    await flush();
    expect((await store.get("g1"))?.checkpoint.completed.a?.sessionId).toBe("sa");

    reg.reportResult("b", true, { outcome: "completed", sessionId: null, nodeRunId: "rb" });
    await flush();
    const done = await store.get("g1");
    expect(done?.status).toBe("completed");
    expect(done?.endedAt).toBe(5);
  });

  it("calls onError('empty') and returns null when there are no nodes", () => {
    const reg = createAgentRunRegistry();
    const onError = vi.fn();
    const session = startGraphRunSession({ nodeIds: [], deps: [] }, reg, { onError });
    expect(session).toBeNull();
    expect(onError).toHaveBeenCalledWith("empty");
  });

  it("resumes without re-dispatching completed nodes (0 wasted tokens)", () => {
    const reg = createAgentRunRegistry();
    const store = createInMemoryGraphRunStore();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    reg.register("b", { run: () => ran.push("b") });
    const checkpoint = applyNodeCompletion(initCheckpoint(graph), "a", {
      outcome: "completed", sessionId: "sa", nodeRunId: "ra",
    });
    startGraphRunSession(graph, reg, {}, { store, projectId: "p1", now: () => 9 }, {
      graphRunId: "g1", checkpoint,
    });
    expect(ran).toEqual(["b"]); // "a" is already complete — only the pending node runs
  });

  it("settles immediately when resuming an already-complete checkpoint", () => {
    const reg = createAgentRunRegistry();
    const onSettled = vi.fn();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    reg.register("b", { run: () => ran.push("b") });
    let cp = applyNodeCompletion(initCheckpoint(graph), "a", { outcome: "completed", sessionId: null, nodeRunId: "ra" });
    cp = applyNodeCompletion(cp, "b", { outcome: "completed", sessionId: null, nodeRunId: "rb" });
    const session = startGraphRunSession(graph, reg, { onSettled }, undefined, { graphRunId: "g1", checkpoint: cp });
    expect(ran).toEqual([]);
    expect(onSettled).toHaveBeenCalledOnce();
    session?.dispose();
  });

  it("calls onError('cycle') and returns null when no node can start", () => {
    const reg = createAgentRunRegistry();
    const onError = vi.fn();
    const cyclic = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }, { from: "b", to: "a" }] };
    const session = startGraphRunSession(cyclic, reg, { onError });
    expect(session).toBeNull();
    expect(onError).toHaveBeenCalledWith("cycle");
  });

  it("calls onError('missing-runner') and returns null when a runnable node is not registered", () => {
    const reg = createAgentRunRegistry();
    const onError = vi.fn();
    reg.register("a", { run: () => {} });
    const session = startGraphRunSession(graph, reg, { onError });
    expect(session).toBeNull();
    expect(onError).toHaveBeenCalledWith("missing-runner", ["b"]);
  });

  it("fails and settles a run that becomes stuck behind a detached cycle", async () => {
    const stuck = { nodeIds: ["a", "b", "c"], deps: [{ from: "b", to: "c" }, { from: "c", to: "b" }] };
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of stuck.nodeIds) reg.register(id, { run: () => ran.push(id) });
    const store = createInMemoryGraphRunStore();
    const onError = vi.fn();
    const onSettled = vi.fn();

    const session = startGraphRunSession(stuck, reg, { onError, onSettled }, { store, projectId: "p1", now: () => 7, idGen: () => "g1" });
    expect(ran).toEqual(["a"]);
    reg.reportResult("a", true, { outcome: "completed", sessionId: null, nodeRunId: "ra" });
    await flush();

    expect(onError).toHaveBeenCalledWith("cycle", ["b", "c"]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await store.get("g1"))?.status).toBe("error");
    session?.dispose();
  });

  it("does not mistake a pending fan-in for a cycle while a sibling is still running", () => {
    // a and b both feed c. When a finishes, c cannot run yet (b is still in flight) and nothing
    // is released — but that is normal progress, not a stuck graph.
    const diamond = { nodeIds: ["a", "b", "c"], deps: [{ from: "a", to: "c" }, { from: "b", to: "c" }] };
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of diamond.nodeIds) reg.register(id, { run: () => ran.push(id) });
    const onError = vi.fn();
    const onSettled = vi.fn();

    const session = startGraphRunSession(diamond, reg, { onError, onSettled });
    expect(ran).toEqual(["a", "b"]);

    reg.reportResult("a", true);
    expect(onError).not.toHaveBeenCalled();

    reg.reportResult("b", true);
    expect(ran).toEqual(["a", "b", "c"]);
    reg.reportResult("c", true);
    expect(onError).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
    session?.dispose();
  });

  it("never runs more nodes at once than maxConcurrent, and drains as they finish", () => {
    const wide = { nodeIds: ["a", "b", "c", "d", "e"], deps: [] };
    const reg = createAgentRunRegistry();
    const live = new Set<string>();
    const ran: string[] = [];
    let peak = 0;
    for (const id of wide.nodeIds) {
      reg.register(id, { run: () => { ran.push(id); live.add(id); peak = Math.max(peak, live.size); } });
    }
    const onSettled = vi.fn();

    const session = startGraphRunSession(wide, reg, { onSettled }, undefined, undefined, { maxConcurrent: 2 });
    expect(ran).toEqual(["a", "b"]);

    for (const id of wide.nodeIds) {
      live.delete(id);
      reg.reportResult(id, true);
    }

    expect(peak).toBe(2);
    expect(ran).toEqual(wide.nodeIds); // everything still ran, just not all at once
    expect(onSettled).toHaveBeenCalledOnce();
    session?.dispose();
  });

  it("hands each node its upstream ids and the run's title + goal", () => {
    const reg = createAgentRunRegistry();
    const ctxs: Record<string, unknown> = {};
    for (const id of ["a", "b"]) reg.register(id, { run: (ctx) => { ctxs[id] = ctx; } });

    const session = startGraphRunSession(graph, reg, {}, undefined, undefined, { run: { title: "Ship", brief: "Do it" } });
    reg.reportResult("a", true);

    expect(ctxs.a).toMatchObject({ upstreamIds: [], run: { title: "Ship", brief: "Do it" } });
    expect(ctxs.b).toMatchObject({ upstreamIds: ["a"], run: { title: "Ship", brief: "Do it" } });
    session?.dispose();
  });

  it("two runs on one pool never have more nodes in flight together than the pool limit", () => {
    const pool = createRunSlotPool(2);
    const reg = createAgentRunRegistry();
    const live = new Set<string>();
    const ran: string[] = [];
    let peak = 0;
    const ids = ["a1", "a2", "a3", "b1", "b2", "b3"];
    for (const id of ids) {
      reg.register(id, { run: () => { ran.push(id); live.add(id); peak = Math.max(peak, live.size); } });
    }
    const settledA = vi.fn();
    const settledB = vi.fn();

    const runA = startGraphRunSession({ nodeIds: ["a1", "a2", "a3"], deps: [] }, reg, { onSettled: settledA }, undefined, undefined, { slotPool: pool });
    const runB = startGraphRunSession({ nodeIds: ["b1", "b2", "b3"], deps: [] }, reg, { onSettled: settledB }, undefined, undefined, { slotPool: pool });
    expect(ran).toEqual(["a1", "a2"]); // run B waits: run A already holds both slots

    // FIFO across runs: a3 queued before b1, so it goes first …
    live.delete("a1");
    reg.reportResult("a1", true);
    expect(ran).toEqual(["a1", "a2", "a3"]);
    // … and the next slot run A frees goes to run B's oldest waiting node.
    live.delete("a2");
    reg.reportResult("a2", true);
    expect(ran).toEqual(["a1", "a2", "a3", "b1"]);

    for (const id of ["a3", "b1", "b2", "b3"]) {
      live.delete(id);
      reg.reportResult(id, true);
    }

    expect(peak).toBe(2);
    expect([...ran].sort()).toEqual([...ids].sort());
    expect(settledA).toHaveBeenCalledOnce();
    expect(settledB).toHaveBeenCalledOnce();
    expect(pool.inFlight()).toBe(0);
    runA?.dispose();
    runB?.dispose();
  });

  it("a disposed run gives its slots to the other runs on the pool", () => {
    const pool = createRunSlotPool(1);
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of ["a1", "b1"]) reg.register(id, { run: () => ran.push(id) });

    const runA = startGraphRunSession({ nodeIds: ["a1"], deps: [] }, reg, {}, undefined, undefined, { slotPool: pool });
    const runB = startGraphRunSession({ nodeIds: ["b1"], deps: [] }, reg, {}, undefined, undefined, { slotPool: pool });
    expect(ran).toEqual(["a1"]);

    runA?.dispose();
    expect(ran).toEqual(["a1", "b1"]);
    runB?.dispose();
  });

  it("does not report a cycle while runnable nodes are only waiting for a slot", () => {
    const wide = { nodeIds: ["a", "b", "c"], deps: [] };
    const reg = createAgentRunRegistry();
    for (const id of wide.nodeIds) reg.register(id, { run: () => {} });
    const onError = vi.fn();

    const session = startGraphRunSession(wide, reg, { onError }, undefined, undefined, { maxConcurrent: 1 });
    reg.reportResult("a", true);
    reg.reportResult("b", true);
    expect(onError).not.toHaveBeenCalled();
    reg.reportResult("c", true);
    expect(onError).not.toHaveBeenCalled();
    session?.dispose();
  });

  it("stops dispatching queued nodes once the session is disposed", () => {
    const wide = { nodeIds: ["a", "b", "c"], deps: [] };
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of wide.nodeIds) reg.register(id, { run: () => ran.push(id) });

    const session = startGraphRunSession(wide, reg, {}, undefined, undefined, { maxConcurrent: 1 });
    expect(ran).toEqual(["a"]);
    session?.dispose();
    reg.reportResult("a", true);
    expect(ran).toEqual(["a"]); // b and c were waiting on a slot that will never open
  });

  it("fails and settles when a node unregisters before it is released", async () => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    const unregisterB = reg.register("b", { run: () => ran.push("b") });
    const store = createInMemoryGraphRunStore();
    const onError = vi.fn();
    const onSettled = vi.fn();

    const session = startGraphRunSession(graph, reg, { onError, onSettled }, { store, projectId: "p1", now: () => 8, idGen: () => "g1" });
    unregisterB();
    reg.reportResult("a", true, { outcome: "completed", sessionId: null, nodeRunId: "ra" });
    await flush();

    expect(ran).toEqual(["a"]);
    expect(onError).toHaveBeenCalledWith("missing-runner", ["b"]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await store.get("g1"))?.status).toBe("error");
    session?.dispose();
  });
});

describe("startGraphRunSession — budget cap (#76)", () => {
  const cost = (id: string, costUsd?: number) => ({
    outcome: "completed" as const, sessionId: null, nodeRunId: `r-${id}`,
    ...(costUsd !== undefined ? { usage: { inputTokens: 1, outputTokens: 1, costUsd } } : {}),
  });
  const pipeline = { nodeIds: ["a", "b", "c"], deps: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
  const setup = (ids: string[]) => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of ids) reg.register(id, { run: () => ran.push(id) });
    return { reg, ran, store: createInMemoryGraphRunStore(), onSettled: vi.fn() };
  };

  it("ac2 — stops before the step that would start past the cap and settles paused", async () => {
    const { reg, ran, store, onSettled } = setup(pipeline.nodeIds);
    const session = startGraphRunSession(pipeline, reg, { onSettled }, { store, projectId: "p", now: () => 5, idGen: () => "g" }, undefined, { budgetCap: 1 });
    reg.reportResult("a", true, cost("a", 0.6));
    expect(ran).toEqual(["a", "b"]);
    reg.reportResult("b", true, cost("b", 0.5));
    await flush();

    expect(ran).toEqual(["a", "b"]);
    expect(onSettled).toHaveBeenCalledOnce();
    const rec = await store.get("g");
    expect(rec?.status).toBe("paused");
    expect(rec?.endedAt).toBeNull();
    expect(Object.keys(rec?.checkpoint.completed ?? {})).toEqual(["a", "b"]);
    expect(rec?.checkpoint.pending).toEqual(["c"]);
    session?.dispose();
  });

  it("ac1 — without a cap the same spend runs to the end", async () => {
    const { reg, ran, store } = setup(pipeline.nodeIds);
    startGraphRunSession(pipeline, reg, {}, { store, projectId: "p", now: () => 5, idGen: () => "g" });
    reg.reportResult("a", true, cost("a", 0.6));
    reg.reportResult("b", true, cost("b", 0.5));
    reg.reportResult("c", true, cost("c", 9));
    await flush();
    expect(ran).toEqual(["a", "b", "c"]);
    expect((await store.get("g"))?.status).toBe("completed");
  });

  it("ac3 — fan-out on one slot: the cap hit by a drops what a released", async () => {
    const fan = { nodeIds: ["a", "b", "c"], deps: [{ from: "a", to: "b" }, { from: "a", to: "c" }] };
    const { reg, ran, store, onSettled } = setup(fan.nodeIds);
    const pool = createRunSlotPool(1);
    startGraphRunSession(fan, reg, { onSettled }, { store, projectId: "p", now: () => 5, idGen: () => "g" }, undefined, { budgetCap: 1, slotPool: pool });
    reg.reportResult("a", true, cost("a", 1));
    await flush();

    expect(ran).toEqual(["a"]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await store.get("g"))?.status).toBe("paused");
    expect(pool.inFlight()).toBe(0);
    expect(pool.queued()).toBe(0);
  });

  it("a failed step's cost counts: an expensive failure pauses the run before the next step starts", async () => {
    const graph = { nodeIds: ["a", "b", "c"], deps: [{ from: "b", to: "c" }] };
    const { reg, ran, store, onSettled } = setup(graph.nodeIds);
    const pool = createRunSlotPool(1);
    startGraphRunSession(graph, reg, { onSettled }, { store, projectId: "p", now: () => 5, idGen: () => "g" }, undefined, { budgetCap: 1, slotPool: pool });
    expect(ran).toEqual(["a"]);
    reg.reportResult("a", false, { outcome: "error", sessionId: null, nodeRunId: "r-a", usage: { inputTokens: 1, outputTokens: 1, costUsd: 1.2 } });
    await flush();

    expect(ran).toEqual(["a"]);
    expect(onSettled).toHaveBeenCalledOnce();
    const rec = await store.get("g");
    expect(rec?.status).toBe("paused");
    expect(rec?.checkpoint.failed).toEqual(["a"]);
  });

  it("ac3 — a step already in flight when the cap hits finishes and is recorded, then the run pauses", async () => {
    const wide = { nodeIds: ["a", "b", "c"], deps: [] };
    const { reg, ran, store, onSettled } = setup(wide.nodeIds);
    const pool = createRunSlotPool(2);
    startGraphRunSession(wide, reg, { onSettled }, { store, projectId: "p", now: () => 5, idGen: () => "g" }, undefined, { budgetCap: 1, slotPool: pool });
    expect(ran).toEqual(["a", "b"]); // c waits for a slot

    reg.reportResult("a", true, cost("a", 1.2));
    expect(ran).toEqual(["a", "b"]); // the slot a freed does not go to c
    expect(onSettled).not.toHaveBeenCalled();

    reg.reportResult("b", true, cost("b", 0.3));
    await flush();
    expect(onSettled).toHaveBeenCalledOnce();
    const rec = await store.get("g");
    expect(rec?.status).toBe("paused");
    expect(rec?.checkpoint.completed.b?.usage?.costUsd).toBe(0.3);
    expect(rec?.checkpoint.pending).toEqual(["c"]);
    expect(pool.inFlight()).toBe(0);
  });

  it("a queued node of another run still gets the slot a paused run frees", () => {
    const pool = createRunSlotPool(1);
    const { reg, ran } = setup(["a", "b", "x"]);
    startGraphRunSession({ nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] }, reg, {}, undefined, undefined, { budgetCap: 1, slotPool: pool });
    startGraphRunSession({ nodeIds: ["x"], deps: [] }, reg, {}, undefined, undefined, { slotPool: pool });
    expect(ran).toEqual(["a"]);
    reg.reportResult("a", true, cost("a", 2));
    expect(ran).toEqual(["a", "x"]);
  });

  it("a step without a cost adds nothing to the spend", () => {
    const { reg, ran, store } = setup(pipeline.nodeIds);
    startGraphRunSession(pipeline, reg, {}, { store, projectId: "p", now: () => 5, idGen: () => "g" }, undefined, { budgetCap: 1 });
    reg.reportResult("a", true, cost("a"));
    reg.reportResult("b", true);
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("another run's result never lands in this run's checkpoint or spend", async () => {
    const { reg, ran, store } = setup(["a", "b", "x"]);
    startGraphRunSession({ nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] }, reg, {}, { store, projectId: "p", now: () => 5, idGen: () => "g" }, undefined, { budgetCap: 1 });
    reg.reportResult("x", true, cost("x", 5));
    reg.reportResult("a", true, cost("a", 0.1));
    await flush();
    expect(ran).toEqual(["a", "b"]);
    expect(Object.keys((await store.get("g"))?.checkpoint.completed ?? {})).toEqual(["a"]);
  });

  it("ac4 — resuming a paused run under a raised cap runs only what is left", async () => {
    const { reg, ran, store, onSettled } = setup(pipeline.nodeIds);
    startGraphRunSession(pipeline, reg, {}, { store, projectId: "p", now: () => 5, idGen: () => "g" }, undefined, { budgetCap: 1 });
    reg.reportResult("a", true, cost("a", 0.6));
    reg.reportResult("b", true, cost("b", 0.5));
    await flush();
    const paused = (await store.get("g"))!;
    ran.length = 0;

    startGraphRunSession(pipeline, reg, { onSettled }, { store, projectId: "p", now: () => 9 }, { graphRunId: "g", checkpoint: paused.checkpoint }, { budgetCap: 1.5 });
    expect(ran).toEqual(["c"]);
    reg.reportResult("c", true, cost("c", 0.2));
    await flush();
    const rec = await store.get("g");
    expect(rec?.status).toBe("completed");
    expect(rec?.endedAt).toBe(9);
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("resuming with the spend still at the cap pauses again without dispatching", async () => {
    const { reg, ran, store, onSettled } = setup(pipeline.nodeIds);
    let checkpoint = initCheckpoint(pipeline);
    checkpoint = applyNodeCompletion(checkpoint, "a", cost("a", 2));
    await store.create({ id: "g", projectId: "p", status: "paused", checkpoint, startedAt: 1, endedAt: null, updatedAt: 1 });

    const session = startGraphRunSession(pipeline, reg, { onSettled }, { store, projectId: "p", now: () => 9 }, { graphRunId: "g", checkpoint }, { budgetCap: 1.5 });
    await flush();
    expect(session).toBeNull();
    expect(ran).toEqual([]);
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await store.get("g"))?.status).toBe("paused");
  });
});

describe("startGraphRunSession — Pause and Abort from the ⋯ menu (#114)", () => {
  const setup = (ids: string[]) => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    for (const id of ids) reg.register(id, { run: () => ran.push(id) });
    return { reg, ran, store: createInMemoryGraphRunStore(), onSettled: vi.fn() };
  };
  const persist = (store: ReturnType<typeof createInMemoryGraphRunStore>) => ({ store, projectId: "p", now: () => 5, idGen: () => "g" });

  it("Pause: no new step starts; the running one finishes and is recorded; the run settles paused", async () => {
    const pipeline = { nodeIds: ["a", "b", "c"], deps: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
    const { reg, ran, store, onSettled } = setup(pipeline.nodeIds);
    const session = startGraphRunSession(pipeline, reg, { onSettled }, persist(store));
    expect(ran).toEqual(["a"]);

    session!.pause();
    expect(onSettled).not.toHaveBeenCalled();
    reg.reportResult("a", true);
    await flush();

    expect(ran).toEqual(["a"]);
    expect(onSettled).toHaveBeenCalledOnce();
    const rec = await store.get("g");
    expect(rec?.status).toBe("paused");
    expect(rec?.endedAt).toBeNull();
    expect(Object.keys(rec?.checkpoint.completed ?? {})).toEqual(["a"]);
  });

  it("Pause drops the queued steps and frees the pool", async () => {
    const wide = { nodeIds: ["a", "b", "c"], deps: [] };
    const { reg, ran, store, onSettled } = setup(wide.nodeIds);
    const pool = createRunSlotPool(1);
    const session = startGraphRunSession(wide, reg, { onSettled }, persist(store), undefined, { slotPool: pool });
    session!.pause();
    reg.reportResult("a", true);
    await flush();
    expect(ran).toEqual(["a"]);
    expect(pool.inFlight()).toBe(0);
    expect(pool.queued()).toBe(0);
    expect((await store.get("g"))?.status).toBe("paused");
  });

  it("a paused run resumes and runs only what is left", async () => {
    const pipeline = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] };
    const { reg, ran, store } = setup(pipeline.nodeIds);
    const session = startGraphRunSession(pipeline, reg, {}, persist(store));
    session!.pause();
    reg.reportResult("a", true);
    await flush();
    const rec = (await store.get("g"))!;

    const onSettled = vi.fn();
    startGraphRunSession(pipeline, reg, { onSettled }, persist(store), { graphRunId: "g", checkpoint: rec.checkpoint });
    expect(ran).toEqual(["a", "b"]);
    reg.reportResult("b", true);
    await flush();
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await store.get("g"))?.status).toBe("completed");
  });

  it("Abort: records cancelled and settles now; a step still running is left alone and its result ignored", async () => {
    const pipeline = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] };
    const { reg, ran, store, onSettled } = setup(pipeline.nodeIds);
    const session = startGraphRunSession(pipeline, reg, { onSettled }, persist(store));

    session!.abort();
    await flush();
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await store.get("g"))?.status).toBe("cancelled");

    reg.reportResult("a", true);
    await flush();
    expect(ran).toEqual(["a"]);
    const rec = await store.get("g");
    expect(rec?.status).toBe("cancelled");
    expect(rec?.checkpoint.completed).toEqual({});
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("Abort while pausing ends the run as cancelled, not paused", async () => {
    const pipeline = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] };
    const { reg, store, onSettled } = setup(pipeline.nodeIds);
    const session = startGraphRunSession(pipeline, reg, { onSettled }, persist(store));
    session!.pause();
    session!.abort();
    reg.reportResult("a", true);
    await flush();
    expect(onSettled).toHaveBeenCalledOnce();
    expect((await store.get("g"))?.status).toBe("cancelled");
  });
});
