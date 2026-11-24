import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphRunChanged } from "@/lib/tauri/graph-run";
import type { GraphRunRecord, GraphRunStatus } from "@/modules/codecanvas/services/graph-run-record";
import { useFactoryRuns, type FactoryRunsClient } from "@/modules/factory/hooks/useFactoryRuns";
import { factoryNodeId, factoryWorkflowId } from "@/modules/factory/services/factory-run";

function run(status: GraphRunStatus, issue: number, startedAt = issue): GraphRunRecord {
  const step = factoryNodeId("o/r", issue);
  return {
    id: `r${issue}-${startedAt}`,
    projectId: "p",
    workflowId: factoryWorkflowId("o/r", issue),
    status,
    checkpoint: {
      nodeIds: [step],
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
    startedAt,
    endedAt: null,
    updatedAt: startedAt,
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

describe("useFactoryRuns", () => {
  it("lists every Factory Run in groups once loaded", async () => {
    const { c } = client(async () => [run("running", 1), run("error", 2)]);
    const { result } = renderHook(() => useFactoryRuns(c));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups.map((g) => g.id)).toEqual(["needs-you", "working"]);
    expect(result.current.needsYou).toBe(1);
  });

  it("reads again when a run changes", async () => {
    let runs = [run("running", 1)];
    const { c, emit } = client(async () => runs);
    const { result } = renderHook(() => useFactoryRuns(c));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.needsYou).toBe(0);
    runs = [run("paused", 1)];
    await act(async () => emit());
    await waitFor(() => expect(result.current.needsYou).toBe(1));
  });

  it("does not poll: it reads once until told", async () => {
    vi.useFakeTimers();
    try {
      const listAll = vi.fn(async () => [run("running", 1)]);
      const { c } = client(listAll);
      renderHook(() => useFactoryRuns(c));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(listAll).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the newest answer win when two reads overlap", async () => {
    const resolvers: Array<(runs: GraphRunRecord[]) => void> = [];
    const { c, emit } = client(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = renderHook(() => useFactoryRuns(c));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await act(async () => emit());
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[1]([run("paused", 1)]));
    await act(async () => resolvers[0]([run("running", 1)]));
    expect(result.current.needsYou).toBe(1);
  });

  it("keeps the last rows and says why when a read fails", async () => {
    let fail = false;
    const { c, emit } = client(async () => {
      if (fail) throw new Error("db locked");
      return [run("running", 1)];
    });
    const { result } = renderHook(() => useFactoryRuns(c));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fail = true;
    await act(async () => emit());
    await waitFor(() => expect(result.current.error).toBe("db locked"));
    expect(result.current.groups).toHaveLength(1);
  });

  it("stops listening when it unmounts", async () => {
    const { c, stop } = client(async () => []);
    const { unmount } = renderHook(() => useFactoryRuns(c));
    await waitFor(() => expect(c.onChanged).toHaveBeenCalled());
    await act(async () => {});
    unmount();
    expect(stop).toHaveBeenCalled();
  });

  it("stops listening even when it unmounts before the listener is ready", async () => {
    const stop = vi.fn();
    let ready: (stop: () => void) => void = () => {};
    const c: FactoryRunsClient = {
      listAll: async () => [],
      onChanged: () => new Promise((resolve) => (ready = resolve)),
    };
    const { unmount } = renderHook(() => useFactoryRuns(c));
    unmount();
    ready(stop);
    await Promise.resolve();
    expect(stop).toHaveBeenCalled();
  });

  it("still shows the runs, and says why, when the listener cannot start", async () => {
    const c: FactoryRunsClient = {
      listAll: async () => [run("running", 1)],
      onChanged: async () => {
        throw new Error("no tauri runtime");
      },
    };
    const { result } = renderHook(() => useFactoryRuns(c));
    await waitFor(() => expect(result.current.error).toBe("no tauri runtime"));
    expect(result.current.groups).toHaveLength(1);
  });
});
