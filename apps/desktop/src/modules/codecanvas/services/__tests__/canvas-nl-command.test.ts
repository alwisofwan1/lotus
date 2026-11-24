import { describe, expect, it } from "vitest";
import { buildNodeIndex, resolveAgentByName, resolveNodeByName, resolveNlIntent, resolveNlIntents, summarizeResolutions, batchNodeId, INTENT_REGISTRY, type CanvasNodeRef, type NlCanvasIntent, type NlResolution } from "../canvas-nl-command";
import type { AgentStatusSnapshot } from "../agent-status-registry";

const roster: AgentStatusSnapshot[] = [
  { id: "a-skye", name: "Skye", status: "running" },
  { id: "a-rex", name: "Rex", status: "idle" },
  { id: "a-rex2", name: "Rex", status: "idle" }, // duplicate name → ambiguous
];

const nodeRefs: CanvasNodeRef[] = [
  { id: "a-skye", kind: "agent", name: "Skye" },
  { id: "a-rex", kind: "agent", name: "Rex" },
  { id: "a-rex2", kind: "agent", name: "Rex" }, // duplicate → ambiguous
  { id: "n-1", kind: "note", name: "Shopping list" },
  { id: "t-1", kind: "task", name: "Fix auth bug" },
  { id: "term-1", kind: "terminal", name: "Terminal 1" },
  { id: "br-1", kind: "browser", name: "Browser 1" },
];

describe("resolveAgentByName", () => {
  it("resolves a person-style name to its agent id, case-insensitively", () => {
    expect(resolveAgentByName("skye", roster)).toEqual({ ok: true, id: "a-skye" });
    expect(resolveAgentByName("  SKYE ", roster)).toEqual({ ok: true, id: "a-skye" });
  });

  it("tolerates trailing punctuation and surrounding quotes from natural speech", () => {
    // Regression: "Close Iris." used to fail because the target kept the sentence period.
    expect(resolveAgentByName("skye.", roster)).toEqual({ ok: true, id: "a-skye" });
    expect(resolveAgentByName("'Skye'", roster)).toEqual({ ok: true, id: "a-skye" });
    expect(resolveAgentByName("skye!", roster)).toEqual({ ok: true, id: "a-skye" });
  });

  it("resolves live agent aliases like Codex for dispatch targets", () => {
    expect(
      resolveAgentByName("Codex", [
        { id: "a1", name: "Nova", status: "running", aliases: ["Codex", "Codex agent", "Kodeks"] },
      ]),
    ).toEqual({ ok: true, id: "a1" });
  });

  it("resolves ordinal runner aliases with STS-style separators for dispatch targets", () => {
    expect(
      resolveAgentByName("claude-3", [
        { id: "sena", name: "Sena", status: "running", aliases: ["Claude 1", "Claude one"] },
        { id: "nara", name: "Nara", status: "running", aliases: ["Claude 2", "Claude two"] },
        { id: "bima", name: "Bima", status: "running", aliases: ["Claude 3", "Claude three"] },
      ]),
    ).toEqual({ ok: true, id: "bima" });
  });

  it("reports not-found and ambiguous instead of guessing", () => {
    expect(resolveAgentByName("nobody", roster)).toEqual({ ok: false, reason: "not-found" });
    const rex = resolveAgentByName("Rex", roster);
    expect(rex).toMatchObject({ ok: false, reason: "ambiguous" });
    // Carries the candidates so the bar can offer a disambiguation (Option C).
    expect(rex.ok === false && rex.reason === "ambiguous" && rex.candidates.length).toBeGreaterThanOrEqual(2);
  });
});

describe("summarizeResolutions", () => {
  const ctx = { roster, nodeRefs: [] as CanvasNodeRef[] };
  const resolve = (intents: NlCanvasIntent[]) => resolveNlIntents(intents, ctx) as NlResolution[];

  it("collapses a multi-spawn batch into one counted phrase per runner", () => {
    const resolved = resolve([
      { action: "spawn_agent", runner: "codex" },
      { action: "spawn_agent", runner: "codex" },
      { action: "spawn_agent", runner: "codex" },
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
    ]);
    const { trace, speak } = summarizeResolutions(resolved);
    expect(speak).toBe("Spawning 3 Codex agents and 2 Claude agents");
    expect(trace).toBe("Spawning 3 Codex agents and 2 Claude agents");
  });

  it("uses a singular article for a single spawn", () => {
    expect(summarizeResolutions(resolve([{ action: "spawn_agent", runner: "cursor" }])).speak).toBe(
      "Spawning a Cursor agent",
    );
  });

  it("passes ungrouped resolutions through, preserving order", () => {
    const { speak } = summarizeResolutions(
      resolve([{ action: "arrange" }, { action: "spawn_agent", runner: "codex" }, { action: "spawn_agent", runner: "codex" }]),
    );
    expect(speak).toBe("Arranging the canvas. Spawning 2 Codex agents");
  });
});

