import { describe, expect, it } from "vitest";
import { buildNlIntentPrompt, buildRealtimeToolDefs, buildNlIntentJsonSchema, buildNlIntentSchema, parseNlIntent, parseNlIntents } from "../canvas-nl-parse";
import { CANVAS_CREATE_NODE_KINDS } from "../commands/canvas-command";
import { INTENT_REGISTRY, type CanvasNodeRef } from "../canvas-nl-command";

describe("buildNlIntentPrompt", () => {
  const prompt = buildNlIntentPrompt({ text: "spawn a terminal", agentNames: ["Skye", "Rex"], nodeKinds: ["terminal", "note"] });

  it("embeds the user request, the available node kinds, and the agent roster", () => {
    expect(prompt).toContain("spawn a terminal");
    expect(prompt).toContain("terminal");
    expect(prompt).toContain("Skye");
    expect(prompt).toContain("Rex");
  });

  it("instructs a JSON-only reply and offers an error escape hatch", () => {
    expect(prompt).toMatch(/json/i);
    expect(prompt).toContain("error");
  });

  it("advertises the collective byType close target so the planner can express 'close all browsers'", () => {
    expect(prompt).toContain("byType");
    expect(prompt).toMatch(/close all browsers|tutup semua browser/i);
  });

  it("surfaces recent commands so the planner can resolve anaphora ('close them' / 'yang tadi')", () => {
    const p = buildNlIntentPrompt({
      text: "close them",
      agentNames: [],
      nodeKinds: ["terminal", "note"],
      recentCommands: ["buka 2 browser → opened Browser 2, Browser 3", "cari facebook di browser 2 → navigated Browser 2"],
    });
    expect(p).toMatch(/recent/i);
    expect(p).toContain("buka 2 browser");
    expect(p).toMatch(/them|lastMentioned/i);
  });

  it("surfaces current diagrams so an edit request reuses their node ids (edit-in-place)", () => {
    const p = buildNlIntentPrompt({
      text: "add a verification step to the login flow",
      agentNames: [],
      nodeKinds: ["terminal", "note"],
      currentDiagrams: ['Diagram "Login flow" — nodes: login=Login form, valid=Valid?. To edit it, resend draw_diagram reusing these node ids plus your changes.'],
    });
    expect(p).toMatch(/Diagrams currently on the canvas/i);
    expect(p).toContain("login=Login form");
    expect(p).toMatch(/reuse .*node ids|EDIT it in place/i);
  });

  it("omits the diagram block when there are none", () => {
    const p = buildNlIntentPrompt({ text: "draw a flowchart", agentNames: [], nodeKinds: ["terminal", "note"] });
    expect(p).not.toMatch(/Diagrams currently on the canvas/i);
  });

  it("grounds the parser with per-type node counts, computed over ALL nodes (beyond the listed cap)", () => {
    const many: CanvasNodeRef[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, kind: "browser", name: `Browser ${i + 1}` })),
      { id: "t1", kind: "terminal", name: "Terminal 1" },
      { id: "a1", kind: "agent", name: "Skye" },
      { id: "a2", kind: "agent", name: "Rex" },
    ];
    const grounded = buildNlIntentPrompt({ text: "tutup semua browser", agentNames: ["Skye", "Rex"], nodeKinds: ["terminal", "note"], nodeRefs: many });
    expect(grounded).toMatch(/3 browser/i);
    expect(grounded).toMatch(/1 terminal/i);
    expect(grounded).toMatch(/2 agent/i);
  });

  it("answers only grounded Canvas questions in the user's language and refuses repository analysis", () => {
    expect(prompt).toMatch(/same language as the user/i);
    expect(prompt).toMatch(/cannot inspect|cannot analyze/i);
    expect(prompt).toMatch(/repository|codebase/i);
    expect(prompt).not.toMatch(/otherwise English|never any other language/);
  });

  it("surfaces selected browser nodes as current targets for planner fallback", () => {
    const selectedPrompt = buildNlIntentPrompt({
      text: "navigate the browser to YouTube",
      agentNames: [],
      nodeKinds: ["terminal", "note"],
      nodeRefs: [
        { id: "browser-1", kind: "browser", name: "Browser 1" },
        { id: "browser-2", kind: "browser", name: "Browser 2" },
      ],
      selectedNodeIds: ["browser-1"],
    });
    expect(selectedPrompt).toContain("Selected nodes: Browser 1 (browser).");
  });

  it("includes visible-agent target hints in realtime dispatch tool descriptions", () => {
    const dispatch = buildRealtimeToolDefs({
      nodeKinds: ["terminal", "note"],
      agentNames: ["Sena", "Nara", "Bima", "Bayu"],
      agentTargetHints: ["Sena (Claude 1 / Cloud one)", "Nara (Claude 2 / Cloud two)", "Bima (Claude 3 / Cloud three)", "Bayu (Codex 1)"],
    }).find((tool) => tool.name === "dispatch")!;

    expect(JSON.stringify(dispatch.parameters)).toContain("Visible name");
    expect(JSON.stringify(dispatch.parameters)).toContain("Bima (Claude 3 / Cloud three)");
  });

  it("surfaces browser aliases in the target context", () => {
    const browserPrompt = buildNlIntentPrompt({
      text: "open YouTube in docs",
      agentNames: [],
      nodeKinds: ["terminal", "note"],
      nodeRefs: [
        { id: "browser-1", kind: "browser", name: "Docs", aliases: ["Browser 1", "localhost:5173"] },
      ],
    });

    expect(browserPrompt).toContain("Docs (browser; aliases: Browser 1, localhost:5173)");
  });
});

