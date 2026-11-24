import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { describe, expect, it } from "vitest";
import { indexProjects, toTrackerTask, trackerTaskKey } from "@/modules/tasks/services/task-mapping";
import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import type { TrackerProject } from "@/modules/tasks/types";

const STORED: BridgeTask = {
  id: "task_abc",
  workspaceId: "ws-1",
  number: 2,
  title: "Fix the rail",
  goal: "",
  knowledge: "",
  status: "in-progress",
  priority: "high",
  assignees: [],
  createdAt: 1,
  updatedAt: 2,
};

const PROJECTS: TrackerProject[] = [{ id: "ws-1", name: "interview-hss", prefix: "IH", vocabulary: LOTUS_VOCABULARY }];

describe("mapping a stored task onto a row", () => {
  it("keeps only what a row draws, and calls the workspace a project", () => {
    expect(toTrackerTask(STORED)).toEqual({
      id: "task_abc",
      projectId: "ws-1",
      number: 2,
      title: "Fix the rail",
      status: "in-progress",
      priority: "high",
      createdAt: 1,
      updatedAt: 2,
      cellId: undefined,
    });
  });

  it("prints the key from the project's prefix and the task's number", () => {
    expect(trackerTaskKey(toTrackerTask(STORED), indexProjects(PROJECTS))).toBe("IH-2");
  });

  it("prints nothing when the task predates numbering", () => {
    const legacy = toTrackerTask({ ...STORED, number: undefined });
    expect(trackerTaskKey(legacy, indexProjects(PROJECTS))).toBeNull();
  });

  it("prints nothing for a project this window does not know", () => {
    // A task can belong to a workspace that is not open here; inventing a prefix for it would
    // put a key on screen that nobody else would recognise.
    const orphan = toTrackerTask({ ...STORED, workspaceId: "ws-elsewhere" });
    expect(trackerTaskKey(orphan, indexProjects(PROJECTS))).toBeNull();
  });
});

describe("a task made from something else", () => {
  it("carries the file it was made from onto its row, so the ticket can find it", () => {
    const row = toTrackerTask({ ...STORED, source: { kind: "vault", ref: "TKT-874.md", label: "TKT-874" } });
    expect(row.sourceRef).toBe("TKT-874.md");
  });
});
