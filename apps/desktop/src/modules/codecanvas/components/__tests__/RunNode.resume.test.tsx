import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReactFlowProvider, type Node } from "@xyflow/react";

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return { ...actual, Handle: () => null, NodeResizer: () => null };
});
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => "full" }));

// The app's store, swapped for one in memory: a record left "running" by a closed app is exactly
// what a restart finds on disk.
const disk = vi.hoisted(() => ({ store: null as unknown }));
vi.mock("@/modules/codecanvas/services/graph-run-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/graph-run-store")>();
  const store = actual.createInMemoryGraphRunStore();
  disk.store = store;
  return { ...actual, graphRunStore: store };
});

import { RunNode } from "../nodes/RunNode";
import { agentRunRegistry } from "../../services/agent-run-registry";
import { applyNodeCompletion, buildGraphRunRecord } from "../../services/graph-run-record";
import type { GraphRunStore } from "../../services/graph-run-store";
import { runNodeWorkflowId } from "../../services/run-node";

const store = () => disk.store as GraphRunStore;
const flush = () => act(() => new Promise((r) => setTimeout(r, 0)));
const agent = (id: string, name: string): Node => ({ id, type: "agent", position: { x: 0, y: 0 }, data: { name } });
const runNode = (id: string, memberIds: string[]) => ({
  id,
  data: { title: id, memberIds, brief: "Ship it", projectId: "p1", dispatchCommand: vi.fn() },
  selected: false,
}) as unknown as Parameters<typeof RunNode>[0];

/** What the app left on disk: a run cut off after `done` finished, the rest never ran. */
async function interruptedRun(runNodeId: string, nodeIds: string[], done: string[], startedAt: number) {
  let record = buildGraphRunRecord({ projectId: "p1", graph: { nodeIds, deps: [] }, now: startedAt, id: `rec-${runNodeId}`, workflowId: runNodeWorkflowId(runNodeId) });
  for (const id of done) {
    record = { ...record, checkpoint: applyNodeCompletion(record.checkpoint, id, { outcome: "completed", sessionId: null, nodeRunId: `r-${id}` }) };
  }
  await store().create(record);
}

const unregister: Array<() => void> = [];
afterEach(() => unregister.splice(0).forEach((fn) => fn()));

describe("RunNode after a restart (#73)", () => {
  it("shows Interrupted · Resume, and resume skips the steps that already finished", async () => {
    const ran: string[] = [];
    for (const id of ["a", "b"]) unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) }));
    await interruptedRun("run-1", ["a", "b"], ["a"], 1);

    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren"), agent("b", "Kai")]}>
        <RunNode {...runNode("run-1", ["a", "b"])} />
      </ReactFlowProvider>,
    );
    await flush();

    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));

    expect(ran).toEqual(["b"]);
    act(() => agentRunRegistry.reportResult("b", true, { outcome: "completed", sessionId: null, nodeRunId: "rb" }));
    await flush();
    expect(screen.getByText("Done")).toBeTruthy();
    expect((await store().get("rec-run-1"))?.status).toBe("completed");
  });

  it("two interrupted runs each resume on their own card", async () => {
    const ran: string[] = [];
    for (const id of ["a", "b", "c", "d"]) unregister.push(agentRunRegistry.register(id, { run: () => ran.push(id) }));
    await interruptedRun("run-1", ["a", "b"], ["a"], 1);
    await interruptedRun("run-2", ["c", "d"], [], 2);

    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren"), agent("b", "Kai"), agent("c", "Mo"), agent("d", "Ida")]}>
        <div data-testid="one"><RunNode {...runNode("run-1", ["a", "b"])} /></div>
        <div data-testid="two"><RunNode {...runNode("run-2", ["c", "d"])} /></div>
      </ReactFlowProvider>,
    );
    await flush();
    const one = within(screen.getByTestId("one"));
    const two = within(screen.getByTestId("two"));
    expect(one.getByRole("button", { name: /Resume/ })).toBeTruthy();
    expect(two.getByRole("button", { name: /Resume/ })).toBeTruthy();

    fireEvent.click(two.getByRole("button", { name: /Resume/ }));
    expect(ran.sort()).toEqual(["c", "d"]);
    expect(one.getByText("Interrupted")).toBeTruthy();

    fireEvent.click(one.getByRole("button", { name: /Resume/ }));
    expect(ran.sort()).toEqual(["b", "c", "d"]);
    act(() => { for (const id of ["b", "c", "d"]) agentRunRegistry.reportResult(id, true, { outcome: "completed", sessionId: null, nodeRunId: `r-${id}` }); });
    await flush();
    expect((await store().get("rec-run-1"))?.status).toBe("completed");
    expect((await store().get("rec-run-2"))?.status).toBe("completed");
  });

  it("does not offer to resume an old record behind a newer finished run", async () => {
    unregister.push(agentRunRegistry.register("a", { run: () => {} }));
    await interruptedRun("run-1", ["a"], [], 1);
    let done = buildGraphRunRecord({ projectId: "p1", graph: { nodeIds: ["a"], deps: [] }, now: 5, id: "rec-new", workflowId: runNodeWorkflowId("run-1") });
    done = { ...done, status: "completed", checkpoint: applyNodeCompletion(done.checkpoint, "a", { outcome: "completed", sessionId: null, nodeRunId: "ra" }) };
    await store().create(done);

    render(
      <ReactFlowProvider initialNodes={[agent("a", "Ren")]}>
        <RunNode {...runNode("run-1", ["a"])} />
      </ReactFlowProvider>,
    );
    await flush();

    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Resume/ })).toBeNull();
  });
});
