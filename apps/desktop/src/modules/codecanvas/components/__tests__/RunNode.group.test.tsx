import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, useStoreApi, type Node } from "@xyflow/react";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  // No <ReactFlow> is mounted, so there is no viewport to portal into: draw in place.
  return { ...actual, Handle: () => null, NodeResizer: () => null, ViewportPortal: ({ children }: { children: ReactNode }) => <>{children}</> };
});
const lod = vi.hoisted(() => ({ tier: "full" as "full" | "glyph" }));
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => lod.tier }));

import { RunNode } from "../nodes/RunNode";
import { RunGroupOverlay } from "../nodes/RunGroupOverlay";
import { agentRunRegistry } from "../../services/agent-run-registry";
import { RUN_GROUP_HEADER, RUN_GROUP_PAD } from "../../services/run-group";
import { isRunNodeActive } from "../../services/run-node-activity";
import type { RunCardView } from "../../services/run-node";

const agent = (id: string, name: string, x: number): Node =>
  ({ id, type: "agent", position: { x, y: 0 }, width: 100, height: 50, data: { name } });
const props = (memberIds: string[], extra: Record<string, unknown> = {}) => ({
  id: "run-1",
  data: { title: "Ship auth", memberIds, brief: "Add login rate limit", dispatchCommand: vi.fn(), ...extra },
  selected: false,
}) as unknown as Parameters<typeof RunNode>[0];
const dispatchOf = (p: Parameters<typeof RunNode>[0]) => (p.data as { dispatchCommand: ReturnType<typeof vi.fn> }).dispatchCommand;

const unregister: Array<() => void> = [];
afterEach(() => {
  unregister.splice(0).forEach((fn) => fn());
  lod.tier = "full";
});

let moveMember: (id: string, x: number, dragging?: boolean) => void = () => {};
function Mover() {
  const api = useStoreApi();
  moveMember = (id, x, dragging = false) => {
    const { nodes, setNodes } = api.getState();
    setNodes(nodes.map((n) => (n.id === id ? { ...n, position: { x, y: 0 }, dragging } : n)));
  };
  return null;
}

