import { describe, expect, it } from "vitest";
import {
  resolveVoiceOutcome,
  type VoiceRouterDeps,
} from "../voice-intent-router";
import type { CanvasVoiceContext } from "../canvas-voice-context";
import type { VoiceInputSettings } from "../voice-mode";

const settings: VoiceInputSettings = { autoSubmit: true, minWordsToSubmit: 2, polish: true, autoCleanup: false, dictationMode: "clean", sendRightAway: true };
const noVerb: VoiceRouterDeps = { hasCommandVerb: () => false };
const isVerb: VoiceRouterDeps = { hasCommandVerb: () => true };

const withAgent: CanvasVoiceContext = {
  focus: { nodeId: "a1", kind: "agent", name: "Rowan", agentId: "a1", isLiveAgent: true, selectedText: "" },
  selectionCount: 1,
};
const empty: CanvasVoiceContext = { focus: null, selectionCount: 0 };
const noteFocused: CanvasVoiceContext = {
  focus: { nodeId: "n1", kind: "note", name: "Spec", agentId: null, isLiveAgent: false, selectedText: "" },
  selectionCount: 1,
};
const terminalFocused: CanvasVoiceContext = {
  focus: { nodeId: "t1", kind: "terminal", name: "Terminal 1", agentId: null, isLiveAgent: false, selectedText: "" },
  selectionCount: 1,
};
const noteWithSelection: CanvasVoiceContext = {
  focus: { nodeId: "n1", kind: "note", name: "Spec", agentId: null, isLiveAgent: false, selectedText: "the quick brown fox" },
  selectionCount: 1,
};

