import { describe, it, expect } from "vitest";
import {
  createInMemoryTaskStore,
  createPersistentTaskStore,
  TASK_CAPS,
  type StorageAdapter,
} from "../task-store";

describe("task-store — create + get", () => {
  it("creates a task and retrieves it by id with sensible defaults", async () => {
    const store = createInMemoryTaskStore();
    const created = await store.create({
      workspaceId: "ws_1",
      title: "Fix tab switch bug",
      goal: "Tab switch must preserve PTY session",
    });

    expect(created.id).toMatch(/^task_/);
    expect(created.workspaceId).toBe("ws_1");
    expect(created.title).toBe("Fix tab switch bug");
    expect(created.goal).toBe("Tab switch must preserve PTY session");
    expect(created.status).toBe("todo");
    expect(created.priority).toBe("none");
    expect(created.knowledge).toBe("");
    expect(created.assignees).toEqual([]);
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBe(created.createdAt);

    const fetched = await store.get(created.id);
    expect(fetched).toEqual(created);
  });

  it("returns undefined for unknown id", async () => {
    const store = createInMemoryTaskStore();
    expect(await store.get("task_nope")).toBeUndefined();
  });
});

describe("task-store — list + filter", () => {
  const seed = async () => {
    const store = createInMemoryTaskStore();
    await store.create({ workspaceId: "ws_1", title: "A", goal: "g", status: "todo" });
    await store.create({ workspaceId: "ws_1", title: "B", goal: "g", status: "in-progress", assignees: ["claude-1"] });
    await store.create({ workspaceId: "ws_2", title: "C", goal: "g", status: "complete" });
    await store.create({ workspaceId: "ws_1", title: "D", goal: "g", status: "in-progress", assignees: ["codex-1"] });
    return store;
  };

  it("lists all tasks when no filter is provided", async () => {
    const store = await seed();
    const all = await store.list();
    expect(all).toHaveLength(4);
  });

  it("filters by workspaceId", async () => {
    const store = await seed();
    const ws1 = await store.list({ workspaceId: "ws_1" });
    expect(ws1.map((t) => t.title).sort()).toEqual(["A", "B", "D"]);
  });

  it("filters by status", async () => {
    const store = await seed();
    const inProgress = await store.list({ status: "in-progress" });
    expect(inProgress).toHaveLength(2);
  });

  it("filters by assignee", async () => {
    const store = await seed();
    const claudeTasks = await store.list({ assignee: "claude-1" });
    expect(claudeTasks).toHaveLength(1);
    expect(claudeTasks[0].title).toBe("B");
  });

  it("combines filters with AND semantics", async () => {
    const store = await seed();
    const result = await store.list({ workspaceId: "ws_1", status: "in-progress" });
    expect(result.map((t) => t.title).sort()).toEqual(["B", "D"]);
  });
});

describe("task-store — update", () => {
  it("patches fields and bumps updatedAt", async () => {
    let nowVal = 1_000;
    const store = createInMemoryTaskStore({ now: () => nowVal });
    const created = await store.create({ workspaceId: "ws_1", title: "T", goal: "g" });
    expect(created.updatedAt).toBe(1_000);

    nowVal = 2_500;
    const updated = await store.update(created.id, {
      status: "in-progress",
      assignees: ["claude-1"],
      knowledge: "added context",
    });

    expect(updated.status).toBe("in-progress");
    expect(updated.assignees).toEqual(["claude-1"]);
    expect(updated.knowledge).toBe("added context");
    expect(updated.updatedAt).toBe(2_500);
    expect(updated.createdAt).toBe(1_000);
    // Untouched fields preserved
    expect(updated.title).toBe("T");
    expect(updated.goal).toBe("g");
  });

  it("clears optional execution fields when patch value is null", async () => {
    const store = createInMemoryTaskStore();
    const created = await store.create({ workspaceId: "ws_1", title: "T", goal: "g" });
    const bound = await store.update(created.id, {
      cellId: "pane_1",
      lastError: "failed",
    });

    expect(bound.cellId).toBe("pane_1");
    expect(bound.lastError).toBe("failed");

    const cleared = await store.update(created.id, {
      cellId: null,
      lastError: null,
    });

    expect(cleared.cellId).toBeUndefined();
    expect(cleared.lastError).toBeUndefined();
  });

  it("throws when updating an unknown id", async () => {
    const store = createInMemoryTaskStore();
    await expect(store.update("task_nope", { status: "complete" })).rejects.toThrow(/not found/i);
  });
});

