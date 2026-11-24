import { describe, expect, it, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { describeVoiceAdapterContract } from "@/modules/voice-core/testing/voice-adapter-contract";
import type { AgentStatusSnapshot } from "../../agent-status-registry";
import {
  CANVAS_ADDED_TO_MESSAGE_REASON,
  canvasCannotTakeUnsentReason,
  createCanvasVoiceAdapter,
  type CanvasVoiceRoutes,
} from "../canvas-voice-adapter";
import type { VoiceLiveTools } from "@/modules/voice-core/voice-adapter";
import { DEFAULT_VOICE_INPUT, type VoiceInputSettings } from "../voice-mode";

interface Setup {
  nodes?: Node[];
  roster?: AgentStatusSnapshot[];
  settings?: Partial<VoiceInputSettings>;
  routes?: Partial<CanvasVoiceRoutes>;
  liveTools?: VoiceLiveTools;
}

const agentNode = (id: string, name: string, selected = false): Node =>
  ({ id, type: "agent", position: { x: 0, y: 0 }, data: { name }, selected }) as Node;
const terminalNode = (id: string, label: string, selected = false): Node =>
  ({ id, type: "terminal", position: { x: 0, y: 0 }, data: { label }, selected }) as Node;
const live = (id: string, name: string): AgentStatusSnapshot =>
  ({ id, name, status: "idle", sessionId: `s-${id}` }) as AgentStatusSnapshot;

function makeCanvas(setup: Setup = {}) {
  const nodes = setup.nodes ?? [agentNode("a1", "Skye", true), terminalNode("t1", "Build")];
  const roster = setup.roster ?? [live("a1", "Skye")];
  const effects: string[] = [];
  const routes: CanvasVoiceRoutes = {
    command: vi.fn(async (text: string) => { effects.push(`command:${text}`); return true; }),
    dictate: vi.fn(async (agentId: string, _name: string, text: string) => {
      effects.push(`dictate:${agentId}:${text}`);
      return { text, delivery: "written" as const };
    }),
    insertAgent: vi.fn((agentId: string, _name: string, text: string) => {
      effects.push(`insert:${agentId}:${text}`);
      return { ok: true as const };
    }),
    insertTerminal: vi.fn(() => false),
    submitTerminal: vi.fn(async (nodeId: string, _name: string, text: string) => { effects.push(`terminal:${nodeId}:${text}`); return true; }),
    transform: vi.fn(async () => true),
    ...setup.routes,
  };
  const ui = {
    text: "",
    traces: [] as Array<{ text: string; tone: "ok" | "error" }>,
    keptFor: [] as Array<string | null>,
  };
  const adapter = createCanvasVoiceAdapter({
    getNodes: () => nodes,
    getRoster: () => roster,
    getInputSettings: () => ({ ...DEFAULT_VOICE_INPUT, ...setup.settings }),
    hasCommandVerb: (text) => /^(create|open|close)\b/i.test(text),
    routes,
    ui: {
      setText: (next) => {
        const value = typeof next === "function" ? next(ui.text) : next;
        if (value !== ui.text) effects.push(`text:${value}`);
        ui.text = value;
      },
      focusInput: () => {},
      setTrace: (trace) => ui.traces.push(trace),
      hasText: () => ui.text.trim() !== "",
      keepFor: (target) => ui.keptFor.push(target?.id ?? null),
      interruptSpeech: () => {},
    },
    liveTools: setup.liveTools,
  });
  const select = (id: string) => {
    for (const node of nodes) node.selected = node.id === id;
  };
  return { adapter, routes, ui, effects, select, settings: (setup.settings ??= {}) };
}

describeVoiceAdapterContract("canvas", () => {
  const liveTools: VoiceLiveTools = {
    instructions: "You run the canvas.",
    tools: [{ type: "function", name: "dispatch", description: "Send a task to an agent.", parameters: { type: "object", properties: {} } }],
    execute: async (call) => (call.name === "dispatch" ? { ok: true } : { error: `unknown tool ${call.name}` }),
  };
  const canvas = makeCanvas({ nodes: [agentNode("a1", "Skye"), terminalNode("t1", "Build")], liveTools });
  return {
    adapter: canvas.adapter,
    targetNames: ["Skye", "Build"],
    sendable: { text: "create a terminal" },
    // A forced spoken dictation with no agent selected stays in the bar.
    holdable: { text: "fix the flaky login test please", intent: { source: "voice", forced: "dictate" } },
    effects: () => canvas.effects.filter((e) => !e.startsWith("text:")).length,
  };
});

const SKYE = { id: "a1", name: "Skye" };
const nodeOf = (effect: string) => effect.split(":")[1];

describeVoiceAdapterContract("canvas, a focused agent", () => {
  const canvas = makeCanvas({ nodes: [agentNode("a1", "Skye", true), agentNode("a2", "Rowan")], roster: [live("a1", "Skye"), live("a2", "Rowan")] });
  const delivered = () => canvas.effects.filter((e) => e.startsWith("dictate:")).map(nodeOf);
  let insertRefused = false;
  vi.mocked(canvas.routes.insertAgent).mockImplementation((agentId, _name, text) => {
    if (insertRefused) return { ok: false };
    canvas.effects.push(`insert:${agentId}:${text}`);
    return { ok: true };
  });
  return {
    adapter: canvas.adapter,
    targetNames: ["Skye", "Rowan"],
    sendable: { text: "create a terminal" },
    effects: () => canvas.effects.filter((e) => !e.startsWith("text:")).length,
    lockedTarget: {
      target: SKYE,
      text: "fix the flaky login test",
      moveFocus: () => canvas.select("a2"),
      deliveredTo: delivered,
    },
    heldPrompt: {
      target: SKYE,
      text: "fix the flaky login test",
      prompted: () => canvas.effects.filter((e) => e.startsWith("insert:")).map(nodeOf),
      sent: delivered,
      typeInComposer: () => {
        canvas.ui.text = "and the lint";
      },
      cannotTakeUnsent: () => {
        insertRefused = true;
      },
      setSendRightAway: (on) => {
        canvas.settings.sendRightAway = on;
      },
    },
  };
});

describe("Canvas Voice Adapter", () => {
  it("sends typed prose to the focused agent", async () => {
    const { adapter, effects } = makeCanvas();
    const result = await adapter.deliver("fix the flaky login test", { source: "typed" });
    expect(result).toMatchObject({ status: "sent", route: "dictate", text: "fix the flaky login test" });
    expect(effects).toContain("dictate:a1:fix the flaky login test");
  });

  it("runs a canvas command verb through the NL pipeline even with an agent focused", async () => {
    const { adapter, effects } = makeCanvas();
    const result = await adapter.deliver("create a terminal", { source: "voice" });
    expect(result).toMatchObject({ status: "sent", route: "command" });
    expect(effects).toContain("command:create a terminal");
  });

  it("sends a typed message addressed to a terminal to that terminal", async () => {
    const { adapter, effects } = makeCanvas();
    const result = await adapter.deliver("tell Build to npm test", { source: "typed" });
    expect(result).toMatchObject({ status: "sent", route: "terminal-submit" });
    expect(effects).toContain("terminal:t1:npm test");
  });

  it("reports a failed agent write", async () => {
    const { adapter } = makeCanvas({
      routes: { dictate: async (_id, _name, text) => ({ text, delivery: "failed" }) },
    });
    const result = await adapter.deliver("fix the flaky login test", { source: "typed" });
    expect(result).toMatchObject({ status: "failed", route: "dictate" });
  });

  it("reports a failed command when the NL pipeline could not carry it out", async () => {
    const { adapter } = makeCanvas({ routes: { command: async () => false } });
    const result = await adapter.deliver("create a terminal", { source: "typed" });
    expect(result).toMatchObject({ status: "failed", route: "command", text: "create a terminal" });
  });

  it("puts spoken dictation, unsent, in the agent's own prompt by default", async () => {
    const { adapter, effects } = makeCanvas();
    const result = await adapter.deliver("fix the flaky login test", { source: "voice" });
    expect(result).toEqual({ status: "prompted", route: "dictate", text: "fix the flaky login test", target: SKYE });
    expect(effects).toEqual(["insert:a1:fix the flaky login test"]);
  });

  it("keeps the dictation in the bar, with the reason, when the agent's prompt cannot take text", async () => {
    const { adapter, ui, effects } = makeCanvas({ routes: { insertAgent: () => ({ ok: false }) } });
    const result = await adapter.deliver("fix the flaky login test", { source: "voice" });
    expect(result).toEqual({
      status: "held",
      route: "composer",
      text: "fix the flaky login test",
      reason: canvasCannotTakeUnsentReason("Skye"),
    });
    expect(ui.text).toBe("fix the flaky login test");
    expect(effects.filter((e) => !e.startsWith("text:"))).toEqual([]);
  });

  it("adds spoken dictation to a message already in the bar", async () => {
    const { adapter, ui } = makeCanvas();
    ui.text = "please";
    const result = await adapter.deliver("fix the flaky login test", { source: "voice" });
    expect(result).toMatchObject({ status: "held", route: "composer", reason: CANVAS_ADDED_TO_MESSAGE_REASON });
    expect(ui.text).toBe("please fix the flaky login test");
  });

  it("keeps a spoken turn for the agent it was spoken to when the focus moved, and the next Enter sends it there", async () => {
    const { adapter, ui, effects, select } = makeCanvas();
    select("t1");
    const result = await adapter.deliver("fix the flaky login test", { source: "voice", target: SKYE });
    expect(result).toMatchObject({ status: "held", route: "composer" });
    expect(ui.keptFor).toEqual(["a1"]);
    await adapter.deliver(ui.text, { source: "typed", target: SKYE });
    expect(effects).toContain("dictate:a1:fix the flaky login test");
  });

  it("adds a later turn to the text kept in the bar without losing the agent it was kept for", async () => {
    const { adapter, ui, effects, select } = makeCanvas({
      nodes: [agentNode("a1", "Skye", true), agentNode("a2", "Rowan")],
      roster: [live("a1", "Skye"), live("a2", "Rowan")],
    });
    select("a2");
    await adapter.deliver("fix the flaky login test", { source: "voice", target: SKYE });
    await adapter.deliver("and add a test", { source: "voice", target: { id: "a2", name: "Rowan" } });
    expect(ui.keptFor).toEqual(["a1"]);
    await adapter.deliver(ui.text, { source: "typed", target: SKYE });
    expect(effects).toContain("dictate:a1:fix the flaky login test and add a test");
  });

  it("still runs a spoken command when the focus moved", async () => {
    const { adapter, effects, select } = makeCanvas();
    select("t1");
    const result = await adapter.deliver("create a terminal", { source: "voice", target: SKYE });
    expect(result).toMatchObject({ status: "sent", route: "command" });
    expect(effects).toContain("command:create a terminal");
  });

  it("waits for an asynchronous dictation rewrite (automatic cleanup) before delivering", async () => {
    const { adapter, effects } = makeCanvas();
    const result = await adapter.deliver("lotus voice is uh ready", {
      source: "voice",
      rewriteDictation: async (text) => (text === "lotus voice is uh ready" ? "Lotus Voice is ready." : text),
    });
    expect(result).toMatchObject({ status: "prompted", route: "dictate" });
    expect(effects).toEqual(["insert:a1:Lotus Voice is ready."]);
  });

  it("never rewrites a spoken command", async () => {
    const rewriteDictation = vi.fn((text: string) => text.toUpperCase());
    const { adapter, effects } = makeCanvas();
    await adapter.deliver("create a terminal", { source: "voice", rewriteDictation });
    expect(rewriteDictation).not.toHaveBeenCalled();
    expect(effects).toContain("command:create a terminal");
  });

  it("auto-sends spoken dictation when the setting is on", async () => {
    const { adapter, effects } = makeCanvas({ settings: { sendRightAway: true } });
    const result = await adapter.deliver("fix the flaky login test", { source: "voice" });
    expect(result).toMatchObject({ status: "sent", route: "dictate", delivery: "written" });
    expect(effects).toContain("dictate:a1:fix the flaky login test");
  });

  it("keeps a forced dictation in the bar with the reason when no agent is selected", async () => {
    const { adapter, ui } = makeCanvas({ nodes: [agentNode("a1", "Skye")] });
    const result = await adapter.deliver("fix the flaky login test please", { source: "voice", forced: "dictate" });
    expect(result).toMatchObject({ status: "held", reason: "no agent selected" });
    expect(ui.text).toBe("fix the flaky login test please");
  });

  it("does not report sent when the turn is cancelled while delivering", async () => {
    const controller = new AbortController();
    const { adapter } = makeCanvas({
      routes: { command: async () => { controller.abort(); return true; } },
    });
    const result = await adapter.deliver("create a terminal", { source: "typed", signal: controller.signal });
    expect(result).toMatchObject({ status: "failed", reason: "cancelled" });
  });

  it("lists agents as busy while they run", () => {
    const { adapter } = makeCanvas({ roster: [{ ...live("a1", "Skye"), status: "running" }] });
    expect(adapter.targets()).toEqual([
      { id: "a1", name: "Skye", kind: "agent", busy: true },
      { id: "t1", name: "Build", kind: "terminal" },
    ]);
  });
});