describe("buildNodeIndex", () => {
  it("derives a human name per node kind and skips nameless nodes", () => {
    const refs = buildNodeIndex([
      { id: "a1", type: "agent", data: { name: "Skye" } },
      { id: "a2", type: "agent", data: { name: "Nova", runner: "codex" } },
      { id: "t1", type: "task", data: { title: "Fix auth bug" } },
      { id: "n1", type: "note", data: { content: "  \nGroceries\nmore" } }, // first non-empty line
      { id: "term1", type: "terminal", data: { terminalNumber: 3, label: "API server" } },
      { id: "b1", type: "browser", data: { browserNumber: 2 } },
      { id: "b2", type: "browser", data: { browserNumber: 3, label: "Docs", url: "https://tailwindcss.com/docs" } },
      { id: "b3", type: "browser", data: { browserNumber: 4, pageTitle: "Ghibli Grove", url: "https://grove.example/app" } },
      { id: "blank", type: "note", data: { content: "   " } }, // no usable name → skipped
      { id: "typeless", data: {} }, // no type → skipped
    ]);
    expect(refs).toEqual([
      { id: "a1", kind: "agent", name: "Skye" },
      {
        id: "a2",
        kind: "agent",
        name: "Nova",
        aliases: ["Codex", "Codex agent", "Code X", "Kodeks", "Cortex", "OpenAI agent", "Codex 1", "Codex one", "Codex agent 1", "Codex agent one"],
      },
      { id: "t1", kind: "task", name: "Fix auth bug" },
      { id: "n1", kind: "note", name: "Groceries" },
      { id: "term1", kind: "terminal", name: "API server", aliases: ["Terminal 3"] },
      { id: "b1", kind: "browser", name: "Browser 2" },
      { id: "b2", kind: "browser", name: "Docs", aliases: ["Browser 3", "tailwindcss.com"] },
      { id: "b3", kind: "browser", name: "Ghibli Grove", aliases: ["Browser 4", "grove.example"] },
    ]);
  });
});

