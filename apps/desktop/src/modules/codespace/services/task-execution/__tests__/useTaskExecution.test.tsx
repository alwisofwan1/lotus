import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTaskExecution, type TaskExecutionPrimitives } from "../useTaskExecution";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import type { PtyOutputMetrics } from "@/lib/tauri-api";

function task(over: Partial<BridgeTask> = {}): BridgeTask {
  return {
    id: "task_x",
    workspaceId: "ws_a",
    title: "Run unit tests",
    goal: "Pass all suites",
    knowledge: "",
    status: "todo",
    priority: "none",
    assignees: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function metrics(over: Partial<PtyOutputMetrics> = {}): PtyOutputMetrics {
  return {
    totalBytes: 0, bufferLen: 0, idleMs: 0, ageMs: 0, hasOutput: false, detectedAgent: null,
    ...over,
  };
}

function makePrimitives() {
  const addPane = vi.fn().mockReturnValue("pane_1");
  const awaitSessionId = vi.fn().mockResolvedValue("sess_1");
  const writeToSession = vi.fn().mockResolvedValue(undefined);
  const killSession = vi.fn().mockResolvedValue(undefined);
  const updateTask = vi.fn().mockResolvedValue(undefined);
  const onPostSpawn = vi.fn();
  // Default metrics: agent banner detected immediately to short-circuit waitForPtyReady
  const getMetrics = vi.fn().mockResolvedValue(metrics({ detectedAgent: "claude", hasOutput: true, idleMs: 100 }));
  const primitives: TaskExecutionPrimitives = {
    addPane, awaitSessionId, writeToSession, killSession, updateTask,
    getMetrics, onPostSpawn,
  };
  return Object.assign(primitives, {
    _calls: { addPane, awaitSessionId, writeToSession, killSession, updateTask, getMetrics, onPostSpawn },
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("useTaskExecution — an agent launched as the PTY's own process", () => {
  const instant = { sleep: async () => {} };

  it("waits for its terminal handover, then types the prompt and presses Enter on its own", async () => {
    const p = makePrimitives();
    const awaitHandover = vi.fn().mockResolvedValue(true);
    const pane = Object.assign(p, { awaitHandover, addPane: vi.fn().mockResolvedValue("pane_1") });
    const { result } = renderHook(() =>
      useTaskExecution({ workspaceId: "ws_a", primitives: pane, promptSettle: async () => {}, handoverKeystrokes: instant }),
    );
    let res: Awaited<ReturnType<typeof result.current.execute>> | undefined;
    await act(async () => { res = await result.current.execute(task()); });
    expect(res?.ok).toBe(true);
    expect(awaitHandover).toHaveBeenCalledWith("pane_1", expect.objectContaining({ timeoutMs: 45_000 }));
    // Not the quiet-output wait: that is what let the prompt in before the TUI owned the terminal.
    expect(p._calls.getMetrics).not.toHaveBeenCalled();
    const writes = p._calls.writeToSession.mock.calls as [string, string][];
    expect(writes[0][1]).toContain("Task: Run unit tests");
    expect(writes[0][1].endsWith("\n")).toBe(false);
    expect(writes.slice(1).every(([, data]) => data === "\r")).toBe(true);
    expect(writes.length).toBeGreaterThan(1);
  });

  it("falls back to the quiet-output wait when no handover is seen", async () => {
    const p = makePrimitives();
    const pane = Object.assign(p, { awaitHandover: vi.fn().mockResolvedValue(false) });
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: pane, promptSettle: async () => {} }));
    await act(async () => { await result.current.execute(task()); });
    expect(p._calls.getMetrics).toHaveBeenCalled();
    expect(p._calls.writeToSession.mock.calls.at(-1)).toEqual(["sess_1", "\r"]);
  });
});

describe("useTaskExecution — happy path", () => {
  it("addPane → awaitSessionId → waitReady → writeToSession → updateTask, in order", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.execute>> | undefined;
    await act(async () => {
      res = await result.current.execute(task());
    });
    expect(res?.ok).toBe(true);
    expect(res?.paneId).toBe("pane_1");
    expect(p._calls.addPane).toHaveBeenCalledWith("ws_a", "claude", undefined, expect.objectContaining({ id: expect.any(String) }), undefined);
    expect(p._calls.awaitSessionId).toHaveBeenCalledWith("pane_1", expect.any(Object));
    /*
      Two writes, not one. This used to assert that the single write ENDED in "\r" — which is
      exactly the shape a TUI reads as a paste, so the prompt would land in the agent's input box
      and sit there unsent. The test agreed with the bug rather than catching it.
    */
    const writes = p._calls.writeToSession.mock.calls as [string, string][];
    expect(writes).toHaveLength(2);
    expect(writes[0][0]).toBe("sess_1");
    expect(writes[0][1]).toContain("Task: Run unit tests");
    expect(writes[0][1].endsWith("\r")).toBe(false);
    expect(writes[1]).toEqual(["sess_1", "\r"]);
    expect(p._calls.updateTask).toHaveBeenCalledWith("task_x", expect.objectContaining({ status: "in-progress" }));
  });

  it("uses task.assignees[0] as agent command when present", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    await act(async () => { await result.current.execute(task({ assignees: ["codex", "@alice"] })); });
    expect(p._calls.addPane).toHaveBeenCalledWith("ws_a", "codex", undefined, expect.objectContaining({ id: expect.any(String) }), undefined);
  });

  it("does not treat BridgeBoard assignee labels as executable names", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    await act(async () => { await result.current.execute(task({ assignees: ["bridge", "claude-1"] })); });
    expect(p._calls.addPane).toHaveBeenCalledWith("ws_a", "claude", undefined, expect.objectContaining({ id: expect.any(String) }), undefined);
  });

  it("calls onPostSpawn(paneId) after addPane to allow UI to switch + focus", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    await act(async () => { await result.current.execute(task()); });
    expect(p._calls.onPostSpawn).toHaveBeenCalledWith("pane_1");
  });
});