describe("parseNlIntent", () => {
  it("parses a clean JSON intent", () => {
    expect(parseNlIntent('{"action":"create_node","nodeType":"terminal"}')).toEqual({ action: "create_node", nodeType: "terminal" });
  });

  it("parses create_node with optional content (e.g. a note's text)", () => {
    expect(parseNlIntent('{"action":"create_node","nodeType":"note","content":"hello world"}')).toEqual({
      action: "create_node",
      nodeType: "note",
      content: "hello world",
    });
  });

  it("extracts JSON from a fenced code block with surrounding prose", () => {
    const raw = "Sure!\n```json\n{ \"action\": \"focus\", \"target\": \"Skye\" }\n```\nDone.";
    expect(parseNlIntent(raw)).toEqual({ action: "focus", target: "Skye" });
  });

  it("parses an arrange intent", () => {
    expect(parseNlIntent('{"action":"arrange"}')).toEqual({ action: "arrange" });
  });

  it("parses a dispatch intent with target and task", () => {
    expect(parseNlIntent('{"action":"dispatch","target":"Rex","task":"fix the bug"}')).toEqual({ action: "dispatch", target: "Rex", task: "fix the bug" });
  });

  it("rejects an unknown action", () => {
    expect(parseNlIntent('{"action":"explode"}')).toMatchObject({ error: expect.any(String) });
  });

  it("rejects create_node with an invalid node kind", () => {
    expect(parseNlIntent('{"action":"create_node","nodeType":"spaceship"}')).toMatchObject({ error: expect.any(String) });
  });

  it("rejects intents missing required fields", () => {
    expect(parseNlIntent('{"action":"focus"}')).toMatchObject({ error: expect.any(String) });
    expect(parseNlIntent('{"action":"dispatch","target":"Rex"}')).toMatchObject({ error: expect.any(String) });
  });

  it("returns an error for non-JSON output", () => {
    expect(parseNlIntent("I cannot help with that.")).toMatchObject({ error: expect.any(String) });
  });

  it("passes through an explicit model error", () => {
    expect(parseNlIntent('{"error":"unsupported request"}')).toMatchObject({ error: "unsupported request" });
  });

  it("parses spawn_agent: native runner kept, absent → claude, unknown → custom marker (resolve maps it)", () => {
    expect(parseNlIntent('{"action":"spawn_agent","runner":"codex"}')).toEqual({ action: "spawn_agent", runner: "codex" });
    expect(parseNlIntent('{"action":"spawn_agent"}')).toEqual({ action: "spawn_agent", runner: "claude" });
    // A non-native token is carried as a marker; resolve() maps the label to a native runner by
    // alias or fuzzy match (or falls back to claude).
    expect(parseNlIntent('{"action":"spawn_agent","runner":"Wesley"}')).toEqual({
      action: "spawn_agent",
      runner: "custom",
      runnerLabel: "Wesley",
    });
    expect(parseNlIntent('{"action":"spawn_agent","runner":"CCS"}')).toEqual({
      action: "spawn_agent",
      runner: "custom",
      runnerLabel: "CCS",
    });
  });

  it("parses run_task with a default mode of single, honoring an explicit team mode", () => {
    expect(parseNlIntent('{"action":"run_task","target":"Fix auth bug"}')).toEqual({ action: "run_task", target: "Fix auth bug", mode: "single" });
    expect(parseNlIntent('{"action":"run_task","target":"Build LP","mode":"team"}')).toEqual({ action: "run_task", target: "Build LP", mode: "team" });
  });

  it("rejects run_task without a target", () => {
    expect(parseNlIntent('{"action":"run_task"}')).toMatchObject({ error: expect.any(String) });
  });

  it("parses spawn_agent with an optional brief", () => {
    expect(parseNlIntent('{"action":"spawn_agent","runner":"codex","brief":"build hero"}')).toEqual({
      action: "spawn_agent",
      runner: "codex",
      brief: "build hero",
    });
  });

  it("parses spawn_agent with an optional model", () => {
    expect(parseNlIntent('{"action":"spawn_agent","runner":"claude","model":"opus"}')).toEqual({
      action: "spawn_agent",
      runner: "claude",
      model: "opus",
    });
  });

  it("parses make_lead and rejects it without a target", () => {
    expect(parseNlIntent('{"action":"make_lead","target":"Skye"}')).toEqual({ action: "make_lead", target: "Skye" });
    expect(parseNlIntent('{"action":"make_lead"}')).toMatchObject({ error: expect.any(String) });
  });

  it("parses open_browser with optional url + target", () => {
    expect(parseNlIntent('{"action":"open_browser"}')).toEqual({ action: "open_browser" });
    expect(parseNlIntent('{"action":"open_browser","url":"localhost:3000","target":"Terminal 1"}')).toEqual({
      action: "open_browser",
      url: "http://localhost:3000",
      target: "Terminal 1",
    });
  });

  it("parses navigate_browser and normalizes spoken site names", () => {
    expect(parseNlIntent('{"action":"navigate_browser","url":"YouTube","target":"Browser 1"}')).toEqual({
      action: "navigate_browser",
      url: "https://www.youtube.com/",
      target: "Browser 1",
    });
  });

  it("parses recover and rejects it without a target", () => {
    expect(parseNlIntent('{"action":"recover","target":"Terminal 1"}')).toEqual({ action: "recover", target: "Terminal 1" });
    expect(parseNlIntent('{"action":"recover"}')).toMatchObject({ error: expect.any(String) });
  });

  it("parses a close with a collective byType target (the 'close all browsers' path)", () => {
    expect(parseNlIntent('{"action":"close","target":{"kind":"byType","nodeType":"browser","quantifier":"all"}}')).toEqual({
      action: "close",
      target: { kind: "byType", nodeType: "browser", quantifier: "all" },
    });
    expect(parseNlIntent('{"action":"close","target":{"kind":"byType","nodeType":"browser","quantifier":"count","count":2}}')).toEqual({
      action: "close",
      target: { kind: "byType", nodeType: "browser", quantifier: "count", count: 2 },
    });
    expect(parseNlIntent('{"action":"close","target":{"kind":"selection"}}')).toEqual({
      action: "close",
      target: { kind: "selection" },
    });
  });

  it("normalizes a legacy string close target to byName, and rejects a malformed collective", () => {
    expect(parseNlIntent('{"action":"close","target":"Browser 2"}')).toEqual({
      action: "close",
      target: { kind: "byName", name: "Browser 2" },
    });
    // count quantifier without a count is malformed → error, not a silent all-close.
    expect(parseNlIntent('{"action":"close","target":{"kind":"byType","nodeType":"browser","quantifier":"count"}}')).toMatchObject({
      error: expect.any(String),
    });
    expect(parseNlIntent('{"action":"close"}')).toMatchObject({ error: expect.any(String) });
  });
});

