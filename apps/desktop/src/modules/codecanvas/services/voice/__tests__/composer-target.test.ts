import { describe, expect, it } from "vitest";
import { composerTargetFor, type ComposerTargetDeps } from "../composer-target";
import type { VoiceRouterDeps } from "../voice-intent-router";
import type { CanvasVoiceContext } from "../canvas-voice-context";

const noVerb: VoiceRouterDeps = { hasCommandVerb: () => false };
const isVerb: VoiceRouterDeps = { hasCommandVerb: () => true };

const nothing: CanvasVoiceContext = { focus: null, selectionCount: 0 };
const rowan: CanvasVoiceContext = {
  focus: { nodeId: "a1", kind: "agent", name: "Rowan", agentId: "a1", isLiveAgent: true, selectedText: "" },
  selectionCount: 1,
};
const terminal: CanvasVoiceContext = {
  focus: { nodeId: "t1", kind: "terminal", name: "Terminal 1", agentId: null, isLiveAgent: false, selectedText: "" },
  selectionCount: 1,
};
const noteWithSelection: CanvasVoiceContext = {
  focus: { nodeId: "n1", kind: "note", name: "Spec", agentId: null, isLiveAgent: false, selectedText: "the quick brown fox" },
  selectionCount: 1,
};

describe("composerTargetFor — where Enter goes, from the router's fast path", () => {
  it("a canvas verb goes to Lotus, even with an agent focused", () => {
    expect(composerTargetFor("arrange the agents in a grid", rowan, isVerb)).toEqual({ to: "lotus", decides: false });
  });

  it("prose with an agent focused goes to that agent", () => {
    expect(composerTargetFor("fix the auth bug in the login flow", rowan, noVerb)).toEqual({
      to: "agent",
      id: "a1",
      name: "Rowan",
    });
  });

  it("prose the fast path cannot place goes to Lotus, which decides", () => {
    expect(composerTargetFor("what agents are running and which one is stuck", nothing, noVerb)).toEqual({
      to: "lotus",
      decides: true,
    });
  });

  it("never names an agent the fast path did not resolve", () => {
    // Named in the words, but nothing focused: only Lotus can work out who Skye is.
    expect(composerTargetFor("Skye, look at the failing tests", nothing, noVerb)).toEqual({ to: "lotus", decides: true });
    expect(composerTargetFor("tell Skye to look at the failing tests", nothing, isVerb)).toEqual({ to: "lotus", decides: false });
    // Named in the words, Rowan focused: the fast path sends it to Rowan, so the label says Rowan.
    expect(composerTargetFor("Skye, look at the failing tests", rowan, noVerb)).toMatchObject({ to: "agent", name: "Rowan" });
  });

  it("an empty field is labelled as prose would go", () => {
    expect(composerTargetFor("", rowan, noVerb)).toEqual({ to: "agent", id: "a1", name: "Rowan" });
    expect(composerTargetFor("  ", nothing, noVerb)).toEqual({ to: "lotus", decides: false });
  });

  it("a focused terminal takes the text itself", () => {
    expect(composerTargetFor("ls -la", terminal, noVerb)).toEqual({ to: "terminal", id: "t1", name: "Terminal 1" });
  });

  it("a terminal named in the words takes them before the router reads them", () => {
    const deps: ComposerTargetDeps = {
      ...noVerb,
      addressedTerminal: (text) => (text.startsWith("Terminal 1,") ? { nodeId: "t1", nodeName: "Terminal 1" } : null),
    };
    expect(composerTargetFor("Terminal 1, ls -la", rowan, deps)).toEqual({ to: "terminal", id: "t1", name: "Terminal 1" });
    expect(composerTargetFor("look at the failing tests", rowan, deps)).toMatchObject({ to: "agent", name: "Rowan" });
  });

  it("an instruction about selected note text edits that note", () => {
    expect(composerTargetFor("make this shorter", noteWithSelection, noVerb)).toEqual({ to: "note", id: "n1", name: "Spec" });
  });

  it("a turn forced to Command goes to Lotus whatever has focus", () => {
    expect(composerTargetFor("", rowan, noVerb, "command")).toEqual({ to: "lotus", decides: false });
    expect(composerTargetFor("summarise the board for me", rowan, noVerb, "command")).toEqual({ to: "lotus", decides: false });
  });
});
