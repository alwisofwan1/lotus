import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, type Node } from "@xyflow/react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, Handle: () => null, NodeResizer: () => null };
});

const lod = vi.hoisted(() => ({ tier: "full" as "full" | "glyph" | "overview" }));
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => lod.tier }));

import { RunNode } from "../nodes/RunNode";
import { RunNodeCard } from "../nodes/RunNodeCard";
import { agentRunRegistry } from "../../services/agent-run-registry";
import type { RunCardView } from "../../services/run-node";

const agent = (id: string, name: string): Node => ({ id, type: "agent", position: { x: 0, y: 0 }, data: { name } });
const runProps = (memberIds: string[], brief = "Add login rate limit") => ({
  id: "run-1",
  data: { title: "Ship auth", memberIds, brief, dispatchCommand: vi.fn() },
  selected: false,
}) as unknown as Parameters<typeof RunNode>[0];

const unregister: Array<() => void> = [];
afterEach(() => {
  unregister.splice(0).forEach((fn) => fn());
  lod.tier = "full";
});

describe("RunNode", () => {
  it("runs its members only — a node outside the run is never started", () => {
    const ran: string[] = [];
    for (const id of ["a", "b", "outside"]) unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) }));

    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren"), agent("b", "Kai"), agent("outside", "Mo")]}>
        <RunNode {...runProps(["a", "b"])} />
      </ReactFlowProvider>,
    );
    expect(screen.getByText("Ready")).toBeTruthy();
    // No order wire between them: they start together, and the card says so.
    expect(screen.getByText("Ren + Kai")).toBeTruthy();
    expect((screen.getByLabelText("Run goal") as HTMLTextAreaElement).value).toBe("Add login rate limit");

    fireEvent.click(screen.getByRole("button", { name: /Run/ }));

    expect(ran.sort()).toEqual(["a", "b"]);
    expect(screen.getByText("Running")).toBeTruthy();
    act(() => { agentRunRegistry.reportResult("a", true); agentRunRegistry.reportResult("b", true); });
  });

  it("shows the order a triggers wire gives, and only that wire", () => {
    const edges = [
      { id: "e1", source: "a", target: "b", data: { wireKind: "triggers" } },
      { id: "e2", source: "b", target: "c", data: { wireKind: "default" } },
    ];
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren"), agent("b", "Kai"), agent("c", "Mo")]} initialEdges={edges}>
        <RunNode {...runProps(["a", "b", "c"])} />
      </ReactFlowProvider>,
    );
    expect(screen.getByText("Ren + Mo → Kai")).toBeTruthy();
  });

  it("hands each member the run title, goal and upstream ids", () => {
    const ctxs: unknown[] = [];
    unregister.push(agentRunRegistry.register("a", { run: (ctx) => ctxs.push(ctx) }));
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren")]}>
        <RunNode {...runProps(["a"])} />
      </ReactFlowProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    expect(ctxs[0]).toMatchObject({ run: { title: "Ship auth", brief: "Add login rate limit" }, upstreamIds: [] });
    act(() => agentRunRegistry.reportResult("a", true));
  });

  it("names members, not ids, when one cannot be started", () => {
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren"), agent("b", "Kai")]}>
        <RunNode {...runProps(["a", "b"])} />
      </ReactFlowProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Run/ }));
    expect(screen.getByRole("alert").textContent).toContain("Ren, Kai");
  });

  it("keeps Run off until the run has a goal", () => {
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren")]}>
        <RunNode {...runProps(["a"], "  ")} />
      </ReactFlowProvider>,
    );
    expect((screen.getByRole("button", { name: /Run/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows only the title and status dot when zoomed out", () => {
    lod.tier = "glyph";
    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren")]}>
        <RunNode {...runProps(["a"])} />
      </ReactFlowProvider>,
    );
    expect(screen.getByRole("img", { name: "Ship auth — Ready" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Run/ })).toBeNull();
    expect(screen.queryByText("Ren")).toBeNull();
  });
});

describe("RunNodeCard", () => {
  const view = (patch: Partial<RunCardView>): RunCardView => ({ state: "idle", gate: null, moreWaiting: 0, waitingMs: null, finished: 0, total: 2, failed: 0, costUsd: null, unknownCostSteps: 0, budgetCap: null, elapsedMs: null, ...patch });
  const members = [{ id: "a", label: "Ren" }, { id: "b", label: "Kai" }];
  const card = (v: RunCardView) => render(<RunNodeCard title="Ship auth" view={v} members={members} brief="Goal" error={null} onBriefChange={vi.fn()} onRun={vi.fn()} onBudgetCapChange={vi.fn()} onClose={vi.fn()} />);

  it.each([
    ["running", "Running", "running"],
    ["failed", "Failed", "error"],
    ["done", "Done", "completed"],
  ] as const)("%s shows the status word beside a %s-toned dot", (state, word, tone) => {
    const { container } = card(view({ state, finished: 1, elapsedMs: 252_000, costUsd: 0.75 }));
    expect(screen.getByText(word).className).toBe("run-card-status");
    expect(container.querySelector(".run-card")?.getAttribute("data-tone")).toBe(tone);
    expect(screen.getByText("· 4:12")).toBeTruthy();
    expect(screen.getByText("· $0.75")).toBeTruthy();
  });

  it("offers Run again after a finished run", () => {
    card(view({ state: "done", finished: 2 }));
    expect((screen.getByRole("button", { name: /Run again/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
