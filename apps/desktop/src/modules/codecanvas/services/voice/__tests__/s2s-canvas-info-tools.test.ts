import { describe, expect, it, vi } from "vitest";
import type { AgentStatusSnapshot } from "../../agent-status-registry";
import {
  buildS2sInfoTools,
  executeS2sInfoToolCall,
  isS2sInfoTool,
  S2S_INFO_TOOL_NAMES,
  type S2sInfoToolDeps,
} from "../s2s-canvas-info-tools";

function agent(name: string, status: AgentStatusSnapshot["status"], id = name.toLowerCase()): AgentStatusSnapshot {
  return { id, name, status };
}

function call(name: string, args: Record<string, unknown> = {}) {
  return { callId: "c1", name, args };
}

describe("buildS2sInfoTools", () => {
  it("advertises agent_status only when agents exist", () => {
    const withAgents = buildS2sInfoTools({ nodeKinds: [], agentNames: ["Rowan"] }).map((t) => t.name);
    expect(withAgents).toContain("agent_status");

    const noAgents = buildS2sInfoTools({ nodeKinds: [], agentNames: [] }).map((t) => t.name);
    expect(noAgents).not.toContain("agent_status");
  });

  it("advertises read_agent_output alongside agent_status when agents exist", () => {
    const withAgents = buildS2sInfoTools({ nodeKinds: [], agentNames: ["Rowan"] }).map((t) => t.name);
    expect(withAgents).toContain("read_agent_output");
    const noAgents = buildS2sInfoTools({ nodeKinds: [], agentNames: [] }).map((t) => t.name);
    expect(noAgents).not.toContain("read_agent_output");
  });

  it("advertises remember/recall only when project memory is available", () => {
    const withMemory = buildS2sInfoTools({ nodeKinds: [], agentNames: [], hasProjectMemory: true }).map((t) => t.name);
    expect(withMemory).toEqual(expect.arrayContaining(["remember", "recall"]));

    const noMemory = buildS2sInfoTools({ nodeKinds: [], agentNames: [] }).map((t) => t.name);
    expect(noMemory).not.toContain("remember");
    expect(noMemory).not.toContain("recall");
  });

  it("keeps the tool-name set and the isS2sInfoTool guard in sync", () => {
    for (const name of S2S_INFO_TOOL_NAMES) expect(isS2sInfoTool(name)).toBe(true);
    expect(isS2sInfoTool("spawn_agent")).toBe(false);
  });
});

describe("executeS2sInfoToolCall — agent_status", () => {
  const deps = (roster: AgentStatusSnapshot[]): S2sInfoToolDeps => ({ roster });

  it("summarizes every agent when no target is given", async () => {
    const result = await executeS2sInfoToolCall(
      call("agent_status"),
      deps([agent("Rowan", "running"), agent("Sage", "idle")]),
    );
    expect(result).toMatchObject({ ok: true, speak: "Rowan is working and Sage is idle." });
  });

  it("reports a single named agent with natural status phrasing", async () => {
    const result = await executeS2sInfoToolCall(
      call("agent_status", { target: "Rowan" }),
      deps([agent("Rowan", "stalled")]),
    );
    expect(result).toMatchObject({ ok: true, speak: "Rowan is stalled." });
  });

  it("fails gracefully for an unknown agent", async () => {
    const result = await executeS2sInfoToolCall(call("agent_status", { target: "Nobody" }), deps([agent("Rowan", "idle")]));
    expect(result.ok).toBe(false);
    expect(result.speak).toContain("Nobody");
  });

  it("handles an empty fleet", async () => {
    const result = await executeS2sInfoToolCall(call("agent_status"), deps([]));
    expect(result).toMatchObject({ ok: true, speak: "No agents are running right now." });
  });
});

