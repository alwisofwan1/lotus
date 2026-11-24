import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@/lib/tauri/runtime", () => ({ tauriInvoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  GRAPH_RUN_CHANGED_EVENT,
  graphRunAbort,
  graphRunRaiseCap,
  graphRunStart,
  onGraphRunChanged,
} from "@/lib/tauri/graph-run";

// Command names and argument keys must match `graph_run_*` in src-tauri/src/lib.rs
// (Tauri maps snake_case params to camelCase keys).
describe("graph-run tauri contract", () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined);
    mocks.listen.mockReset().mockResolvedValue(() => {});
  });

  it("starts a run with the Rust command's argument names", async () => {
    const graph = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] };
    await graphRunStart({ projectId: "p", graph, workflowId: "run-node:n", run: { title: "T", brief: "B" }, budgetCap: 1 });
    expect(mocks.invoke).toHaveBeenCalledWith("graph_run_start", {
      projectId: "p", graph, workflowId: "run-node:n", run: { title: "T", brief: "B" }, budgetCap: 1,
    });
  });

  it("passes a Factory Run's ticket as the Rust FactoryTicket", async () => {
    const graph = { nodeIds: ["impl"], deps: [] };
    const factory = {
      repo: "o/r", issue: 7, title: "T", body: "B", account: "me", checkout: "/repo", base: "main", implementer: "claude",
    };
    await graphRunStart({ projectId: "p", graph, factory });
    expect(mocks.invoke).toHaveBeenCalledWith("graph_run_start", { projectId: "p", graph, factory });
  });

  it("sends Raise cap and Abort by run id", async () => {
    await graphRunRaiseCap("r1");
    await graphRunAbort("r1");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "graph_run_raise_cap", { id: "r1" });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "graph_run_abort", { id: "r1" });
  });

  it("listens to the change event and hands over its payload", async () => {
    const seen: unknown[] = [];
    await onGraphRunChanged((e) => seen.push(e));
    expect(mocks.listen).toHaveBeenCalledWith(GRAPH_RUN_CHANGED_EVENT, expect.any(Function));
    expect(GRAPH_RUN_CHANGED_EVENT).toBe("graph-run://changed");
    mocks.listen.mock.calls[0][1]({ payload: { id: "r1", projectId: "p", status: "paused" } });
    expect(seen).toEqual([{ id: "r1", projectId: "p", status: "paused" }]);
  });
});
