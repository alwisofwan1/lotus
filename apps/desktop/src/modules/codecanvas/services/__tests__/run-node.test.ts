import { describe, it, expect } from "vitest";
import type { Node, Edge } from "@xyflow/react";
import { buildRunGraph } from "../canvas-run-scheduler";
import { initCheckpoint, type GraphRunRecord } from "../graph-run-record";
import {
  DEFAULT_RUN_NODE_SIZE,
  RUN_CARD_LABEL,
  pausedAtBudget,
  runCardLabel,
  RUN_CARD_TONE,
  formatRunElapsed,
  normalizeBudgetCap,
  raisedBudgetCap,
  runCardView,
  runMembersFromSelection,
  runNodePlacement,
  runNodeWorkflowId,
  runChainLabel,
  runGateAuthor,
  waitingRunGates,
  type RunGateWait,
} from "../run-node";

const node = (id: string, type: string, extra: Partial<Node> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data: {}, ...extra });
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, data: { wireKind: "triggers" } });

describe("buildRunGraph scope", () => {
  const nodes = [node("a", "agent"), node("b", "agent"), node("c", "agent")];
  const edges = [wire("a", "b"), wire("b", "c")];

  it("keeps only member nodes and edges with both ends inside", () => {
    expect(buildRunGraph(nodes, edges, new Set(["a", "b"]))).toEqual({ nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] });
  });

  it("without a scope takes every runnable node (today's behaviour)", () => {
    expect(buildRunGraph(nodes, edges).nodeIds).toEqual(["a", "b", "c"]);
  });

  it("never dispatches a non-runnable member", () => {
    expect(buildRunGraph([...nodes, node("n", "note")], edges, new Set(["a", "n"])).nodeIds).toEqual(["a"]);
  });
});

describe("runMembersFromSelection", () => {
  it("takes selected runnable nodes only", () => {
    const nodes = [
      node("a", "agent", { selected: true }),
      node("g", "human-gate", { selected: true }),
      node("n", "note", { selected: true }),
      node("b", "agent"),
    ];
    expect(runMembersFromSelection(nodes)).toEqual(["a", "g"]);
  });

  it("skips a node another Run Node already owns", () => {
    const nodes = [
      node("r1", "run", { data: { memberIds: ["a"] } }),
      node("a", "agent", { selected: true }),
      node("b", "agent", { selected: true }),
    ];
    expect(runMembersFromSelection(nodes)).toEqual(["b"]);
  });
});

describe("runNodePlacement", () => {
  it("sits above the members' bounding box", () => {
    const members = [node("a", "agent", { position: { x: 100, y: 400 } }), node("b", "agent", { position: { x: 60, y: 500 } })];
    expect(runNodePlacement(members)).toEqual({ x: 60, y: 400 - DEFAULT_RUN_NODE_SIZE.h - 40 });
  });
});

describe("runCardView", () => {
  const record = (patch: Partial<GraphRunRecord>): GraphRunRecord => ({
    id: "g1", projectId: "p", workflowId: runNodeWorkflowId("r1"), status: "running",
    checkpoint: initCheckpoint({ nodeIds: ["a", "b", "c"], deps: [] }),
    startedAt: 1_000, endedAt: null, updatedAt: 2_000, ...patch,
  });

  it("is Ready with no record and no live session", () => {
    expect(runCardView(null, false, 3, 0)).toMatchObject({ state: "idle", total: 3, finished: 0 });
  });

  it("is Running while a session is live, timed to now", () => {
    expect(runCardView(record({}), true, 3, 5_000)).toMatchObject({ state: "running", elapsedMs: 4_000 });
  });

  it("is Interrupted when the record says running but no session is live (app restarted mid-run)", () => {
    expect(runCardView(record({}), false, 3, 9_000)).toMatchObject({ state: "interrupted", elapsedMs: 1_000 });
  });

  it("maps finished records to Failed / Done and sums cost", () => {
    const checkpoint = {
      ...initCheckpoint({ nodeIds: ["a", "b", "c"], deps: [] }),
      completed: {
        a: { outcome: "completed" as const, sessionId: null, nodeRunId: "ra", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.25 } },
        b: { outcome: "completed" as const, sessionId: null, nodeRunId: "rb", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.5 } },
      },
      failed: ["c"],
      pending: [],
    };
    expect(runCardView(record({ status: "error", checkpoint, endedAt: 61_000 }), false, 3, 0))
      .toEqual({ state: "failed", gate: null, moreWaiting: 0, waitingMs: null, finished: 3, total: 3, failed: 1, costUsd: 0.75, unknownCostSteps: 0, budgetCap: null, elapsedMs: 60_000 });
    expect(runCardView(record({ status: "completed", endedAt: 2_000 }), false, 3, 0).state).toBe("done");
  });
});

