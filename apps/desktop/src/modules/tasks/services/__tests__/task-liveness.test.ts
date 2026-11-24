import { describe, expect, it } from "vitest";
import {
  livenessEvent,
  livenessWrites,
  taskLiveness,
} from "@/modules/tasks/services/task-liveness";
import type { PaneActivityState } from "@/modules/workspace-shell/services/pane-activity";

const panes = (entries: Record<string, PaneActivityState["activity"]>) =>
  new Map(Object.entries(entries).map(([id, activity]) => [id, { activity, since: 0 }]));

describe("what the pane a task claims is doing", () => {
  it("says nothing about a task that never named a pane", () => {
    expect(taskLiveness({}, panes({}))).toEqual({ kind: "none" });
  });

  it("reports the pane's own state when it is here", () => {
    expect(taskLiveness({ cellId: "p1" }, panes({ p1: "working" }))).toEqual({
      kind: "running",
      activity: "working",
    });
  });

  /*
    The whole reason this exists. `cellId` is written on dispatch and nothing ever takes it back,
    so a task whose pane died when the app closed goes on claiming a process is on it — and the
    `Active` count goes on believing it.
  */
  it("calls out a task pointing at a pane that is not here any more", () => {
    expect(taskLiveness({ cellId: "ghost" }, panes({ p1: "idle" }))).toEqual({ kind: "gone" });
  });
});

describe("which changes are worth a line in the history", () => {
  it("writes nothing while work is merely proceeding", () => {
    // A pane that is working reports constantly. A history that took every tick would be a log,
    // and nobody reads a log to find out what happened to a task.
    expect(livenessEvent("starting", "working")).toBeNull();
    expect(livenessEvent("working", "idle")).toBeNull();
  });

  it("writes nothing when nothing changed", () => {
    expect(livenessEvent("done", "done")).toBeNull();
    expect(livenessEvent("failed", "failed")).toBeNull();
  });

  it("records finishing, failing, and being asked a question", () => {
    expect(livenessEvent("working", "done")?.kind).toBe("agent-result");
    expect(livenessEvent("working", "failed")?.kind).toBe("task-blocked");
    expect(livenessEvent("working", "needs-you")?.kind).toBe("hitl-question");
  });

  it("says what happened in words, not in the state's own name", () => {
    // `failed` is a machine's word for itself. A history is read for what changed.
    const event = livenessEvent("working", "failed");

    expect(event?.summary).not.toBe("failed");
    expect(event?.summary.length).toBeGreaterThan(10);
  });
});

describe("deciding what to write, once", () => {
  const task = (id: string, cellId?: string) => ({
    id,
    projectId: "ws-1",
    title: id,
    status: "in-progress" as const,
    priority: "none" as const,
    createdAt: 0,
    updatedAt: 0,
    ...(cellId ? { cellId } : {}),
  });

  it("writes the ending once, however many times it is asked", () => {
    const tasks = [task("t1", "p1")];
    const done = panes({ p1: "done" });

    const first = livenessWrites(tasks, done, new Map());
    const second = livenessWrites(tasks, done, first.seen);

    expect(first.writes).toHaveLength(1);
    expect(second.writes).toHaveLength(0);
  });

  it("stays quiet while the work is merely proceeding", () => {
    const tasks = [task("t1", "p1")];

    const run = livenessWrites(tasks, panes({ p1: "working" }), new Map());

    expect(run.writes).toHaveLength(0);
    expect(run.seen.get("t1")).toBe("working");
  });

  it("forgets a task whose pane is gone, so a later run starts fresh", () => {
    // Dispatched again tomorrow, its first state is a change — not a repeat of yesterday's.
    const tasks = [task("t1", "p1")];
    const after = livenessWrites(tasks, panes({}), new Map([["t1", "working" as const]]));

    expect(after.seen.has("t1")).toBe(false);
  });

  it("says nothing about a task that never named a pane", () => {
    expect(livenessWrites([task("t1")], panes({ p1: "done" }), new Map()).writes).toEqual([]);
  });
});

describe("when a task stops naming its pane", () => {
  const task = (id: string, cellId: string) => ({
    id,
    projectId: "ws-1",
    title: id,
    status: "in-progress" as const,
    priority: "none" as const,
    createdAt: 0,
    updatedAt: 0,
    cellId,
  });

  it("lets go once the pane has ended", () => {
    const done = livenessWrites([task("t1", "p1")], panes({ p1: "done" }), new Map());
    const failed = livenessWrites([task("t2", "p2")], panes({ p2: "failed" }), new Map());

    expect(done.writes[0].clearCell).toBe(true);
    expect(failed.writes[0].clearCell).toBe(true);
  });

  it("keeps the binding while the pane is waiting on a person", () => {
    // The pane is alive, and the thread is the thing the person is about to answer in.
    const asking = livenessWrites([task("t1", "p1")], panes({ p1: "needs-you" }), new Map());

    expect(asking.writes[0].clearCell).toBe(false);
  });
});
