import { describe, expect, it, vi } from "vitest";
import { createVoiceAgentOutputCorrelationRegistry } from "../voice-agent-output-correlation";

function createClock() {
  let now = 0;
  let timeout: (() => void) | null = null;
  return {
    clock: {
      now: () => now,
      setTimeout: (callback: () => void) => {
        timeout = callback;
        return () => { timeout = null; };
      },
    },
    advanceTo(value: number) { now = value; },
    expire() { timeout?.(); },
  };
}

describe("VoiceAgentOutputCorrelationRegistry", () => {
  it("correlates only the first meaningful post-Enter output and ignores prompt echo", () => {
    const timer = createClock();
    const onFirstOutput = vi.fn();
    const registry = createVoiceAgentOutputCorrelationRegistry({ clock: timer.clock, timeoutMs: 5_000 });

    expect(registry.arm({
      agentId: "agent-1",
      turnId: "turn-1",
      submittedText: "review authentication",
      onFirstOutput,
      onTimeout: vi.fn(),
    })).toBe(true);

    registry.noteOutput("agent-1", "startup repaint");
    expect(onFirstOutput).not.toHaveBeenCalled();

    timer.advanceTo(100);
    expect(registry.confirmEnter("turn-1")).toBe(true);
    registry.noteOutput("agent-1", "review authentication");
    registry.noteOutput("agent-1", "review auth");
    registry.noteOutput("agent-1", "? for shortcuts · bypass permissions on");
    expect(onFirstOutput).not.toHaveBeenCalled();

    timer.advanceTo(340);
    registry.noteOutput("agent-1", "Working (1s · esc to interrupt)");
    registry.noteOutput("agent-1", "first response token");

    expect(onFirstOutput).toHaveBeenCalledTimes(1);
    expect(onFirstOutput).toHaveBeenCalledWith({ turnId: "turn-1", elapsedSinceEnterMs: 240 });
  });

  it("keeps one unambiguous pending turn per agent and times it out", () => {
    const timer = createClock();
    const onTimeout = vi.fn();
    const registry = createVoiceAgentOutputCorrelationRegistry({ clock: timer.clock, timeoutMs: 5_000 });

    expect(registry.arm({
      agentId: "agent-1",
      turnId: "turn-1",
      submittedText: "first",
      onFirstOutput: vi.fn(),
      onTimeout,
    })).toBe(true);
    expect(registry.arm({
      agentId: "agent-1",
      turnId: "turn-2",
      submittedText: "second",
      onFirstOutput: vi.fn(),
      onTimeout: vi.fn(),
    })).toBe(false);

    expect(registry.confirmEnter("turn-1")).toBe(true);
    timer.expire();
    expect(onTimeout).toHaveBeenCalledWith({ turnId: "turn-1" });
  });
});
