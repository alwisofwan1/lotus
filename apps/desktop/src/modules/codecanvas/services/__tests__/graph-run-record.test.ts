import { describe, it, expect } from "vitest";
import {
  initCheckpoint,
  applyNodeCompletion,
  applyGateBlock,
  deriveGraphRunStatus,
  buildGraphRunRecord,
  replayCheckpoint,
  summarizeGraphRun,
  graphRunSpend,
} from "../graph-run-record";

const graph = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] };

describe("applyGateBlock (N4 critic gate)", () => {
  it("moves gated descendants out of pending into blocked → status error, never re-runs", () => {
    const cp = applyGateBlock(initCheckpoint({ nodeIds: ["a", "c", "b"], deps: [] }), ["b"]);
    expect(cp.pending).not.toContain("b");
    expect(cp.blocked).toEqual(["b"]);
    // critic itself recorded as failed → terminal error once nothing pending
    const settled = applyNodeCompletion({ ...cp, pending: cp.pending.filter((id) => id !== "a") }, "c", {
      outcome: "error", sessionId: null, nodeRunId: "r", gate: "fail",
    });
    expect(deriveGraphRunStatus({ ...settled, pending: [] })).toBe("error");
  });

  it("is a no-op for an empty block list", () => {
    const cp = initCheckpoint(graph);
    expect(applyGateBlock(cp, [])).toBe(cp);
  });
});

describe("graphRunSpend", () => {
  const done = (costUsd?: number) => ({ outcome: "completed" as const, sessionId: null, nodeRunId: "r", ...(costUsd !== undefined ? { usage: { inputTokens: 1, outputTokens: 1, costUsd } } : {}) });

  it("sums the known costs of finished steps and counts the ones without a cost", () => {
    let cp = initCheckpoint({ nodeIds: ["a", "b", "c"], deps: [] });
    cp = applyNodeCompletion(cp, "a", done(0.6));
    cp = applyNodeCompletion(cp, "b", done());
    cp = applyNodeCompletion(cp, "c", done(0.5));
    expect(graphRunSpend(cp)).toEqual({ costUsd: 1.1, unknownCostSteps: 1 });
  });

  it("counts the cost of a failed step — a Critic that says fail or an agent that errors still spent it", () => {
    let cp = initCheckpoint({ nodeIds: ["a", "b"], deps: [] });
    cp = applyNodeCompletion(cp, "a", done(0.6));
    cp = applyNodeCompletion(cp, "b", { outcome: "error", sessionId: null, nodeRunId: "rb", gate: "fail", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.7 } });
    expect(cp.failed).toEqual(["b"]);
    const spend = graphRunSpend(cp);
    expect(spend.costUsd).toBeCloseTo(1.3);
    expect(spend.unknownCostSteps).toBe(0);
  });

  it("reads a checkpoint saved before failed costs were kept", () => {
    const { failedUsage: _dropped, ...old } = applyNodeCompletion(initCheckpoint(graph), graph.nodeIds[0], { outcome: "error", sessionId: null, nodeRunId: "r" });
    expect(graphRunSpend(old)).toEqual({ costUsd: null, unknownCostSteps: 0 });
  });

  it("has no spend before any step reports a cost", () => {
    expect(graphRunSpend(initCheckpoint(graph))).toEqual({ costUsd: null, unknownCostSteps: 0 });
  });
});

describe("initCheckpoint", () => {
  it("starts every node pending with no completed or failed", () => {
    const cp = initCheckpoint(graph);
    expect(cp.pending.sort()).toEqual(["a", "b"]);
    expect(cp.completed).toEqual({});
    expect(cp.failed).toEqual([]);
    expect(cp.deps).toEqual([{ from: "a", to: "b" }]);
  });
});

describe("applyNodeCompletion", () => {
  it("moves a node from pending to completed with its run result", () => {
    const cp = applyNodeCompletion(initCheckpoint(graph), "a", {
      outcome: "completed",
      sessionId: "sess_1",
      nodeRunId: "run_1",
    });
    expect(cp.pending).toEqual(["b"]);
    expect(cp.completed.a).toEqual({ outcome: "completed", sessionId: "sess_1", nodeRunId: "run_1" });
    expect(cp.failed).toEqual([]);
  });

  it("routes error/stopped outcomes to failed (not completed)", () => {
    const cp = applyNodeCompletion(initCheckpoint(graph), "a", {
      outcome: "error",
      sessionId: null,
      nodeRunId: "run_1",
    });
    expect(cp.failed).toEqual(["a"]);
    expect(cp.completed.a).toBeUndefined();
    expect(cp.pending).toEqual(["b"]);
  });

  it("does not mutate the input checkpoint", () => {
    const base = initCheckpoint(graph);
    applyNodeCompletion(base, "a", { outcome: "completed", sessionId: null, nodeRunId: "r" });
    expect(base.pending.sort()).toEqual(["a", "b"]);
    expect(base.completed).toEqual({});
  });
});