describe("resolveNodeByName", () => {
  it("resolves an exact name case-insensitively across any node kind", () => {
    expect(resolveNodeByName("shopping list", nodeRefs)).toMatchObject({ ok: true, id: "n-1" });
    expect(resolveNodeByName("FIX AUTH BUG", nodeRefs)).toMatchObject({ ok: true, id: "t-1" });
  });

  it("falls back to a unique substring match", () => {
    expect(resolveNodeByName("auth", nodeRefs)).toMatchObject({ ok: true, id: "t-1" });
  });

  it("strips trailing punctuation and quotes so spoken targets resolve", () => {
    // Regression for "Close <name>." — the period must not break the match.
    expect(resolveNodeByName("shopping list.", nodeRefs)).toMatchObject({ ok: true, id: "n-1" });
    expect(resolveNodeByName('"Fix auth bug"', nodeRefs)).toMatchObject({ ok: true, id: "t-1" });
  });

  it("resolves agent runner aliases like Codex to the live agent node", () => {
    const refs: CanvasNodeRef[] = [
      { id: "a1", kind: "agent", name: "Nova", aliases: ["Codex", "Codex agent", "Kodeks"] },
      { id: "a2", kind: "agent", name: "Skye", aliases: ["Claude", "Claude agent"] },
    ];

    expect(resolveNodeByName("Codex", refs, { kind: "agent" })).toMatchObject({ ok: true, id: "a1" });
    expect(resolveNodeByName("kodeks", refs, { kind: "agent" })).toMatchObject({ ok: true, id: "a1" });
  });

  it("reports ambiguous for duplicate names and not-found for misses", () => {
    const rex = resolveNodeByName("Rex", nodeRefs);
    expect(rex).toMatchObject({ ok: false, reason: "ambiguous" });
    expect(rex.ok === false && rex.reason === "ambiguous" && rex.candidates.length).toBeGreaterThanOrEqual(2);
    expect(resolveNodeByName("ghost", nodeRefs)).toEqual({ ok: false, reason: "not-found" });
  });

  it("constrains the search to the requested kind", () => {
    expect(resolveNodeByName("Skye", nodeRefs, { kind: "task" })).toEqual({ ok: false, reason: "not-found" });
    expect(resolveNodeByName("auth", nodeRefs, { kind: ["task", "note"] })).toMatchObject({ ok: true, id: "t-1" });
  });

  it("folds spoken number words so 'browser two' / 'browser too' resolve to Browser 2 (STT slip)", () => {
    const browsers: CanvasNodeRef[] = [
      { id: "b1", kind: "browser", name: "Browser 1" },
      { id: "b2", kind: "browser", name: "Browser 2" },
    ];
    expect(resolveNodeByName("browser two", browsers)).toMatchObject({ ok: true, id: "b2" });
    expect(resolveNodeByName("browser too", browsers)).toMatchObject({ ok: true, id: "b2" });
    expect(resolveNodeByName("browser satu", browsers)).toMatchObject({ ok: true, id: "b1" });
  });

  it("fuzzy-matches a mis-transcribed name (1-char slip), but never an unrelated word", () => {
    expect(resolveNodeByName("Shoping list", nodeRefs)).toMatchObject({ ok: true, id: "n-1" }); // missing p
    expect(resolveNodeByName("completely unrelated phrase", nodeRefs)).toEqual({ ok: false, reason: "not-found" });
  });

  it("does not fuzzy-override an exact or substring match (tier order)", () => {
    // "Skye" is exact even though "Rex"/"Rex" exist — fuzzy must not change a clean hit.
    expect(resolveNodeByName("Skye", nodeRefs)).toMatchObject({ ok: true, id: "a-skye" });
  });

  it("resolves browser aliases without duplicating the matched node", () => {
    const refs: CanvasNodeRef[] = [{ id: "browser-docs", kind: "browser", name: "Docs", aliases: ["Browser 3", "tailwindcss.com"] }];

    expect(resolveNodeByName("Browser 3", refs, { kind: "browser" })).toMatchObject({ ok: true, id: "browser-docs" });
    expect(resolveNodeByName("tailwindcss.com", refs, { kind: "browser" })).toMatchObject({ ok: true, id: "browser-docs" });
  });
});

describe("resolveNlIntents — compound batches with in-batch dependencies", () => {
  const spawn = (): NlCanvasIntent => ({ action: "spawn_agent", runner: "claude" });
  const nameOf = (r: NlResolution): string =>
    r.effect.kind === "command" && r.effect.command.kind === "create-agent" ? r.effect.command.definition.name : "";

  it("auto-names sequential spawns uniquely (the working index grows as it plans)", () => {
    const out = resolveNlIntents([spawn(), spawn(), spawn()], { roster: [], nodeRefs: [] }) as NlResolution[];
    const names = out.map(nameOf);
    expect(new Set(names).size).toBe(3); // no collisions — each spawn sees the prior ones as taken
  });

  it("lets a later 'focus <name>' target an agent spawned in the same batch via a deferred-id placeholder", () => {
    const planned = resolveNlIntents([spawn(), spawn(), spawn()], { roster: [], nodeRefs: [] }) as NlResolution[];
    const thirdName = nameOf(planned[2]);
    const out = resolveNlIntents(
      [spawn(), spawn(), spawn(), { action: "focus", target: thirdName }],
      { roster: [], nodeRefs: [] },
    ) as NlResolution[];
    expect(out).toHaveLength(4);
    // The focus targets the THIRD spawn (resolution index 2) by its deferred-id placeholder.
    expect(out[3].effect).toEqual({ kind: "command", command: { kind: "focus-node", nodeId: batchNodeId(2) } });
  });

  it("still errors atomically on a genuinely unknown name", () => {
    const out = resolveNlIntents([spawn(), { action: "focus", target: "nobody-here" }], { roster: [], nodeRefs: [] });
    expect(out).toHaveProperty("error");
  });
});

