import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useCanvasCollaborationLedger } from "../useCanvasCollaborationLedger";

const launch = {
  mode: "swarm-task" as const,
  sourceLabel: "Swarm task",
  autoOpenPanel: true,
  taskId: "task_1",
  workflowId: "wf-feature-pipeline",
};

describe("useCanvasCollaborationLedger", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists assignee spawn mappings for the active project and run", () => {
    const { result, rerender } = renderHook(({ projectId }) => useCanvasCollaborationLedger(projectId, launch), {
      initialProps: { projectId: "project-1" as string | null },
    });

    act(() => {
      result.current.recordSpawn({ assignee: "Mira", nodeId: "node-mira", brief: "Task brief", now: 123 });
    });

    expect(result.current.ledger?.assignments.mira).toMatchObject({ nodeId: "node-mira", lastBrief: "Task brief" });

    rerender({ projectId: "project-1" });

    expect(result.current.ledger?.assignments.mira).toMatchObject({ nodeId: "node-mira", spawnedAt: 123 });
  });

  it("syncs participant lifecycle state into the persisted ledger", () => {
    const { result } = renderHook(() => useCanvasCollaborationLedger("project-1", launch));

    act(() => {
      result.current.recordSpawn({ assignee: "Mira", nodeId: "node-mira", now: 100 });
    });
    act(() => {
      result.current.syncParticipants([
        { id: "node-mira", nodeId: "node-mira", name: "Mira", source: "task-assignee", status: "done", evidenceCount: 1 },
      ], 200);
    });

    expect(result.current.ledger?.assignments.mira).toMatchObject({ state: "done", updatedAt: 200 });
  });

  it("does not create a ledger when collaboration is off", () => {
    const { result } = renderHook(() => useCanvasCollaborationLedger("project-1", { mode: "off" }));

    act(() => {
      result.current.recordSpawn({ assignee: "Mira", nodeId: "node-mira", now: 123 });
    });

    expect(result.current.ledger).toBeNull();
  });
});
