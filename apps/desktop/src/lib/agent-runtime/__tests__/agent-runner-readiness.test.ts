import { describe, expect, it } from "vitest";
import {
  createAgentRunnerReadinessTracker,
  getAgentRunnerReadinessAdapter,
} from "../agent-runner-readiness";

describe("agent runner readiness adapters", () => {
  it("detects Claude-family readiness from the interactive prompt signal", () => {
    const tracker = createAgentRunnerReadinessTracker("claude");

    expect(tracker.observe("Welcome to Claude Code\n")).toEqual({ state: "pending" });
    expect(tracker.observe("Tips for getting started\n? for shortcuts\n")).toEqual({ state: "ready" });
  });

  it("detects current Claude Code readiness from the permission-mode footer", () => {
    const tracker = createAgentRunnerReadinessTracker("claude");

    expect(tracker.observe("Claude Code v2.1.170\nSonnet 4.6 · Claude Team\n")).toEqual({ state: "pending" });
    expect(tracker.observe("▸▸ bypass permissions on (shift+tab to cycle) · ← for agents\n")).toEqual({ state: "ready" });
  });

  it("detects Claude readiness even when ANSI styling splits the footer words", () => {
    const tracker = createAgentRunnerReadinessTracker("claude");

    expect(tracker.observe("\u001b[35m▸▸ by\u001b[0m\u001b[35mpass permissions on\u001b[0m (shift+tab to cycle)\n")).toEqual({ state: "ready" });
  });

  it("detects Claude Code v2.1.201 readiness from the mode-cycle footer in any permission mode", () => {
    // Default mode (no "bypass permissions on" line) — the mode-cycle hint is the stable anchor.
    const t1 = createAgentRunnerReadinessTracker("claude");
    expect(t1.observe("Claude Code v2.1.201\nFable 5 with high effort · Claude Team\n")).toEqual({ state: "pending" });
    expect(t1.observe("▸▸ accept edits on (shift+tab to cycle) · ← for agents\n")).toEqual({ state: "ready" });
  });

  it("detects Claude readiness even when the footer is fragmented across newlines/spaces", () => {
    const tracker = createAgentRunnerReadinessTracker("claude");
    // Cursor-positioned box redraw: the hint words land split across whitespace after stripAnsi.
    expect(tracker.observe("▸▸ bypass\n  permissions   on\n(shift+tab\nto cycle)\n")).toEqual({ state: "ready" });
  });

  it("detects Codex readiness from the Codex prompt signal", () => {
    const tracker = createAgentRunnerReadinessTracker("codex");

    expect(tracker.observe("OpenAI Codex v0.1\n")).toEqual({ state: "pending" });
    expect(tracker.observe("▌ Ask Codex to do anything\n")).toEqual({ state: "ready" });
  });

  it("detects the newer Codex (gpt-5.x) TUI from its live status bar", () => {
    const tracker = createAgentRunnerReadinessTracker("codex");

    expect(tracker.observe("model: gpt-5.5 high\npermissions: YOLO mode\n")).toEqual({ state: "pending" });
    // The status footer only renders once the prompt is interactive.
    expect(tracker.observe("> Implement {feature}\ngpt-5.5 high · Context 0% used\n")).toEqual({ state: "ready" });
  });

  it("detects the newer Codex TUI from the bypass-permissions footer hint", () => {
    const tracker = createAgentRunnerReadinessTracker("codex");

    expect(tracker.observe("Tip: Try the Codex App.\n")).toEqual({ state: "pending" });
    expect(tracker.observe("▸▸ bypass permissions on (shift+tab to cycle)\n")).toEqual({ state: "ready" });
  });

  it("detects Cursor agent readiness (ADR-0027)", () => {
    const tracker = createAgentRunnerReadinessTracker("cursor");

    expect(tracker.observe("starting…\n")).toEqual({ state: "pending" });
    expect(tracker.observe("Cursor Agent — yolo mode\n")).toEqual({ state: "ready" });
  });

  it("classifies terminal runner startup failures before timeout", () => {
    const tracker = createAgentRunnerReadinessTracker("claude");

    expect(tracker.observe("zsh: command not found: claude\n")).toEqual({
      state: "failed",
      message: "Agent runner failed to start: command not found",
    });
  });

  it("uses runner-specific readiness timeouts", () => {
    expect(getAgentRunnerReadinessAdapter("claude").timeoutMs).toBe(45_000);
    expect(getAgentRunnerReadinessAdapter("codex").timeoutMs).toBe(60_000);
    expect(getAgentRunnerReadinessAdapter("custom").timeoutMs).toBe(15_000);
  });
});
