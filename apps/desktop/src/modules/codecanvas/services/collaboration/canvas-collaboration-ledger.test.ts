import { describe, expect, it } from "vitest";
import {
  recordCanvasCollaborationAssigneeSpawn,
  syncCanvasCollaborationLedgerFromParticipants,
  type CanvasCollaborationLedger,
} from "./canvas-collaboration-ledger";
import { projectCanvasCollaborationParticipants, type CanvasCollaborationAgentSnapshot } from "./canvas-collaboration-participants";
import type { BridgeTask } from "@/lib/tauri-api";

function task(): BridgeTask {
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
  };
}

function agent(overrides: Partial<CanvasCollaborationAgentSnapshot>): CanvasCollaborationAgentSnapshot {
  return {
    id: "node-mira",
    name: "Renamed Builder",
    status: "running",
    ...overrides,
  };
}

describe("canvas collaboration ledger", () => {
  it("records assignee to Canvas AgentNode mapping without mutating the prior ledger", () => {
    const ledger: CanvasCollaborationLedger = { runId: "swarm-task:task_1", assignments: {}, updatedAt: 1 };

    const next = recordCanvasCollaborationAssigneeSpawn(ledger, {
      assignee: "Mira",
      nodeId: "node-mira",
      brief: "Task brief",
      now: 123,
    });

    expect(ledger.assignments).toEqual({});
    expect(next.assignments.mira).toMatchObject({ assignee: "Mira", nodeId: "node-mira", state: "spawned", lastBrief: "Task brief", spawnedAt: 123 });
    expect(next.updatedAt).toBe(123);
  });

  it("syncs assignment lifecycle state from participant projection", () => {
    const ledger = recordCanvasCollaborationAssigneeSpawn({ runId: "swarm-task:task_1", assignments: {}, updatedAt: 1 }, {
      assignee: "Mira",
      nodeId: "node-mira",
      brief: "Task brief",
      now: 100,
    });

    const next = syncCanvasCollaborationLedgerFromParticipants(ledger, [
      { id: "node-mira", nodeId: "node-mira", name: "Mira", source: "task-assignee", status: "running", evidenceCount: 0 },
    ], 200);

    expect(next.assignments.mira).toMatchObject({ state: "running", updatedAt: 200 });
    expect(next.updatedAt).toBe(200);
  });

  it("syncs done and blocked terminal states from participant evidence and review status", () => {
    const ledger = recordCanvasCollaborationAssigneeSpawn({ runId: "swarm-task:task_1", assignments: {}, updatedAt: 1 }, {
      assignee: "Mira",
      nodeId: "node-mira",
      now: 100,
    });

    const done = syncCanvasCollaborationLedgerFromParticipants(ledger, [
      { id: "node-mira", nodeId: "node-mira", name: "Mira", source: "task-assignee", status: "done", evidenceCount: 1 },
    ], 200);
    const blocked = syncCanvasCollaborationLedgerFromParticipants(done, [
      { id: "node-mira", nodeId: "node-mira", name: "Mira", source: "task-assignee", status: "needs-attention", evidenceCount: 1 },
    ], 300);

    expect(done.assignments.mira.state).toBe("done");
    expect(blocked.assignments.mira).toMatchObject({ state: "blocked", updatedAt: 300 });
  });

  it("projects ledger metadata for the overlay when an assignee has a durable assignment", () => {
    const ledger = recordCanvasCollaborationAssigneeSpawn({ runId: "swarm-task:task_1", assignments: {}, updatedAt: 1 }, {
      assignee: "Mira",
      nodeId: "node-mira",
      brief: "Task brief",
      now: 123,
    });

    const participants = projectCanvasCollaborationParticipants({
      task: task(),
      agents: [agent({ id: "node-mira", name: "Mira", status: "idle" })],
      ledger,
    });

    expect(participants[0]).toMatchObject({
      assignmentState: "spawned",
      assignmentUpdatedAt: 123,
      assignmentBriefSent: true,
    });
  });

  it("uses the durable assignee mapping before name matching so renamed agents remain focused", () => {
    const ledger = recordCanvasCollaborationAssigneeSpawn({ runId: "swarm-task:task_1", assignments: {}, updatedAt: 1 }, {
      assignee: "Mira",
      nodeId: "node-mira",
      brief: "Task brief",
      now: 123,
    });

    const participants = projectCanvasCollaborationParticipants({
      task: task(),
      agents: [agent({ id: "node-mira", name: "Renamed Builder", status: "running" })],
      ledger,
    });

    expect(participants).toEqual([
      expect.objectContaining({
        id: "node-mira",
        nodeId: "node-mira",
        name: "Renamed Builder",
        status: "running",
        source: "task-assignee",
      }),
    ]);
  });
});
