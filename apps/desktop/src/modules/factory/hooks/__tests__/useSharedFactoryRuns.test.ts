import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphRunChanged } from "@/lib/tauri/graph-run";
import type { GraphRunRecord, GraphRunStatus } from "@/modules/codecanvas/services/graph-run-record";
import type { FactoryRunsClient } from "@/modules/factory/hooks/useFactoryRuns";
import { createFactoryRunsStore, useFactoryRunRow } from "@/modules/factory/hooks/useSharedFactoryRuns";
import { factoryNodeId, factoryWorkflowId } from "@/modules/factory/services/factory-run";

function run(status: GraphRunStatus, issue: number): GraphRunRecord {
  return {
    id: `r${issue}`,
    projectId: "p",
    workflowId: factoryWorkflowId("o/r", issue),
    status,
    checkpoint: {
      nodeIds: [factoryNodeId("o/r", issue)],
      deps: [],
      completed: {},
      failed: [],
      pending: [],
      blocked: [],
      engine: {
        kind: "rust",
        factory: { repo: "o/r", issue, title: `Issue ${issue}`, body: "", account: "me", checkout: "/c", base: "main", implementer: "p1" },
      },
    },
    startedAt: 1,
    endedAt: null,
    updatedAt: 1,
  };
}

function client(listAll: FactoryRunsClient["listAll"]) {
  let emit: (event: GraphRunChanged) => void = () => {};
  const stop = vi.fn();
  const c: FactoryRunsClient = {
    listAll,
    onChanged: vi.fn(async (handler) => {
      emit = handler;
      return stop;
    }),
  };
  return { c, stop, emit: () => emit({ id: "r", projectId: "p", status: "running" } as GraphRunChanged) };
}

describe("the shared Factory run list (#146)", () => {
  it("reads once for many nodes, follows each change, and stops when the last node leaves", async () => {
    let status: GraphRunStatus = "running";
    const listAll = vi.fn(async () => [run(status, 6), run("completed", 7)]);
    const { c, stop, emit } = client(listAll);
    const store = createFactoryRunsStore(c);

    const a = renderHook(() => useFactoryRunRow("o/r", 6, store));
    const b = renderHook(() => useFactoryRunRow("O/R", 7, store));
    await waitFor(() => expect(a.result.current.row?.state).toBe("running"));
    expect(b.result.current.row?.issue).toBe(7);
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(c.onChanged).toHaveBeenCalledTimes(1);

    status = "paused";
    await act(async () => emit());
    await waitFor(() => expect(a.result.current.row?.state).toBe("paused"));

    a.unmount();
    expect(stop).not.toHaveBeenCalled();
    b.unmount();
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it("gives an issue with no run null, once read", async () => {
    const { c } = client(async () => [run("running", 6)]);
    const store = createFactoryRunsStore(c);
    const { result } = renderHook(() => useFactoryRunRow("o/r", 99, store));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.row).toBeNull();
  });
});
