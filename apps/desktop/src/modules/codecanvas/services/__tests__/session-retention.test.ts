import { describe, expect, it } from "vitest";
import type { CanvasSessionRecord } from "../session-record";
import {
  EMPTY_SESSION_TTL_MS,
  MAX_SESSIONS_PER_NODE,
  planSessionRetention,
} from "../session-retention";
import { createInMemoryCanvasSessionStore } from "../session-store";
import {
  applyNodeRetention,
  attachSessionToNode,
  createNodeSession,
  detachNodeSessions,
  listNodeSessions,
  renameNodeSession,
  setNodeSessionPinned,
} from "../session-mutations";

const NOW = 1_700_000_000_000;

function session(overrides: Partial<CanvasSessionRecord> & { id: string }): CanvasSessionRecord {
  return {
    projectId: "cp_1",
    nodeId: "agent-1",
    runner: "claude",
    cwd: "/repos/demo",
    title: `Session ${overrides.id}`,
    status: "resumable",
    origin: "manual",
    turnCount: 5,
    lastActivityAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

/** `n` sessions, oldest activity first, so cap tests read in an obvious order. */
function ladder(count: number): CanvasSessionRecord[] {
  return Array.from({ length: count }, (_, i) =>
    session({ id: `s${i}`, lastActivityAt: NOW - (count - i) * 60_000 }),
  );
}

describe("planSessionRetention", () => {
  it("keeps everything while under the cap", () => {
    const plan = planSessionRetention(ladder(3), { now: NOW });
    expect(plan.keep).toHaveLength(3);
    expect(plan.drop).toEqual([]);
  });

  it("keeps the most recently active up to the cap", () => {
    const plan = planSessionRetention(ladder(MAX_SESSIONS_PER_NODE + 3), { now: NOW });
    expect(plan.keep).toHaveLength(MAX_SESSIONS_PER_NODE);
    expect(plan.drop).toHaveLength(3);
    // The three dropped are the three least recently active.
    expect(plan.drop.map((d) => d.session.id)).toEqual(["s2", "s1", "s0"]);
    expect(plan.drop.every((d) => d.reason === "over-cap")).toBe(true);
  });

  // The rule every other rule yields to.
  it("never drops a pinned session, even far past the cap", () => {
    const sessions = [
      session({ id: "pinned", pinned: true, lastActivityAt: NOW - 999_999_999 }),
      ...ladder(MAX_SESSIONS_PER_NODE + 5),
    ];
    const plan = planSessionRetention(sessions, { now: NOW });
    expect(plan.keep.some((s) => s.id === "pinned")).toBe(true);
    expect(plan.drop.some((d) => d.session.id === "pinned")).toBe(false);
  });

  it("never drops the session the node is currently in", () => {
    const sessions = [
      session({ id: "active", lastActivityAt: NOW - 999_999_999, turnCount: 0, createdAt: 0 }),
      ...ladder(MAX_SESSIONS_PER_NODE + 2),
    ];
    const plan = planSessionRetention(sessions, { now: NOW, activeSessionId: "active" });
    expect(plan.keep.some((s) => s.id === "active")).toBe(true);
  });

  // A "New session" click nobody used. Waiting for the cap would evict real work meanwhile.
  it("drops an empty session once it is a day old", () => {
    const fresh = session({ id: "fresh", turnCount: 0, createdAt: NOW - 60_000 });
    const stale = session({ id: "stale", turnCount: 0, createdAt: NOW - EMPTY_SESSION_TTL_MS - 1 });
    const plan = planSessionRetention([fresh, stale], { now: NOW });

    expect(plan.keep.map((s) => s.id)).toEqual(["fresh"]);
    expect(plan.drop).toEqual([{ session: stale, reason: "empty" }]);
  });

  it("keeps an old empty session that someone pinned", () => {
    const pinnedEmpty = session({
      id: "kept",
      turnCount: 0,
      pinned: true,
      createdAt: NOW - EMPTY_SESSION_TTL_MS - 1,
    });
    const plan = planSessionRetention([pinnedEmpty], { now: NOW });
    expect(plan.drop).toEqual([]);
  });

  // Nine sessions, two pinned: the cap counts the pinned ones, because the popover has one length.
  it("counts pinned sessions against the cap rather than beside it", () => {
    const sessions = [
      session({ id: "p1", pinned: true, lastActivityAt: NOW - 900_000 }),
      session({ id: "p2", pinned: true, lastActivityAt: NOW - 800_000 }),
      ...ladder(7),
    ];
    const plan = planSessionRetention(sessions, { now: NOW });
    expect(plan.keep).toHaveLength(MAX_SESSIONS_PER_NODE);
    expect(plan.keep.filter((s) => s.pinned)).toHaveLength(2);
    expect(plan.drop).toHaveLength(1);
  });

  it("returns what it keeps in newest-first order", () => {
    const plan = planSessionRetention(ladder(4), { now: NOW });
    const times = plan.keep.map((s) => s.lastActivityAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("node session mutations", () => {
  it("creates an empty session that is still waiting for its CLI id", async () => {
    const store = createInMemoryCanvasSessionStore();
    const created = await createNodeSession({
      store,
      projectId: "cp_1",
      nodeId: "agent-1",
      cwd: "/repos/demo",
      agentName: "Rowan",
      now: NOW,
    });

    expect(created.providerSessionId).toBeNull();
    expect(created.turnCount).toBe(0);
    expect(created.title).toContain("Rowan");
    expect(await listNodeSessions(store, "cp_1", "agent-1")).toHaveLength(1);
  });

  it("keeps each node's sessions to itself", async () => {
    const store = createInMemoryCanvasSessionStore();
    await createNodeSession({ store, projectId: "cp_1", nodeId: "agent-1", cwd: "/x", now: NOW });
    await createNodeSession({ store, projectId: "cp_1", nodeId: "agent-2", cwd: "/x", now: NOW });

    expect(await listNodeSessions(store, "cp_1", "agent-1")).toHaveLength(1);
    expect(await listNodeSessions(store, "cp_1", "agent-2")).toHaveLength(1);
  });

  it("marks a renamed title as a human's choice", async () => {
    const store = createInMemoryCanvasSessionStore();
    const created = await createNodeSession({
      store,
      projectId: "cp_1",
      nodeId: "agent-1",
      cwd: "/x",
      now: NOW,
    });

    const renamed = await renameNodeSession(store, created, "  Refactor auth  ");
    expect(renamed?.title).toBe("Refactor auth");
    expect(renamed?.titleSource).toBe("manual");
  });

  it("ignores a rename that changes nothing", async () => {
    const store = createInMemoryCanvasSessionStore();
    const created = await createNodeSession({
      store,
      projectId: "cp_1",
      nodeId: "agent-1",
      cwd: "/x",
      now: NOW,
    });
    expect(await renameNodeSession(store, created, "   ")).toBeNull();
    expect(await renameNodeSession(store, created, created.title)).toBeNull();
  });

  it("pins and unpins", async () => {
    const store = createInMemoryCanvasSessionStore();
    const created = await createNodeSession({
      store,
      projectId: "cp_1",
      nodeId: "agent-1",
      cwd: "/x",
      now: NOW,
    });

    expect((await setNodeSessionPinned(store, created, true)).pinned).toBe(true);
    expect((await setNodeSessionPinned(store, created, false)).pinned).toBe(false);
  });

  it("trims a node past the cap and reports what it removed", async () => {
    const store = createInMemoryCanvasSessionStore();
    for (const row of ladder(MAX_SESSIONS_PER_NODE + 2)) await store.upsert(row);

    const dropped = await applyNodeRetention({
      store,
      projectId: "cp_1",
      nodeId: "agent-1",
      now: NOW,
    });

    expect(dropped).toHaveLength(2);
    expect(await listNodeSessions(store, "cp_1", "agent-1")).toHaveLength(MAX_SESSIONS_PER_NODE);
  });

  it("leaves another node's sessions alone when trimming", async () => {
    const store = createInMemoryCanvasSessionStore();
    for (const row of ladder(MAX_SESSIONS_PER_NODE + 2)) await store.upsert(row);
    await store.upsert(session({ id: "other", nodeId: "agent-2", lastActivityAt: 1 }));

    await applyNodeRetention({ store, projectId: "cp_1", nodeId: "agent-1", now: NOW });

    expect(await listNodeSessions(store, "cp_1", "agent-2")).toHaveLength(1);
  });

  // Tidying a board must never feel like throwing work away.
  it("keeps a node's conversations when the node itself is deleted", async () => {
    const store = createInMemoryCanvasSessionStore();
    await store.upsert(session({ id: "a", status: "live" }));
    await store.upsert(session({ id: "b" }));
    await store.upsert(session({ id: "other", nodeId: "agent-2" }));

    const detached = await detachNodeSessions(store, "cp_1", "agent-1");

    expect(detached).toBe(2);
    const rows = await store.list("cp_1");
    expect(rows.filter((r) => r.nodeId === null)).toHaveLength(2);
    // A detached conversation has no process by definition, so `live` would be a lie.
    expect(rows.filter((r) => r.status === "live")).toHaveLength(0);
    // Another node's sessions are untouched.
    expect(rows.find((r) => r.id === "other")?.nodeId).toBe("agent-2");
  });

  it("binds a detached conversation to a new node", async () => {
    const store = createInMemoryCanvasSessionStore();
    const orphan = session({ id: "a", nodeId: null });
    await store.upsert(orphan);

    const attached = await attachSessionToNode(store, orphan, "agent-9", NOW + 5);

    expect(attached.nodeId).toBe("agent-9");
    expect((await listNodeSessions(store, "cp_1", "agent-9")).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("provenance in retention (Slice 10)", () => {
  // A run's agents are execution artefacts; a conversation someone had outranks them even if the
  // run happened more recently.
  it("trims a graph run's sessions before a manual one", () => {
    const manual = Array.from({ length: MAX_SESSIONS_PER_NODE }, (_, i) =>
      session({ id: `m${i}`, lastActivityAt: NOW - 100_000 - i }),
    );
    const fromRun = session({ id: "run", origin: "graph-run", lastActivityAt: NOW });

    const plan = planSessionRetention([...manual, fromRun], { now: NOW });

    expect(plan.drop.map((d) => d.session.id)).toEqual(["run"]);
    expect(plan.keep).toHaveLength(MAX_SESSIONS_PER_NODE);
  });

  it("still protects a pinned session that came from a run", () => {
    const manual = Array.from({ length: MAX_SESSIONS_PER_NODE }, (_, i) =>
      session({ id: `m${i}`, lastActivityAt: NOW - i }),
    );
    const pinnedRun = session({ id: "run", origin: "graph-run", pinned: true, lastActivityAt: 1 });

    const plan = planSessionRetention([...manual, pinnedRun], { now: NOW });
    expect(plan.keep.some((s) => s.id === "run")).toBe(true);
  });
});
