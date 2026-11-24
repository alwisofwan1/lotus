import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BridgeTask } from "@/lib/tauri-api";
import { useCanvasCollaborationTask } from "../useCanvasCollaborationTask";

const { bridgeGetTask } = vi.hoisted(() => ({ bridgeGetTask: vi.fn() }));

vi.mock("@/lib/tauri-api", () => ({ bridgeGetTask }));

const task: BridgeTask = {
  id: "task_bug_123",
  workspaceId: "ws-1",
  title: "Fix paste crash",
  goal: "Pasting image crashes.",
  knowledge: "",
  status: "in-progress",
  priority: "high",
  assignees: [],
  createdAt: 1,
  updatedAt: 2,
};

describe("useCanvasCollaborationTask", () => {
  beforeEach(() => {
    bridgeGetTask.mockReset();
  });

  it("does not fetch for clean canvas launches", () => {
    renderHook(() => useCanvasCollaborationTask({ mode: "off" }));

    expect(bridgeGetTask).not.toHaveBeenCalled();
  });

  it("fetches the Swarm task for task-triggered collaboration launches", async () => {
    bridgeGetTask.mockResolvedValue(task);

    const { result } = renderHook(() => useCanvasCollaborationTask({
      mode: "swarm-task",
      sourceLabel: "Swarm task",
      taskId: "task_bug_123",
      workspaceId: "ws-1",
      workflowId: "wf-feature-pipeline",
      autoOpenPanel: true,
    }));

    await waitFor(() => expect(result.current.task).toEqual(task));
    expect(bridgeGetTask).toHaveBeenCalledWith("ws-1", "task_bug_123");
    expect(result.current.error).toBeNull();
  });

  it("surfaces deleted task state without crashing the canvas", async () => {
    bridgeGetTask.mockResolvedValue(null);

    const { result } = renderHook(() => useCanvasCollaborationTask({
      mode: "swarm-task",
      sourceLabel: "Swarm task",
      taskId: "missing",
      workspaceId: "ws-1",
      autoOpenPanel: true,
    }));

    await waitFor(() => expect(result.current.error).toMatch(/no longer exists/i));
    expect(result.current.task).toBeNull();
  });
});