describe("useTaskExecution — error paths", () => {
  it("returns ok=false with error message and does not transition status when sessionId never appears", async () => {
    const p = makePrimitives();
    p.awaitSessionId = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.execute>> | undefined;
    await act(async () => { res = await result.current.execute(task()); });
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/session/i);
    expect(p._calls.updateTask).not.toHaveBeenCalled();
  });

  it("surfaces writeToSession failure via lastError and does not transition status", async () => {
    const p = makePrimitives();
    p.writeToSession = vi.fn().mockRejectedValue(new Error("ENXIO"));
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    await act(async () => { await result.current.execute(task()); });
    expect(result.current.lastError).toMatch(/ENXIO/);
    expect(p._calls.updateTask).not.toHaveBeenCalled();
  });

  it("returns ok=false when no workspaceId is selected", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: null, primitives: p }));
    let res: Awaited<ReturnType<typeof result.current.execute>> | undefined;
    await act(async () => { res = await result.current.execute(task()); });
    expect(res?.ok).toBe(false);
    expect(p._calls.addPane).not.toHaveBeenCalled();
  });
});

describe("useTaskExecution — bridge dispatch mode", () => {
  it("dispatches the bridge envelope via the bus primitive (preferred path) and skips addPane / awaitSessionId / writeToSession", async () => {
    const p = makePrimitives();
    p.findBridgePane = vi.fn().mockReturnValue({ paneId: "bridge_pane", sessionId: null });
    const dispatchToBridge = vi.fn();
    p.dispatchToBridge = dispatchToBridge;
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.execute>> | undefined;
    await act(async () => {
      res = await result.current.execute(task({ title: "Investigate flake" }), { mode: "bridge" });
    });
    expect(res?.ok).toBe(true);
    expect(p._calls.addPane).not.toHaveBeenCalled();
    expect(p._calls.awaitSessionId).not.toHaveBeenCalled();
    expect(p._calls.writeToSession).not.toHaveBeenCalled();
    expect(dispatchToBridge).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "bridge_pane",
      workspaceId: "ws_a",
      payload: expect.stringContaining("<bridge-task"),
    }));
    const payload = dispatchToBridge.mock.calls[0][0].payload as string;
    expect(payload).toContain("Investigate flake");
    expect(p._calls.updateTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "in-progress", cellId: "bridge_pane" }),
    );
  });

  it("falls back to direct PTY write when dispatchToBridge is missing but a sessionId is available", async () => {
    const p = makePrimitives();
    p.findBridgePane = vi.fn().mockReturnValue({ paneId: "bridge_pane", sessionId: "bridge_sess" });
    p.dispatchToBridge = undefined;
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    await act(async () => {
      await result.current.execute(task(), { mode: "bridge" });
    });
    expect(p._calls.writeToSession).toHaveBeenCalledWith("bridge_sess", expect.stringContaining("<bridge-task"));
  });

  it("returns ok=false when no Bridge pane is available", async () => {
    const p = makePrimitives();
    p.findBridgePane = vi.fn().mockReturnValue(null);
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.execute>> | undefined;
    await act(async () => {
      res = await result.current.execute(task(), { mode: "bridge" });
    });
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/no active bridge cell/i);
    expect(p._calls.writeToSession).not.toHaveBeenCalled();
    expect(p._calls.updateTask).not.toHaveBeenCalled();
  });
});

