import { describe, expect, it, vi } from "vitest";
import { buildNodeIndex, resolveNodeByName, type NlCommandContext } from "../../canvas-nl-command";
import { executeS2sCanvasToolCall } from "../s2s-canvas-tool-executor";

function ctx(overrides: Partial<NlCommandContext> = {}): NlCommandContext {
  return {
    roster: [],
    nodeRefs: [],
    selectedNodeIds: [],
    ...overrides,
  };
}

describe("S2S voice grounding regressions", () => {
  it("adds runner ordinal aliases so Claude one / Cloud two / Codex resolve to visible agent nodes", () => {
    const refs = buildNodeIndex([
      { id: "sena", type: "agent", data: { name: "Sena", runner: "claude" } },
      { id: "nara", type: "agent", data: { name: "Nara", runner: "claude" } },
      { id: "bima", type: "agent", data: { name: "Bima", runner: "claude" } },
      { id: "bayu", type: "agent", data: { name: "Bayu", runner: "codex" } },
    ]);

    expect(resolveNodeByName("Claude one", refs, { kind: "agent" })).toMatchObject({ ok: true, id: "sena" });
    expect(resolveNodeByName("Cloud two", refs, { kind: "agent" })).toMatchObject({ ok: true, id: "nara" });
    expect(resolveNodeByName("claude-3", refs, { kind: "agent" })).toMatchObject({ ok: true, id: "bima" });
    expect(resolveNodeByName("Codex", refs, { kind: "agent" })).toMatchObject({ ok: true, id: "bayu" });
  });

  it("asks a natural clarification when a runner alias matches multiple live agents", () => {
    const dispatch = vi.fn(() => ({ delivered: [], queued: [], skipped: [] }));
    const nodeRefs = buildNodeIndex([
      { id: "sena", type: "agent", data: { name: "Sena", runner: "claude" } },
      { id: "nara", type: "agent", data: { name: "Nara", runner: "claude" } },
      { id: "bima", type: "agent", data: { name: "Bima", runner: "claude" } },
    ]);

    const result = executeS2sCanvasToolCall(
      { callId: "call-ambiguous", name: "dispatch", args: { target: "Claude", task: "review logging" } },
      ctx({ roster: nodeRefs.map((node) => ({ id: node.id, name: node.name, status: "running", aliases: node.aliases })), nodeRefs }),
      { runCommand: vi.fn(), dispatch, runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({
      ok: false,
      speak: "Which Claude — Sena, Nara, or Bima?",
      clarify: { ambiguousName: "Claude", candidates: [{ label: "Sena" }, { label: "Nara" }, { label: "Bima" }] },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("asks for confirmation instead of auto-dispatching a fuzzy medium-confidence target", () => {
    const dispatch = vi.fn(() => ({ delivered: [], queued: [], skipped: [] }));

    const result = executeS2sCanvasToolCall(
      { callId: "call-fuzzy", name: "dispatch", args: { target: "Bma", task: "review logging" } },
      ctx({
        roster: [{ id: "bima", name: "Bima", status: "running", aliases: ["Claude 3"] }],
        nodeRefs: [{ id: "bima", kind: "agent", name: "Bima", aliases: ["Claude 3"] }],
      }),
      { runCommand: vi.fn(), dispatch, runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({
      ok: false,
      speak: "Did you mean Bima?",
      clarify: { ambiguousName: "Bma", candidates: [{ label: "Bima" }] },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("resolves realtime dispatch targets like claude-3 against live roster ordinal aliases", () => {
    const dispatch = vi.fn(() => ({ delivered: ["bima"], queued: [], skipped: [] }));
    const nodeRefs = buildNodeIndex([
      { id: "sena", type: "agent", data: { name: "Sena", runner: "claude" } },
      { id: "nara", type: "agent", data: { name: "Nara", runner: "claude" } },
      { id: "bima", type: "agent", data: { name: "Bima", runner: "claude" } },
      { id: "bayu", type: "agent", data: { name: "Bayu", runner: "codex" } },
    ]);

    const result = executeS2sCanvasToolCall(
      { callId: "call-claude-3", name: "dispatch", args: { target: "claude-3", task: "review the logging utility" } },
      ctx({
        roster: nodeRefs.map((node) => ({ id: node.id, name: node.name, status: "running", aliases: node.aliases })),
        nodeRefs,
      }),
      { runCommand: vi.fn(), dispatch, runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Dispatch to Bima", speak: "I sent that to Bima." });
    expect(dispatch).toHaveBeenCalledWith("bima", "review the logging utility");
  });

  it("turns a greeting dispatch into an exact say_to_agent message, not an instruction wrapper", () => {
    const dispatch = vi.fn(() => ({ delivered: ["sena"], queued: [], skipped: [] }));

    const result = executeS2sCanvasToolCall(
      { callId: "call-hi", name: "dispatch", args: { target: "Codex", task: "Sampaikan salam: Halo, Sena!" } },
      ctx({
        roster: [{ id: "sena", name: "Sena", status: "running", aliases: ["Codex", "Codex agent"] }],
        nodeRefs: [{ id: "sena", kind: "agent", name: "Sena", aliases: ["Codex", "Codex agent"] }],
      }),
      { runCommand: vi.fn(), dispatch, runApp: vi.fn(() => false) },
    );

    expect(result).toMatchObject({ ok: true, summary: "Say to Sena", speak: "I said hello to Sena." });
    expect(dispatch).toHaveBeenCalledWith("sena", "Halo, Sena!");
  });
});