describe("waiting on a member gate (#75)", () => {
  const gateNode = (id: string, status: string, waitingSince?: number) =>
    node(id, "human-gate", { data: { title: `Gate ${id}`, instructions: "Check it", status, ...(waitingSince ? { waitingSince } : {}) } });
  const live = (gates: RunGateWait[], now = 10_000) => runCardView(null, true, 3, now, gates);

  it("lists waiting member gates in member order, skipping other nodes and decided gates", () => {
    const board = new Map([gateNode("g2", "waiting", 4_000), node("a", "agent"), gateNode("g1", "waiting"), gateNode("g3", "approved")].map((n) => [n.id, n]));
    expect(waitingRunGates(["g1", "a", "g3", "g2", "gone"], (id) => board.get(id))).toEqual([
      { gateId: "g1", title: "Gate g1", instructions: "Check it" },
      { gateId: "g2", title: "Gate g2", instructions: "Check it", waitingSince: 4_000 },
    ]);
  });

  it("ac1 — a live run with a waiting gate is Waiting on you, in the amber blocked tone, timed from waitingSince", () => {
    const view = live([{ gateId: "g1", title: "Gate", instructions: "", waitingSince: 7_500 }]);
    expect(view).toMatchObject({ state: "waiting", gate: { gateId: "g1" }, moreWaiting: 0, waitingMs: 2_500 });
    expect(RUN_CARD_LABEL.waiting).toBe("Waiting on you");
    expect(RUN_CARD_TONE.waiting).toBe("blocked");
  });

  it("decides the first waiting gate and counts the rest", () => {
    const view = live([{ gateId: "g1", title: "A", instructions: "" }, { gateId: "g2", title: "B", instructions: "" }, { gateId: "g3", title: "C", instructions: "" }]);
    expect(view).toMatchObject({ gate: { gateId: "g1" }, moreWaiting: 2, waitingMs: null });
  });

  it("is never waiting without a live session (a gate left waiting by a closed app)", () => {
    const view = runCardView(null, false, 3, 0, [{ gateId: "g1", title: "A", instructions: "" }]);
    expect(view).toMatchObject({ state: "idle", gate: null, moreWaiting: 0 });
  });

  it("runGateAuthor: only a single upstream member is an author", () => {
    const members = ["a", "b", "g"];
    expect(runGateAuthor("g", members, [{ from: "a", to: "g" }])).toBe("a");
    expect(runGateAuthor("g", members, [{ from: "a", to: "g" }, { from: "b", to: "g" }])).toBeNull();
    expect(runGateAuthor("g", members, [])).toBeNull();
    expect(runGateAuthor("g", members, [{ from: "outside", to: "g" }])).toBeNull();
  });
});

describe("formatRunElapsed", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatRunElapsed(252_000)).toBe("4:12");
    expect(formatRunElapsed(3_729_000)).toBe("1:02:09");
  });
});

