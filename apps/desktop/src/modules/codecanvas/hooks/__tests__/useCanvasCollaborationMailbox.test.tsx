import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { BridgeTask } from "@/lib/tauri-api";
import { useCanvasCollaborationMailbox } from "../useCanvasCollaborationMailbox";

const launch = {
  mode: "swarm-task" as const,
  sourceLabel: "Swarm task",
  autoOpenPanel: true,
  taskId: "task_1",
  workflowId: "wf-feature-pipeline",
};

function task(overrides: Partial<BridgeTask> = {}): BridgeTask {
  return {
    id: "task_1",
    workspaceId: "ws-1",
    title: "Ship feature",
    goal: "Deliver the feature",
    knowledge: "",
    status: "in-progress",
    priority: "medium",
    assignees: ["Mira"],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("useCanvasCollaborationMailbox", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists mailbox messages for the active project and collaboration run", () => {
    const { result, rerender } = renderHook(({ projectId }) => useCanvasCollaborationMailbox(projectId, launch), {
      initialProps: { projectId: "project-1" as string | null },
    });

    act(() => {
      result.current.appendMessage({ id: "msg-1", assignee: "Mira", kind: "handoff", author: "director", body: "Task brief", now: 123 });
    });

    expect(result.current.messages).toEqual([expect.objectContaining({ id: "msg-1", body: "Task brief" })]);

    rerender({ projectId: "project-1" });

    expect(result.current.mailbox?.messages[0]).toMatchObject({ id: "msg-1", assignee: "Mira", createdAt: 123 });
  });

  it("records evidence through the mailbox adapter", () => {
    const { result } = renderHook(() => useCanvasCollaborationMailbox("project-1", launch));

    act(() => {
      result.current.recordEvidence({ id: "ev-1", assignee: "Mira", summary: "Done", files: ["a.ts"], now: 200 });
    });

    expect(result.current.messages[0]).toMatchObject({ kind: "evidence", body: "Done", evidence: { files: ["a.ts"] } });
  });

  it("syncs Swarm task feedback into persisted mailbox messages", () => {
    const { result } = renderHook(() => useCanvasCollaborationMailbox("project-1", launch));

    act(() => {
      result.current.syncTaskFeedback(task({
        feedbackEvents: [
          { id: "ev-result", at: 100, actor: "agent", kind: "agent-result", summary: "Fixed paste crash", payload: { member: "Mira", files: ["src/editor.ts"] } },
        ],
      }));
    });

    expect(result.current.messages).toEqual([
      expect.objectContaining({ id: "swarm-feedback:ev-result", kind: "evidence", body: "Fixed paste crash" }),
    ]);
  });

  it("does not create a mailbox when collaboration is off", () => {
    const { result } = renderHook(() => useCanvasCollaborationMailbox("project-1", { mode: "off" }));

    act(() => {
      result.current.appendMessage({ id: "msg-1", assignee: "Mira", kind: "handoff", author: "director", body: "Task brief", now: 123 });
    });

    expect(result.current.mailbox).toBeNull();
    expect(result.current.messages).toEqual([]);
  });
});
