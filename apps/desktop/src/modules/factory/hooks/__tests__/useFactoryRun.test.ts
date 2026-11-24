import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFactoryRun, type FactoryRunClient } from "@/modules/factory/hooks/useFactoryRun";
import { factoryNodeId, factoryWorkflowId } from "@/modules/factory/services/factory-run";
import { localProjectIdForRoot } from "@/modules/codecanvas/services/codecanvas-project-repository";
import type { GraphRunRecord, GraphRunStatus } from "@/modules/codecanvas/services/graph-run-record";
import type { GraphRunChanged } from "@/lib/tauri/graph-run";

const STEP = factoryNodeId("o/r", 7);

const CHECKOUT = "/code/lotus";
const PROJECT = localProjectIdForRoot(CHECKOUT);

function run(status: GraphRunStatus, id = "r1"): GraphRunRecord {
  return {
    id,
    projectId: PROJECT,
    workflowId: factoryWorkflowId("o/r", 7),
    status,
    checkpoint: { nodeIds: [STEP], deps: [], completed: {}, failed: [], pending: [STEP], blocked: [], engine: { kind: "rust" } },
    startedAt: 1,
    endedAt: null,
    updatedAt: 1,
  };
}

function client(over: Partial<FactoryRunClient> = {}) {
  let emit: (event: GraphRunChanged) => void = () => {};
  const c: FactoryRunClient = {
    findCheckout: vi.fn(async () => ({ workspaceId: "w1", cwd: CHECKOUT })),
    listRuns: vi.fn(async () => []),
    start: vi.fn(async () => "r1"),
    raiseCap: vi.fn(async () => 4),
    abort: vi.fn(async () => {}),
    onChanged: vi.fn(async (handler) => {
      emit = handler;
      return () => {};
    }),
    ...over,
  };
  return { c, emit: (event: GraphRunChanged) => emit(event) };
}

const ticket = { repo: "o/r", issue: { number: 7, title: "Fix it", body: "do it" }, account: "me" };
const workspaces = () => [
  { id: "w1", cwd: "/code", remote: false },
  { id: "w2", cwd: "/remote", remote: true },
];

describe("useFactoryRun", () => {
  it("finds the checkout among local workspaces and reads the ticket's runs under its folder's project", async () => {
    const { c } = client({ listRuns: vi.fn(async () => [run("paused")]) });
    const { result } = renderHook(() => useFactoryRun({ client: c, ...ticket, workspaces }));
    await waitFor(() => expect(result.current.view.state).toBe("paused"));
    expect(c.findCheckout).toHaveBeenCalledWith("o/r", [{ id: "w1", cwd: "/code" }], null);
    expect(c.listRuns).toHaveBeenCalledWith(PROJECT);
    expect(result.current.checkout).toBe(CHECKOUT);
  });

  it("cannot start without a checkout, and says why", async () => {
    const { c } = client({ findCheckout: vi.fn(async () => null) });
    const { result } = renderHook(() => useFactoryRun({ client: c, ...ticket, workspaces }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.checkout).toBeNull();
    expect(result.current.canStart).toBe(false);
    expect(c.listRuns).not.toHaveBeenCalled();
  });

  it("starts a Factory Run with the ticket and reads the record again", async () => {
    const runs = vi.fn<FactoryRunClient["listRuns"]>(async () => []);
    const { c } = client({ listRuns: runs });
    const { result } = renderHook(() => useFactoryRun({ client: c, ...ticket, workspaces }));
    await waitFor(() => expect(result.current.canStart).toBe(true));
    runs.mockResolvedValue([run("running")]);
    await act(() => result.current.start("claude"));
    expect(c.start).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT,
        workflowId: "factory:o/r#7",
        factory: expect.objectContaining({ repo: "o/r", issue: 7, account: "me", checkout: CHECKOUT, implementer: "claude", base: "" }),
      }),
    );
    expect(result.current.view.state).toBe("running");
    expect(result.current.error).toBeNull();
  });

  it("shows why Rust refused the start", async () => {
    const { c } = client({ start: vi.fn(async () => Promise.reject("the repo declares no gate")) });
    const { result } = renderHook(() => useFactoryRun({ client: c, ...ticket, workspaces }));
    await waitFor(() => expect(result.current.canStart).toBe(true));
    await act(() => result.current.start("claude"));
    expect(result.current.error).toBe("the repo declares no gate");
    expect(result.current.busy).toBe(false);
  });

  it("reads the record again when the engine says its project's run changed", async () => {
    const runs = vi.fn<FactoryRunClient["listRuns"]>(async () => [run("running")]);
    const { c, emit } = client({ listRuns: runs });
    const { result } = renderHook(() => useFactoryRun({ client: c, ...ticket, workspaces }));
    await waitFor(() => expect(result.current.view.state).toBe("running"));
    runs.mockResolvedValue([run("completed")]);
    emit({ id: "other", projectId: "cp_else", status: "completed" });
    expect(runs).toHaveBeenCalledTimes(1);
    act(() => emit({ id: "r1", projectId: PROJECT, status: "completed" }));
    await waitFor(() => expect(result.current.view.state).toBe("done"));
  });

  it("raises the cap and aborts the shown run", async () => {
    const { c } = client({ listRuns: vi.fn(async () => [run("paused", "r9")]) });
    const { result } = renderHook(() => useFactoryRun({ client: c, ...ticket, workspaces }));
    await waitFor(() => expect(result.current.view.state).toBe("paused"));
    await act(() => result.current.raiseCap());
    expect(c.raiseCap).toHaveBeenCalledWith("r9");
    await act(() => result.current.abort());
    expect(c.abort).toHaveBeenCalledWith("r9");
  });
});