describe("RunNode — open as a group (#74)", () => {
  it("ac1 — › asks to open; open draws the outline around all members instead of the card, and it follows them", () => {
    const closed = props(["a", "b"]);
    const { rerender } = render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0), agent("b", "Kai", 200)]}>
        <RunNode {...closed} />
      </ReactFlowProvider>,
    );
    expect(screen.queryByTestId("run-group")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open as group" }));
    expect(dispatchOf(closed)).toHaveBeenCalledWith({ kind: "patch-run", nodeId: "run-1", patch: { open: true } });

    rerender(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0), agent("b", "Kai", 200)]}>
        <Mover />
        <RunNode {...props(["a", "b"], { open: true })} />
      </ReactFlowProvider>,
    );
    const outline = screen.getByTestId("run-group");
    expect(screen.queryByLabelText("Run goal")).toBeNull();
    expect(outline.style.left).toBe(`${-RUN_GROUP_PAD}px`);
    expect(outline.style.top).toBe(`${-RUN_GROUP_PAD - RUN_GROUP_HEADER}px`);
    expect(outline.style.width).toBe(`${300 + 2 * RUN_GROUP_PAD}px`);

    act(() => moveMember("b", 400));
    expect(screen.getByTestId("run-group").style.width).toBe(`${500 + 2 * RUN_GROUP_PAD}px`);

    // While a member is dragged the outline stays where the drag started, so the node can leave it.
    act(() => moveMember("b", 1200, true));
    expect(screen.getByTestId("run-group").style.width).toBe(`${500 + 2 * RUN_GROUP_PAD}px`);
    act(() => moveMember("b", 1200, false));
    expect(screen.getByTestId("run-group").style.width).toBe(`${1300 + 2 * RUN_GROUP_PAD}px`);
  });

  it("ac2 — the header: collapse, dot, title, meta, the meter once only with a cap, and the card's one action", () => {
    const { rerender } = render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0)]}>
        <RunNode {...props(["a"], { open: true })} />
      </ReactFlowProvider>,
    );
    expect(screen.getByRole("button", { name: "Collapse run" })).toBeTruthy();
    expect(screen.getByText("Ship auth")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("· 1 node")).toBeTruthy();
    expect(screen.queryByRole("meter", { name: "Budget" })).toBeNull();
    expect(screen.getByRole("button", { name: /Run/ })).toBeTruthy();
    expect(screen.getByText("Drag a node in or out to change the run.")).toBeTruthy();

    rerender(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0)]}>
        <RunNode {...props(["a"], { open: true, budgetCap: 1 })} />
      </ReactFlowProvider>,
    );
    expect(screen.getByRole("meter", { name: "Budget" })).toBeTruthy();
    expect(screen.getAllByText("$0.00 / $1.00")).toHaveLength(1);
  });

  it("ac2 — Decide while a gate waits, with Enter when the header has focus", () => {
    const view: RunCardView = {
      state: "waiting", gate: { gateId: "g", title: "Review the diff", instructions: "Read it." }, moreWaiting: 0, waitingMs: null,
      finished: 1, total: 2, failed: 0, costUsd: null, unknownCostSteps: 0, budgetCap: null, elapsedMs: 1000,
    };
    const onShip = vi.fn();
    render(
      <RunGroupOverlay
        box={{ x: 0, y: 0, w: 400, h: 300 }} title="Ship auth" view={view} memberCount={2} hasGoal error={null}
        compact={false} onCollapse={vi.fn()} onRun={vi.fn()} onShip={onShip} onSendBack={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Decide/ })).toBeTruthy();
    expect(screen.queryByText("Drag a node in or out to change the run.")).toBeNull();
    act(() => screen.getByRole("group", { name: "Ship auth — Waiting on you" }).focus());
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(window, { key: "1" });
    expect(onShip).toHaveBeenCalledOnce();
  });

  it("ac8 — ⌄ asks to close", () => {
    const open = props(["a", "b"], { open: true });
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0), agent("b", "Kai", 200)]}>
        <RunNode {...open} />
      </ReactFlowProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse run" }));
    expect(dispatchOf(open)).toHaveBeenCalledWith({ kind: "patch-run", nodeId: "run-1", patch: { open: false } });
  });

  it("ac8 — closed again, the card is back and counts the new members", () => {
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0), agent("b", "Kai", 200), agent("c", "Mo", 400)]}>
        <RunNode {...props(["a", "b", "c"], { open: false })} />
      </ReactFlowProvider>,
    );
    expect(screen.queryByTestId("run-group")).toBeNull();
    expect(screen.getByLabelText("Run goal")).toBeTruthy();
    expect(screen.getByText("· 3 nodes")).toBeTruthy();
  });

  it("ac10 — after a member change, Run dispatches exactly the new members; the run reports itself active", () => {
    const ran: string[] = [];
    for (const id of ["a", "b", "c"]) unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) }));
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0), agent("b", "Kai", 200), agent("c", "Mo", 400)]}>
        <RunNode {...props(["a", "c"], { open: true })} />
      </ReactFlowProvider>,
    );
    expect(isRunNodeActive("run-1")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    expect(ran.sort()).toEqual(["a", "c"]);
    expect(isRunNodeActive("run-1")).toBe(true);
    expect(screen.queryByText("Drag a node in or out to change the run.")).toBeNull();
    act(() => { agentRunRegistry.reportResult("a", true); agentRunRegistry.reportResult("c", true); });
  });

  it("ac11 — zoomed out, the outline stays and the header is dot + title only", () => {
    lod.tier = "glyph";
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren", 0)]}>
        <RunNode {...props(["a"], { open: true })} />
      </ReactFlowProvider>,
    );
    expect(screen.getByTestId("run-group")).toBeTruthy();
    expect(screen.getByText("Ship auth")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse run" })).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
  });
});