describe("parseNlIntents (multi-intent)", () => {
  it("parses a JSON array of intents in order", () => {
    expect(parseNlIntents('[{"action":"create_node","nodeType":"terminal"},{"action":"create_node","nodeType":"note"}]')).toEqual([
      { action: "create_node", nodeType: "terminal" },
      { action: "create_node", nodeType: "note" },
    ]);
  });

  it("accepts an {intents:[...]} wrapper", () => {
    expect(parseNlIntents('{"intents":[{"action":"arrange"},{"action":"focus","target":"Skye"}]}')).toEqual([
      { action: "arrange" },
      { action: "focus", target: "Skye" },
    ]);
  });

  it("wraps a single object into a 1-element list", () => {
    expect(parseNlIntents('{"action":"arrange"}')).toEqual([{ action: "arrange" }]);
  });

  it("expands a counted spawn group into independently executable intents", () => {
    expect(parseNlIntents(JSON.stringify({
      outcome: "intents",
      intents: [{ action: "spawn_agent", runner: "claude", count: 3, brief: "review auth" }],
      answer: null,
      error: null,
    }))).toEqual(Array.from({ length: 3 }, () => ({
      action: "spawn_agent",
      runner: "claude",
      brief: "review auth",
    })));
  });

  it("expands multiple counted runner groups in request order", () => {
    expect(parseNlIntents(JSON.stringify({
      outcome: "intents",
      intents: [
        { action: "spawn_agent", runner: "claude", count: 2 },
        { action: "spawn_agent", runner: "codex", count: 3 },
      ],
      answer: null,
      error: null,
    }))).toEqual([
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "claude" },
      { action: "spawn_agent", runner: "codex" },
      { action: "spawn_agent", runner: "codex" },
      { action: "spawn_agent", runner: "codex" },
    ]);
  });

  it("rejects invalid or unsafe spawn counts instead of silently spawning one", () => {
    expect(parseNlIntents('[{"action":"spawn_agent","runner":"claude","count":0}]')).toMatchObject({ error: expect.any(String) });
    expect(parseNlIntents('[{"action":"spawn_agent","runner":"claude","count":51}]')).toMatchObject({ error: expect.any(String) });
    expect(parseNlIntents('[{"action":"spawn_agent","runner":"claude","count":1.5}]')).toMatchObject({ error: expect.any(String) });
    expect(parseNlIntents('[{"action":"spawn_agent","runner":"claude","count":26},{"action":"spawn_agent","runner":"codex","count":25}]')).toMatchObject({ error: expect.any(String) });
  });

  it("allows a production-sized spawn batch beyond the former limit of ten", () => {
    const parsed = parseNlIntents('[{"action":"spawn_agent","runner":"claude","count":25}]');
    expect(parsed).toHaveLength(25);
  });

  it("rejects a structured envelope whose discriminator conflicts with its payload", () => {
    expect(parseNlIntents(JSON.stringify({
      outcome: "answer",
      intents: [{ action: "close_all" }],
      answer: "Nothing happened.",
      error: null,
    }))).toMatchObject({ error: expect.any(String) });
  });

  it("passes an informational {answer} through (not an error, not an intent)", () => {
    expect(parseNlIntents('{"outcome":"answer","intents":null,"answer":"There are 6 agents on the canvas.","error":null}')).toEqual({
      answer: "There are 6 agents on the canvas.",
    });
  });

  it("extracts a top-level array from surrounding prose / fences", () => {
    const raw = "Sure:\n```json\n[{ \"action\": \"arrange\" }]\n```\n";
    expect(parseNlIntents(raw)).toEqual([{ action: "arrange" }]);
  });

  it("fails the whole batch when any element is invalid", () => {
    expect(parseNlIntents('[{"action":"arrange"},{"action":"explode"}]')).toMatchObject({ error: expect.any(String) });
    expect(parseNlIntents('[{"action":"focus"}]')).toMatchObject({ error: expect.any(String) });
  });

  it("rejects an empty array", () => {
    expect(parseNlIntents("[]")).toMatchObject({ error: expect.any(String) });
  });

  it("passes through an explicit model error", () => {
    expect(parseNlIntents('{"outcome":"error","intents":null,"answer":null,"error":"unsupported request"}')).toMatchObject({ error: "unsupported request" });
  });

  it("returns an error for non-JSON output", () => {
    expect(parseNlIntents("I cannot help with that.")).toMatchObject({ error: expect.any(String) });
  });
});