describe("resolveNlIntent", () => {
  const ctx = { roster, nodeRefs };

  it("maps create_node to a focused create-node command (safe)", () => {
    const r = resolveNlIntent({ action: "create_node", nodeType: "terminal" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "command", command: { kind: "create-node", nodeType: "terminal", focus: true } }, destructive: false });
  });

  it("threads create_node content into the create-node command (note text)", () => {
    const r = resolveNlIntent({ action: "create_node", nodeType: "note", content: "hello world" }, ctx);
    expect(r).toMatchObject({
      effect: { kind: "command", command: { kind: "create-node", nodeType: "note", content: "hello world", focus: true } },
      destructive: false,
    });
  });

  it("maps arrange to an arrange-layout command (safe)", () => {
    const r = resolveNlIntent({ action: "arrange" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "command", command: { kind: "arrange-layout" } }, destructive: false });
  });

  it("maps focus to a focus-node command on the resolved agent (safe)", () => {
    const r = resolveNlIntent({ action: "focus", target: "Skye" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "command", command: { kind: "focus-node", nodeId: "a-skye" } }, destructive: false });
  });

  it("maps dispatch to a dispatch effect carrying the resolved agent id and task text (safe)", () => {
    const r = resolveNlIntent({ action: "dispatch", target: "Skye", task: "investigate the bug" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "dispatch", agentId: "a-skye", text: "investigate the bug" }, destructive: false });
  });

  it("snapshot_browser (Gap B): dispatches a snapshot brief to a named agent", () => {
    const r = resolveNlIntent({ action: "snapshot_browser", target: "Skye" }, ctx) as NlResolution;
    expect(r.effect).toMatchObject({ kind: "dispatch", agentId: "a-skye" });
    expect((r.effect as { kind: "dispatch"; text: string }).text).toMatch(/snapshot/i);
    expect(r.destructive).toBe(false);
  });

  it("snapshot_browser (Gap B): defaults to the only live agent when no target is named", () => {
    const solo: AgentStatusSnapshot[] = [{ id: "a-atlas", name: "Atlas", status: "running" }];
    const r = resolveNlIntent({ action: "snapshot_browser" }, { roster: solo, nodeRefs: [] }) as NlResolution;
    expect(r.effect).toMatchObject({ kind: "dispatch", agentId: "a-atlas" });
  });

  it("snapshot_browser (Gap B): errors with guidance when no live agent exists", () => {
    const r = resolveNlIntent({ action: "snapshot_browser" }, { roster: [], nodeRefs: [] });
    expect(r).toHaveProperty("error");
  });

  it("snapshot_browser (Gap B): errors (ambiguous) when several agents and no target", () => {
    const r = resolveNlIntent({ action: "snapshot_browser" }, ctx);
    expect(r).toHaveProperty("error");
  });

  it("draws draw_diagram DIRECTLY on the canvas (a draw-diagram command, no agent spawn/dispatch)", () => {
    const graph = { nodes: [{ id: "a", label: "Start" }, { id: "b", label: "End" }], edges: [{ from: "a", to: "b" }] };
    const r = resolveNlIntent({ action: "draw_diagram", topic: "the login flow", graph }, { roster: [], nodeRefs: [] }) as NlResolution;
    expect(r).toMatchObject({
      effect: { kind: "command", command: { kind: "draw-diagram", topic: "the login flow" } },
      destructive: false,
    });
    expect((r.effect as { command: { graph: typeof graph } }).command.graph).toEqual(graph);
    // Crucially: never a dispatch or an agent spawn.
    expect((r.effect as { kind: string }).kind).toBe("command");
  });

  it("draws directly even when a live agent exists (no dispatch to it)", () => {
    const graph = { nodes: [{ id: "a", label: "A" }], edges: [] };
    const r = resolveNlIntent({ action: "draw_diagram", topic: "x", graph }, ctx) as NlResolution;
    expect((r.effect as { command: { kind: string } }).command.kind).toBe("draw-diagram");
  });

  it("draw_diagram parse requires an inline graph and rejects an empty one", () => {
    const def = INTENT_REGISTRY.find((d) => d.name === "draw_diagram")!;
    const ok = def.parse({ topic: "auth", graph: { nodes: [{ id: "n", label: "Login" }], edges: [] } });
    expect(ok).toMatchObject({ action: "draw_diagram", topic: "auth" });
    const noGraph = def.parse({ topic: "auth" });
    expect("error" in noGraph).toBe(true);
    const emptyGraph = def.parse({ topic: "auth", graph: { nodes: [] } });
    expect("error" in emptyGraph).toBe(true);
  });

  it("is registered in the intent registry so the NL parser offers it", () => {
    expect(INTENT_REGISTRY.some((d) => d.name === "draw_diagram")).toBe(true);
  });

  it("instructs the model to branch decision nodes (not draw a straight line)", () => {
    const def = INTENT_REGISTRY.find((d) => d.name === "draw_diagram")!;
    expect(def.description.toLowerCase()).toMatch(/decision/);
    expect(def.description.toLowerCase()).toMatch(/two outgoing|2 outgoing|at least two|≥2/);
    expect(def.promptSchema({ nodeKinds: [], customRunnerNames: [] } as never).toLowerCase()).toMatch(/decision/);
  });

  it("applies close immediately — not destructive (no confirmation)", () => {
    const r = resolveNlIntent({ action: "close", target: "Skye" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "command", command: { kind: "close-node", nodeId: "a-skye" } }, destructive: false });
  });

  it("resolves close_all to a close-all-nodes command, marked destructive (blast radius = everything)", () => {
    expect(resolveNlIntent({ action: "close_all" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "close-all-nodes" } },
      destructive: true,
      summary: "Close everything",
    });
  });

  it("focuses and closes non-agent nodes by name (not just live agents)", () => {
    expect(resolveNlIntent({ action: "focus", target: "Shopping list" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "focus-node", nodeId: "n-1" } },
    });
    expect(resolveNlIntent({ action: "close", target: "Fix auth bug" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "close-node", nodeId: "t-1" } },
      destructive: false,
    });
  });

  it("resolves spawn_agent to a create-agent command carrying the chosen runner + a unique auto-name", () => {
    const r = resolveNlIntent({ action: "spawn_agent", runner: "codex" }, ctx);
    expect(r).toMatchObject({
      effect: { kind: "command", command: { kind: "create-agent", definition: { runner: "codex" }, focus: true } },
      destructive: false,
    });
    const cmd = "effect" in r && r.effect.kind === "command" ? r.effect.command : null;
    expect(cmd && cmd.kind === "create-agent" && cmd.definition.name.length > 0).toBe(true);
  });

  it("resolves run_task to a dispatch-task command on the named task node", () => {
    expect(resolveNlIntent({ action: "run_task", target: "Fix auth bug", mode: "single" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "dispatch-task", nodeId: "t-1", mode: "single" } },
      destructive: false,
    });
  });

  it("errors run_task when no task node matches the name", () => {
    expect(resolveNlIntent({ action: "run_task", target: "nonexistent", mode: "single" }, ctx)).toMatchObject({
      error: expect.stringContaining("task"),
    });
  });

  it("threads a spawn_agent brief into the create-agent command as the agent's first task", () => {
    expect(resolveNlIntent({ action: "spawn_agent", runner: "claude", brief: "build the hero" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "create-agent", brief: "build the hero", definition: { runner: "claude" } } },
    });
  });

  it("resolves open_browser to a standalone create-browser, or open-or-focus on a named terminal", () => {
    expect(resolveNlIntent({ action: "open_browser", url: "localhost:3000" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "create-browser", url: "localhost:3000", focus: true } },
    });
    expect(resolveNlIntent({ action: "open_browser", target: "Terminal 1" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "open-browser-for-terminal", terminalId: "term-1" } },
    });
  });

  it("opens or navigates a named BrowserNode when the planner emits open_browser target Browser 1", () => {
    expect(resolveNlIntent({ action: "open_browser", target: "Browser 1", url: "https://www.youtube.com/" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "navigate-browser-node", nodeId: "br-1", url: "https://www.youtube.com/" } },
      destructive: false,
    });
    expect(resolveNlIntent({ action: "open_browser", target: "Browser 1" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "focus-node", nodeId: "br-1" } },
      destructive: false,
    });
  });

  it("navigates a named BrowserNode without treating it as a terminal", () => {
    expect(resolveNlIntent({ action: "navigate_browser", target: "Browser 1", url: "https://www.youtube.com/" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "navigate-browser-node", nodeId: "br-1", url: "https://www.youtube.com/" } },
      destructive: false,
    });
  });

  it("navigates the selected BrowserNode when no browser target is named", () => {
    expect(
      resolveNlIntent(
        { action: "navigate_browser", url: "https://www.youtube.com/" },
        { ...ctx, selectedNodeIds: ["br-1"] },
      ),
    ).toMatchObject({
      effect: { kind: "command", command: { kind: "navigate-browser-node", nodeId: "br-1", url: "https://www.youtube.com/" } },
    });
  });

  it("navigates the only BrowserNode when aliases are present", () => {
    expect(
      resolveNlIntent(
        { action: "navigate_browser", url: "https://www.youtube.com/" },
        { roster, nodeRefs: [{ id: "br-docs", kind: "browser", name: "Docs", aliases: ["Browser 1", "localhost:5173"] }] },
      ),
    ).toMatchObject({
      effect: { kind: "command", command: { kind: "navigate-browser-node", nodeId: "br-docs", url: "https://www.youtube.com/" } },
    });
  });

  it("navigates a terminal-paired browser when a terminal target is named", () => {
    expect(resolveNlIntent({ action: "navigate_browser", target: "Terminal 1", url: "https://www.youtube.com/" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "open-browser-for-terminal", terminalId: "term-1", url: "https://www.youtube.com/" } },
    });
  });

  it("recovers a terminal or a browser by name, picking the matching command", () => {
    expect(resolveNlIntent({ action: "recover", target: "Terminal 1" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "recover-terminal", nodeId: "term-1" } },
    });
    expect(resolveNlIntent({ action: "recover", target: "Browser 1" }, ctx)).toMatchObject({
      effect: { kind: "command", command: { kind: "recover-browser", nodeId: "br-1" } },
    });
  });

  it("returns an actionable error when the target name does not resolve", () => {
    expect(resolveNlIntent({ action: "focus", target: "Ghost" }, ctx)).toMatchObject({ error: expect.stringContaining("Ghost") });
    expect(resolveNlIntent({ action: "dispatch", target: "Rex", task: "x" }, ctx)).toMatchObject({ error: expect.stringMatching(/multiple|ambiguous/i) });
  });

  it("spawn_agent pins a chosen model on the created agent definition", () => {
    const r = resolveNlIntent({ action: "spawn_agent", runner: "claude", model: "opus" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "command", command: { kind: "create-agent", definition: { model: "opus" } } } });
    expect("summary" in r && r.summary).toContain("opus");
  });

  it("make_lead dispatches the orchestrator brief to a live agent by name", () => {
    const r = resolveNlIntent({ action: "make_lead", target: "Skye" }, ctx);
    expect(r).toMatchObject({ effect: { kind: "dispatch", agentId: "a-skye" } });
    expect("effect" in r && r.effect.kind === "dispatch" && r.effect.text).toMatch(/lotus_|lead orchestrator/i);
  });

  it("make_lead errors when the agent is not live", () => {
    expect(resolveNlIntent({ action: "make_lead", target: "Ghost" }, ctx)).toMatchObject({
      error: expect.stringContaining("Ghost"),
    });
  });

  it("produces a human-readable trace summary for every resolved intent", () => {
    const r = resolveNlIntent({ action: "focus", target: "Skye" }, ctx);
    expect("summary" in r && r.summary).toMatch(/focus/i);
  });
});

