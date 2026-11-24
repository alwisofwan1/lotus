import { describe, expect, it } from "vitest";
import {
  resolveCanvasCollaborationLaunch,
} from "../canvas-collaboration-launch";

describe("canvas collaboration launch", () => {
  it("keeps ordinary canvas routes clean by default", () => {
    const launch = resolveCanvasCollaborationLaunch(new URLSearchParams("run=wf-feature-pipeline"));

    expect(launch).toEqual({ mode: "off" });
  });

  it("enables the collaboration ledger for a Swarm task workflow run", () => {
    const launch = resolveCanvasCollaborationLaunch(new URLSearchParams("run=wf-feature-pipeline&collab=swarm-task&task=task_bug_123&workspace=ws-1"));

    expect(launch).toMatchObject({
      mode: "swarm-task",
      sourceLabel: "Swarm task",
      taskId: "task_bug_123",
      workspaceId: "ws-1",
      workflowId: "wf-feature-pipeline",
      autoOpenPanel: true,
    });
  });

  it("enables the collaboration ledger for an explicit Swarm workflow run", () => {
    const launch = resolveCanvasCollaborationLaunch(new URLSearchParams("run=wf-release&collab=swarm-workflow"));

    expect(launch).toMatchObject({
      mode: "swarm-workflow",
      sourceLabel: "Swarm workflow",
      workflowId: "wf-release",
      autoOpenPanel: true,
    });
  });
});