describe("buildRealtimeToolDefs (STS readiness)", () => {
  const defs = buildRealtimeToolDefs({ nodeKinds: ["terminal", "note"], agentNames: ["Skye"] });

  it("generates one function tool per registry intent, from the same source as the prompt", () => {
    expect(defs.map((d) => d.name).sort()).toEqual(INTENT_REGISTRY.map((d) => d.name).sort());
    for (const d of defs) {
      expect(d.type).toBe("function");
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.parameters).toMatchObject({ type: "object" });
    }
  });

  it("threads live enums (node kinds) into the create_node tool params", () => {
    const createNode = defs.find((d) => d.name === "create_node");
    expect((createNode?.parameters as { properties: { nodeType: { enum: string[] } } }).properties.nodeType.enum).toEqual([
      "terminal",
      "note",
    ]);
  });

  it("does not advertise CCS/CSP profile wrappers as native spawn runners", () => {
    const spawn = defs.find((d) => d.name === "spawn_agent");
    const enumValues = (spawn?.parameters as { properties: { runner: { enum: string[] } } }).properties.runner.enum;
    expect(enumValues).toContain("claude");
    expect(enumValues).toContain("codex");
    expect(enumValues).not.toContain("ccs");
    expect(enumValues).not.toContain("csp");
  });
});