describe("resolveNlIntents (batch)", () => {
  const ctx = { roster, nodeRefs };

  it("resolves several intents into an ordered list of resolutions", () => {
    const r = resolveNlIntents(
      [
        { action: "create_node", nodeType: "terminal" },
        { action: "focus", target: "Skye" },
      ],
      ctx,
    );
    expect(r).toMatchObject([
      { effect: { command: { kind: "create-node", nodeType: "terminal" } } },
      { effect: { command: { kind: "focus-node", nodeId: "a-skye" } } },
    ]);
  });

  it("fails the whole batch on the first unresolvable intent", () => {
    const r = resolveNlIntents(
      [
        { action: "focus", target: "Skye" },
        { action: "focus", target: "Ghost" },
      ],
      ctx,
    );
    expect(r).toMatchObject({ error: expect.stringContaining("Ghost") });
  });

  it("rejects an empty batch", () => {
    expect(resolveNlIntents([], ctx)).toMatchObject({ error: expect.any(String) });
  });
});

describe("resolveNlIntents — collective close (byType / selection)", () => {
  const manyBrowsers: CanvasNodeRef[] = [
    { id: "br-1", kind: "browser", name: "Browser 1" },
    { id: "br-2", kind: "browser", name: "Browser 2" },
    { id: "br-3", kind: "browser", name: "Browser 3" },
    { id: "term-1", kind: "terminal", name: "Terminal 1" },
    { id: "n-1", kind: "note", name: "Notes" },
  ];
  const ctx = { roster: [] as AgentStatusSnapshot[], nodeRefs: manyBrowsers };
  const resolve = (intent: NlCanvasIntent) => resolveNlIntents([intent], ctx);

  it("closes EVERY browser and leaves other kinds untouched (byType/all) — the 'semua browser' fix", () => {
    const r = resolve({ action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "all" } }) as NlResolution[];
    expect(Array.isArray(r)).toBe(true);
    expect(r.map((x) => (x.effect.kind === "command" && x.effect.command.kind === "close-node" ? x.effect.command.nodeId : null))).toEqual([
      "br-1",
      "br-2",
      "br-3",
    ]);
    // Renders as one grouped phrase, not three lines.
    expect(summarizeResolutions(r).speak).toBe("Closing 3 browsers");
  });

  it("closes exactly N browsers for a counted collective (byType/count)", () => {
    const r = resolve({ action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "count", count: 2 } }) as NlResolution[];
    expect(r).toHaveLength(2);
    expect(summarizeResolutions(r).speak).toBe("Closing 2 browsers");
  });

  it("errors (typed noun, not a name error) when no node of that kind exists", () => {
    const r = resolveNlIntents([{ action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "all" } }], {
      roster: [],
      nodeRefs: [{ id: "term-1", kind: "terminal", name: "Terminal 1" }],
    });
    expect(r).toMatchObject({ error: expect.stringContaining("browser") });
    expect((r as { error: string }).error).not.toContain('"'); // not the No node named "…" form
  });

  it("closes the current selection (target=selection)", () => {
    const r = resolveNlIntents([{ action: "close", target: { kind: "selection" } }], {
      ...ctx,
      selectedNodeIds: ["br-2", "term-1"],
    }) as NlResolution[];
    expect(r.map((x) => (x.effect.kind === "command" && x.effect.command.kind === "close-node" ? x.effect.command.nodeId : null))).toEqual([
      "br-2",
      "term-1",
    ]);
  });

  it("errors when target=selection but nothing is selected", () => {
    expect(resolveNlIntents([{ action: "close", target: { kind: "selection" } }], ctx)).toMatchObject({
      error: expect.stringMatching(/selected/i),
    });
  });

  it("closes the last-mentioned nodes ('close them') from dialogue state passed on the context", () => {
    const r = resolveNlIntents([{ action: "close", target: { kind: "lastMentioned" } }], {
      ...ctx,
      lastMentionedIds: ["br-1", "br-3"],
    }) as NlResolution[];
    expect(r.map((x) => (x.effect.kind === "command" && x.effect.command.kind === "close-node" ? x.effect.command.nodeId : null))).toEqual([
      "br-1",
      "br-3",
    ]);
  });

  it("errors for lastMentioned when there is nothing recent to refer to", () => {
    expect(resolveNlIntents([{ action: "close", target: { kind: "lastMentioned" } }], ctx)).toMatchObject({
      error: expect.stringMatching(/recent|refer/i),
    });
  });

  it("still closes a single node for a legacy string target (back-compat)", () => {
    const r = resolveNlIntents([{ action: "close", target: "Browser 2" }], ctx) as NlResolution[];
    expect(r).toHaveLength(1);
    expect(r[0].effect).toEqual({ kind: "command", command: { kind: "close-node", nodeId: "br-2" } });
  });

  it("marks a large collective close destructive (blast-radius confirm), a small one immediate", () => {
    // 3 browsers → over the threshold → each resolution destructive → the bar confirms once.
    const big = resolveNlIntents([{ action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "all" } }], ctx) as NlResolution[];
    expect(big.every((r) => r.destructive)).toBe(true);
    // 2 browsers → under the threshold → immediate, no confirmation.
    const small = resolveNlIntents([{ action: "close", target: { kind: "byType", nodeType: "browser", quantifier: "count", count: 2 } }], ctx) as NlResolution[];
    expect(small.every((r) => r.destructive)).toBe(false);
  });

  it("keeps a single named close immediate (not destructive)", () => {
    const r = resolveNlIntents([{ action: "close", target: "Browser 2" }], ctx) as NlResolution[];
    expect(r[0].destructive).toBe(false);
  });
});