describe("deriveGraphRunStatus", () => {
  const done = (id: string) => ({ outcome: "completed" as const, sessionId: null, nodeRunId: id });

  it("is running while nodes are still pending", () => {
    expect(deriveGraphRunStatus(initCheckpoint(graph))).toBe("running");
  });

  it("is completed when nothing pending and nothing failed", () => {
    let cp = applyNodeCompletion(initCheckpoint(graph), "a", done("a"));
    cp = applyNodeCompletion(cp, "b", done("b"));
    expect(deriveGraphRunStatus(cp)).toBe("completed");
  });

  it("is error when finished with at least one failed node", () => {
    let cp = applyNodeCompletion(initCheckpoint(graph), "a", { outcome: "error", sessionId: null, nodeRunId: "a" });
    cp = applyNodeCompletion(cp, "b", done("b"));
    expect(deriveGraphRunStatus(cp)).toBe("error");
  });
});

describe("replayCheckpoint", () => {
  const chain = { nodeIds: ["a", "b", "c"], deps: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };
  const allDone = () => {
    let cp = applyNodeCompletion(initCheckpoint(chain), "a", { outcome: "completed", sessionId: "sa", nodeRunId: "ra" });
    cp = applyNodeCompletion(cp, "b", { outcome: "completed", sessionId: "sb", nodeRunId: "rb" });
    return applyNodeCompletion(cp, "c", { outcome: "completed", sessionId: "sc", nodeRunId: "rc" });
  };

  it("resets a node and its descendants to pending, keeping ancestors completed", () => {
    const cp = replayCheckpoint(allDone(), "b");
    expect(Object.keys(cp.completed)).toEqual(["a"]); // ancestor cache preserved
    expect(cp.completed.a?.sessionId).toBe("sa");
    expect(cp.pending.sort()).toEqual(["b", "c"]);
    expect(cp.failed).toEqual([]);
  });

  it("forgets the cost of a failed step it resets, keeps the one it does not", () => {
    let cp = applyNodeCompletion(initCheckpoint(chain), "a", { outcome: "error", sessionId: null, nodeRunId: "ra", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.4 } });
    cp = applyNodeCompletion(cp, "b", { outcome: "error", sessionId: null, nodeRunId: "rb", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 } });
    expect(graphRunSpend(replayCheckpoint(cp, "b")).costUsd).toBe(0.4);
  });

  it("resets the whole graph when replaying from the root", () => {
    const cp = replayCheckpoint(allDone(), "a");
    expect(cp.completed).toEqual({});
    expect(cp.pending.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("summarizeGraphRun", () => {
  const chain = { nodeIds: ["a", "b", "c"], deps: [{ from: "a", to: "b" }, { from: "b", to: "c" }] };

  it("counts total/done/failed and computes duration for a finished run", () => {
    let cp = applyNodeCompletion(initCheckpoint(chain), "a", { outcome: "completed", sessionId: null, nodeRunId: "ra" });
    cp = applyNodeCompletion(cp, "b", { outcome: "error", sessionId: null, nodeRunId: "rb" });
    const rec = { ...buildGraphRunRecord({ projectId: "p", graph: chain, now: 1000, id: "g" }), checkpoint: cp, endedAt: 4000, status: "error" as const };
    expect(summarizeGraphRun(rec)).toEqual({ total: 3, done: 1, failed: 1, blocked: 0, durationMs: 3000, status: "error" });
  });

  it("reports null duration while the run is still in flight", () => {
    const rec = buildGraphRunRecord({ projectId: "p", graph: chain, now: 1000, id: "g" });
    expect(summarizeGraphRun(rec).durationMs).toBeNull();
  });
});

describe("buildGraphRunRecord", () => {
  it("creates a running record with an init checkpoint and stamped times", () => {
    const rec = buildGraphRunRecord({ projectId: "p1", graph, now: 1000, id: "gr_1" });
    expect(rec).toMatchObject({
      id: "gr_1",
      projectId: "p1",
      status: "running",
      startedAt: 1000,
      endedAt: null,
      updatedAt: 1000,
    });
    expect(rec.checkpoint.pending.sort()).toEqual(["a", "b"]);
  });
});
