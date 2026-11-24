import { describe, expect, it } from "vitest";
import type { BridgeTask } from "@/lib/tauri-api";
import {
  planCanvasCollaborationMcpRequest,
  type CanvasCollaborationMcpRequest,
} from "./canvas-collaboration-mcp";
import type { CanvasCollaborationParticipantView } from "./canvas-collaboration-participants";

const task: BridgeTask = {
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

const participant: CanvasCollaborationParticipantView = {
  id: "node-mira",
  nodeId: "node-mira",
  name: "Mira",
  status: "running",
  source: "task-assignee",
  evidenceCount: 0,
};

function request(overrides: Partial<CanvasCollaborationMcpRequest>): CanvasCollaborationMcpRequest {
  return { requestId: "req-1", action: "list-participants", ...overrides };
}

describe("canvas collaboration MCP planner", () => {
  it("rejects requests when no explicit collaboration run is active", () => {
    const result = planCanvasCollaborationMcpRequest(request({}), {
      launch: { mode: "off" },
      participants: [],
      mailboxMessages: [],
    });

    expect(result).toEqual({ ok: false, error: expect.stringMatching(/No active CodeCanvas collaboration run/) });
  });

  it("lists participants and task context for the active run", () => {
    const result = planCanvasCollaborationMcpRequest(request({}), {
      launch: { mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_1", autoOpenPanel: true },
      participants: [participant],
      task,
      mailboxMessages: [],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        run: { mode: "swarm-task", taskId: "task_1" },
        task: { id: "task_1", title: "Ship feature" },
        taskFreshness: "live-ui",
        participants: [expect.objectContaining({ name: "Mira", nodeId: "node-mira" })],
      },
    });
  });

  it("reads one assignment with its mailbox thread and action summary", () => {
    const result = planCanvasCollaborationMcpRequest(request({ action: "read-assignment", assignee: "Mira" }), {
      launch: { mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_1", autoOpenPanel: true },
      participants: [{ ...participant, evidenceCount: 1 }],
      task,
      mailboxMessages: [
        { id: "msg-1", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "handoff", author: "director", body: "Brief", createdAt: 1 },
        { id: "msg-2", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "evidence", author: "agent", body: "Tests pass", createdAt: 2, evidence: { files: ["src/a.ts"], checks: ["bun test"] } },
        { id: "msg-3", assignee: "Mira", assigneeKey: "mira", nodeId: "node-mira", kind: "blocker", author: "agent", body: "Need API key", createdAt: 3, evidence: { blockers: ["Missing key"] } },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        participant: expect.objectContaining({ name: "Mira" }),
        taskFreshness: "live-ui",
        assignment: {
          assignee: "Mira",
          status: "running",
          evidenceCount: 1,
          messageCount: 3,
          latestEvidence: expect.objectContaining({ body: "Tests pass" }),
          latestBlocker: expect.objectContaining({ body: "Need API key" }),
          nextAction: expect.stringMatching(/blocker/i),
        },
      },
    });
    if (!result.ok) throw new Error("expected success");
    expect((result.data as { messages: Array<{ body: string }> }).messages[0]).toMatchObject({ body: "Need API key" });
  });

  it("plans durable mailbox writes for evidence and blockers", () => {
    const evidence = planCanvasCollaborationMcpRequest(request({ action: "record-evidence", assignee: "Mira", summary: "Done", files: ["a.ts"], checks: ["bun test"] }), {
      launch: { mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_1", autoOpenPanel: true },
      participants: [participant],
      task,
      mailboxMessages: [],
    });
    const blocker = planCanvasCollaborationMcpRequest(request({ action: "mark-blocked", assignee: "node-mira", summary: "Blocked", blockers: ["Need fixture"] }), {
      launch: { mode: "swarm-task", sourceLabel: "Swarm task", taskId: "task_1", autoOpenPanel: true },
      participants: [participant],
      task,
      mailboxMessages: [],
    });

    expect(evidence).toMatchObject({
      ok: true,
      appendMessage: { assignee: "Mira", nodeId: "node-mira", kind: "evidence", author: "agent", body: "Done", evidence: { files: ["a.ts"], checks: ["bun test"] } },
    });
    expect(blocker).toMatchObject({
      ok: true,
      appendMessage: { assignee: "Mira", nodeId: "node-mira", kind: "blocker", author: "agent", body: "Blocked", evidence: { blockers: ["Need fixture"] } },
    });
  });
});
