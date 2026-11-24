import { describe, expect, it } from "vitest";
import type { BridgeTask } from "@/lib/tauri-api";
import { projectCanvasCollaborationParticipants, type CanvasCollaborationAgentSnapshot } from "./canvas-collaboration-participants";

function task(overrides: Partial<BridgeTask> = {}): BridgeTask {
  return {
    id: "task_1",
    workspaceId: "ws-1",
    title: "Ship feature",
    goal: "Deliver the feature",
    knowledge: "",
    status: "in-progress",
    priority: "medium",
    assignees: ["Mira", "Ilya"],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function agent(overrides: Partial<CanvasCollaborationAgentSnapshot>): CanvasCollaborationAgentSnapshot {
  return {
    id: "agent-1",
    name: "Mira",
    status: "running",
    ...overrides,
  };
}

describe("projectCanvasCollaborationParticipants", () => {
  it("shows task assignees missing from the canvas as not spawned", () => {
    const participants = projectCanvasCollaborationParticipants({ task: task(), agents: [] });

    expect(participants).toEqual([
      expect.objectContaining({ name: "Mira", status: "not-spawned", source: "task-assignee" }),
      expect.objectContaining({ name: "Ilya", status: "not-spawned", source: "task-assignee" }),
    ]);
  });

  it("matches task assignees to live Canvas AgentNodes by name", () => {
    const participants = projectCanvasCollaborationParticipants({
      task: task(),
      agents: [agent({ id: "node-mira", name: "mira", status: "running" })],
    });

    expect(participants[0]).toMatchObject({
      id: "node-mira",
      name: "mira",
      status: "running",
      source: "task-assignee",
    });
    expect(participants[1]).toMatchObject({ name: "Ilya", status: "not-spawned" });
  });

  it("marks an assignee done when its latest feedback is an agent result", () => {
    const participants = projectCanvasCollaborationParticipants({
      task: task({
        assignees: ["Mira"],
        feedbackEvents: [
          { id: "e1", at: 10, actor: "agent", kind: "agent-result", summary: "Mira produced evidence", payload: { member: "Mira" } },
        ],
      }),
      agents: [agent({ name: "Mira", status: "running" })],
    });

    expect(participants[0]).toMatchObject({
      name: "Mira",
      status: "done",
      evidenceCount: 1,
      lastEventSummary: "Mira produced evidence",
    });
  });

  it("marks an assignee needs-attention when blocked or failed review feedback targets it", () => {
    const participants = projectCanvasCollaborationParticipants({
      task: task({
        assignees: ["Ilya"],
        feedbackEvents: [
          { id: "e1", at: 10, actor: "reviewer", kind: "review-verdict", summary: "FAIL: shortcut matrix incomplete", payload: { member: "Ilya", verdict: "FAIL" } },
        ],
      }),
      agents: [agent({ name: "Ilya", status: "idle" })],
    });

    expect(participants[0]).toMatchObject({
      name: "Ilya",
      status: "needs-attention",
      lastEventSummary: "FAIL: shortcut matrix incomplete",
    });
  });

  it("uses collaboration mailbox evidence and blockers in participant state", () => {
    const participants = projectCanvasCollaborationParticipants({
      task: task({ assignees: ["Mira", "Ilya"] }),
      agents: [agent({ id: "node-mira", name: "Mira", status: "running" }), agent({ id: "node-ilya", name: "Ilya", status: "running" })],
      mailboxMessages: [
        { id: "mail-1", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "evidence", author: "human", body: "Manual proof", createdAt: 100 },
        { id: "mail-2", assignee: "Ilya", assigneeKey: "ilya", nodeId: "node-ilya", kind: "blocker", author: "human", body: "Needs QA fixture", createdAt: 200 },
      ],
    });

    expect(participants[0]).toMatchObject({ name: "Mira", status: "done", evidenceCount: 1, lastEventSummary: "Manual proof" });
    expect(participants[1]).toMatchObject({ name: "Ilya", status: "needs-attention", evidenceCount: 0, lastEventSummary: "Needs QA fixture" });
  });

  it("keeps unassigned canvas agents visible as canvas-agent participants", () => {
    const participants = projectCanvasCollaborationParticipants({
      task: task({ assignees: ["Mira"] }),
      agents: [agent({ name: "Mira", status: "completed" }), agent({ id: "node-rowan", name: "Rowan Lead", status: "idle" })],
    });

    expect(participants).toEqual([
      expect.objectContaining({ name: "Mira", source: "task-assignee", status: "done" }),
      expect.objectContaining({ id: "node-rowan", name: "Rowan Lead", source: "canvas-agent", status: "queued" }),
    ]);
  });
});

describe("a blocked agent as a collaboration participant", () => {
  // `agentStatus` is an exhaustive switch with no `default`, so widening AgentNodeStatus with
  // `needs-you` (plans/honest-agent-status/) made it fall off the end and return undefined. That
  // is a TYPE error the production build catches and `bun run test` does not — this test is what
  // makes it a behaviour question instead, and pins the mapping rather than just its existence.
  it("surfaces as needs-attention, which is what the collaboration vocabulary already calls it", () => {
    const agents: CanvasCollaborationAgentSnapshot[] = [
      { id: "n1", name: "Mira", status: "needs-you" },
    ];

    const participants = projectCanvasCollaborationParticipants({ agents });

    expect(participants.find((p) => p.name === "Mira")?.status).toBe("needs-attention");
  });

  it("never reports a blocked agent as running or done", () => {
    // The two readings that would matter: a run overlay showing it as progressing, or as finished.
    const agents: CanvasCollaborationAgentSnapshot[] = [
      { id: "n1", name: "Mira", status: "needs-you" },
    ];

    const status = projectCanvasCollaborationParticipants({ agents }).find(
      (p) => p.name === "Mira",
    )?.status;

    expect(status).not.toBe("running");
    expect(status).not.toBe("done");
  });
});
