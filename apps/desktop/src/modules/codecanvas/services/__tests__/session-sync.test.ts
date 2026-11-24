import { describe, expect, it } from "vitest";
import { createInMemoryCanvasSessionStore } from "../session-store";
import { recordCapturedSession } from "../session-sync";
import { buildSessionRecord } from "../session-record";

const base = {
  projectId: "cp_1",
  nodeId: "agent-1",
  runner: "claude",
  cwd: "/tmp/demo",
  agentName: "Rowan",
  now: 1_000,
};

describe("recordCapturedSession", () => {
  it("records a captured id as a live session for the node", async () => {
    const store = createInMemoryCanvasSessionStore();
    const outcome = await recordCapturedSession({ ...base, store, providerSessionId: "prov-1" });

    expect(outcome.kind).toBe("recorded");
    const rows = await store.list("cp_1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeId: "agent-1",
      providerSessionId: "prov-1",
      runner: "claude",
      cwd: "/tmp/demo",
      status: "live",
      origin: "manual",
    });
  });

  // A node rebuilt from the row must run on the same account (portable-accounts issues/07).
  it("keeps the Claude account the node ran as", async () => {
    const store = createInMemoryCanvasSessionStore();
    await recordCapturedSession({ ...base, store, providerSessionId: "prov-1", account: "initech" });
    expect((await store.list("cp_1"))[0]?.account).toBe("initech");
  });

  // The capture effect is one-shot per mount, but a remount re-runs it. Writing a second row for
  // the same conversation would show one conversation twice in the list.
  it("is idempotent for the same id", async () => {
    const store = createInMemoryCanvasSessionStore();
    await recordCapturedSession({ ...base, store, providerSessionId: "prov-1" });
    const second = await recordCapturedSession({ ...base, store, providerSessionId: "prov-1" });

    expect(second.kind).toBe("unchanged");
    expect(await store.list("cp_1")).toHaveLength(1);
  });

  // Two agents launched in the same cwd can diff up the same fresh transcript. The second node must
  // be told the id belongs to someone else rather than filing the conversation under both.
  it("refuses an id already owned by another node", async () => {
    const store = createInMemoryCanvasSessionStore();
    await recordCapturedSession({ ...base, store, providerSessionId: "shared" });

    const rival = await recordCapturedSession({
      ...base,
      store,
      nodeId: "agent-2",
      providerSessionId: "shared",
    });

    expect(rival).toEqual({ kind: "claimed-elsewhere", providerSessionId: "shared" });
    expect(await store.list("cp_1")).toHaveLength(1);
  });

  it("surfaces a store-level claim rejection as claimed-elsewhere, not a crash", async () => {
    const store = createInMemoryCanvasSessionStore();
    // A row the read path cannot see (another window wrote it between our list and upsert).
    const hidden = { ...store, list: async () => [] } as typeof store;
    await store.upsert(
      buildSessionRecord({ projectId: "cp_1", nodeId: "other", cwd: "/tmp/demo", now: 1 }),
    );
    await store.upsert({
      ...buildSessionRecord({ projectId: "cp_1", nodeId: "other", cwd: "/tmp/demo", now: 2 }),
      providerSessionId: "shared",
    });

    const outcome = await recordCapturedSession({
      ...base,
      store: hidden,
      providerSessionId: "shared",
    });
    expect(outcome.kind).toBe("claimed-elsewhere");
  });

  // `onPersistSession(id, "")` is how LiveAgentNode already clears a dead resume id.
  it("marks the node's session dead when the resume id is cleared", async () => {
    const store = createInMemoryCanvasSessionStore();
    await recordCapturedSession({ ...base, store, providerSessionId: "prov-1" });

    const cleared = await recordCapturedSession({ ...base, store, providerSessionId: "" });

    expect(cleared.kind).toBe("marked-dead");
    const rows = await store.list("cp_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("dead");
    expect(rows[0].providerSessionId).toBe("prov-1");
  });

  it("does nothing when a clear arrives for a node that never had a session", async () => {
    const store = createInMemoryCanvasSessionStore();
    const outcome = await recordCapturedSession({ ...base, store, providerSessionId: "" });
    expect(outcome).toEqual({ kind: "noop" });
    expect(await store.list("cp_1")).toHaveLength(0);
  });

  it("does nothing without a project", async () => {
    const store = createInMemoryCanvasSessionStore();
    const outcome = await recordCapturedSession({
      ...base,
      store,
      projectId: "",
      providerSessionId: "prov-1",
    });
    expect(outcome).toEqual({ kind: "noop" });
  });

  it("keeps a node's earlier session and adds the new one", async () => {
    const store = createInMemoryCanvasSessionStore();
    await recordCapturedSession({ ...base, store, providerSessionId: "prov-1" });
    await recordCapturedSession({ ...base, store, providerSessionId: "prov-2", now: 2_000 });

    const rows = await store.list("cp_1");
    expect(rows.map((r) => r.providerSessionId)).toEqual(["prov-2", "prov-1"]);
  });

  it("carries the worktree path so a resume knows where to land", async () => {
    const store = createInMemoryCanvasSessionStore();
    await recordCapturedSession({
      ...base,
      store,
      providerSessionId: "prov-1",
      worktreePath: "/tmp/wt/feat",
    });
    expect((await store.list("cp_1"))[0].worktreePath).toBe("/tmp/wt/feat");
  });
});

describe("canvas session store", () => {
  it("lists newest activity first, scoped to one project", async () => {
    const store = createInMemoryCanvasSessionStore();
    await store.upsert({
      ...buildSessionRecord({ projectId: "cp_1", nodeId: "a", cwd: "/x", now: 10 }),
      id: "old",
    });
    await store.upsert({
      ...buildSessionRecord({ projectId: "cp_1", nodeId: "b", cwd: "/x", now: 99 }),
      id: "new",
    });
    await store.upsert({
      ...buildSessionRecord({ projectId: "cp_2", nodeId: "c", cwd: "/x", now: 50 }),
      id: "other",
    });

    expect((await store.list("cp_1")).map((s) => s.id)).toEqual(["new", "old"]);
    expect((await store.list("cp_2")).map((s) => s.id)).toEqual(["other"]);
  });

  it("rejects a provider id already claimed in the same project, but allows it in another", async () => {
    const store = createInMemoryCanvasSessionStore();
    const first = {
      ...buildSessionRecord({ projectId: "cp_1", nodeId: "a", cwd: "/x", now: 1 }),
      providerSessionId: "shared",
    };
    await store.upsert(first);

    await expect(
      store.upsert({
        ...buildSessionRecord({ projectId: "cp_1", nodeId: "b", cwd: "/x", now: 2 }),
        providerSessionId: "shared",
      }),
    ).rejects.toThrow(/already claimed/);

    await expect(
      store.upsert({
        ...buildSessionRecord({ projectId: "cp_2", nodeId: "c", cwd: "/x", now: 3 }),
        providerSessionId: "shared",
      }),
    ).resolves.toBeUndefined();
  });

  it("lets a session update itself without tripping its own claim", async () => {
    const store = createInMemoryCanvasSessionStore();
    const row = {
      ...buildSessionRecord({ projectId: "cp_1", nodeId: "a", cwd: "/x", now: 1 }),
      providerSessionId: "shared",
    };
    await store.upsert(row);
    await expect(store.upsert({ ...row, turnCount: 9 })).resolves.toBeUndefined();
    expect((await store.list("cp_1"))[0].turnCount).toBe(9);
  });
});