describe("buildNlIntentJsonSchema (structured-outputs contract, from the same registry)", () => {
  const schema = buildNlIntentJsonSchema({ nodeKinds: ["terminal", "note"], agentNames: ["Skye"] }) as {
    type: string;
    properties: {
      outcome: { enum: string[] };
      intents: { anyOf: Array<{ type?: string; items?: { anyOf: Array<{ properties: { action: { const: string } }; required: string[]; additionalProperties: boolean }> } }> };
      answer: { type: string[] };
      error: { type: string[] };
    };
    required: string[];
    additionalProperties: boolean;
  };

  it("offers one strict root object with explicit intents, grounded-answer, and error outcomes", () => {
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.outcome.enum).toEqual(["intents", "answer", "error"]);
    expect(schema.required).toEqual(["outcome", "intents", "answer", "error"]);
    expect(schema.properties.answer.type).toEqual(["string", "null"]);
    expect(schema.properties.error.type).toEqual(["string", "null"]);
  });

  it("emits one strict variant per registry intent, each pinning its action via const", () => {
    const variants = schema.properties.intents.anyOf.find((variant) => variant.type === "array")!.items!.anyOf;
    expect(variants).toHaveLength(INTENT_REGISTRY.length);
    const actions = variants.map((v) => v.properties.action.const).sort();
    expect(actions).toEqual(INTENT_REGISTRY.map((d) => d.name).sort());
    for (const v of variants) {
      expect(v.additionalProperties).toBe(false);
      expect(v.required).toContain("action");
    }
  });

  it("advertises a bounded count on spawn_agent so strict output can represent multi-spawn", () => {
    const variants = schema.properties.intents.anyOf.find((variant) => variant.type === "array")!.items!.anyOf;
    const spawn = variants.find((variant) => variant.properties.action.const === "spawn_agent") as {
      properties: { count?: { type?: string; minimum?: number; maximum?: number } };
    };
    expect(spawn.properties.count).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
  });
});

/**
 * OpenAI's strict structured-output dialect cannot express "omit this key": every declared property
 * must appear in `required`, so an optional field is widened to accept `null` instead (see
 * `strictify_schema` in `src-tauri/src/nl_model.rs`). The grammar therefore now *permits* replies that
 * spell absence as an explicit null — and the parser has to read those as absent rather than as values.
 * Without this, enforcing the grammar would trade parse failures for a subtler bug: `brief: null`
 * dispatching an agent with a literal "null" first task.
 */