describe("useTaskExecution — idempotency + cancel", () => {
  it("second execute(t) call while first is in-flight returns ok=false busy", async () => {
    const p = makePrimitives();
    let release!: () => void;
    p.awaitSessionId = vi.fn().mockReturnValue(new Promise((r) => { release = () => r("sess_1"); }));
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));

    let res2: Awaited<ReturnType<typeof result.current.execute>> | undefined;
    await act(async () => {
      const first = result.current.execute(task());
      res2 = await result.current.execute(task());
      release();
      await first;
    });
    expect(res2?.ok).toBe(false);
    expect(res2?.error).toMatch(/in flight/i);
  });

  it("cancel(taskId) calls killSession on the active pane and updates status to cancelled", async () => {
    const p = makePrimitives();
    let release!: () => void;
    p.awaitSessionId = vi.fn().mockReturnValue(new Promise((r) => { release = () => r("sess_1"); }));
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));

    await act(async () => {
      const exec = result.current.execute(task({ id: "task_y" }));
      // Let the in-flight ref fill
      await Promise.resolve();
      result.current.cancel("task_y");
      release();
      await exec;
    });
    expect(p._calls.killSession).toHaveBeenCalled();
    expect(p._calls.updateTask).toHaveBeenCalledWith("task_y", expect.objectContaining({ status: "cancelled" }));
  });
});

// ── executeIntoCell ────────────────────────────────────────────────────────

import type { CellDispatchTarget } from "../useTaskExecution";

function terminalTarget(over: Partial<CellDispatchTarget> = {}): CellDispatchTarget {
  return {
    cellId: "cell_1",
    cellType: "terminal",
    runtimeSessionId: "sess_t",
    agentCommand: "claude",
    ...over,
  };
}

function orchestratorTarget(over: Partial<CellDispatchTarget> = {}): CellDispatchTarget {
  return {
    cellId: "orch_1",
    cellType: "orchestrator",
    runtimeSessionId: null,
    agentCommand: null,
    ...over,
  };
}

