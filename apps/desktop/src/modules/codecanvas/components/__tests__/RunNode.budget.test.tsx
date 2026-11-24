import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, useNodes, useStoreApi, type Edge, type Node } from "@xyflow/react";
import { useCallback } from "react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, Handle: () => null, NodeResizer: () => null };
});
const lod = vi.hoisted(() => ({ tier: "full" as "full" | "glyph" }));
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => lod.tier }));

const disk = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("@/modules/codecanvas/services/graph-run-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/graph-run-store")>();
  const store = actual.createInMemoryGraphRunStore();
  disk.store = store;
  return { ...actual, graphRunStore: store };
});

import { RunNode } from "../nodes/RunNode";
import { HumanGateNode } from "../nodes/HumanGateNode";
import { agentRunRegistry } from "../../services/agent-run-registry";
import { applyNodeCompletion, buildGraphRunRecord, type GraphRunNodeResult } from "../../services/graph-run-record";
import type { GraphRunStore } from "../../services/graph-run-store";
import { runNodeWorkflowId } from "../../services/run-node";
import type { CanvasNodeCommand } from "../../services/nodes/canvas-node-command";

const store = () => disk.store as GraphRunStore;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const agent = (id: string, name: string): Node => ({ id, type: "agent", position: { x: 0, y: 0 }, data: { name } });
const gate = (id: string): Node => ({
  id, type: "human-gate", position: { x: 0, y: 0 },
  data: { title: "Review the diff", instructions: "Read it.", gateKind: "approval", status: "idle" },
});
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, data: { wireKind: "triggers" } });

// The in-memory store outlives each test, so every test files its records under a fresh Run Node id.
let runCount = 0;
let runId = "";
beforeEach(() => { runId = `budget-run-${++runCount}`; });
const ran: string[] = [];
const unregister: Array<() => void> = [];
afterEach(() => {
  unregister.splice(0).forEach((fn) => fn());
  ran.length = 0;
  lod.tier = "full";
});

const runNode = (memberIds: string[], budgetCap?: number): Node => ({
  id: runId, type: "run", position: { x: 0, y: 0 },
  data: { title: "Ship auth", memberIds, brief: "Add login rate limit", ...(budgetCap !== undefined ? { budgetCap } : {}) },
});

/** The canvas, cut down: run and gate patches land on the board, and the card reads its data back from it. */
function Board() {
  const storeApi = useStoreApi();
  const nodes = useNodes();
  // Straight into the store: without a <ReactFlow> mounted, updateNodeData only emits change events.
  const dispatchCommand = useCallback((command: CanvasNodeCommand) => {
    if (command.kind !== "patch-human-gate" && command.kind !== "patch-run") return;
    const { nodes: current, setNodes } = storeApi.getState();
    setNodes(current.map((n) => (n.id === command.nodeId ? { ...n, data: { ...n.data, ...command.patch } } : n)));
  }, [storeApi]);
  const run = nodes.find((n) => n.id === runId);
  const runProps = { id: runId, data: { ...run?.data, projectId: "p1", dispatchCommand }, selected: true } as unknown as Parameters<typeof RunNode>[0];
  return (
    <>
      {nodes.filter((n) => n.type === "human-gate").map((n) => (
        <div key={n.id} data-testid={`gate-${n.id}`}>
          <HumanGateNode {...({ id: n.id, data: { ...n.data, dispatchCommand }, selected: false } as unknown as Parameters<typeof HumanGateNode>[0])} />
        </div>
      ))}
      <div data-testid="card"><RunNode {...runProps} /></div>
      <output data-testid="cap">{String(run?.data.budgetCap)}</output>
    </>
  );
}

const registerAgents = (...ids: string[]) => ids.forEach((id) => unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) })));
const result = (id: string, costUsd?: number): GraphRunNodeResult => ({
  outcome: "completed", sessionId: null, nodeRunId: `r-${id}-${ran.length}`, ...(costUsd !== undefined ? { usage: { inputTokens: 1, outputTokens: 1, costUsd } } : {}),
});
const finish = (id: string, costUsd?: number) => act(() => agentRunRegistry.reportResult(id, true, result(id, costUsd)));
const card = () => within(screen.getByTestId("card"));
const runCard = () => screen.getByTestId("card").querySelector(".run-card");
const nodeCap = () => screen.getByTestId("cap").textContent;
const runsOf = async () => (await store().list("p1")).filter((r) => r.workflowId === runNodeWorkflowId(runId));

function board(nodes: Node[], edges: Edge[] = []) {
  const tree = () => (
    <ReactFlowProvider initialNodes={nodes} initialEdges={edges}>
      <Board />
    </ReactFlowProvider>
  );
  const { rerender } = render(tree());
  return () => rerender(tree());
}

