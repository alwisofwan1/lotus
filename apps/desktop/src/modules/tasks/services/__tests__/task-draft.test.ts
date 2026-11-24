import { describe, expect, it } from "vitest";
import {
  applyTrackerTaskPatch,
  prepareTaskDraft,
  restoreTrackerTask,
  TASK_GOAL_CAP,
  TASK_TITLE_CAP,
} from "@/modules/tasks/services/task-draft";
import type { TrackerTask } from "@/modules/tasks/types";

const draft = { title: "  Fix   the flaky login test ", projectId: "ws-1", priority: "high" as const };

describe("prepareTaskDraft", () => {
  it("accepts a typed line and squeezes its whitespace", () => {
    const result = prepareTaskDraft(draft);
    expect(result).toEqual({
      ok: true,
      input: {
        workspaceId: "ws-1",
        title: "Fix the flaky login test",
        goal: "Fix the flaky login test",
        priority: "high",
        status: "todo",
      },
    });
  });

  it("refuses a task with no title, which the store would have accepted", () => {
    expect(prepareTaskDraft({ ...draft, title: "   " })).toEqual({
      ok: false,
      reason: "empty-title",
    });
  });

  it("refuses a title the store would reject for length", () => {
    const long = "a".repeat(TASK_TITLE_CAP + 1);
    expect(prepareTaskDraft({ ...draft, title: long })).toEqual({
      ok: false,
      reason: "title-too-long",
    });
  });

  it("refuses when no project was chosen", () => {
    expect(prepareTaskDraft({ ...draft, projectId: "" })).toEqual({
      ok: false,
      reason: "no-project",
    });
  });

  /*
    The store refuses a task with no goal — `validate_create` in `bridge_tasks.rs`, on every write
    path, not just the MCP one. Caught by creating a task against the running app; the first
    version of this test asserted the opposite and would have locked the refusal in.
  */
  it("sends the title as the goal, because the store refuses a task without one", () => {
    const result = prepareTaskDraft(draft);
    expect(result.ok && result.input.goal).toBe("Fix the flaky login test");
  });
});

describe("optimistic edits", () => {
  const task: TrackerTask = {
    id: "t1",
    projectId: "ws-1",
    title: "Fix login",
    status: "todo",
    priority: "none",
    createdAt: 1,
    updatedAt: 1,
  };
  const tasks = [task, { ...task, id: "t2", title: "Other" }];

  it("shows the change at once, and stamps it", () => {
    const next = applyTrackerTaskPatch(tasks, "t1", { status: "in-progress" }, 99);
    expect(next[0]).toMatchObject({ status: "in-progress", updatedAt: 99 });
    // The row nobody touched keeps its identity, so a memoised row does not redraw.
    expect(next[1]).toBe(tasks[1]);
  });

  it("puts the old row back when the store refuses", () => {
    const optimistic = applyTrackerTaskPatch(tasks, "t1", { priority: "high" }, 99);
    const restored = restoreTrackerTask(optimistic, task);
    expect(restored[0]).toEqual(task);
  });
});

describe("prepareTaskDraft — what the New task modal adds", () => {
  it("sends the description as the goal, so the worker gets the brief that was written", () => {
    const result = prepareTaskDraft({ ...draft, description: "  Repro: log in twice.  " });
    expect(result.ok && result.input.goal).toBe("Repro: log in twice.");
  });

  it("falls back to the title when the description is blank — the store requires a goal", () => {
    const result = prepareTaskDraft({ ...draft, description: "   " });
    expect(result.ok && result.input.goal).toBe("Fix the flaky login test");
  });

  it("keeps the status that was picked instead of forcing todo", () => {
    const result = prepareTaskDraft({ ...draft, status: "in-progress" });
    expect(result.ok && result.input.status).toBe("in-progress");
  });

  it("refuses a description the store would reject for length", () => {
    expect(prepareTaskDraft({ ...draft, description: "a".repeat(TASK_GOAL_CAP + 1) })).toEqual({
      ok: false,
      reason: "description-too-long",
    });
  });
});

describe("prepareTaskDraft — caps are the store's bytes, not characters", () => {
  it("refuses a title of 120 characters that is more than 120 bytes", () => {
    // 118 letters and an em dash: 119 characters, 121 bytes.
    const title = `${"a".repeat(59)} — ${"b".repeat(57)}`;
    expect(title.length).toBeLessThanOrEqual(TASK_TITLE_CAP);

    const result = prepareTaskDraft({ title, projectId: "ws-1", priority: "none" });

    expect(result).toEqual({ ok: false, reason: "title-too-long" });
  });

  it("accepts a title that is exactly 120 bytes", () => {
    const title = `${"a".repeat(58)} — ${"b".repeat(57)}`;
    expect(Buffer.byteLength(title, "utf8")).toBe(120);

    expect(prepareTaskDraft({ title, projectId: "ws-1", priority: "none" }).ok).toBe(true);
  });
});