describe("executeS2sInfoToolCall — read_agent_output", () => {
  const paneAgent = (name: string, hookPaneId: string): AgentStatusSnapshot => ({ id: name.toLowerCase(), name, status: "running", hookPaneId });

  it("returns the ANSI-stripped tail in summary with empty speak for the model to summarize", async () => {
    const raw = `[32mBuild passed[0m\r\n]0;titleAll 12 tests green.`;
    const readTranscript = vi.fn(() => raw);
    const result = await executeS2sInfoToolCall(call("read_agent_output", { target: "Rowan" }), {
      roster: [paneAgent("Rowan", "pane-rowan")],
      readTranscript,
    });

    expect(readTranscript).toHaveBeenCalledWith("pane-rowan");
    if (!result.ok) throw new Error(result.error);
    expect(result.speak).toBe("");
    expect(result.summary).toContain("Rowan output:");
    expect(result.summary).toContain("Build passed");
    expect(result.summary).toContain("All 12 tests green.");
    // control/ansi bytes are gone
    expect(result.summary).not.toContain("");
    expect(result.summary).not.toContain("title");
  });

  it("uses the only agent when no target is given", async () => {
    const readTranscript = vi.fn(() => "done");
    const result = await executeS2sInfoToolCall(call("read_agent_output"), {
      roster: [paneAgent("Solo", "pane-solo")],
      readTranscript,
    });
    expect(readTranscript).toHaveBeenCalledWith("pane-solo");
    expect(result.ok).toBe(true);
  });

  it("asks which agent when several run and none is named", async () => {
    const result = await executeS2sInfoToolCall(call("read_agent_output"), {
      roster: [paneAgent("A", "p-a"), paneAgent("B", "p-b")],
      readTranscript: vi.fn(() => "x"),
    });
    expect(result.ok).toBe(false);
    expect(result.speak?.toLowerCase()).toContain("which agent");
  });

  it("reports no-output when the transcript is empty", async () => {
    const result = await executeS2sInfoToolCall(call("read_agent_output", { target: "Rowan" }), {
      roster: [paneAgent("Rowan", "pane-rowan")],
      readTranscript: vi.fn(() => ""),
    });
    expect(result).toMatchObject({ ok: true, speak: "Rowan hasn't produced any output yet." });
  });

  it("fails gracefully when output reading is unavailable", async () => {
    const result = await executeS2sInfoToolCall(call("read_agent_output", { target: "Rowan" }), {
      roster: [paneAgent("Rowan", "pane-rowan")],
    });
    expect(result).toMatchObject({ ok: false, speak: "I can't read agent output here." });
  });
});

describe("executeS2sInfoToolCall — remember", () => {
  it("writes a durable note tagged from voice", async () => {
    const memoryWrite = vi.fn(async () => ({}) as never);
    const result = await executeS2sInfoToolCall(
      call("remember", { note: "We ship auth behind a flag", title: "Auth rollout" }),
      { roster: [], projectId: "p1", memoryWrite },
    );

    expect(result).toMatchObject({ ok: true, speak: "Got it — I'll remember that." });
    expect(memoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        kind: "note",
        body: "We ship auth behind a flag",
        title: "Auth rollout",
        source: "voice",
        actorKind: "human",
        tags: ["voice"],
      }),
    );
  });

  it("refuses when project memory is unavailable", async () => {
    const result = await executeS2sInfoToolCall(call("remember", { note: "x" }), { roster: [] });
    expect(result.ok).toBe(false);
    expect(result.speak).toBe("I can't save to memory here.");
  });

  it("asks what to remember when the note is empty", async () => {
    const result = await executeS2sInfoToolCall(call("remember", { note: "  " }), { roster: [], projectId: "p1", memoryWrite: vi.fn() });
    expect(result).toMatchObject({ ok: false, speak: "What should I remember?" });
  });

  it("reports a write failure without throwing", async () => {
    const memoryWrite = vi.fn(async () => {
      throw new Error("disk full");
    });
    const result = await executeS2sInfoToolCall(call("remember", { note: "x" }), { roster: [], projectId: "p1", memoryWrite });
    expect(result).toMatchObject({ ok: false, error: "disk full", speak: "I couldn't save that to memory." });
  });
});

describe("executeS2sInfoToolCall — recall", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    item: { id: "m1", projectId: "p1", scopeKind: "project", kind: "note", body: "body text", importance: 3, tags: [], metadata: null, source: "voice", actorKind: "human", createdAt: 0, updatedAt: 0, ...over },
    rank: 1,
  });

  it("speaks a concise summary of the top hits", async () => {
    const memorySearch = vi.fn(async () => [item({ title: "Auth rollout" }), item({ id: "m2", title: "DB migration" })]);
    const result = await executeS2sInfoToolCall(call("recall", { query: "auth" }), { roster: [], projectId: "p1", memorySearch });

    expect(result).toMatchObject({ ok: true, speak: "I found 2 — Auth rollout and DB migration." });
    expect(memorySearch).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p1", query: "auth", limit: 3 }));
  });

  it("says so when nothing matches", async () => {
    const memorySearch = vi.fn(async () => []);
    const result = await executeS2sInfoToolCall(call("recall", { query: "auth" }), { roster: [], projectId: "p1", memorySearch });
    expect(result).toMatchObject({ ok: true, speak: "I didn't find anything about auth." });
  });

  it("refuses when project memory is unavailable", async () => {
    const result = await executeS2sInfoToolCall(call("recall", { query: "auth" }), { roster: [] });
    expect(result).toMatchObject({ ok: false, speak: "I can't search memory here." });
  });
});
