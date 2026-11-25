import { describe, expect, it, vi } from "vitest";
import type { AgentStatusSnapshot } from "../../agent-status-registry";
import type { NlCommandContext } from "../../canvas-nl-command";
import {
  buildS2sCanvasRealtimeTools,
  executeS2sCanvasToolCall,
  S2S_CANVAS_TOOL_NAMES,
} from "../s2s-canvas-tool-executor";

function ctx(overrides: Partial<NlCommandContext> = {}): NlCommandContext {
  return {
    roster: [],
    nodeRefs: [],
    selectedNodeIds: [],
    ...overrides,
  };
}

describe("buildS2sCanvasRealtimeTools", () => {
  it("advertises the safe Canvas intent tools, including agent spawn and diagram drawing", () => {
    const tools = buildS2sCanvasRealtimeTools({
      nodeKinds: ["terminal", "note"],
      agentNames: ["Skye"],
      hasBrowserNodes: true,
      projectNames: ["Beta"],
    });
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([...S2S_CANVAS_TOOL_NAMES, "end_conversation"].sort());
    expect(names).toContain("spawn_agent");
    expect(names).toContain("draw_diagram");
    expect(names).toContain("close");
    expect(names).toContain("close_all");
  });

  it("advertises the Tier 1 parity intents when their preconditions are met", () => {
    const names = buildS2sCanvasRealtimeTools({
      nodeKinds: ["terminal", "note"],
      agentNames: ["Skye"],
      hasBrowserNodes: true,
      projectNames: ["Beta"],
    }).map((tool) => tool.name);

    for (const name of ["snapshot_browser", "run_task", "recover", "make_lead", "switch_project", "open_page", "new_project"]) {
      expect(names).toContain(name);
    }
  });

  it("never advertises close_project by voice (destructive)", () => {
    const names = buildS2sCanvasRealtimeTools({
      nodeKinds: ["terminal", "note"],
      agentNames: ["Skye"],
      hasBrowserNodes: true,
      projectNames: ["Beta"],
    }).map((tool) => tool.name);
    expect(names).not.toContain("close_project");
  });

  it("gates parity intents on their preconditions (agents, browser, projects)", () => {
    const bare = buildS2sCanvasRealtimeTools({ nodeKinds: ["terminal", "note"], agentNames: [] }).map((t) => t.name);
    expect(bare).not.toContain("make_lead"); // no agents
    expect(bare).not.toContain("snapshot_browser"); // no browser
    expect(bare).not.toContain("switch_project"); // no other projects
    // recover / open_page / new_project have no precondition and are always available.
    expect(bare).toContain("recover");
    expect(bare).toContain("open_page");
    expect(bare).toContain("new_project");
  });

  it("always advertises end_conversation; the session hook vetoes it unless the user signed off", () => {
    const idle = buildS2sCanvasRealtimeTools({ nodeKinds: ["terminal", "note"], agentNames: [] }).map((tool) => tool.name);
    expect(idle).toContain("end_conversation");

    const clarifying = buildS2sCanvasRealtimeTools({
      nodeKinds: ["terminal", "note"],
      agentNames: ["Bima"],
      hasPendingClarification: true,
    }).map((tool) => tool.name);
    expect(clarifying).toContain("end_conversation");
  });

  it("hides live-agent tools when no live agents exist and exposes choose_target only while clarifying", () => {
    const noAgents = buildS2sCanvasRealtimeTools({ nodeKinds: ["terminal", "note"], agentNames: [] }).map((tool) => tool.name);
    expect(noAgents).not.toContain("dispatch");
    expect(noAgents).not.toContain("say_to_agent");
    expect(noAgents).not.toContain("choose_target");

    const clarifying = buildS2sCanvasRealtimeTools({
      nodeKinds: ["terminal", "note"],
      agentNames: ["Bima"],
      hasPendingClarification: true,
    }).map((tool) => tool.name);
    expect(clarifying).toContain("dispatch");
    expect(clarifying).toContain("say_to_agent");
    expect(clarifying).toContain("choose_target");
  });

  it("hides navigate_browser until a browser node exists", () => {
    const withoutBrowser = buildS2sCanvasRealtimeTools({ nodeKinds: ["terminal", "note"], agentNames: ["Bima"] }).map((tool) => tool.name);
    expect(withoutBrowser).not.toContain("navigate_browser");

    const withBrowser = buildS2sCanvasRealtimeTools({
      nodeKinds: ["terminal", "note"],
      agentNames: ["Bima"],
      hasBrowserNodes: true,
    }).map((tool) => tool.name);
    expect(withBrowser).toContain("navigate_browser");
  });

  it("does not advertise profile-wrapper runners as live-voice spawn choices", () => {
    const spawn = buildS2sCanvasRealtimeTools({
      nodeKinds: ["terminal", "note"],
      agentNames: [],
    }).find((tool) => tool.name === "spawn_agent");
    const runner = (spawn?.parameters.properties as Record<string, { enum?: string[] }> | undefined)?.runner;

    expect(runner?.enum).toContain("claude");
    expect(runner?.enum).not.toContain("ccs");
    expect(runner?.enum).not.toContain("csp");
    expect(runner?.enum).not.toContain("CCS");
    expect(runner?.enum).not.toContain("CSP");
  });

  it("describes close tools as no-confirmation live-voice actions", () => {
    const tools = buildS2sCanvasRealtimeTools({ nodeKinds: ["terminal", "note"], agentNames: [] });
    const close = tools.find((tool) => tool.name === "close");
    const closeAll = tools.find((tool) => tool.name === "close_all");

    expect(close?.description).toContain("without confirmation");
    expect(closeAll?.description).toContain("without confirmation");
    expect(close?.description.toLowerCase()).not.toContain("confirmed first");
    expect(closeAll?.description.toLowerCase()).not.toContain("confirmed first");
  });

  it("advertises count and grouped items for intuitive multi-agent spawn requests", () => {
    const spawn = buildS2sCanvasRealtimeTools({ nodeKinds: ["terminal", "note"], agentNames: [] }).find((tool) => tool.name === "spawn_agent");
    const properties = spawn?.parameters.properties as Record<string, unknown> | undefined;

    expect(spawn?.description).toContain("multiple agents");
    expect(properties?.count).toMatchObject({ type: "integer", maximum: 50 });
    expect(properties?.items).toMatchObject({ type: "array" });
  });

  it("advertises dispatch with a short intent + key_constraints instead of a verbatim task field", () => {
    const dispatch = buildS2sCanvasRealtimeTools({ nodeKinds: ["terminal", "note"], agentNames: ["Skye"] }).find(
      (tool) => tool.name === "dispatch",
    );
    const properties = dispatch?.parameters.properties as Record<string, unknown> | undefined;

    expect(properties?.intent).toMatchObject({ type: "string" });
    expect(properties?.key_constraints).toMatchObject({ type: "array" });
    expect(properties?.task).toBeUndefined();
    expect(dispatch?.parameters.required).toEqual(["target", "intent"]);
    expect(dispatch?.description).toContain("app appends the user's verbatim request automatically");
  });
});

