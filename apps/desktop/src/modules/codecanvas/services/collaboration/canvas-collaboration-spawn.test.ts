import { describe, expect, it } from "vitest";
import type { BridgeTask } from "@/lib/tauri-api";
import {
  buildMissingAssigneeAgentDefinitions,
  buildMissingAssigneeSpawnSpecs,
  missingAssigneeParticipants,
  type CanvasCollaborationParticipantView,
} from "./canvas-collaboration-participants";

const participant = (overrides: Partial<CanvasCollaborationParticipantView>): CanvasCollaborationParticipantView => ({
  id: "assignee:mira",
  name: "Mira",
  status: "not-spawned",
  source: "task-assignee",
  evidenceCount: 0,
  ...overrides,
});

describe("canvas collaboration spawn projection", () => {
  it("returns only task assignees that are not spawned yet", () => {
    const missing = missingAssigneeParticipants([
      participant({ name: "Mira", status: "not-spawned", source: "task-assignee" }),
      participant({ name: "Ilya", status: "running", source: "task-assignee" }),
      participant({ name: "Rowan", status: "queued", source: "canvas-agent" }),
    ]);

    expect(missing.map((p) => p.name)).toEqual(["Mira"]);
  });

  it("builds task briefs for spawned missing assignees", () => {
    const task: BridgeTask = {
      id: "task_bug_123",
      workspaceId: "ws-1",
      title: "Fix paste crash",
      goal: "Pasting an image should not crash the note editor.",
      knowledge: "Crash appears after image clipboard handling changed.",
      status: "in-progress",
      priority: "high",
      assignees: ["Mira"],
      createdAt: 1,
      updatedAt: 2,
      subtasks: [
        { id: "sub-1", title: "Add regression test", status: "pending", assignedTo: "Mira" },
        { id: "sub-2", title: "Review unrelated logs", status: "pending", assignedTo: "Rowan" },
      ],
      feedbackEvents: [
        { id: "evt-1", at: 3, actor: "director", kind: "assignment-dispatched", summary: "Mira owns clipboard regression" },
      ],
    };

    const specs = buildMissingAssigneeSpawnSpecs([participant({ name: "Mira" })], { task, projectId: "cp_1", runId: "swarm-task:task_1", now: 123 });

    expect(specs).toHaveLength(1);
    expect(specs[0].definition.name).toBe("Mira");
    expect(specs[0].brief).toContain("Assignee: Mira");
    expect(specs[0].brief).toContain("Fix paste crash");
    expect(specs[0].brief).toContain("Pasting an image should not crash");
    expect(specs[0].brief).toContain("Add regression test");
    expect(specs[0].brief).not.toContain("Review unrelated logs");
    expect(specs[0].brief).toContain("Mira owns clipboard regression");
    expect(specs[0].brief).toContain("Report evidence when complete");
    expect(specs[0].brief).toContain("lotus_canvas_read_assignment");
    expect(specs[0].brief).toContain("lotus_canvas_record_evidence");
    expect(specs[0].brief).toContain("lotus_canvas_mark_blocked");
    expect(specs[0].brief).toContain("projectId: cp_1");
    expect(specs[0].brief).toContain("runId: swarm-task:task_1");
  });

  it("builds stable ad-hoc AgentDefinitions for missing Swarm assignees", () => {
    const definitions = buildMissingAssigneeAgentDefinitions([
      participant({ id: "assignee:mira", name: "Mira" }),
      participant({ id: "assignee:qa", name: "QA Reviewer", role: "Reviewer" }),
    ], {
      taskTitle: "Fix paste crash",
      now: 123,
    });

    expect(definitions).toEqual([
      expect.objectContaining({
        id: "collab-assignee-mira",
        name: "Mira",
        role: "Swarm task assignee",
        runner: "claude",
        permissionMode: "full",
        updatedAt: 123,
      }),
      expect.objectContaining({
        id: "collab-assignee-qa-reviewer",
        name: "QA Reviewer",
        role: "Reviewer",
      }),
    ]);
    expect(definitions[0].prompt).toContain("Fix paste crash");
  });
});
