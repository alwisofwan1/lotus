import { afterEach, describe, expect, it, vi } from "vitest";
import { createS2sAutoEndRuntime } from "../s2s-auto-end-runtime";
import type { S2sPhase } from "@/modules/voice-core/s2s-session";

const FAST_POLICY = {
  idleTimeoutMs: 50,
  clarificationIdleTimeoutMs: 100,
  listeningTurnSettleMs: 25,
  thinkingTurnSettleMs: 25,
  postAgentGraceMs: 0,
  maxDurationMs: 1_000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("S2S auto-end runtime", () => {
  it("ends a settled turn once and ignores subsequent polling", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let phase: S2sPhase = "listening";
    const onEnd = vi.fn(() => { phase = "closed"; });
    const runtime = createS2sAutoEndRuntime({
      getPhase: () => phase,
      getAgentSpeaking: () => false,
      hasPendingClarification: () => false,
      getPolicy: () => FAST_POLICY,
      onEnd,
      pollMs: 10,
    });

    runtime.startSession();
    runtime.markTurnSettled();
    runtime.startPolling();
    vi.advanceTimersByTime(100);

    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith("turn-complete", "Live voice ended.");
    runtime.stopSession();
  });

  it("waits for farewell completion but has a bounded fallback", () => {
    vi.useFakeTimers();
    let phase: S2sPhase = "thinking";
    const onEnd = vi.fn(() => { phase = "closed"; });
    const runtime = createS2sAutoEndRuntime({
      getPhase: () => phase,
      getAgentSpeaking: () => true,
      hasPendingClarification: () => false,
      getPolicy: () => FAST_POLICY,
      onEnd,
      farewellFallbackMs: 40,
    });

    runtime.startSession();
    runtime.requestGracefulEnd("voice-command", "Goodbye.");
    expect(runtime.hasPendingGracefulEnd()).toBe(true);
    vi.advanceTimersByTime(39);
    expect(onEnd).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onEnd).toHaveBeenCalledWith("voice-command", "Goodbye.");
    expect(runtime.hasPendingGracefulEnd()).toBe(false);
  });

  it("finalizes a pending farewell immediately when agent audio ends", () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const runtime = createS2sAutoEndRuntime({
      getPhase: () => "thinking",
      getAgentSpeaking: () => true,
      hasPendingClarification: () => false,
      getPolicy: () => FAST_POLICY,
      onEnd,
      farewellFallbackMs: 100,
    });

    runtime.startSession();
    runtime.requestGracefulEnd("voice-command", "See you.");
    runtime.markAgentAudioEnd();
    runtime.finalizeGracefulEnd();
    vi.advanceTimersByTime(100);

    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith("voice-command", "See you.");
  });

  it("keeps the session when the farewell is cancelled", () => {
    vi.useFakeTimers();
    const onEnd = vi.fn();
    const runtime = createS2sAutoEndRuntime({
      getPhase: () => "agent",
      getAgentSpeaking: () => true,
      hasPendingClarification: () => false,
      getPolicy: () => FAST_POLICY,
      onEnd,
      farewellFallbackMs: 40,
    });

    runtime.startSession();
    runtime.requestGracefulEnd("voice-command", "Bye.");
    runtime.cancelGracefulEnd();
    runtime.finalizeGracefulEnd();
    vi.advanceTimersByTime(100);

    expect(onEnd).not.toHaveBeenCalled();
    expect(runtime.hasPendingGracefulEnd()).toBe(false);
  });
});
