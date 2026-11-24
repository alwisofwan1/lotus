import { describe, it, expect } from "vitest";
import { createInMemoryAgentRunStore, MAX_RUNS_PER_AGENT } from "../agent-run-store";
import type { AgentRunRecord } from "../agent-run-record";

const rec = (id: string, agentId = "n1"): AgentRunRecord => ({
  id, agentId, kind: "run", outcome: "completed", startedAt: 0, endedAt: 1, sessionId: null, actions: [],
});

describe("in-memory agent run store", () => {
  it("lists a node's runs newest-first", async () => {
    const store = createInMemoryAgentRunStore();
    await store.append(rec("r1"));
    await store.append(rec("r2"));
    expect((await store.list("n1")).map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("scopes runs per node", async () => {
    const store = createInMemoryAgentRunStore();
    await store.append(rec("a", "n1"));
    await store.append(rec("b", "n2"));
    expect((await store.list("n1")).map((r) => r.id)).toEqual(["a"]);
  });

  it("retains only the most recent runs per node", async () => {
    const store = createInMemoryAgentRunStore();
    for (let i = 0; i < MAX_RUNS_PER_AGENT + 5; i += 1) await store.append(rec(`r${i}`));
    const list = await store.list("n1");
    expect(list).toHaveLength(MAX_RUNS_PER_AGENT);
    expect(list[0].id).toBe(`r${MAX_RUNS_PER_AGENT + 4}`); // newest kept
  });
});