describe("task-store — field caps", () => {
  it("exposes BridgeMCP-mirror cap constants", () => {
    expect(TASK_CAPS.TITLE).toBe(120);
    expect(TASK_CAPS.GOAL).toBe(500);
    expect(TASK_CAPS.KNOWLEDGE).toBe(200_000);
  });

  it("rejects create when title exceeds cap", async () => {
    const store = createInMemoryTaskStore();
    await expect(
      store.create({ workspaceId: "ws", title: "x".repeat(121), goal: "g" }),
    ).rejects.toThrow(/title.*120/i);
  });

  it("rejects create when goal exceeds cap", async () => {
    const store = createInMemoryTaskStore();
    await expect(
      store.create({ workspaceId: "ws", title: "t", goal: "x".repeat(501) }),
    ).rejects.toThrow(/goal.*500/i);
  });

  it("rejects create when knowledge exceeds cap", async () => {
    const store = createInMemoryTaskStore();
    await expect(
      store.create({
        workspaceId: "ws",
        title: "t",
        goal: "g",
        knowledge: "x".repeat(200_001),
      }),
    ).rejects.toThrow(/knowledge.*200000/i);
  });

  it("rejects update when patch exceeds caps", async () => {
    const store = createInMemoryTaskStore();
    const t = await store.create({ workspaceId: "ws", title: "t", goal: "g" });
    await expect(store.update(t.id, { knowledge: "x".repeat(200_001) })).rejects.toThrow(/knowledge/i);
  });

  it("(placeholder removed)", () => {});

  it("requires workspaceId, title, and goal", async () => {
    const store = createInMemoryTaskStore();
    await expect(store.create({ workspaceId: "", title: "t", goal: "g" })).rejects.toThrow(/workspaceId/i);
    await expect(store.create({ workspaceId: "ws", title: "", goal: "g" })).rejects.toThrow(/title/i);
    await expect(store.create({ workspaceId: "ws", title: "t", goal: "" })).rejects.toThrow(/goal/i);
  });
});

describe("task-store — persistent (adapter-backed)", () => {
  function memoryAdapter(initial: string | null = null): StorageAdapter {
    let state = initial;
    return {
      async load() {
        return state;
      },
      async save(payload: string) {
        state = payload;
      },
    };
  }

  it("survives a full round-trip: create → reopen → list", async () => {
    const adapter = memoryAdapter();
    const first = await createPersistentTaskStore(adapter);
    await first.create({ workspaceId: "ws", title: "Persisted", goal: "g" });

    const second = await createPersistentTaskStore(adapter);
    const all = await second.list();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Persisted");
  });

  it("persists updates", async () => {
    const adapter = memoryAdapter();
    const store = await createPersistentTaskStore(adapter);
    const t = await store.create({ workspaceId: "ws", title: "T", goal: "g" });
    await store.update(t.id, { status: "in-progress" });

    const reopened = await createPersistentTaskStore(adapter);
    const fetched = await reopened.get(t.id);
    expect(fetched?.status).toBe("in-progress");
  });

  it("starts empty when adapter has no payload", async () => {
    const store = await createPersistentTaskStore(memoryAdapter(null));
    expect(await store.list()).toEqual([]);
  });

  it("ignores corrupt payload and starts empty", async () => {
    const store = await createPersistentTaskStore(memoryAdapter("not json {"));
    expect(await store.list()).toEqual([]);
    // can still create after corrupt-recovery
    const created = await store.create({ workspaceId: "ws", title: "T", goal: "g" });
    expect(created.id).toMatch(/^task_/);
  });
});
