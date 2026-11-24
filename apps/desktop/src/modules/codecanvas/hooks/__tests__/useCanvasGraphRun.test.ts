import { describe, it, expect } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { Node, Edge } from "@xyflow/react";
import { useCanvasGraphRun } from "../useCanvasGraphRun";
import { buildRunGraph } from "../../services/canvas-run-scheduler";
import { createAgentRunRegistry } from "../../services/agent-run-registry";
import { createInMemoryGraphRunStore } from "../../services/graph-run-store";
import { applyNodeCompletion, buildGraphRunRecord } from "../../services/graph-run-record";

const agents: Node[] = [
  { id: "a", type: "agent", position: { x: 0, y: 0 }, data: {} },
  { id: "b", type: "agent", position: { x: 0, y: 0 }, data: {} },
];
const triggerAtoB: Edge[] = [{ id: "e", source: "a", target: "b", data: { wireKind: "triggers" } }];
const graphOf = (n: Node[], e: Edge[]) => () => buildRunGraph(n, e);

describe("useCanvasGraphRun", () => {
  it("runs roots first, then releases dependents on completion", () => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    reg.register("b", { run: () => ran.push("b") });

    const { result } = renderHook(() => useCanvasGraphRun(graphOf(agents, triggerAtoB), reg));
    act(() => result.current.run());
    expect(ran).toEqual(["a"]);
    expect(result.current.running).toBe(true);

    act(() => reg.reportResult("a", true));
    expect(ran).toEqual(["a", "b"]);

    act(() => reg.reportResult("b", true));
    expect(result.current.running).toBe(false);
  });

  it("refuses to run when there are no agents", () => {
    const reg = createAgentRunRegistry();
    const { result } = renderHook(() => useCanvasGraphRun(graphOf([], []), reg));
    act(() => result.current.run());
    expect(result.current.running).toBe(false);
    expect(result.current.error).toBeTruthy();
  });

  it("surfaces an interrupted run and resumes it without re-running completed nodes", async () => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    reg.register("b", { run: () => ran.push("b") });
    const store = createInMemoryGraphRunStore();
    // Persist a half-finished run: "a" done, "b" pending.
    const rec = buildGraphRunRecord({ projectId: "p1", graph: buildRunGraph(agents, triggerAtoB), now: 1, id: "g1" });
    const checkpoint = applyNodeCompletion(rec.checkpoint, "a", { outcome: "completed", sessionId: "sa", nodeRunId: "ra" });
    await store.create({ ...rec, checkpoint });

    const { result } = renderHook(() =>
      useCanvasGraphRun(graphOf(agents, triggerAtoB), reg, undefined, { projectId: "p1", store }));
    await waitFor(() => expect(result.current.resumable?.id).toBe("g1"));

    act(() => result.current.resume());
    expect(ran).toEqual(["b"]); // "a" was already complete
    expect(result.current.running).toBe(true);
    expect(result.current.resumable).toBeNull();
  });

  it("never offers to resume a run the Rust engine owns (it resumes that one itself)", async () => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    reg.register("b", { run: () => ran.push("b") });
    const store = createInMemoryGraphRunStore();
    const rec = buildGraphRunRecord({ projectId: "p1", graph: buildRunGraph(agents, triggerAtoB), now: 1, id: "rust-run" });
    const checkpoint = applyNodeCompletion(rec.checkpoint, "a", { outcome: "completed", sessionId: null, nodeRunId: "" });
    await store.create({ ...rec, checkpoint: { ...checkpoint, engine: { kind: "rust" } } });

    const { result } = renderHook(() =>
      useCanvasGraphRun(graphOf(agents, triggerAtoB), reg, undefined, { projectId: "p1", store }));
    await waitFor(() => expect(result.current.latestRun?.id).toBe("rust-run"));
    expect(result.current.resumable).toBeNull();
    act(() => result.current.resume());
    expect(ran).toEqual([]);
  });

  it("only sees runs filed under its own workflowId", async () => {
    const reg = createAgentRunRegistry();
    const store = createInMemoryGraphRunStore();
    const graph = buildRunGraph(agents, triggerAtoB);
    await store.create(buildGraphRunRecord({ projectId: "p1", graph, now: 1, id: "canvas-run" }));
    await store.create(buildGraphRunRecord({ projectId: "p1", graph, now: 2, id: "run-a", workflowId: "run-node:a" }));
    await store.create(buildGraphRunRecord({ projectId: "p1", graph, now: 3, id: "run-b", workflowId: "run-node:b" }));

    const canvas = renderHook(() => useCanvasGraphRun(graphOf(agents, triggerAtoB), reg, undefined, { projectId: "p1", store }));
    const runA = renderHook(() => useCanvasGraphRun(graphOf(agents, triggerAtoB), reg, undefined, { projectId: "p1", store, workflowId: "run-node:a" }));

    await waitFor(() => expect(runA.result.current.latestRun?.id).toBe("run-a"));
    await waitFor(() => expect(canvas.result.current.latestRun?.id).toBe("canvas-run"));
    expect(runA.result.current.resumable?.id).toBe("run-a");
    expect(canvas.result.current.resumable?.id).toBe("canvas-run");
  });

  it("replays from a node, re-running it and its descendants but not ancestors", async () => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    reg.register("b", { run: () => ran.push("b") });
    const store = createInMemoryGraphRunStore();
    const rec = buildGraphRunRecord({ projectId: "p1", graph: buildRunGraph(agents, triggerAtoB), now: 1, id: "g1" });
    let cp = applyNodeCompletion(rec.checkpoint, "a", { outcome: "completed", sessionId: null, nodeRunId: "ra" });
    cp = applyNodeCompletion(cp, "b", { outcome: "completed", sessionId: null, nodeRunId: "rb" });
    await store.create({ ...rec, checkpoint: cp, status: "completed" });

    const { result } = renderHook(() =>
      useCanvasGraphRun(graphOf(agents, triggerAtoB), reg, undefined, { projectId: "p1", store }));
    await waitFor(() => expect(result.current.replayable).toBe(true)); // latest run loaded
    expect(result.current.resumable).toBeNull(); // it completed — nothing to resume

    act(() => result.current.replayFrom("b"));
    expect(ran).toEqual(["b"]); // "a" is upstream of "b" → cached, not re-run
    expect((await store.list("p1")).length).toBe(2); // replay created a new audit record
  });

  it("holds a replay asked for mid-run until the session settles, then replays from the finalized record", async () => {
    const reg = createAgentRunRegistry();
    const ran: string[] = [];
    reg.register("a", { run: () => ran.push("a") });
    reg.register("b", { run: () => ran.push("b") });
    const store = createInMemoryGraphRunStore();
    const { result } = renderHook(() =>
      useCanvasGraphRun(graphOf(agents, triggerAtoB), reg, undefined, { projectId: "p1", store }));

    act(() => result.current.run());
    act(() => reg.reportResult("a", true));
    act(() => result.current.replayFromWhenSettled("b"));
    expect(ran).toEqual(["a", "b"]); // nothing replayed while the session is live

    act(() => reg.reportResult("b", true));
    await waitFor(() => expect(ran).toEqual(["a", "b", "b"]));
    expect(result.current.running).toBe(true);
    const runs = await store.list("p1");
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.status).sort()).toEqual(["completed", "running"]);
  });

  it("flags a cycle instead of hanging", () => {
    const reg = createAgentRunRegistry();
    const cyclic: Edge[] = [
      { id: "e1", source: "a", target: "b", data: { wireKind: "triggers" } },
      { id: "e2", source: "b", target: "a", data: { wireKind: "triggers" } },
    ];
    const { result } = renderHook(() => useCanvasGraphRun(graphOf(agents, cyclic), reg));
    act(() => result.current.run());
    expect(result.current.running).toBe(false);
    expect(result.current.error).toMatch(/cycle/i);
  });

  it("flags missing live node runners before starting", () => {
    const reg = createAgentRunRegistry();
    reg.register("a", { run: () => {} });
    const { result } = renderHook(() => useCanvasGraphRun(graphOf(agents, triggerAtoB), reg));
    act(() => result.current.run());
    expect(result.current.running).toBe(false);
    expect(result.current.error).toContain("b");
  });
});