describe("Run Node persistence", () => {
  it("survives save → JSON → load with its title and members", async () => {
    const { toCanvasSnapshot } = await import("../canvas-serialize");
    const { decodeCanvasSnapshot } = await import("../canvas-snapshot-codec");
    const { recordToNode, runNode } = await import("../canvas-node-factory");

    const saved = toCanvasSnapshot({
      id: "c", rootDir: "/app", edges: [], noteContent: new Map(),
      nodes: [runNode({ id: "r1", position: { x: 10, y: 20 }, title: "Ship auth", memberIds: ["a", "b"], brief: "Add login rate limit" })],
    });
    const decoded = decodeCanvasSnapshot(JSON.parse(JSON.stringify(saved)));
    if (!decoded.ok) throw new Error(decoded.error);
    const record = decoded.snapshot.nodes.find((n) => n.id === "r1");
    expect(record).toMatchObject({ type: "run", title: "Ship auth", memberIds: ["a", "b"], brief: "Add login rate limit" });

    const restored = recordToNode(record!, "/app", null);
    expect(restored).toMatchObject({ id: "r1", type: "run", position: { x: 10, y: 20 }, data: { title: "Ship auth", memberIds: ["a", "b"], brief: "Add login rate limit" } });
  });

  it("ac6 — keeps the budget cap through save → JSON → load, and drops an invalid one", async () => {
    const { toCanvasSnapshot } = await import("../canvas-serialize");
    const { decodeCanvasSnapshot } = await import("../canvas-snapshot-codec");
    const { recordToNode, runNode } = await import("../canvas-node-factory");

    const saved = toCanvasSnapshot({
      id: "c", rootDir: "/app", edges: [], noteContent: new Map(),
      nodes: [
        runNode({ id: "r1", position: { x: 0, y: 0 }, memberIds: ["a"], budgetCap: 1.5 }),
        runNode({ id: "r2", position: { x: 0, y: 0 }, memberIds: ["b"] }),
      ],
    });
    const json = JSON.parse(JSON.stringify(saved)) as { nodes: Record<string, unknown>[] };
    json.nodes.push({ ...json.nodes[1], id: "r3", budgetCap: -2 });
    const decoded = decodeCanvasSnapshot(json);
    if (!decoded.ok) throw new Error(decoded.error);
    const byId = (id: string) => decoded.snapshot.nodes.find((n) => n.id === id)!;

    expect(byId("r1")).toMatchObject({ budgetCap: 1.5 });
    expect(recordToNode(byId("r1"), "/app", null).data).toMatchObject({ budgetCap: 1.5 });
    expect(byId("r2")).not.toHaveProperty("budgetCap");
    expect(recordToNode(byId("r2"), "/app", null).data).not.toHaveProperty("budgetCap");
    expect(byId("r3")).not.toHaveProperty("budgetCap");
  });

  it("#74 ac3 + ac9 — keeps open and changed members through save → JSON → load; absent is closed", async () => {
    const { toCanvasSnapshot } = await import("../canvas-serialize");
    const { decodeCanvasSnapshot } = await import("../canvas-snapshot-codec");
    const { recordToNode, runNode } = await import("../canvas-node-factory");

    const saved = toCanvasSnapshot({
      id: "c", rootDir: "/app", edges: [], noteContent: new Map(),
      nodes: [
        runNode({ id: "r1", position: { x: 0, y: 0 }, memberIds: ["a", "c"], open: true }),
        runNode({ id: "r2", position: { x: 0, y: 0 }, memberIds: ["b"] }),
      ],
    });
    const decoded = decodeCanvasSnapshot(JSON.parse(JSON.stringify(saved)));
    if (!decoded.ok) throw new Error(decoded.error);
    const byId = (id: string) => decoded.snapshot.nodes.find((n) => n.id === id)!;

    expect(byId("r1")).toMatchObject({ open: true, memberIds: ["a", "c"] });
    expect(recordToNode(byId("r1"), "/app", null).data).toMatchObject({ open: true, memberIds: ["a", "c"] });
    expect(byId("r2")).not.toHaveProperty("open");
    expect(recordToNode(byId("r2"), "/app", null).data).not.toHaveProperty("open");
  });
});

describe("runChainLabel", () => {
  const m = (id: string) => ({ id, label: id.toUpperCase() });

  it("shows unwired members as starting together, not as an order", () => {
    expect(runChainLabel([m("a"), m("b")], [])).toBe("A + B");
  });

  it("follows the order wires: a fan-out shows its parallel steps", () => {
    expect(runChainLabel([m("c"), m("b"), m("a")], [{ from: "a", to: "b" }, { from: "a", to: "c" }])).toBe("A → C + B");
  });

  it("ignores wires to non-members and ends a cycle as one group", () => {
    expect(runChainLabel([m("a"), m("b")], [{ from: "x", to: "a" }, { from: "a", to: "b" }, { from: "b", to: "a" }])).toBe("A + B");
  });
});

