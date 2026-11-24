import { describe, expect, it, vi } from "vitest";
import { runNlCommand, executeNlEffect, bindBatchNodeIds } from "../canvas-nl-runner";
import { batchNodeId } from "../canvas-nl-command";
import { EMPTY_DIALOGUE_STATE, recordNlTurn } from "../canvas-nl-dialogue-state";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const roster: AgentStatusSnapshot[] = [{ id: "a-skye", name: "Skye", status: "running" }];
const nodeRefs = [{ id: "a-skye", kind: "agent", name: "Skye" }];
const deps = (callModel: (p: string) => Promise<string>) => ({ callModel, roster, nodeRefs, nodeKinds: ["terminal", "note"] as const });

describe("runNlCommand", () => {
  it("runs the full pipeline for a non-fast-path request: prompt the model, parse, resolve", async () => {
    // "set up a terminal for me" isn't a recognized fast-path verb, so it goes to the LLM planner.
    const callModel = vi.fn(async (prompt: string) => {
      void prompt;
      return '{"action":"create_node","nodeType":"terminal"}';
    });
    const result = await runNlCommand("set up a terminal for me", deps(callModel));
    expect(callModel).toHaveBeenCalledOnce();
    expect(callModel.mock.calls[0][0]).toContain("set up a terminal for me"); // the built prompt carries the request
    expect(result).toMatchObject([{ effect: { kind: "command", command: { kind: "create-node", nodeType: "terminal" } }, destructive: false }]);
  });

  it("dispatches explicitly targeted repository work to the coding agent without the utility planner", async () => {
    const callModel = vi.fn(async () => { throw new Error("planner must not run"); });

    const result = await runNlCommand("tell Skye to analyze this repository", deps(callModel));

    expect(callModel).not.toHaveBeenCalled();
    expect(result).toMatchObject([{
      effect: { kind: "dispatch", agentId: "a-skye", text: "analyze this repository" },
    }]);
  });

  it("refuses repository analysis locally because the utility planner cannot inspect files", async () => {
    const callModel = vi.fn(async () => '{"outcome":"answer","intents":null,"answer":"Invented project summary","error":null}');

    const result = await runNlCommand("Tolong analisis dan jelaskan proyek ini secara singkat", deps(callModel));

    expect(callModel).not.toHaveBeenCalled();
    expect(result).toEqual({ error: "Select a coding agent so it can inspect the repository." });
  });

  it("passes a structured-output schema alongside the prompt so the reply can be grammar-enforced", async () => {
    const callModel = vi.fn(async (prompt: string, schemaArg?: Record<string, unknown>) => {
      void prompt;
      void schemaArg;
      return '{"action":"create_node","nodeType":"terminal"}';
    });
    await runNlCommand("set up a terminal for me", deps(callModel));
    const schema = callModel.mock.calls[0][1] as Record<string, unknown> | undefined;
    expect(schema).toBeDefined();
    // One strict root object carries an explicit outcome and nullable payload fields.
    expect((schema as { properties?: Record<string, unknown> }).properties).toHaveProperty("outcome");
    expect((schema as { properties?: Record<string, unknown> }).properties).toHaveProperty("intents");
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["outcome", "intents", "answer", "error"],
    });
  });

  it("resolves common commands locally WITHOUT calling the model (0-token fast path)", async () => {
    const callModel = vi.fn(async () => { throw new Error("model should not be called for fast-path commands"); });
    expect(await runNlCommand("arrange the canvas", deps(callModel))).toMatchObject([
      { effect: { kind: "command", command: { kind: "arrange-layout" } } },
    ]);
    expect(await runNlCommand("focus Skye", deps(callModel))).toMatchObject([
      { effect: { kind: "command", command: { kind: "focus-node", nodeId: "a-skye" } } },
    ]);
    expect(await runNlCommand("create a terminal", deps(callModel))).toMatchObject([
      { effect: { kind: "command", command: { kind: "create-node", nodeType: "terminal" } } },
    ]);
    expect(callModel).not.toHaveBeenCalled();
  });

  it("navigates the selected browser from an Indonesian voice-style command without calling the model", async () => {
    const callModel = vi.fn(async () => { throw new Error("browser fast path must not call the model"); });
    const result = await runNlCommand("Tolong fokus ke browser dan navigasi ke YouTube", {
      ...deps(callModel),
      nodeRefs: [
        ...nodeRefs,
        { id: "browser-1", kind: "browser", name: "Browser 1" },
        { id: "browser-2", kind: "browser", name: "Browser 2" },
      ],
      selectedNodeIds: ["browser-1"],
    });
    expect(callModel).not.toHaveBeenCalled();
    expect(result).toMatchObject([
      { effect: { kind: "command", command: { kind: "navigate-browser-node", nodeId: "browser-1", url: "https://www.youtube.com/" } } },
    ]);
  });

  it("switches project by name end-to-end via the fast path (0 LLM), resolving against the open projects", async () => {
    const callModel = vi.fn(async () => { throw new Error("project switch fast path must not call the model"); });
    const projects = [{ id: "cp_alpha", name: "Alpha" }, { id: "cp_beta", name: "Beta" }];
    const result = await runNlCommand("switch to project Beta", { ...deps(callModel), projects, activeProjectId: "cp_alpha" });
    expect(callModel).not.toHaveBeenCalled();
    expect(result).toMatchObject([{ effect: { kind: "app", command: { type: "switch-project", projectId: "cp_beta" } } }]);
  });

  it("goes back to the previous project via a back-reference (0 LLM), using the pre-computed previous id", async () => {
    const callModel = vi.fn(async () => { throw new Error("previous-project fast path must not call the model"); });
    const projects = [{ id: "cp_alpha", name: "Alpha" }, { id: "cp_beta", name: "Beta" }];
    const result = await runNlCommand("balik ke proyek sebelumnya", {
      ...deps(callModel), projects, activeProjectId: "cp_beta", previousProjectId: "cp_alpha",
    });
    expect(callModel).not.toHaveBeenCalled();
    expect(result).toMatchObject([{ effect: { kind: "app", command: { type: "switch-project", projectId: "cp_alpha" } } }]);
  });

  it("grounds the planner with the open project names so a spoken switch resolves", async () => {
    const projects = [{ id: "cp_alpha", name: "Alpha" }, { id: "cp_lotus", name: "lotus-app" }];
    const callModel = vi.fn(async (prompt: string) => {
      expect(prompt).toContain("lotus-app"); // project names surfaced in the switch_project enum
      return '{"action":"switch_project","target":"lotus-app"}';
    });
    // "take me over to the lotus one" isn't a fast-path phrasing → the planner handles it.
    const result = await runNlCommand("take me over to the lotus one", { ...deps(callModel), projects, activeProjectId: "cp_alpha" });
    expect(result).toMatchObject([{ effect: { kind: "app", command: { type: "switch-project", projectId: "cp_lotus" } } }]);
  });

  it("resolves a spoken alias ('cloud agent') to claude instead of failing", async () => {
    const callModel = vi.fn(async () => '{"action":"spawn_agent","runner":"cloud agent"}');
    const result = await runNlCommand("spin up a cloud agent", deps(callModel));
    expect(result).toMatchObject([
      { effect: { kind: "command", command: { kind: "create-agent", definition: { runner: "claude" } } } },
    ]);
  });

  it("fast-paths cloud agent to Claude", async () => {
    const callModel = vi.fn(async () => { throw new Error("cloud alias should resolve before the planner"); });
    const result = await runNlCommand("open cloud agent", deps(callModel));
    expect(callModel).not.toHaveBeenCalled();
    expect(result).toMatchObject([
      { effect: { kind: "command", command: { kind: "create-agent", definition: { runner: "claude" } } } },
    ]);
  });

  it("falls back to the model for compound / unrecognized requests", async () => {
    const callModel = vi.fn(async () => '{"action":"arrange"}');
    await runNlCommand("tidy up and focus Skye", deps(callModel)); // compound → LLM
    await runNlCommand("do something clever", deps(callModel)); // unrecognized → LLM
    expect(callModel).toHaveBeenCalledTimes(2);
  });

  it("resolves a single-action request to a 1-element batch", async () => {
    const result = await runNlCommand("add a terminal", deps(async () => '{"action":"create_node","nodeType":"terminal"}'));
    expect(Array.isArray(result)).toBe(true);
    if (Array.isArray(result)) expect(result).toHaveLength(1);
  });

  it("resolves a compound request into ordered resolutions", async () => {
    const result = await runNlCommand(
      "add a terminal and a note",
      deps(async () => '[{"action":"create_node","nodeType":"terminal"},{"action":"create_node","nodeType":"note"}]'),
    );
    expect(result).toMatchObject([
      { effect: { command: { kind: "create-node", nodeType: "terminal" } } },
      { effect: { command: { kind: "create-node", nodeType: "note" } } },
    ]);
  });

  it("spawns every requested agent when planner fallback emits a counted spawn", async () => {
    const callModel = vi.fn(async () => JSON.stringify({
      outcome: "intents",
      intents: [{ action: "spawn_agent", runner: "claude", count: 3, brief: "review auth" }],
      answer: null,
      error: null,
    }));

    // Polite/free-form wording intentionally misses the narrow regex fast path and exercises the
    // strict NL planner contract that previously collapsed this request to one agent.
    const result = await runNlCommand("tolong siapkan tiga agen Claude untuk mengulas modul auth", deps(callModel));

    expect(callModel).toHaveBeenCalledOnce();
    expect(result).toHaveLength(3);
    expect(result).toMatchObject(Array.from({ length: 3 }, () => ({
      effect: {
        kind: "command",
        command: {
          kind: "create-agent",
          definition: { runner: "claude" },
          brief: "review auth",
        },
      },
    })));
  });

  it("fails the whole batch when one intent in a compound request can't resolve", async () => {
    const result = await runNlCommand(
      "focus Skye and focus Ghost",
      deps(async () => '[{"action":"focus","target":"Skye"},{"action":"focus","target":"Ghost"}]'),
    );
    expect(result).toMatchObject({ error: expect.stringContaining("Ghost") });
  });

  it("resolves a dispatch to a named live agent", async () => {
    const result = await runNlCommand("tell Skye to investigate", deps(async () => '{"action":"dispatch","target":"Skye","task":"investigate"}'));
    expect(result).toMatchObject([{ effect: { kind: "dispatch", agentId: "a-skye", text: "investigate" } }]);
  });

  it("surfaces a parse error without resolving", async () => {
    const result = await runNlCommand("do something weird", deps(async () => "I can't do that"));
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it("surfaces a name-resolution error from a valid intent", async () => {
    const result = await runNlCommand("focus Ghost", deps(async () => '{"action":"focus","target":"Ghost"}'));
    expect(result).toMatchObject({ error: expect.stringContaining("Ghost") });
  });

  it("returns an error if the model call throws", async () => {
    const result = await runNlCommand("x", deps(async () => { throw new Error("offline"); }));
    expect(result).toMatchObject({ error: expect.stringContaining("offline") });
  });

  it("resolves anaphoric 'tutup mereka' from dialogue state via the fast path (0 LLM)", async () => {
    const callModel = vi.fn(async () => { throw new Error("anaphora must resolve locally"); });
    const state = recordNlTurn(EMPTY_DIALOGUE_STATE, {
      utterance: "buka browser",
      actions: ["open_browser"],
      resolvedNodeIds: ["browser-9"],
      outcome: "ok",
    });
    const result = await runNlCommand("tutup mereka", {
      ...deps(callModel),
      nodeRefs: [...nodeRefs, { id: "browser-9", kind: "browser", name: "Browser 9" }],
      dialogueState: state,
    });
    expect(callModel).not.toHaveBeenCalled();
    expect(result).toMatchObject([{ effect: { kind: "command", command: { kind: "close-node", nodeId: "browser-9" } } }]);
  });

  it("threads recent commands into the planner prompt so anaphora is grounded", async () => {
    let seenPrompt = "";
    const callModel = vi.fn(async (prompt: string) => {
      seenPrompt = prompt;
      return '{"action":"arrange"}';
    });
    const state = recordNlTurn(EMPTY_DIALOGUE_STATE, {
      utterance: "buka 2 browser",
      actions: ["open_browser", "open_browser"],
      resolvedNodeIds: ["b1", "b2"],
      outcome: "ok",
    });
    // Compound ("and") → LLM path, which must carry the recent-command context.
    await runNlCommand("what did I just do and tidy up", { ...deps(callModel), dialogueState: state });
    expect(callModel).toHaveBeenCalledOnce();
    expect(seenPrompt).toContain("buka 2 browser");
    expect(seenPrompt).toMatch(/recent/i);
  });
});

