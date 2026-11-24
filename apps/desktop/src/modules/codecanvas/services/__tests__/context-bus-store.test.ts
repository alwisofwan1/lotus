import { describe, expect, it } from "vitest";
import { createInMemoryContextBusStore, MAX_ARTIFACTS_PER_PROJECT } from "../context-bus-store";
import { buildArtifact, type ContextArtifact } from "../context-bus-record";

const art = (key: string, value: string, now: number, version = 1): ContextArtifact =>
  buildArtifact({ projectId: "p", busNodeId: "bus-1", key, value, producer: key, graphRunId: null, now, version });

describe("createInMemoryContextBusStore", () => {
  it("saves and lists artifacts for a project, newest first", async () => {
    const store = createInMemoryContextBusStore();
    await store.save(art("A", "x", 1));
    await store.save(art("B", "y", 2));
    const list = await store.list("p");
    expect(list.map((a) => a.key)).toEqual(["B", "A"]);
  });

  it("upserts on the same (project, bus, key) instead of duplicating", async () => {
    const store = createInMemoryContextBusStore();
    await store.save(art("A", "old", 1, 1));
    await store.save(art("A", "new", 2, 2));
    const list = await store.list("p");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ value: "new", version: 2 });
  });

  it("caps retention per project, evicting the oldest", async () => {
    const store = createInMemoryContextBusStore();
    for (let i = 0; i < MAX_ARTIFACTS_PER_PROJECT + 5; i++) {
      await store.save(art(`k${i}`, "v", i + 1));
    }
    const list = await store.list("p");
    expect(list).toHaveLength(MAX_ARTIFACTS_PER_PROJECT);
    expect(list.some((a) => a.key === "k0")).toBe(false); // oldest evicted
  });
});
