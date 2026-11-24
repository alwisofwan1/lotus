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
import type { GraphRunStore } from "../../services/graph-run-store";
import { runNodeWorkflowId } from "../../services/run-node";
import type { CanvasNodeCommand } from "../../services/nodes/canvas-node-command";

const store = () => disk.store as GraphRunStore;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const agent = (id: string, name: string): Node => ({ id, type: "agent", position: { x: 0, y: 0 }, data: { name } });
const gate = (id: string, title = "Review the diff"): Node => ({
  id, type: "human-gate", position: { x: 0, y: 0 },
  data: { title, instructions: "Read the PR before shipping.", gateKind: "approval", status: "idle" },
});
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, data: { wireKind: "triggers" } });

/** The canvas, cut down: gate patches land on the board, so the gate node and the run card both see them. */
function Board({ memberIds, selected = true }: { memberIds: string[]; selected?: boolean }) {
  const storeApi = useStoreApi();
  const nodes = useNodes();
  // Straight into the store: without a <ReactFlow> mounted, updateNodeData only emits change events.
  const dispatchCommand = useCallback((command: CanvasNodeCommand) => {
    if (command.kind !== "patch-human-gate") return;
    const { nodes: current, setNodes } = storeApi.getState();
    setNodes(current.map((n) => (n.id === command.nodeId ? { ...n, data: { ...n.data, ...command.patch } } : n)));
  }, [storeApi]);
  const runProps = {
    id: runId,
    data: { title: "Ship auth", memberIds, brief: "Add login rate limit", projectId: "p1", dispatchCommand },
    selected,
  } as unknown as Parameters<typeof RunNode>[0];
  return (
    <>
      {nodes.filter((n) => n.type === "human-gate").map((n) => (
        <div key={n.id} data-testid={`gate-${n.id}`}>
          <HumanGateNode {...({ id: n.id, data: { ...n.data, dispatchCommand }, selected: false } as unknown as Parameters<typeof HumanGateNode>[0])} />
        </div>
      ))}
      <div data-testid="card"><RunNode {...runProps} /></div>
    </>
  );
}

// The in-memory store outlives each test, so every test files its records under a fresh Run Node id.
let runCount = 0;
let runId = "";
beforeEach(() => { runId = `run-${++runCount}`; });
const ran: string[] = [];
const unregister: Array<() => void> = [];
afterEach(() => {
  unregister.splice(0).forEach((fn) => fn());
  ran.length = 0;
  lod.tier = "full";
});
const registerAgents = (...ids: string[]) => ids.forEach((id) => unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) })));
const finish = (id: string) => act(() => agentRunRegistry.reportResult(id, true, { outcome: "completed", sessionId: null, nodeRunId: `r-${id}-${ran.length}` }));
const card = () => within(screen.getByTestId("card"));
const gateStatus = (id: string) => within(screen.getByTestId(`gate-${id}`)).getByText(/^(idle|waiting|approved|rejected)$/).textContent;
const runsOf = async () => (await store().list("p1")).filter((r) => r.workflowId === runNodeWorkflowId(runId));

/** a (plan) → w (writer, the gate's author) → g (gate) → d (deploy), all members of one run. */
function startPipeline(edges: Edge[] = [wire("a", "w"), wire("w", "g"), wire("g", "d")], memberIds = ["a", "w", "g", "d"]) {
  registerAgents("a", "w", "d");
  const tree = () => (
    <ReactFlowProvider initialNodes={[agent("a", "Ren"), agent("w", "Kai"), gate("g"), agent("d", "Mo")]} initialEdges={edges}>
      <Board memberIds={memberIds} />
    </ReactFlowProvider>
  );
  const { rerender } = render(tree());
  fireEvent.click(card().getByRole("button", { name: /Run/ }));
  return () => rerender(tree());
}

async function reachGate() {
  const rerender = startPipeline();
  finish("a");
  finish("w");
  await flush();
  return rerender;
}

