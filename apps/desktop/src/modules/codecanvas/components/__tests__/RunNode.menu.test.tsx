import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, useNodes, useStoreApi, type Edge, type Node } from "@xyflow/react";
import { useCallback, type ReactNode } from "react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, Handle: () => null, NodeResizer: () => null, ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</> };
});
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => "full" }));

const disk = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("@/modules/codecanvas/services/graph-run-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/graph-run-store")>();
  const store = actual.createInMemoryGraphRunStore();
  disk.store = store;
  return { ...actual, graphRunStore: store };
});

import { RunNode } from "../nodes/RunNode";
import { agentRunRegistry } from "../../services/agent-run-registry";
import type { GraphRunStore } from "../../services/graph-run-store";
import { runNodeWorkflowId } from "../../services/run-node";
import type { CanvasNodeCommand } from "../../services/nodes/canvas-node-command";

const store = () => disk.store as GraphRunStore;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const agent = (id: string, name: string): Node => ({ id, type: "agent", position: { x: 0, y: 0 }, width: 100, height: 50, data: { name } });
const wire = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target, data: { wireKind: "triggers" } });

let runCount = 0;
let runId = "";
beforeEach(() => { runId = `menu-run-${++runCount}`; });
const ran: string[] = [];
const unregister: Array<() => void> = [];
afterEach(() => {
  unregister.splice(0).forEach((fn) => fn());
  ran.length = 0;
});

function Board() {
  const storeApi = useStoreApi();
  const nodes = useNodes();
  const dispatchCommand = useCallback((command: CanvasNodeCommand) => {
    if (command.kind !== "patch-run") return;
    const { nodes: current, setNodes } = storeApi.getState();
    setNodes(current.map((n) => (n.id === command.nodeId ? { ...n, data: { ...n.data, ...command.patch } } : n)));
  }, [storeApi]);
  const run = nodes.find((n) => n.id === runId);
  const runProps = { id: runId, data: { ...run?.data, projectId: "p1", dispatchCommand }, selected: true } as unknown as Parameters<typeof RunNode>[0];
  return <div data-testid="card"><RunNode {...runProps} /></div>;
}

const card = () => within(screen.getByTestId("card"));
const status = () => screen.getByTestId("card").querySelector(".run-card-status")?.textContent;
const state = () => screen.getByTestId("card").querySelector("[data-run-state]")?.getAttribute("data-run-state");
const runsOf = async () => (await store().list("p1")).filter((r) => r.workflowId === runNodeWorkflowId(runId));
const finish = (id: string) => act(() => agentRunRegistry.reportResult(id, true, { outcome: "completed", sessionId: null, nodeRunId: `r-${id}` }));
const menu = (name: "Pause" | "Abort") => {
  fireEvent.click(card().getByRole("button", { name: "Run menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`^${name}`) }));
};

/** a → b, started; `open` draws it as the group (#74). */
function start(open = false) {
  for (const id of ["a", "b"]) unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) }));
  render(
    <ReactFlowProvider
      initialNodes={[agent("a", "Ren"), agent("b", "Kai"), {
        id: runId, type: "run", position: { x: 0, y: 0 },
        data: { title: "Ship auth", memberIds: ["a", "b"], brief: "Add login rate limit", open },
      }]}
      initialEdges={[wire("a", "b")]}
    >
      <Board />
    </ReactFlowProvider>,
  );
  fireEvent.click(card().getByRole("button", { name: /^Run$/ }));
}

describe("RunNode — Pause and Abort from the ⋯ menu (#114)", () => {
  it("no ⋯ before the run starts", () => {
    for (const id of ["a", "b"]) unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) }));
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren"), { id: runId, type: "run", position: { x: 0, y: 0 }, data: { title: "Ship auth", memberIds: ["a"], brief: "x" } }]}>
        <Board />
      </ReactFlowProvider>,
    );
    expect(card().queryByRole("button", { name: "Run menu" })).toBeNull();
  });

  it("Pause: Pausing… while the step finishes, then Paused (not · budget) with Resume, which runs only what is left", async () => {
    start();
    expect(ran).toEqual(["a"]);
    menu("Pause");
    expect(state()).toBe("pausing");
    expect(status()).toBe("Pausing…");
    // Pausing: only Abort is left in the menu.
    fireEvent.click(card().getByRole("button", { name: "Run menu" }));
    expect(screen.queryByRole("menuitem", { name: /^Pause/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /^Abort/ })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });

    finish("a");
    await flush();
    expect(ran).toEqual(["a"]);
    expect(state()).toBe("paused");
    expect(status()).toBe("Paused");
    expect(card().queryByRole("button", { name: /Raise cap/ })).toBeNull();
    expect((await runsOf())[0].status).toBe("paused");

    fireEvent.click(card().getByRole("button", { name: /Resume/ }));
    expect(ran).toEqual(["a", "b"]);
    finish("b");
    await flush();
    expect(state()).toBe("done");
  });

  it("Abort: Stopped at once, no next step, the running step's result is ignored", async () => {
    start();
    menu("Abort");
    await flush();
    expect(state()).toBe("stopped");
    expect(status()).toBe("Stopped");
    expect((await runsOf())[0].status).toBe("cancelled");

    finish("a");
    await flush();
    expect(ran).toEqual(["a"]);
    expect(state()).toBe("stopped");
    expect(card().queryByRole("button", { name: "Run menu" })).toBeNull();
    expect(card().getByRole("button", { name: /Run again/ })).toBeTruthy();
  });

  it("Abort a paused run: it is no longer resumable", async () => {
    start();
    menu("Pause");
    finish("a");
    await flush();
    expect(card().getByRole("button", { name: /Resume/ })).toBeTruthy();

    menu("Abort");
    await flush();
    expect(state()).toBe("stopped");
    expect(card().queryByRole("button", { name: /Resume/ })).toBeNull();
    expect((await runsOf())[0].status).toBe("cancelled");
  });

  it("the open group header has the same ⋯", async () => {
    start(true);
    expect(screen.getByTestId("run-group")).toBeTruthy();
    menu("Pause");
    expect(status()).toBe("Pausing…");
    finish("a");
    await flush();
    expect(status()).toBe("Paused");
  });
});