describe("speak (voice-feedback contract)", () => {
  const ctx = { roster, nodeRefs };

  it("every registry intent exposes a speak() returning a non-empty confirmation for its own action", () => {
    const sample: Record<string, Parameters<(typeof INTENT_REGISTRY)[number]["speak"]>[0]> = {
      create_node: { action: "create_node", nodeType: "terminal" },
      arrange: { action: "arrange" },
      focus: { action: "focus", target: "Skye" },
      dispatch: { action: "dispatch", target: "Skye", task: "go" },
      say_to_agent: { action: "say_to_agent", target: "Skye", message: "hello" },
      close: { action: "close", target: "Skye" },
      spawn_agent: { action: "spawn_agent", runner: "codex" },
      run_task: { action: "run_task", target: "Fix auth bug", mode: "single" },
      open_browser: { action: "open_browser" },
      navigate_browser: { action: "navigate_browser", target: "Browser 1", url: "https://www.youtube.com/" },
      snapshot_browser: { action: "snapshot_browser" },
      recover: { action: "recover", target: "Terminal 1" },
      make_lead: { action: "make_lead", target: "Skye" },
      switch_project: { action: "switch_project", target: "Beta" },
      open_page: { action: "open_page", page: "settings" },
      new_project: { action: "new_project" },
      close_project: { action: "close_project", target: "Beta" },
      create_frame: { action: "create_frame", title: "Auth", members: ["T1"] },
      move_to_frame: { action: "move_to_frame", targets: ["T1"], frame: "Auth" },
      leave_frame: { action: "leave_frame", targets: ["T1"] },
      go_to_frame: { action: "go_to_frame", frame: "Auth" },
      draw_diagram: { action: "draw_diagram", topic: "this project", graph: { nodes: [{ id: "a", label: "A" }], edges: [] } },
    };
    for (const def of INTENT_REGISTRY) {
      expect(def.speak(sample[def.name]).length).toBeGreaterThan(0);
    }
  });

  it("speaks the pretty runner label, matching the grouped-batch phrasing (Codex, not codex)", () => {
    const def = INTENT_REGISTRY.find((d) => d.name === "spawn_agent")!;
    expect(def.speak({ action: "spawn_agent", runner: "codex" })).toBe("Spawning a Codex agent");
    expect(def.speak({ action: "spawn_agent", runner: "claude", brief: "fix the bug" })).toBe(
      "Spawning a Claude agent to fix the bug",
    );
  });

  it("populates speak on a resolved intent (e.g. spawn_agent names the runner)", () => {
    const r = resolveNlIntent({ action: "spawn_agent", runner: "codex", brief: "build hero" }, ctx);
    expect("speak" in r && r.speak).toMatch(/spawn/i);
    expect("speak" in r && r.speak).toMatch(/codex/i); // pretty label ("Codex")
  });

  it("speaks the target on close", () => {
    const r = resolveNlIntent({ action: "close", target: "Skye" }, ctx);
    expect("speak" in r && r.speak).toBe("Closing Skye");
  });

  it("propagates speak to every resolution in a batch", () => {
    const r = resolveNlIntents(
      [
        { action: "create_node", nodeType: "terminal" },
        { action: "arrange" },
      ],
      ctx,
    );
    expect(Array.isArray(r)).toBe(true);
    if (Array.isArray(r)) {
      expect(r[0].speak).toBe("Creating a terminal node");
      expect(r[1].speak).toBe("Arranging the canvas");
    }
  });
});

describe("resolveNlIntents — clarification (Option C)", () => {
  it("a single ambiguous target yields a clarify carrying candidates + the pending intent", () => {
    const res = resolveNlIntents([{ action: "focus", target: "Rex" }], { roster, nodeRefs });
    expect("clarify" in res && !!res.clarify).toBe(true);
    if ("clarify" in res && res.clarify) {
      expect(res.clarify.candidates.map((c) => c.id).sort()).toEqual(["a-rex", "a-rex2"]);
      expect(res.clarify.intents).toEqual([{ action: "focus", target: "Rex" }]);
      expect(res.clarify.question.toLowerCase()).toContain("which");
    }
  });

  it("does NOT clarify inside a multi-intent batch — plain error, no candidates", () => {
    const res = resolveNlIntents([{ action: "arrange" }, { action: "focus", target: "Rex" }], { roster, nodeRefs });
    expect("error" in res).toBe(true);
    expect("clarify" in res && res.clarify).toBeFalsy();
  });
});
