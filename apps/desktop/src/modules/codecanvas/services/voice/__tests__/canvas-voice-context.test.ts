import { describe, expect, it } from "vitest";
import { buildCanvasVoiceContext, type VoiceContextNode } from "../canvas-voice-context";
import type { AgentStatusSnapshot } from "../../agent-status-registry";

const agent = (id: string, over: Partial<VoiceContextNode> = {}): VoiceContextNode => ({
  id,
  kind: "agent",
  name: id,
  selected: false,
  ...over,
});
const roster = (...ids: { id: string; name?: string; session?: boolean }[]): AgentStatusSnapshot[] =>
  ids.map((a) => ({ id: a.id, name: a.name ?? a.id, status: "idle", sessionId: a.session ? `sess-${a.id}` : null }));

describe("buildCanvasVoiceContext — Focused Node", () => {
  it("no selection → focus null, count 0", () => {
    const ctx = buildCanvasVoiceContext([agent("rowan"), agent("sage")], roster());
    expect(ctx.focus).toBeNull();
    expect(ctx.selectionCount).toBe(0);
  });

  it("multi-selection is NOT a Focused Node (selectionCount === 1 rule)", () => {
    const ctx = buildCanvasVoiceContext(
      [agent("rowan", { selected: true }), agent("sage", { selected: true })],
      roster({ id: "rowan" }, { id: "sage" }),
    );
    expect(ctx.focus).toBeNull();
    expect(ctx.selectionCount).toBe(2);
  });

  it("single selected agent → focus with agentId, name from live roster", () => {
    const ctx = buildCanvasVoiceContext(
      [agent("a1", { selected: true, name: "stale" }), agent("a2")],
      roster({ id: "a1", name: "Rowan", session: true }),
    );
    expect(ctx.focus).toEqual({
      nodeId: "a1",
      kind: "agent",
      name: "Rowan",
      agentId: "a1",
      isLiveAgent: true,
      selectedText: "",
    });
  });

  it("carries a focused note's selected text (trimmed) for the transform path", () => {
    const ctx = buildCanvasVoiceContext(
      [{ id: "n1", kind: "note", name: "Spec", selected: true, selectedText: "  hello world  " }],
      roster(),
    );
    expect(ctx.focus?.kind).toBe("note");
    expect(ctx.focus?.selectedText).toBe("hello world");
    expect(ctx.focus?.agentId).toBeNull();
  });

  it("focused agent with no session → agentId set but not a live dispatch target", () => {
    const ctx = buildCanvasVoiceContext([agent("a1", { selected: true })], roster({ id: "a1", session: false }));
    expect(ctx.focus?.agentId).toBe("a1");
    expect(ctx.focus?.isLiveAgent).toBe(false);
  });

  it("single selected non-agent node → focus present but agentId null", () => {
    const ctx = buildCanvasVoiceContext(
      [{ id: "n1", kind: "note", name: "Spec", selected: true }],
      roster(),
    );
    expect(ctx.focus?.agentId).toBeNull();
    expect(ctx.focus?.kind).toBe("note");
    expect(ctx.selectionCount).toBe(1);
  });

  it("falls back to node's own name when the agent is not in the roster", () => {
    const ctx = buildCanvasVoiceContext([agent("a1", { selected: true, name: "Kai" })], roster());
    expect(ctx.focus?.name).toBe("Kai");
    expect(ctx.focus?.isLiveAgent).toBe(false);
  });
});