describe("RunNode — decide from the card (#75)", () => {
  it("ac1 — a live run with a waiting member gate shows Waiting on you and Decide", async () => {
    await reachGate();
    expect(gateStatus("g")).toBe("waiting");
    expect(card().getByText("Waiting on you")).toBeTruthy();
    expect(card().getByRole("button", { name: /^Decide/ })).toBeTruthy();
    expect(screen.getByTestId("card").querySelector(".run-card")?.getAttribute("data-tone")).toBe("blocked");
  });

  it("ac2 — Ship approves the gate, dispatches downstream, and the run finishes Done", async () => {
    await reachGate();
    fireEvent.click(card().getByRole("button", { name: /^Decide/ }));
    expect(card().getByText("Read the PR before shipping.")).toBeTruthy();
    fireEvent.click(card().getByRole("button", { name: /Ship/ }));

    expect(gateStatus("g")).toBe("approved");
    expect(ran).toEqual(["a", "w", "d"]);
    finish("d");
    await flush();
    expect(card().getByText("Done")).toBeTruthy();
    expect((await runsOf()).map((r) => r.status)).toEqual(["completed"]);
  });

  it("ac3 — Send back rejects, then a new run replays the author and the gate, not what came before", async () => {
    await reachGate();
    fireEvent.click(card().getByRole("button", { name: /^Decide/ }));
    fireEvent.click(card().getByRole("button", { name: /Send back/ }));
    await flush();
    await flush();

    expect(ran).toEqual(["a", "w", "w"]); // a is not re-run, d never ran
    const runs = await runsOf();
    expect(runs).toHaveLength(2);
    const [replay, rejected] = runs;
    expect(rejected.status).toBe("error");
    expect(rejected.checkpoint.failed).toContain("g");
    expect(Object.keys(replay.checkpoint.completed)).toEqual(["a"]);

    finish("w");
    await flush();
    expect(gateStatus("g")).toBe("waiting");
    expect(card().getByText("Waiting on you")).toBeTruthy();
    expect(ran).toEqual(["a", "w", "w"]);
  });

  it("ac4 — Send back is disabled, with a reason, when the gate has no single upstream member", async () => {
    // Two members feed the gate: which one to send back to is ambiguous.
    startPipeline([wire("a", "g"), wire("w", "g"), wire("g", "d")]);
    finish("a");
    finish("w");
    await flush();
    fireEvent.click(card().getByRole("button", { name: /^Decide/ }));
    const sendBack = card().getByRole("button", { name: /Send back/ }) as HTMLButtonElement;
    expect(sendBack.disabled).toBe(true);
    expect(sendBack.title).toMatch(/exactly one member/);
    fireEvent.keyDown(window, { key: "2" });
    expect(gateStatus("g")).toBe("waiting");
  });

  it("ac5 — Enter opens, Esc closes, 2 sends back; ⌥1 does nothing", async () => {
    await reachGate();
    fireEvent.keyDown(window, { key: "1" });
    expect(gateStatus("g")).toBe("waiting"); // the card is closed: digits do not decide

    fireEvent.keyDown(window, { key: "Enter" });
    expect(card().getByRole("group", { name: /Decide/ })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(card().queryByRole("group", { name: /Decide/ })).toBeNull();
    expect(gateStatus("g")).toBe("waiting");

    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "1", altKey: true });
    expect(gateStatus("g")).toBe("waiting");
    fireEvent.keyDown(window, { key: "2" });
    expect(gateStatus("g")).toBe("rejected");
  });

  it("ac5 — 1 ships", async () => {
    await reachGate();
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "1" });
    expect(gateStatus("g")).toBe("approved");
    expect(ran).toEqual(["a", "w", "d"]);
  });

  it("ac6 — the zoomed-out glyph says Waiting on you", async () => {
    const rerender = await reachGate();
    lod.tier = "glyph";
    rerender();
    const glyph = screen.getByRole("img", { name: "Ship auth — Waiting on you" });
    expect(glyph.getAttribute("data-tone")).toBe("blocked");
  });

  it("ac7 — approving on the gate node itself clears the card's waiting state", async () => {
    await reachGate();
    fireEvent.click(within(screen.getByTestId("gate-g")).getByRole("button", { name: "Approve" }));
    expect(card().queryByText("Waiting on you")).toBeNull();
    expect(card().getByText("Running")).toBeTruthy();
    expect(ran).toEqual(["a", "w", "d"]);
  });

  it("decides the first waiting gate in member order and says how many more wait", async () => {
    registerAgents("a");
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren"), gate("g1", "First gate"), gate("g2", "Second gate")]}>
        <Board memberIds={["a", "g1", "g2"]} />
      </ReactFlowProvider>,
    );
    fireEvent.click(card().getByRole("button", { name: /Run/ }));
    await flush();
    expect(card().getByText("· +1 waiting")).toBeTruthy();
    fireEvent.click(card().getByRole("button", { name: /^Decide/ }));
    expect(card().getByRole("group", { name: "Decide: First gate" })).toBeTruthy();
    fireEvent.click(card().getByRole("button", { name: /Ship/ }));
    expect(gateStatus("g1")).toBe("approved");
    expect(gateStatus("g2")).toBe("waiting");
    expect(card().queryByText("· +1 waiting")).toBeNull();
    act(() => agentRunRegistry.reportResult("a", true));
  });
});