describe("resolveVoiceOutcome — Auto Mode routing (ADR-0034)", () => {
  it("empty transcript → ignore", () => {
    expect(resolveVoiceOutcome("   ", withAgent, settings, noVerb).kind).toBe("ignore");
  });

  it("Auto: prose + focused agent → dictate to that agent (zero model)", () => {
    const o = resolveVoiceOutcome("fix the auth bug in the login flow", withAgent, settings, noVerb);
    expect(o).toEqual({ kind: "dictate", agentId: "a1", agentName: "Rowan", text: "fix the auth bug in the login flow", autoSend: true });
  });

  it("Auto: command verb wins even with an agent focused (precedence)", () => {
    const o = resolveVoiceOutcome("arrange the canvas", withAgent, settings, isVerb);
    expect(o).toEqual({ kind: "command", text: "arrange the canvas" });
  });

  it("Auto: prose + nothing focused → command pipeline (may be compound/conversational)", () => {
    const o = resolveVoiceOutcome("what agents are running", empty, settings, noVerb);
    expect(o).toEqual({ kind: "command", text: "what agents are running" });
  });

  it("keeps an explicit named-agent repository request on the grounded dispatch path", () => {
    expect(
      resolveVoiceOutcome("tell Rowan to analyze this repository", empty, settings, isVerb),
    ).toEqual({ kind: "command", text: "tell Rowan to analyze this repository" });
    expect(
      resolveVoiceOutcome("Rowan, analyze and explain this codebase", empty, settings, isVerb),
    ).toEqual({ kind: "command", text: "Rowan, analyze and explain this codebase" });
  });

  it("does not treat an unrelated Canvas verb as a repository-capable target", () => {
    expect(
      resolveVoiceOutcome("open the project and analyze this repository", empty, settings, isVerb),
    ).toEqual({
      kind: "insert",
      text: "open the project and analyze this repository",
      reason: "repository-needs-agent",
    });
  });

  it("never sends untargeted repository analysis to the canvas utility planner", () => {
    expect(
      resolveVoiceOutcome("Tolong analisis dan jelaskan proyek ini secara singkat", empty, settings, noVerb),
    ).toEqual({
      kind: "insert",
      text: "Tolong analisis dan jelaskan proyek ini secara singkat",
      reason: "repository-needs-agent",
    });
    expect(
      resolveVoiceOutcome("Analyze and briefly explain this repository", withAgent, settings, noVerb, "command"),
    ).toEqual({
      kind: "dictate",
      agentId: "a1",
      agentName: "Rowan",
      text: "Analyze and briefly explain this repository",
      autoSend: true,
    });
  });

  it("Auto: focused note with NO selection is not a dictate target → command", () => {
    const o = resolveVoiceOutcome("make this shorter", noteFocused, settings, noVerb);
    expect(o.kind).toBe("command");
  });

  it("Auto: text selected in a focused note → transform the selection (instruction = transcript)", () => {
    const o = resolveVoiceOutcome("make this bullet points", noteWithSelection, settings, noVerb);
    expect(o).toEqual({ kind: "transform", nodeId: "n1", instruction: "make this bullet points", selection: "the quick brown fox" });
  });

  it("Auto: a command verb still wins over a note selection", () => {
    const o = resolveVoiceOutcome("arrange the canvas", noteWithSelection, settings, isVerb);
    expect(o.kind).toBe("command");
  });

  it("forced command overrides a note selection → command (no transform)", () => {
    const o = resolveVoiceOutcome("translate to English", noteWithSelection, settings, noVerb, "command");
    expect(o.kind).toBe("command");
  });

  it("forced dictate (⌘⇧D) bypasses verb detection → dictate literal words", () => {
    const o = resolveVoiceOutcome("arrange the canvas", withAgent, settings, isVerb, "dictate");
    expect(o).toEqual({ kind: "dictate", agentId: "a1", agentName: "Rowan", text: "arrange the canvas", autoSend: true });
  });

  it("Auto: prose with a focused plain Terminal submits literal text to that Terminal", () => {
    const o = resolveVoiceOutcome("git status", terminalFocused, settings, noVerb);
    expect(o).toEqual({
      kind: "terminal-submit",
      nodeId: "t1",
      nodeName: "Terminal 1",
      text: "git status",
    });
  });

  it("routes repository work to a focused plain Terminal instead of the utility planner", () => {
    expect(
      resolveVoiceOutcome("analyze this repository", terminalFocused, settings, noVerb),
    ).toEqual({
      kind: "terminal-submit",
      nodeId: "t1",
      nodeName: "Terminal 1",
      text: "analyze this repository",
    });
  });

  it("forced dictate with a focused terminal inserts into that terminal without submitting", () => {
    const o = resolveVoiceOutcome("git status", terminalFocused, settings, noVerb, "dictate");
    expect(o).toEqual({
      kind: "terminal-insert",
      nodeId: "t1",
      nodeName: "Terminal 1",
      text: "git status",
    });
  });

  it("forced dictate with no agent focused → insert with no-dictate-target reason", () => {
    const o = resolveVoiceOutcome("hello there", empty, settings, noVerb, "dictate");
    expect(o).toEqual({ kind: "insert", text: "hello there", reason: "no-dictate-target" });
  });

  it("forced command (⌘⇧V) ignores focused agent → command", () => {
    const o = resolveVoiceOutcome("fix the bug now", withAgent, settings, noVerb, "command");
    expect(o).toEqual({ kind: "command", text: "fix the bug now" });
  });

  it("command below the word floor → insert (too-short guard), even in Auto", () => {
    const o = resolveVoiceOutcome("go", empty, settings, isVerb);
    expect(o).toEqual({ kind: "insert", text: "go", reason: "too-short" });
  });

  it("word floor never blocks dictate — a one-word message still dictates", () => {
    const o = resolveVoiceOutcome("stop", withAgent, settings, noVerb, "dictate");
    expect(o.kind).toBe("dictate");
  });

  it("autoSubmit off → command is held for review (insert)", () => {
    const o = resolveVoiceOutcome("close everything", empty, { ...settings, autoSubmit: false }, isVerb);
    expect(o).toEqual({ kind: "insert", text: "close everything", reason: "too-short" });
  });

  it("Send Right Away off → dictate carries autoSend:false so the bar holds it for review (Auto)", () => {
    const o = resolveVoiceOutcome("fix the auth bug in the login flow", withAgent, { ...settings, sendRightAway: false }, noVerb);
    expect(o).toEqual({ kind: "dictate", agentId: "a1", agentName: "Rowan", text: "fix the auth bug in the login flow", autoSend: false });
  });

  it("Send Right Away off → forced ⌘⇧D dictate also carries autoSend:false", () => {
    const o = resolveVoiceOutcome("stop", withAgent, { ...settings, sendRightAway: false }, noVerb, "dictate");
    expect(o).toEqual({ kind: "dictate", agentId: "a1", agentName: "Rowan", text: "stop", autoSend: false });
  });

  it("Send Right Away on → dictate carries autoSend:true (immediate send)", () => {
    const o = resolveVoiceOutcome("stop", withAgent, { ...settings, sendRightAway: true }, noVerb, "dictate");
    expect(o).toEqual({ kind: "dictate", agentId: "a1", agentName: "Rowan", text: "stop", autoSend: true });
  });
});

describe("explicit Dictate precedence", () => {
  it("inserts repository requests into terminals without submitting", () => {
    const text = "Analyze and explain this repository";
    expect(resolveVoiceOutcome(text, terminalFocused, settings, isVerb, "dictate"))
      .toEqual({ kind: "terminal-insert", nodeId: "t1", nodeName: "Terminal 1", text });
  });
});