describe("budget cap (#76)", () => {
  const paid = (costUsd?: number) => ({ outcome: "completed" as const, sessionId: null, nodeRunId: "r", ...(costUsd !== undefined ? { usage: { inputTokens: 1, outputTokens: 1, costUsd } } : {}) });
  const record = (patch: Partial<GraphRunRecord>): GraphRunRecord => ({
    id: "g1", projectId: "p", workflowId: runNodeWorkflowId("r1"), status: "paused",
    checkpoint: { ...initCheckpoint({ nodeIds: ["a", "b", "c"], deps: [] }), completed: { a: paid(0.6), b: paid(0.5) }, pending: ["c"] },
    startedAt: 1_000, endedAt: null, updatedAt: 2_000, ...patch,
  });

  it("a paused record is Paused · budget in the amber tone, with its spend and cap", () => {
    const view = runCardView(record({}), false, 3, 9_000, [], 1);
    expect(view).toMatchObject({ state: "paused", costUsd: 1.1, budgetCap: 1, finished: 2, elapsedMs: 1_000 });
    expect(runCardLabel(view)).toBe("Paused · budget");
    expect(pausedAtBudget(view)).toBe(true);
    expect(RUN_CARD_TONE.paused).toBe("blocked");
  });

  it("a run paused from the ⋯ menu under its cap is just Paused, not at budget (#114)", () => {
    const view = runCardView(record({}), false, 3, 9_000, [], 5);
    expect(runCardLabel(view)).toBe("Paused");
    expect(pausedAtBudget(view)).toBe(false);
    expect(runCardLabel(runCardView(record({}), false, 3, 9_000))).toBe("Paused");
  });

  it("a live run being paused reads Pausing…, but a waiting gate still wins (#114)", () => {
    expect(runCardView(record({}), true, 3, 9_000, [], null, true).state).toBe("pausing");
    const gate = { gateId: "g", title: "Review", instructions: "" };
    expect(runCardView(record({}), true, 3, 9_000, [gate], null, true).state).toBe("waiting");
  });

  it("a live session wins over the paused record (the run was just resumed)", () => {
    expect(runCardView(record({}), true, 3, 9_000, [], 1.5).state).toBe("running");
  });

  it("counts finished steps that reported no cost", () => {
    const view = runCardView(record({ checkpoint: { ...record({}).checkpoint, completed: { a: paid(), b: paid(0.2) } } }), false, 3, 0);
    expect(view).toMatchObject({ costUsd: 0.2, unknownCostSteps: 1, budgetCap: null });
  });

  it("treats empty, zero, negative and non-numbers as no cap", () => {
    for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1"]) expect(normalizeBudgetCap(bad)).toBeUndefined();
    expect(normalizeBudgetCap(0.5)).toBe(0.5);
  });

  it("keeps a cap in whole cents (#76 fix 2): 0.113906 is 0.11, below a cent is no cap", () => {
    expect(normalizeBudgetCap(0.113906)).toBe(0.11);
    expect(normalizeBudgetCap(0.125)).toBe(0.13);
    expect(normalizeBudgetCap(0.004)).toBeUndefined();
  });

  it("raises from max(cap, spent) × 1.5, rounded up to whole cents (#76 fix 1)", () => {
    expect(raisedBudgetCap(0.01, 0.08)).toBe(0.12); // the app test: spend 8× the cap, one press
    expect(raisedBudgetCap(1, 1.1)).toBe(1.65); // spec ac4
    expect(raisedBudgetCap(1, 0.5)).toBe(1.5); // spend below the cap: the cap is the base
    expect(raisedBudgetCap(1, null)).toBe(1.5); // spend unknown
    expect(raisedBudgetCap(0.1, 0.0701)).toBe(0.15);
    expect(raisedBudgetCap(0.01, 0.0734)).toBe(0.12); // 0.1101 rounds UP to 0.12
  });

  it("always raises past the spend, so one press is enough to dispatch the next step", () => {
    for (const cap of [0.01, 0.1, 1, 3.33]) {
      for (const spent of [0.01, 0.08, 0.99, 1, 5.55, 80]) expect(raisedBudgetCap(cap, spent)).toBeGreaterThan(spent);
    }
  });
});
