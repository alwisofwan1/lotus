import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeCanvasCollaborationRecordUpdatedPayload } from "../../services/collaboration/canvas-collaboration-store-events";

const launch = {
  mode: "swarm-task" as const,
  sourceLabel: "Swarm task",
  autoOpenPanel: true,
  taskId: "task_1",
};

const runId = "swarm-task:task:task_1";
const task = {
  id: "task_1",
  workspaceId: "ws-1",
  title: "Ship feature",
  goal: "Deliver the feature",
  knowledge: "",
  status: "in-progress" as const,
  priority: "high" as const,
  assignees: ["Mira"],
  createdAt: 1,
  updatedAt: 2,
};

describe("CodeCanvas collaboration project-backed store migration", () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
  });

  function mockTauriEventBridge() {
    let listener: ((event: { payload: CodeCanvasCollaborationRecordUpdatedPayload }) => void) | null = null;
    vi.doMock("@/lib/tauri/runtime", () => ({ loadTauriCore: vi.fn(async () => undefined) }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: vi.fn(async (_event: string, callback: typeof listener) => {
        listener = callback;
        return vi.fn();
      }),
    }));
    return {
      emit: (payload: CodeCanvasCollaborationRecordUpdatedPayload) => listener?.({ payload }),
    };
  }

  it("migrates local ledger and mailbox records into the project-backed store when Tauri is available", async () => {
    const load = vi.fn(async () => null);
    const save = vi.fn(async () => undefined);
    mockTauriEventBridge();
    vi.doMock("@/lib/tauri-api", () => ({ isTauri: () => true }));
    vi.doMock("@/lib/tauri/codecanvas", () => ({
      codecanvasLoadCollaborationRecord: load,
      codecanvasSaveCollaborationRecord: save,
    }));

    const ledger = { runId, assignments: {}, updatedAt: 123 };
    const mailbox = { runId, messages: [], updatedAt: 456 };
    window.localStorage.setItem(`lotus:canvas-collaboration-ledger:v1:project-1:${runId}`, JSON.stringify(ledger));
    window.localStorage.setItem(`lotus:canvas-collaboration-mailbox:v1:project-1:${runId}`, JSON.stringify(mailbox));

    const { useCanvasCollaborationLedger } = await import("../useCanvasCollaborationLedger");
    const { useCanvasCollaborationMailbox } = await import("../useCanvasCollaborationMailbox");

    renderHook(() => useCanvasCollaborationLedger("project-1", launch));
    renderHook(() => useCanvasCollaborationMailbox("project-1", launch));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenCalledWith("project-1", runId, "ledger", ledger);
    expect(save).toHaveBeenCalledWith("project-1", runId, "mailbox", mailbox);
  });

  it("persists collaboration run context for native MCP reads", async () => {
    const load = vi.fn(async () => null);
    const save = vi.fn(async () => undefined);
    mockTauriEventBridge();
    vi.doMock("@/lib/tauri-api", () => ({ isTauri: () => true }));
    vi.doMock("@/lib/tauri/codecanvas", () => ({
      codecanvasLoadCollaborationRecord: load,
      codecanvasSaveCollaborationRecord: save,
    }));

    const { useCanvasCollaborationContext } = await import("../useCanvasCollaborationContext");
    renderHook(() => useCanvasCollaborationContext("project-1", launch, task));

    await waitFor(() => expect(save).toHaveBeenCalledWith(
      "project-1",
      runId,
      "context",
      expect.objectContaining({
        runId,
        launch: expect.objectContaining({ mode: "swarm-task", taskId: "task_1" }),
        task: expect.objectContaining({ id: "task_1", title: "Ship feature" }),
      }),
    ));
  });

  it("refreshes mailbox state when a native collaboration update event arrives", async () => {
    const nativeMailbox = { runId, messages: [{ id: "mcp-1", assignee: "Mira", assigneeKey: "mira", kind: "evidence", author: "agent", body: "MCP proof", createdAt: 200 }], updatedAt: 200 };
    const load = vi.fn(async (_projectId: string, _runId: string, kind: string) => kind === "mailbox" ? nativeMailbox : null);
    const save = vi.fn(async () => undefined);
    const bridge = mockTauriEventBridge();
    vi.doMock("@/lib/tauri-api", () => ({ isTauri: () => true }));
    vi.doMock("@/lib/tauri/codecanvas", () => ({
      codecanvasLoadCollaborationRecord: load,
      codecanvasSaveCollaborationRecord: save,
    }));

    const { useCanvasCollaborationMailbox } = await import("../useCanvasCollaborationMailbox");
    const { result } = renderHook(() => useCanvasCollaborationMailbox("project-1", launch));

    await waitFor(() => expect(load).toHaveBeenCalled());
    bridge.emit({ projectId: "project-1", runId, kind: "mailbox", source: "mcp" });

    await waitFor(() => expect(result.current.messages[0]).toMatchObject({ id: "mcp-1", body: "MCP proof" }));
    expect(result.current.storageStatus).toBe("mcp-updated");
  });
});