describe("executeS2sCanvasToolCall", () => {
  it("runs run_task through the Canvas command seam", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c1", name: "run_task", args: { target: "Ship login", mode: "team" } },
      ctx({ nodeRefs: [{ id: "task-1", kind: "task", name: "Ship login" }] }),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, speak: "Running Ship login with the team." });
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "dispatch-task", nodeId: "task-1", mode: "team" }));
  });

  it("runs switch_project through the app command seam", () => {
    const runApp = vi.fn(() => true);

    const result = executeS2sCanvasToolCall(
      { callId: "c1", name: "switch_project", args: { target: "Beta" } },
      ctx({ projects: [{ id: "p-beta", name: "Beta" }], activeProjectId: "p-alpha" }),
      { runCommand: vi.fn(), dispatch: vi.fn(), runApp },
    );

    expect(result).toMatchObject({ ok: true, speak: "Switch to Beta." });
    expect(runApp).toHaveBeenCalledWith(expect.objectContaining({ type: "switch-project", projectId: "p-beta" }));
  });

  it("runs spawn_agent through the Canvas command seam", () => {
    const runCommand = vi.fn(() => ({ nodeId: "agent-1" }));

    const result = executeS2sCanvasToolCall(
      { callId: "c1", name: "spawn_agent", args: { runner: "claude", brief: "review the PR" } },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: "Spawn a claude agent to: review the PR",
      speak: "I’m opening a Claude agent for that.",
      nodeId: "agent-1",
    });
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "create-agent", brief: "review the PR" }));
  });

  it("does not hand a new agent a brief that only restates the spawn request", () => {
    // The shipped bug: "spawn cloud code agent and codex agent" made the model split the utterance
    // and pass each fragment as that agent's first task, so both agents burned a real model turn
    // answering "cloud code agent". A spawn with no work in it must arrive with no brief.
    const runCommand = vi.fn(() => ({ nodeId: "agent-1" }));

    const result = executeS2sCanvasToolCall(
      { callId: "c1", name: "spawn_agent", args: { runner: "claude", brief: "cloud code agent" } },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(runCommand).toHaveBeenCalledWith(expect.not.objectContaining({ brief: expect.anything() }));
    // The spoken line branches on the brief, so a dropped one must also stop Lotus saying
    // "for that" when there is no "that".
    expect(result).toMatchObject({ speak: "I’m opening a Claude agent." });
  });

  it("still forwards a brief that carries real work", () => {
    const runCommand = vi.fn(() => ({ nodeId: "agent-1" }));

    executeS2sCanvasToolCall(
      { callId: "c1", name: "spawn_agent", args: { runner: "codex", brief: "fix the failing auth tests" } },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create-agent", brief: "fix the failing auth tests" }),
    );
  });

  it("normalizes a live-voice CCS misroute back to Claude for cloud-agent requests", () => {
    const runCommand = vi.fn(() => ({ nodeId: "agent-1" }));

    const result = executeS2sCanvasToolCall(
      { callId: "c1", name: "spawn_agent", args: { runner: "ccs" } },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: "Spawn a claude agent",
      speak: "I’m opening a Claude agent.",
    });
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-agent",
        definition: expect.objectContaining({ runner: "claude" }),
      }),
    );
  });

  it("spawns one runner count from live voice with aggregate feedback", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c-count-spawn", name: "spawn_agent", args: { runner: "claude", count: 2 } },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: "Spawning 2 Claude agents",
      speak: "I’m opening 2 Claude agents.",
    });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  it("supports live-voice batches beyond ten agents", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c-large-spawn", name: "spawn_agent", args: { runner: "codex", count: 12 } },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Spawning 12 Codex agents" });
    expect(runCommand).toHaveBeenCalledTimes(12);
  });

  it("rejects malformed live-voice counts instead of rounding or partially parsing them", () => {
    const exec = { runCommand: vi.fn(() => ({})), dispatch: vi.fn(), runApp: vi.fn(() => false) };

    expect(executeS2sCanvasToolCall(
      { callId: "c-fractional", name: "spawn_agent", args: { runner: "claude", count: 1.5 } },
      ctx(),
      exec,
    )).toMatchObject({ ok: false });
    expect(executeS2sCanvasToolCall(
      { callId: "c-malformed", name: "spawn_agent", args: { runner: "claude", count: "12 agents" } },
      ctx(),
      exec,
    )).toMatchObject({ ok: false });
    expect(exec.runCommand).not.toHaveBeenCalled();
  });

  it("spawns grouped multi-runner requests from one live-voice tool call with aggregate feedback", () => {
    const runCommand = vi.fn((command) => ({ nodeId: `node-${runCommand.mock.calls.length}-${command.kind}` }));

    const result = executeS2sCanvasToolCall(
      {
        callId: "c-multi-spawn",
        name: "spawn_agent",
        args: { items: [{ runner: "claude", count: 2 }, { runner: "codex", count: 3 }] },
      },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({
      ok: true,
      summary: "Spawning 2 Claude agents and 3 Codex agents",
      speak: "I’m opening 2 Claude agents and 3 Codex agents.",
    });
    expect(runCommand).toHaveBeenCalledTimes(5);
    expect(runCommand.mock.calls.slice(0, 2).map(([command]) => command.definition.runner)).toEqual(["claude", "claude"]);
    expect(runCommand.mock.calls.slice(2).map(([command]) => command.definition.runner)).toEqual(["codex", "codex", "codex"]);
  });

  it("runs draw_diagram through the Canvas command seam", () => {
    const runCommand = vi.fn(() => ({}));
    const graph = { nodes: [{ id: "start", label: "Start", kind: "terminator" }], edges: [] };

    const result = executeS2sCanvasToolCall(
      { callId: "c2", name: "draw_diagram", args: { topic: "login flow", graph } },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Draw a diagram of login flow", speak: "I’m drawing the login flow now." });
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({ kind: "draw-diagram", topic: "login flow" }));
  });

  it("dispatches to a live agent via the existing agent messaging seam", () => {
    const dispatch = vi.fn(() => ({ delivered: ["agent-1"], queued: [], skipped: [] }));
    const roster: AgentStatusSnapshot[] = [{ id: "agent-1", name: "Skye", status: "running" }];

    const result = executeS2sCanvasToolCall(
      { callId: "c3", name: "dispatch", args: { target: "Skye", task: "check auth" } },
      ctx({ roster }),
      { runCommand: vi.fn(), dispatch, runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Dispatch to Skye", speak: "I sent that to Skye." });
    expect(dispatch).toHaveBeenCalledWith("agent-1", "check auth");
  });

  it("falls back to intent as the task when a dispatch call arrives without task (safety net)", () => {
    const dispatch = vi.fn(() => ({ delivered: ["agent-1"], queued: [], skipped: [] }));
    const roster: AgentStatusSnapshot[] = [{ id: "agent-1", name: "Skye", status: "running" }];

    const result = executeS2sCanvasToolCall(
      { callId: "c-intent-fallback", name: "dispatch", args: { target: "Skye", intent: "check auth" } },
      ctx({ roster }),
      { runCommand: vi.fn(), dispatch, runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Dispatch to Skye" });
    expect(dispatch).toHaveBeenCalledWith("agent-1", "check auth");
  });

  it("focuses a Codex agent by runner alias, not only by node display name", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c3b", name: "focus", args: { target: "Codex" } },
      ctx({ nodeRefs: [{ id: "agent-codex", kind: "agent", name: "Nova", aliases: ["Codex", "Codex agent", "Kodeks"] }] }),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Focus Nova", speak: "Focused Nova, the Codex agent." });
    expect(runCommand).toHaveBeenCalledWith({ kind: "focus-node", nodeId: "agent-codex" });
  });

  it("closes a named agent immediately through live voice", () => {
    const runCommand = vi.fn(() => ({ nodeId: "agent-atlas" }));

    const result = executeS2sCanvasToolCall(
      { callId: "c-close", name: "close", args: { target: "Atlas" } },
      ctx({ nodeRefs: [{ id: "agent-atlas", kind: "agent", name: "Atlas" }] }),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Close Atlas", speak: "Closed Atlas." });
    expect(runCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "agent-atlas" });
  });

  it("closes browser and music nodes by visible name through live voice", () => {
    const runCommand = vi.fn(() => ({}));
    const nodeRefs = [
      { id: "browser-1", kind: "browser", name: "Browser 1" },
      { id: "music-1", kind: "music", name: "Music Player" },
    ];

    expect(
      executeS2sCanvasToolCall(
        { callId: "c-close-browser", name: "close", args: { target: "Browser 1" } },
        ctx({ nodeRefs }),
        { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
      ),
    ).toMatchObject({ ok: true, summary: "Close Browser 1", speak: "Closed Browser 1." });
    expect(
      executeS2sCanvasToolCall(
        { callId: "c-close-music", name: "close", args: { target: "Music Player" } },
        ctx({ nodeRefs }),
        { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
      ),
    ).toMatchObject({ ok: true, summary: "Close Music Player", speak: "Closed Music Player." });
    expect(runCommand).toHaveBeenNthCalledWith(1, { kind: "close-node", nodeId: "browser-1" });
    expect(runCommand).toHaveBeenNthCalledWith(2, { kind: "close-node", nodeId: "music-1" });
  });

  it("closes all browsers through live voice without confirmation", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c-close-all-browsers", name: "close", args: { target: { kind: "byType", nodeType: "browser", quantifier: "all" } } },
      ctx({
        nodeRefs: [
          { id: "browser-1", kind: "browser", name: "Browser 1" },
          { id: "browser-2", kind: "browser", name: "Browser 2" },
          { id: "agent-atlas", kind: "agent", name: "Atlas" },
        ],
      }),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Closing 2 browsers", speak: "Closed 2 browsers." });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenNthCalledWith(1, { kind: "close-node", nodeId: "browser-1" });
    expect(runCommand).toHaveBeenNthCalledWith(2, { kind: "close-node", nodeId: "browser-2" });
  });

  it("closes all agents through live voice without confirmation", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c-close-all-agents", name: "close", args: { target: { kind: "byType", nodeType: "agent", quantifier: "all" } } },
      ctx({
        nodeRefs: [
          { id: "agent-atlas", kind: "agent", name: "Atlas" },
          { id: "agent-nova", kind: "agent", name: "Nova" },
          { id: "browser-1", kind: "browser", name: "Browser 1" },
        ],
      }),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Closing 2 agents", speak: "Closed 2 agents." });
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenNthCalledWith(1, { kind: "close-node", nodeId: "agent-atlas" });
    expect(runCommand).toHaveBeenNthCalledWith(2, { kind: "close-node", nodeId: "agent-nova" });
  });

  it("asks a target clarification before closing an ambiguous node name", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c-close-ambiguous", name: "close", args: { target: "Atlas" } },
      ctx({
        nodeRefs: [
          { id: "agent-atlas", kind: "agent", name: "Atlas" },
          { id: "browser-atlas", kind: "browser", name: "Atlas Browser", aliases: ["Atlas"] },
        ],
      }),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({
      ok: false,
      speak: "Which Atlas — Atlas or Atlas Browser?",
      clarify: { ambiguousName: "Atlas" },
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("closes everything through live voice without confirmation", () => {
    const runCommand = vi.fn(() => ({}));

    const result = executeS2sCanvasToolCall(
      { callId: "c4", name: "close_all", args: {} },
      ctx(),
      { runCommand, dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Close everything", speak: "Closed everything." });
    expect(runCommand).toHaveBeenCalledWith({ kind: "close-all-nodes" });
  });

  it("rejects unsupported tools from realtime voice", () => {
    const result = executeS2sCanvasToolCall(
      { callId: "c4", name: "close_project", args: {} },
      ctx(),
      { runCommand: vi.fn(), dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );

    expect(result).toEqual({
      ok: false,
      error: 'Realtime voice tool "close_project" is not allowed.',
      speak: "I can’t run that by voice yet.",
    });
  });
});
