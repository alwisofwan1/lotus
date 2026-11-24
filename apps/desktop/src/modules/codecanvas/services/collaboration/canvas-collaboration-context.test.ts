import { describe, expect, it } from "vitest";
import type { BridgeTask } from "@/lib/tauri-api";
import { buildCanvasCollaborationContextRecord } from "./canvas-collaboration-context";

const task: BridgeTask = {
  id: "task_1",
  workspaceId: "ws-1",
  title: "Ship feature",
  goal: "Deliver the feature",
  knowledge: "Use project notes",
  status: "in-progress",
  priority: "high",
  assignees: ["Mira"],
  createdAt: 1,
  updatedAt: 2,
};

describe("canvas collaboration context", () => {
  it("builds a persisted run context with launch and task summaries", () => {
    const record = buildCanvasCollaborationContextRecord({
      launch: {
        mode: "swarm-task",
        sourceLabel: "Swarm task",
        taskId: "task_1",
        workflowId: "wf-feature-pipeline",
        workspaceId: "ws-1",
        autoOpenPanel: true,
      },
      runId: "swarm-task:task:task_1",
      task,
      now: 123,
    });

    expect(record).toEqual({
      runId: "swarm-task:task:task_1",
      launch: {
        mode: "swarm-task",
        sourceLabel: "Swarm task",
        taskId: "task_1",
        workflowId: "wf-feature-pipeline",
        workspaceId: "ws-1",
      },
      task: {
        id: "task_1",
        workspaceId: "ws-1",
        title: "Ship feature",
        goal: "Deliver the feature",
        knowledge: "Use project notes",
        status: "in-progress",
        priority: "high",
        assignees: ["Mira"],
        updatedAt: 2,
      },
      updatedAt: 123,
    });
  });

  it("returns null when collaboration is off or missing a run id", () => {
    expect(buildCanvasCollaborationContextRecord({ launch: { mode: "off" }, runId: null })).toBeNull();
  });
});
