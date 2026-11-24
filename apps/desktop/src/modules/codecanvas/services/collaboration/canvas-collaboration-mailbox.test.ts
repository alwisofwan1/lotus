import { describe, expect, it } from "vitest";
import type { BridgeTask } from "@/lib/tauri-api";
import {
  appendCanvasCollaborationMessage,
  createCanvasCollaborationMailbox,
  listCanvasCollaborationMessages,
  recordCanvasCollaborationEvidence,
  syncCanvasCollaborationMailboxFromTaskFeedback,
} from "./canvas-collaboration-mailbox";

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

describe("canvas collaboration mailbox", () => {
  it("appends assignment messages immutably and indexes them by assignee", () => {
    const mailbox = createCanvasCollaborationMailbox("swarm-task:task_1", 1);

    const next = appendCanvasCollaborationMessage(mailbox, {
      id: "msg-1",
      assignee: "Mira",
      nodeId: "node-mira",
      kind: "handoff",
      author: "director",
      body: "Initial task brief",
      now: 123,
    });

    expect(mailbox.messages).toEqual([]);
    expect(next.messages).toEqual([
      expect.objectContaining({ id: "msg-1", assignee: "Mira", nodeId: "node-mira", kind: "handoff", body: "Initial task brief", createdAt: 123 }),
    ]);
    expect(next.updatedAt).toBe(123);
    expect(listCanvasCollaborationMessages(next, { assignee: "mira" })).toHaveLength(1);
  });

  it("records evidence messages with structured evidence metadata", () => {
    const mailbox = recordCanvasCollaborationEvidence(createCanvasCollaborationMailbox("swarm-task:task_1", 1), {
      id: "ev-1",
      assignee: "Mira",
      nodeId: "node-mira",
      summary: "Fixed paste crash",
      files: ["src/editor.ts"],
      checks: ["bun test editor"],
      blockers: ["needs manual macOS paste QA"],
      now: 200,
    });

    expect(mailbox.messages[0]).toMatchObject({
      kind: "evidence",
      body: "Fixed paste crash",
      evidence: {
        files: ["src/editor.ts"],
        checks: ["bun test editor"],
        blockers: ["needs manual macOS paste QA"],
      },
    });
  });

  it("does not duplicate messages with the same id", () => {
    const mailbox = appendCanvasCollaborationMessage(createCanvasCollaborationMailbox("swarm-task:task_1", 1), {
      id: "msg-1",
      assignee: "Mira",
      kind: "handoff",
      author: "director",
      body: "Initial task brief",
      now: 100,
    });

    const next = appendCanvasCollaborationMessage(mailbox, {
      id: "msg-1",
      assignee: "Mira",
      kind: "handoff",
      author: "director",
      body: "Duplicate",
      now: 200,
    });

    expect(next).toBe(mailbox);
    expect(next.messages).toHaveLength(1);
  });

  it("syncs Swarm feedback events into evidence and blocker mailbox messages", () => {
    const mailbox = syncCanvasCollaborationMailboxFromTaskFeedback(createCanvasCollaborationMailbox("swarm-task:task_1", 1), task({
      feedbackEvents: [
        { id: "ev-result", at: 100, actor: "agent", kind: "agent-result", summary: "Fixed paste crash", payload: { member: "Mira", files: ["src/editor.ts"], checks: ["bun test editor"] } },
        { id: "ev-blocked", at: 200, actor: "reviewer", kind: "review-verdict", summary: "FAIL: missing regression", payload: { member: "Mira", verdict: "FAIL", blockers: ["missing regression"] } },
      ],
    }));

    expect(mailbox.messages).toEqual([
      expect.objectContaining({ id: "swarm-feedback:ev-result", kind: "evidence", assignee: "Mira", body: "Fixed paste crash", evidence: { files: ["src/editor.ts"], checks: ["bun test editor"] } }),
      expect.objectContaining({ id: "swarm-feedback:ev-blocked", kind: "blocker", assignee: "Mira", body: "FAIL: missing regression", evidence: { blockers: ["missing regression"] } }),
    ]);
  });

  it("filters mailbox messages by kind and node id in chronological order", () => {
    const mailbox = [
      { id: "m1", assignee: "Mira", nodeId: "node-mira", kind: "reply" as const, author: "agent" as const, body: "Working", now: 300 },
      { id: "m2", assignee: "Ilya", nodeId: "node-ilya", kind: "blocker" as const, author: "agent" as const, body: "Blocked", now: 100 },
      { id: "m3", assignee: "Mira", nodeId: "node-mira", kind: "evidence" as const, author: "agent" as const, body: "Done", now: 200 },
    ].reduce((current, message) => appendCanvasCollaborationMessage(current, message), createCanvasCollaborationMailbox("swarm-task:task_1", 1));

    expect(listCanvasCollaborationMessages(mailbox, { nodeId: "node-mira" }).map((message) => message.id)).toEqual(["m3", "m1"]);
    expect(listCanvasCollaborationMessages(mailbox, { kind: "blocker" }).map((message) => message.id)).toEqual(["m2"]);
  });
});