/** a → b → c under `cap`, started. */
function startPipeline(cap?: number) {
  registerAgents("a", "b", "c");
  const rerender = board(
    [agent("a", "Ren"), agent("b", "Kai"), agent("c", "Mo"), runNode(["a", "b", "c"], cap)],
    [wire("a", "b"), wire("b", "c")],
  );
  fireEvent.click(card().getByRole("button", { name: /^Run$/ }));
  return rerender;
}

async function pauseAtCap() {
  const rerender = startPipeline(1);
  finish("a", 0.6);
  finish("b", 0.5);
  await flush();
  return rerender;
}

describe("RunNode — budget cap (#76)", () => {
  it("ac2 — at the cap the next step never starts: Paused · budget, $spent / $cap, Raise cap", async () => {
    await pauseAtCap();
    expect(ran).toEqual(["a", "b"]);
    expect(card().getByText("Paused · budget")).toBeTruthy();
    // #76 fix 3: once, beside the meter — not again in the meta line.
    expect(card().getAllByText(/\$1\.10 \/ \$1\.00/)).toHaveLength(1);
    expect(card().getByText("$1.10 / $1.00").className).toBe("run-card-budget-text");
    expect(card().getByRole("button", { name: /Raise cap/ })).toBeTruthy();
    expect(runCard()?.getAttribute("data-run-state")).toBe("paused");
    expect(runCard()?.getAttribute("data-tone")).toBe("blocked");
    const [record] = await runsOf();
    expect(record.status).toBe("paused");
    expect(record.endedAt).toBeNull();
  });

  it("ac1 — without a cap the same spend runs to Done, with no meter", async () => {
    startPipeline();
    finish("a", 0.6);
    finish("b", 0.5);
    finish("c", 0.5);
    await flush();
    expect(ran).toEqual(["a", "b", "c"]);
    expect(card().getByText("Done")).toBeTruthy();
    expect(card().getByText("· $1.60")).toBeTruthy();
    expect(card().queryByRole("meter")).toBeNull();
  });

  it("ac4 — Raise cap writes max(cap, spent) × 1.5 and continues from the checkpoint: only c runs, then Done", async () => {
    await pauseAtCap();
    fireEvent.click(card().getByRole("button", { name: /Raise cap/ }));
    expect(nodeCap()).toBe("1.65");
    expect(ran).toEqual(["a", "b", "c"]);
    expect(card().getByText("Running")).toBeTruthy();

    finish("c", 0.2);
    await flush();
    expect(card().getByText("Done")).toBeTruthy();
    const runs = await runsOf();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
  });

  it("ac4 — Enter on the selected paused card raises the cap", async () => {
    await pauseAtCap();
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    expect(nodeCap()).toBe("1");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(nodeCap()).toBe("1.65");
    expect(ran).toEqual(["a", "b", "c"]);
  });

  it("#76 fix 1 — spend 8× the cap: one Raise cap dispatches the next step, cap $0.12", async () => {
    registerAgents("a", "b");
    board([agent("a", "Ren"), agent("b", "Kai"), runNode(["a", "b"], 0.01)], [wire("a", "b")]);
    fireEvent.click(card().getByRole("button", { name: /^Run$/ }));
    finish("a", 0.08);
    await flush();
    expect(card().getByText("Paused · budget")).toBeTruthy();

    fireEvent.click(card().getByRole("button", { name: /Raise cap/ }));
    expect(nodeCap()).toBe("0.12");
    expect(ran).toEqual(["a", "b"]);
    expect(card().getByText("Running")).toBeTruthy();
    finish("b", 0.01);
    await flush();
    expect(card().getByText("Done")).toBeTruthy();
  });

  it("#76 fix 2 — the cap field shows whole cents, after Raise cap and for an old float cap", async () => {
    const field = () => card().getByRole("textbox", { name: "Budget cap (USD)" }) as HTMLInputElement;
    registerAgents("a", "b");
    board([agent("a", "Ren"), agent("b", "Kai"), runNode(["a", "b"], 0.113906)], [wire("a", "b")]);
    expect(field().value).toBe("0.11");
    fireEvent.click(card().getByRole("button", { name: /^Run$/ }));
    finish("a", 0.2);
    await flush();
    fireEvent.click(card().getByRole("button", { name: /Raise cap/ }));
    expect(nodeCap()).toBe("0.3");
    expect(field().value).toBe("0.30");
  });

  it("#76 fix 2 — a typed cap is stored in whole cents", async () => {
    registerAgents("a");
    board([agent("a", "Ren"), runNode(["a"])]);
    const field = () => card().getByRole("textbox", { name: "Budget cap (USD)" }) as HTMLInputElement;
    fireEvent.change(field(), { target: { value: "0.113906" } });
    fireEvent.blur(field());
    expect(nodeCap()).toBe("0.11");
    expect(field().value).toBe("0.11");
  });

  it("ac5 — a step without a cost adds nothing to the spend and is named on the card", async () => {
    startPipeline(1);
    finish("a");
    finish("b", 0.4);
    finish("c", 0.1);
    await flush();
    expect(ran).toEqual(["a", "b", "c"]);
    expect(card().getByText("Done")).toBeTruthy();
    expect(card().getByText("· cost unknown · 1 step")).toBeTruthy();
    expect(card().getByText("$0.50 / $1.00")).toBeTruthy();
  });

  it("ac7 — a paused record found after a restart is still Paused · budget, and Raise cap resumes it", async () => {
    registerAgents("a", "b", "c");
    let record = buildGraphRunRecord({
      projectId: "p1", graph: { nodeIds: ["a", "b", "c"], deps: [{ from: "a", to: "b" }, { from: "b", to: "c" }] },
      now: 1, id: `rec-${runId}`, workflowId: runNodeWorkflowId(runId),
    });
    record = { ...record, checkpoint: applyNodeCompletion(record.checkpoint, "a", result("a", 0.6)) };
    record = { ...record, status: "paused", checkpoint: applyNodeCompletion(record.checkpoint, "b", result("b", 0.5)) };
    await store().create(record);

    board([agent("a", "Ren"), agent("b", "Kai"), agent("c", "Mo"), runNode(["a", "b", "c"], 1)], [wire("a", "b"), wire("b", "c")]);
    await flush();
    expect(card().getByText("Paused · budget")).toBeTruthy();
    expect(card().queryByText("Interrupted")).toBeNull();

    fireEvent.click(card().getByRole("button", { name: /Raise cap/ }));
    expect(ran).toEqual(["c"]);
    finish("c", 0.1);
    await flush();
    expect((await store().get(`rec-${runId}`))?.status).toBe("completed");
  });

  it("ac8 — a waiting gate wins over the cap: Decide first, then the run pauses", async () => {
    registerAgents("a", "d");
    board([agent("a", "Ren"), gate("g"), agent("d", "Mo"), runNode(["a", "g", "d"], 1)], [wire("a", "d"), wire("g", "d")]);
    fireEvent.click(card().getByRole("button", { name: /^Run$/ }));
    finish("a", 1.2);
    await flush();
    expect(card().getByText("Waiting on you")).toBeTruthy();
    expect(card().getByRole("button", { name: /^Decide/ })).toBeTruthy();
    expect(card().queryByRole("button", { name: /Raise cap/ })).toBeNull();

    fireEvent.click(within(screen.getByTestId("gate-g")).getByRole("button", { name: "Approve" }));
    await flush();
    expect(ran).toEqual(["a"]);
    expect(card().getByText("Paused · budget")).toBeTruthy();
  });

  it("ac9 — the zoomed-out glyph says Paused · budget with the paused state", async () => {
    const rerender = await pauseAtCap();
    lod.tier = "glyph";
    rerender();
    const glyph = screen.getByRole("img", { name: "Ship auth — Paused · budget" });
    expect(glyph.getAttribute("data-tone")).toBe("blocked");
    expect(glyph.getAttribute("data-run-state")).toBe("paused");
  });

  it("ac10 — the meter fills spent / cap and shows $spent / $cap", async () => {
    registerAgents("a");
    board([agent("a", "Ren"), runNode(["a"], 1)]);
    fireEvent.click(card().getByRole("button", { name: /^Run$/ }));
    finish("a", 0.6);
    await flush();
    const meter = card().getByRole("meter", { name: "Budget" });
    expect(meter.getAttribute("aria-valuenow")).toBe("0.6");
    expect(meter.getAttribute("aria-valuemax")).toBe("1");
    expect(meter.hasAttribute("data-full")).toBe(false);
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("60%");
    expect(card().getByText("$0.60 / $1.00")).toBeTruthy();
  });

  it("ac10 — at the cap the meter is full", async () => {
    await pauseAtCap();
    const meter = card().getByRole("meter", { name: "Budget" });
    expect(meter.hasAttribute("data-full")).toBe(true);
    expect((meter.firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("the cap field sets and clears the cap, and is read-only while the run is live", async () => {
    registerAgents("a");
    board([agent("a", "Ren"), runNode(["a"])]);
    const field = () => card().getByRole("textbox", { name: "Budget cap (USD)" }) as HTMLInputElement;
    expect(card().queryByRole("meter")).toBeNull();

    fireEvent.change(field(), { target: { value: "2" } });
    fireEvent.blur(field());
    expect(nodeCap()).toBe("2");
    expect(field().value).toBe("2.00");
    expect(card().getByText("$0.00 / $2.00")).toBeTruthy();

    fireEvent.change(field(), { target: { value: "0" } });
    fireEvent.blur(field());
    expect(nodeCap()).toBe("undefined");
    expect(field().value).toBe("");

    fireEvent.click(card().getByRole("button", { name: /^Run$/ }));
    expect(field().readOnly).toBe(true);
    finish("a");
    await flush();
    expect(field().readOnly).toBe(false);
  });
});