describe("useTaskExecution — executeIntoCell", () => {
  it("terminal cell with agent + session: writes prompt directly and updates status", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.executeIntoCell>> | undefined;
    await act(async () => {
      res = await result.current.executeIntoCell(task({ title: "Fix flake" }), terminalTarget());
    });
    expect(res?.ok).toBe(true);
    expect(res?.paneId).toBe("cell_1");
    expect(res?.sessionId).toBe("sess_t");
    expect(p._calls.addPane).not.toHaveBeenCalled();
    expect(p._calls.writeToSession).toHaveBeenCalledWith("sess_t", expect.stringContaining("Fix flake"));
    expect(p._calls.updateTask).toHaveBeenCalledWith(
      "task_x",
      expect.objectContaining({ status: "in-progress", cellId: "cell_1" }),
    );
  });

  it("terminal cell with no live session: returns ok=false and does not write", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.executeIntoCell>> | undefined;
    await act(async () => {
      res = await result.current.executeIntoCell(task(), terminalTarget({ runtimeSessionId: null }));
    });
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/no live pty session/i);
    expect(p._calls.writeToSession).not.toHaveBeenCalled();
  });

  it("terminal cell with no agent command: returns ok=false (plain shell)", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.executeIntoCell>> | undefined;
    await act(async () => {
      res = await result.current.executeIntoCell(task(), terminalTarget({ agentCommand: null }));
    });
    expect(res?.ok).toBe(false);
    expect(res?.error).toMatch(/plain shell/i);
    expect(p._calls.writeToSession).not.toHaveBeenCalled();
  });

  it("orchestrator cell: dispatches bridge envelope via dispatchToBridge and skips writeToSession", async () => {
    const p = makePrimitives();
    const dispatchToBridge = vi.fn();
    p.dispatchToBridge = dispatchToBridge;
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    let res: Awaited<ReturnType<typeof result.current.executeIntoCell>> | undefined;
    await act(async () => {
      res = await result.current.executeIntoCell(task({ title: "Summarise PR" }), orchestratorTarget());
    });
    expect(res?.ok).toBe(true);
    expect(p._calls.writeToSession).not.toHaveBeenCalled();
    expect(dispatchToBridge).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "orch_1",
      workspaceId: "ws_a",
      payload: expect.stringContaining("Summarise PR"),
    }));
    expect(p._calls.updateTask).toHaveBeenCalledWith(
      "task_x",
      expect.objectContaining({ status: "in-progress", cellId: "orch_1" }),
    );
  });

  it("orchestrator cell without dispatchToBridge falls back to PTY write via sessionId", async () => {
    const p = makePrimitives();
    p.dispatchToBridge = undefined;
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    await act(async () => {
      await result.current.executeIntoCell(task(), orchestratorTarget({ runtimeSessionId: "orch_sess" }));
    });
    expect(p._calls.writeToSession).toHaveBeenCalledWith("orch_sess", expect.stringContaining("<bridge-task"));
  });

  it("browser/workbench/other cell types are rejected immediately", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: "ws_a", primitives: p, promptSettle: async () => {} }));
    for (const cellType of ["browser", "workbench", "other"] as const) {
      let res: Awaited<ReturnType<typeof result.current.executeIntoCell>> | undefined;
      await act(async () => {
        res = await result.current.executeIntoCell(
          task(),
          { cellId: "c", cellType, runtimeSessionId: null, agentCommand: null },
        );
      });
      expect(res?.ok).toBe(false);
      expect(res?.error).toContain(cellType);
    }
    expect(p._calls.writeToSession).not.toHaveBeenCalled();
  });

  it("returns ok=false when no workspaceId is selected", async () => {
    const p = makePrimitives();
    const { result } = renderHook(() => useTaskExecution({ workspaceId: null, primitives: p }));
    let res: Awaited<ReturnType<typeof result.current.executeIntoCell>> | undefined;
    await act(async () => {
      res = await result.current.executeIntoCell(task(), terminalTarget());
    });
    expect(res?.ok).toBe(false);
    expect(p._calls.writeToSession).not.toHaveBeenCalled();
  });
});
