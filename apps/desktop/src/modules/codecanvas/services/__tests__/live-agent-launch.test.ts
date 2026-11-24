import { describe, expect, it, vi } from "vitest";
import {
  createLiveAgentLaunchController,
  canDispatchToLiveAgent,
  canQueueToLiveAgent,
} from "../live-agent-launch";
import type { AgentRunnerReadinessSignal, AgentRunnerReadinessTracker } from "@/lib/agent-runtime";

const spec = { command: "claude --dangerously-skip-permissions", submitText: "LIVE PROMPT" };

/** A scripted readiness tracker: returns the next queued signal per observe() call. */
function scriptedTracker(signals: AgentRunnerReadinessSignal[]): AgentRunnerReadinessTracker {
  let i = 0;
  return {
    adapter: { runner: "claude", timeoutMs: 1000, readyPatterns: [] },
    observe: () => signals[Math.min(i++, signals.length - 1)],
  };
}

describe("createLiveAgentLaunchController", () => {
  it("buffers only viable startup/running phases and rejects a failed launch", () => {
    expect(canQueueToLiveAgent("idle")).toBe(true);
    expect(canQueueToLiveAgent("awaiting-ready")).toBe(true);
    expect(canQueueToLiveAgent("ready")).toBe(true);
    expect(canQueueToLiveAgent("running")).toBe(true);
    expect(canQueueToLiveAgent("failed")).toBe(false);
  });

  it("writes the runner command to the PTY on start", () => {
    const write = vi.fn();
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({ spec, write, submit, tracker: scriptedTracker([{ state: "pending" }]) });
    expect(c.phase).toBe("idle");
    c.start();
    expect(write).toHaveBeenCalledWith("claude --dangerously-skip-permissions\n");
    expect(c.phase).toBe("awaiting-ready");
  });

  it("direct mode: the CLI is already the PTY child — start() types nothing, readiness still gates the task", () => {
    const write = vi.fn();
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({
      spec,
      write,
      submit,
      launchMode: "direct",
      tracker: scriptedTracker([{ state: "ready" }]),
    });
    c.start();
    expect(write).not.toHaveBeenCalled(); // no typed command — the process was spawned directly
    expect(c.phase).toBe("awaiting-ready");
    c.observe("? for shortcuts");
    expect(submit).toHaveBeenCalledExactlyOnceWith("LIVE PROMPT");
  });

  it("auto-submits the task via submit() exactly once when ready (if there is a task)", () => {
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({ spec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "pending" }, { state: "ready" }, { state: "ready" }]) });
    c.start();
    c.observe("booting...");        // pending → no submit
    expect(submit).not.toHaveBeenCalled();
    c.observe("? for shortcuts");   // ready → submit once (paste, caller handles delayed Enter)
    expect(submit).toHaveBeenCalledExactlyOnceWith("LIVE PROMPT");
    expect(c.phase).toBe("running");
    c.observe("more output");       // already running → never submit again
    expect(submit).toHaveBeenCalledOnce();
  });

  it("sits READY without submitting when there is no task (bare persona spawn)", () => {
    const submit = vi.fn();
    const bareSpec = { command: "claude --dangerously-skip-permissions", submitText: null };
    const c = createLiveAgentLaunchController({ spec: bareSpec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "ready" }]) });
    c.start();
    c.observe("? for shortcuts");   // ready, but no task → no submit, just ready
    expect(submit).not.toHaveBeenCalled();
    expect(c.phase).toBe("ready");
  });

  describe("Phase 5: runner-agnostic peer bootstrap submit", () => {
    const bootSpec = {
      command: "codex --dangerously-bypass-approvals-and-sandbox",
      submitText: "Fix the header",
      bootstrapText: "You are Nova ... use lotus_list_fleet",
    };

    it("submits the bootstrap BEFORE the task on a fresh ready transition", () => {
      const submit = vi.fn();
      const c = createLiveAgentLaunchController({ spec: bootSpec, write: vi.fn(), submit, launchMode: "direct", tracker: scriptedTracker([{ state: "ready" }]) });
      c.start();
      c.observe("codex ready");
      expect(submit).toHaveBeenNthCalledWith(1, "You are Nova ... use lotus_list_fleet");
      expect(submit).toHaveBeenNthCalledWith(2, "Fix the header");
      expect(c.phase).toBe("running");
    });

    it("submits only the bootstrap when there is no task, and sits ready", () => {
      const submit = vi.fn();
      const c = createLiveAgentLaunchController({ spec: { ...bootSpec, submitText: null }, write: vi.fn(), submit, launchMode: "direct", tracker: scriptedTracker([{ state: "ready" }]) });
      c.start();
      c.observe("codex ready");
      expect(submit).toHaveBeenCalledExactlyOnceWith("You are Nova ... use lotus_list_fleet");
      expect(c.phase).toBe("ready");
    });

    it("does NOT send the bootstrap when adopting an already-running session (reattach)", () => {
      const submit = vi.fn();
      const c = createLiveAgentLaunchController({ spec: bootSpec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "ready" }]) });
      c.adoptRunning();
      expect(submit).not.toHaveBeenCalled();
      expect(c.phase).toBe("ready");
    });
  });

  it("does not submit and surfaces failure when the runner fails to start", () => {
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({ spec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "failed", message: "command not found" }]) });
    c.start();
    c.observe("zsh: command not found: claude");
    expect(submit).not.toHaveBeenCalled();
    expect(c.phase).toBe("failed");
  });

  it("forceReady() is the safety net: makes an unrecognized-TUI persona dispatchable + submits once", () => {
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({ spec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "pending" }]) });
    c.start();
    c.observe("some banner we don't recognize"); // tracker never returns ready
    expect(c.phase).toBe("awaiting-ready");
    expect(submit).not.toHaveBeenCalled();
    c.forceReady();
    expect(c.phase).toBe("running");
    expect(submit).toHaveBeenCalledExactlyOnceWith("LIVE PROMPT");
  });

  it("forceReady() sits ready (no submit) for a bare spawn, and never double-submits or resurrects", () => {
    const submit = vi.fn();
    const bareSpec = { command: "claude --dangerously-skip-permissions", submitText: null };
    const c = createLiveAgentLaunchController({ spec: bareSpec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "ready" }]) });
    c.start();
    c.forceReady();
    expect(c.phase).toBe("ready");
    expect(submit).not.toHaveBeenCalled();
    // No-op once already ready/running (guards against double-submit).
    const c2 = createLiveAgentLaunchController({ spec, write: vi.fn(), submit: vi.fn(), tracker: scriptedTracker([{ state: "ready" }]) });
    c2.start();
    c2.observe("? for shortcuts"); // → running via tracker
    c2.forceReady(); // must not re-run
    expect(c2.phase).toBe("running");
  });

  it("adoptRunning() makes a reattached session dispatchable WITHOUT typing the command or re-submitting", () => {
    const write = vi.fn();
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({ spec, write, submit, tracker: scriptedTracker([{ state: "ready" }]) });
    // Reattach after a project switch: the CLI is still alive, so we neither type the launch
    // command nor re-submit the initial task — we just re-arm dispatch.
    c.adoptRunning();
    expect(c.phase).toBe("ready");
    expect(write).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    // Idempotent / no resurrection once adopted.
    c.adoptRunning();
    expect(c.phase).toBe("ready");
  });

  it("forceReady() before start() is a no-op (nothing to force while idle)", () => {
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({ spec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "pending" }]) });
    c.forceReady();
    expect(c.phase).toBe("idle");
    expect(submit).not.toHaveBeenCalled();
  });

  it("accepts dispatched tasks only once the runner is up (ready or running)", () => {
    expect(canDispatchToLiveAgent("ready")).toBe(true);
    expect(canDispatchToLiveAgent("running")).toBe(true);
    expect(canDispatchToLiveAgent("idle")).toBe(false);
    expect(canDispatchToLiveAgent("awaiting-ready")).toBe(false);
    expect(canDispatchToLiveAgent("failed")).toBe(false);
  });

  it("falls back to a bare relaunch when a resumed session is gone (ADR-0027 Phase 5)", () => {
    const write = vi.fn();
    const onResumeFailed = vi.fn();
    const resumeSpec = { command: "claude --dangerously-skip-permissions --resume dead-id", submitText: "LIVE PROMPT" };
    const c = createLiveAgentLaunchController({
      spec: resumeSpec,
      write,
      submit: vi.fn(),
      fallbackCommand: "claude --dangerously-skip-permissions",
      onResumeFailed,
      tracker: scriptedTracker([{ state: "pending" }]),
    });
    c.start();
    expect(write).toHaveBeenCalledWith("claude --dangerously-skip-permissions --resume dead-id\n");
    c.observe("No conversation found with session ID: dead-id");
    // Recovered: cleared the dead id and relaunched bare, exactly once, still awaiting the new runner.
    expect(onResumeFailed).toHaveBeenCalledOnce();
    expect(write).toHaveBeenLastCalledWith("claude --dangerously-skip-permissions\n");
    expect(c.phase).toBe("awaiting-ready");
    // A second failure line does not trigger another relaunch.
    c.observe("No conversation found with session ID: dead-id");
    expect(onResumeFailed).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(2);
  });

  // A direct spawn has no shell to type into — the CLI IS the PTY child — so the recovery is to
  // tell the caller and let it respawn, never to type a command at a process that is not a shell
  // (`plans/codecanvas-session-refactor/issues/08`).
  it("asks the caller to respawn when a direct-spawn resume finds no session", () => {
    const write = vi.fn();
    const onResumeFailed = vi.fn();
    const c = createLiveAgentLaunchController({
      spec: { command: "claude --resume dead-id", submitText: null },
      write,
      submit: vi.fn(),
      launchMode: "direct",
      fallbackCommand: "claude",
      onResumeFailed,
      tracker: scriptedTracker([{ state: "pending" }]),
    });
    c.start();
    expect(write).not.toHaveBeenCalled();

    c.observe("No conversation found with session ID: dead-id");

    expect(onResumeFailed).toHaveBeenCalledOnce();
    expect(write).not.toHaveBeenCalled();
    // Nothing is left awaiting a runner that will never arrive; the respawn owns what happens next.
    expect(c.phase).toBe("failed");
  });

  it("detects the resume-failure line even when split across chunks", () => {
    const write = vi.fn();
    const c = createLiveAgentLaunchController({
      spec: { command: "claude --resume x", submitText: null },
      write,
      submit: vi.fn(),
      fallbackCommand: "claude",
      onResumeFailed: vi.fn(),
      tracker: scriptedTracker([{ state: "pending" }]),
    });
    c.start();
    c.observe("No conversation found ");
    c.observe("with session ID: x");
    expect(write).toHaveBeenLastCalledWith("claude\n");
  });

  it("ignores output observed before start (no premature submit)", () => {
    const submit = vi.fn();
    const c = createLiveAgentLaunchController({ spec, write: vi.fn(), submit, tracker: scriptedTracker([{ state: "ready" }]) });
    c.observe("? for shortcuts");
    expect(submit).not.toHaveBeenCalled();
    expect(c.phase).toBe("idle");
  });
});
