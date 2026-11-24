import { describe, it, expect } from "vitest";
import { createInMemoryGraphRunStore } from "../graph-run-store";
import { applyNodeCompletion, buildGraphRunRecord } from "../graph-run-record";

const graph = { nodeIds: ["a", "b"], deps: [{ from: "a", to: "b" }] };
const rec = (projectId: string, id: string, now: number) =>
  buildGraphRunRecord({ projectId, graph, now, id });

describe("createInMemoryGraphRunStore", () => {
  it("returns a created run by id", async () => {
    const store = createInMemoryGraphRunStore();
    await store.create(rec("p1", "g1", 1));
    expect((await store.get("g1"))?.id).toBe("g1");
    expect(await store.get("missing")).toBeNull();
  });

  it("lists a project's runs newest-first, scoped to that project", async () => {
    const store = createInMemoryGraphRunStore();
    await store.create(rec("p1", "g1", 1));
    await store.create(rec("p1", "g2", 2));
    await store.create(rec("p2", "g3", 3));
    const runs = await store.list("p1");
    expect(runs.map((r) => r.id)).toEqual(["g2", "g1"]);
  });

  it("update persists the checkpoint and derives a terminal status + endedAt", async () => {
    const store = createInMemoryGraphRunStore();
    await store.create(rec("p1", "g1", 1));
    let cp = applyNodeCompletion(initOf(), "a", { outcome: "completed", sessionId: "s", nodeRunId: "r1" });
    cp = applyNodeCompletion(cp, "b", { outcome: "completed", sessionId: null, nodeRunId: "r2" });
    await store.update("g1", cp, 5);
    const got = await store.get("g1");
    expect(got?.status).toBe("completed");
    expect(got?.endedAt).toBe(5);
    expect(got?.checkpoint.completed.a?.sessionId).toBe("s");
  });

  it("stays running (endedAt null) while nodes remain pending", async () => {
    const store = createInMemoryGraphRunStore();
    await store.create(rec("p1", "g1", 1));
    const cp = applyNodeCompletion(initOf(), "a", { outcome: "completed", sessionId: null, nodeRunId: "r1" });
    await store.update("g1", cp, 5);
    const got = await store.get("g1");
    expect(got?.status).toBe("running");
    expect(got?.endedAt).toBeNull();
  });

  it("finalize forces a terminal status with endedAt (cancellation)", async () => {
    const store = createInMemoryGraphRunStore();
    await store.create(rec("p1", "g1", 1));
    await store.finalize("g1", "cancelled", 9);
    const got = await store.get("g1");
    expect(got?.status).toBe("cancelled");
    expect(got?.endedAt).toBe(9);
  });

  it("pause marks the run paused and keeps it open: no endedAt", async () => {
    const store = createInMemoryGraphRunStore();
    await store.create(rec("p1", "g1", 1));
    await store.pause("g1", 9);
    const got = await store.get("g1");
    expect(got?.status).toBe("paused");
    expect(got?.endedAt).toBeNull();
    expect(got?.updatedAt).toBe(9);
  });
});

function initOf() {
  return buildGraphRunRecord({ projectId: "p1", graph, now: 1 }).checkpoint;
}