describe("parseNlIntents with explicit nulls for optional fields", () => {
  it("treats a null optional field as absent, not as a value", () => {
    const parsed = parseNlIntents(JSON.stringify({ intents: [{ action: "spawn_agent", runner: "claude", model: null, brief: null }] }));
    expect(parsed).toEqual([{ action: "spawn_agent", runner: "claude" }]);
    // Specifically: no key is carried through holding null.
    const [intent] = parsed as Array<Record<string, unknown>>;
    expect(Object.values(intent)).not.toContain(null);
  });

  it("falls back to the default runner when even the runner comes back null", () => {
    const parsed = parseNlIntents(JSON.stringify({ intents: [{ action: "spawn_agent", runner: null, model: null, brief: null }] }));
    expect(parsed).toEqual([{ action: "spawn_agent", runner: "claude" }]);
  });

  it("survives a null on every optional property of every registry intent", () => {
    // Contract sweep: for each intent, send its action plus every declared parameter set to null. The
    // parser may reject an intent whose parameter is genuinely required, but it must never throw and
    // must never emit a null-valued field.
    const schema = buildNlIntentJsonSchema({ nodeKinds: ["terminal", "note"], agentNames: ["Skye"] });
    const variants = (schema as {
      properties: {
        intents: { anyOf: Array<{ type?: string; items?: { anyOf: Array<{ properties: Record<string, unknown> }> } }> };
      };
    }).properties.intents.anyOf.find((variant) => variant.type === "array")!.items!.anyOf;

    for (const variant of variants) {
      const action = (variant.properties.action as { const: string }).const;
      const nulled: Record<string, unknown> = { action };
      for (const key of Object.keys(variant.properties)) {
        if (key !== "action") nulled[key] = null;
      }

      const parsed = parseNlIntents(JSON.stringify({ intents: [nulled] }));
      expect(parsed, `${action} must parse or error, never throw`).toBeDefined();
      if (Array.isArray(parsed)) {
        for (const intent of parsed) {
          const nullKeys = Object.entries(intent).filter(([, v]) => v === null).map(([k]) => k);
          expect(nullKeys, `${action} leaked null-valued keys`).toEqual([]);
        }
      }
    }
  });
});

/**
 * The Rust OpenAI adapter proves its strict-mode transform against a captured copy of this schema
 * (`src-tauri/tests/fixtures/nl-intent-schema.json`, used by `strictify_schema_makes_the_real_generated_
 * schema_sendable`). A fixture can't detect its own staleness: add an intent whose parameters introduce
 * a new shape and the Rust test would keep passing against the old capture while the real request 400s.
 * This test is that drift detector — if it fails, regenerate the fixture from these exact inputs.
 */
describe("nl intent schema fixture shared with the Rust OpenAI adapter", () => {
  // Must match the inputs the fixture was captured with.
  const FIXTURE_INPUT = {
    text: "open claude code agent",
    agentNames: ["Rowan", "Skye"],
    nodeKinds: CANVAS_CREATE_NODE_KINDS,
    nodeRefs: [{ id: "n1", name: "Browser 1", kind: "browser" }],
    selectedNodeIds: ["n1"],
    projectNames: ["Lotus"],
    hasBrowserNodes: true,
  } as unknown as Parameters<typeof buildNlIntentSchema>[0];

  it("is still identical to what the registry generates today", async () => {
    const { readFileSync } = await import("node:fs");
    // Vitest runs with apps/desktop as the cwd (see vitest.config.ts root).
    const captured = JSON.parse(readFileSync("src-tauri/tests/fixtures/nl-intent-schema.json", "utf8"));

    expect(
      buildNlIntentSchema(FIXTURE_INPUT),
      "Rust fixture is stale — regenerate src-tauri/tests/fixtures/nl-intent-schema.json from FIXTURE_INPUT",
    ).toEqual(captured);
  });
});
