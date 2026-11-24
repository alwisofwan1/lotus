import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmTaskStore } from "../store.js";
import type { CreateTaskInput } from "../types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeStore(dir: string, seedTime = 1_000): SwarmTaskStore {
  let t = seedTime;
  let n = 0;
  return new SwarmTaskStore({
    baseDir: dir,
    now: () => (t += 1),
    newId: () => `task_${(n += 1)}`,
  });
}

const BASE: CreateTaskInput = { workspaceId: "/srv/api", title: "Ship it", goal: "Make it work" };

describe("SwarmTaskStore", () => {
  let dir: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "swarm-tasks-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // ─── create ──────────────────────────────────────────────────────────────

  it("creates a task with defaults and an injected id + timestamps", async () => {
    const store = makeStore(dir);
    const task = await store.create(BASE);
    expect(task.id).toBe("task_1");
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("none");
    expect(task.knowledge).toBe("");
    expect(task.assignees).toEqual([]);
    expect(task.subtasks).toEqual([]);
    expect(task.feedbackEvents).toEqual([]);
    expect(task.createdAt).toBe(task.updatedAt);
  });

  it("honours an explicit initial status, priority, and assignees", async () => {
    const store = makeStore(dir);
    const task = await store.create({ ...BASE, status: "in-progress", priority: "high", assignees: ["lead"] });
    expect(task.status).toBe("in-progress");
    expect(task.priority).toBe("high");
    expect(task.assignees).toEqual(["lead"]);
  });

  // ─── get / list ────────────────────────────────────────────────────────────

  it("gets a task by id and returns null for unknown ids", async () => {
    const store = makeStore(dir);
    const created = await store.create(BASE);
    expect(await store.get(created.id)).toEqual(created);
    expect(await store.get("nope")).toBeNull();
  });

  it("lists tasks and filters by workspaceId and status", async () => {
    const store = makeStore(dir);
    await store.create({ ...BASE, workspaceId: "/a", status: "todo" });
    await store.create({ ...BASE, workspaceId: "/a", status: "complete" });
    await store.create({ ...BASE, workspaceId: "/b", status: "todo" });

    expect(await store.list()).toHaveLength(3);
    expect(await store.list({ workspaceId: "/a" })).toHaveLength(2);
    expect(await store.list({ status: "todo" })).toHaveLength(2);
    expect(await store.list({ workspaceId: "/a", status: "todo" })).toHaveLength(1);
  });

  // ─── update ──────────────────────────────────────────────────────────────

  it("applies a patch, bumps updatedAt, and leaves createdAt fixed", async () => {
    const store = makeStore(dir);
    const created = await store.create(BASE);
    const updated = await store.update(created.id, { status: "in-progress" });
    expect(updated?.status).toBe("in-progress");
    expect(updated?.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(updated?.createdAt).toBe(created.createdAt);
  });

  it("returns null when updating an unknown task", async () => {
    const store = makeStore(dir);
    expect(await store.update("ghost", { status: "complete" })).toBeNull();
  });

  it("treats explicit null as a clear and absent as leave-untouched (tri-state)", async () => {
    const store = makeStore(dir);
    const created = await store.create(BASE);
    await store.update(created.id, { cellId: "pty-1", lastError: "boom" });
    const cleared = await store.update(created.id, { cellId: null });
    expect(cleared?.cellId).toBeUndefined();          // null cleared it
    expect(cleared?.lastError).toBe("boom");           // absent left it untouched
  });

  // ─── durability ────────────────────────────────────────────────────────────

  it("persists across store instances (atomic write to disk)", async () => {
    const created = await makeStore(dir).create(BASE);
    const reopened = makeStore(dir);
    const loaded = await reopened.get(created.id);
    expect(loaded?.title).toBe("Ship it");
  });

  it("filters list by assignee membership", async () => {
    const store = makeStore(dir);
    await store.create({ ...BASE, assignees: ["lead", "qa"] });
    await store.create({ ...BASE, assignees: ["qa"] });
    await store.create({ ...BASE, assignees: [] });
    expect(await store.list({ assignee: "qa" })).toHaveLength(2);
    expect(await store.list({ assignee: "lead" })).toHaveLength(1);
  });

  // ─── appendFeedbackEvent ───────────────────────────────────────────────────

  it("appends a feedback event atomically and bumps updatedAt", async () => {
    const store = makeStore(dir);
    const created = await store.create(BASE);
    const event = { id: "e1", at: 5, actor: "director", kind: "intake-created", summary: "brief" } as const;
    const updated = await store.appendFeedbackEvent(created.id, event);
    expect(updated?.feedbackEvents).toEqual([event]);
    expect(updated?.updatedAt).toBeGreaterThan(created.updatedAt);
  });

  it("returns null when appending to an unknown task", async () => {
    const store = makeStore(dir);
    const event = { id: "e", at: 1, actor: "system", kind: "task-blocked", summary: "x" } as const;
    expect(await store.appendFeedbackEvent("ghost", event)).toBeNull();
  });

  it("does not lose events when two appends race on one task", async () => {
    const store = makeStore(dir);
    const created = await store.create(BASE);
    const ev = (id: string) => ({ id, at: 1, actor: "agent", kind: "agent-result", summary: id } as const);
    await Promise.all([
      store.appendFeedbackEvent(created.id, ev("a")),
      store.appendFeedbackEvent(created.id, ev("b")),
    ]);
    const final = await store.get(created.id);
    expect(final?.feedbackEvents.map((e) => e.id).sort()).toEqual(["a", "b"]);
  });

  // ─── concurrency ─────────────────────────────────────────────────────────

  it("serializes concurrent updates to one task (no lost update)", async () => {
    const store = makeStore(dir);
    const created = await store.create(BASE);
    await Promise.all([
      store.update(created.id, { title: "renamed" }),
      store.update(created.id, { goal: "new goal" }),
    ]);
    const final = await store.get(created.id);
    expect(final?.title).toBe("renamed");
    expect(final?.goal).toBe("new goal");
  });
});