describe("executeNlEffect", () => {
  it("routes a command effect to runCommand", () => {
    const runCommand = vi.fn();
    const dispatch = vi.fn();
    const runApp = vi.fn();
    executeNlEffect({ kind: "command", command: { kind: "focus-node", nodeId: "n1" } }, { runCommand, dispatch, runApp });
    expect(runCommand).toHaveBeenCalledWith({ kind: "focus-node", nodeId: "n1" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(runApp).not.toHaveBeenCalled();
  });

  it("routes a dispatch effect to dispatch", () => {
    const runCommand = vi.fn();
    const dispatch = vi.fn();
    const runApp = vi.fn();
    executeNlEffect({ kind: "dispatch", agentId: "a-skye", text: "go" }, { runCommand, dispatch, runApp });
    expect(dispatch).toHaveBeenCalledWith("a-skye", "go");
    expect(runCommand).not.toHaveBeenCalled();
    expect(runApp).not.toHaveBeenCalled();
  });

  it("routes an app effect to runApp and reports it as delivered", () => {
    const runCommand = vi.fn();
    const dispatch = vi.fn();
    const runApp = vi.fn(() => true);
    const outcome = executeNlEffect({ kind: "app", command: { type: "switch-project", projectId: "cp_beta" } }, { runCommand, dispatch, runApp });
    expect(runApp).toHaveBeenCalledWith({ type: "switch-project", projectId: "cp_beta" });
    expect(outcome.appDelivered).toBe(true);
    expect(runCommand).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("surfaces an app effect the host could not carry out (no docked nav) as NOT delivered", () => {
    const outcome = executeNlEffect(
      { kind: "app", command: { type: "open-page", page: "settings" } },
      { runCommand: vi.fn(), dispatch: vi.fn(), runApp: vi.fn(() => false) },
    );
    expect(outcome.appDelivered).toBe(false); // → the batch reports a no-op instead of a false "done"
  });

  it("returns the command result so the batch can capture a created node id", () => {
    const runCommand = vi.fn(() => ({ nodeId: "agent-7" }));
    const dispatch = vi.fn();
    const runApp = vi.fn();
    const outcome = executeNlEffect({ kind: "command", command: { kind: "create-node", nodeType: "terminal" } }, { runCommand, dispatch, runApp });
    expect(outcome.command).toEqual({ nodeId: "agent-7" });
  });
});

describe("bindBatchNodeIds", () => {
  it("passes a non-placeholder command through unchanged", () => {
    const effect = { kind: "command" as const, command: { kind: "focus-node" as const, nodeId: "real-1" } };
    expect(bindBatchNodeIds(effect, [])).toBe(effect);
  });

  it("rebinds a batch placeholder to the real id created earlier in the batch", () => {
    const effect = { kind: "command" as const, command: { kind: "focus-node" as const, nodeId: batchNodeId(2) } };
    const bound = bindBatchNodeIds(effect, [undefined, undefined, "real-iris"]);
    expect(bound).toEqual({ kind: "command", command: { kind: "focus-node", nodeId: "real-iris" } });
  });

  it("returns null when the referenced create produced no real id (skip, don't ghost)", () => {
    const effect = { kind: "command" as const, command: { kind: "close-node" as const, nodeId: batchNodeId(0) } };
    expect(bindBatchNodeIds(effect, [undefined])).toBeNull();
  });

  it("passes dispatch effects through unchanged", () => {
    const effect = { kind: "dispatch" as const, agentId: "a-skye", text: "go" };
    expect(bindBatchNodeIds(effect, [])).toBe(effect);
  });
});
