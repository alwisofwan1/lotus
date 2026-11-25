import { describe, expect, it } from "vitest";
import { evaluateS2sAutoEnd, S2S_AUTO_END_DEFAULTS, S2S_LIVE_VOICE_END_POLICY } from "../s2s-auto-end-policy";

describe("S2S_LIVE_VOICE_END_POLICY", () => {
  it.each([
    ["turn settled long ago", { phase: "listening" as const, turnSettledAtMs: 0, lastActivityAtMs: 0 }],
    ["thinking settled long ago", { phase: "thinking" as const, turnSettledAtMs: 0, lastActivityAtMs: 0 }],
    ["silent for 59 minutes", { phase: "listening" as const, turnSettledAtMs: null, lastActivityAtMs: 0 }],
  ])("never ends the session on its own: %s", (_name, snap) => {
    const decision = evaluateS2sAutoEnd(
      { nowMs: 59 * 60_000, startedAtMs: 0, agentSpeaking: false, hasPendingClarification: false, ...snap },
      S2S_LIVE_VOICE_END_POLICY,
    );
    expect(decision.shouldEnd).toBe(false);
  });

  it("closes a forgotten session after an hour, and says so", () => {
    const decision = evaluateS2sAutoEnd(
      { phase: "listening", nowMs: 60 * 60_000, startedAtMs: 0, lastActivityAtMs: 0, agentSpeaking: false, hasPendingClarification: false },
      S2S_LIVE_VOICE_END_POLICY,
    );
    expect(decision).toMatchObject({ shouldEnd: true, reason: "max-duration", message: "Live voice ended after 60 minutes." });
  });
});

describe("evaluateS2sAutoEnd", () => {
  it("ends a listening session after semantic idle timeout", () => {
    expect(
      evaluateS2sAutoEnd({
        phase: "listening",
        nowMs: S2S_AUTO_END_DEFAULTS.idleTimeoutMs + 1,
        startedAtMs: 0,
        lastActivityAtMs: 0,
        agentSpeaking: false,
        hasPendingClarification: false,
      }),
    ).toEqual({ shouldEnd: true, reason: "idle-timeout", message: "Live voice ended after inactivity." });
  });

  it("holds while the agent is speaking or a clarification has not reached its longer timeout", () => {
    expect(
      evaluateS2sAutoEnd({
        phase: "listening",
        nowMs: S2S_AUTO_END_DEFAULTS.idleTimeoutMs + 1,
        startedAtMs: 0,
        lastActivityAtMs: 0,
        agentSpeaking: true,
        hasPendingClarification: false,
      }).shouldEnd,
    ).toBe(false);

    expect(
      evaluateS2sAutoEnd({
        phase: "listening",
        nowMs: S2S_AUTO_END_DEFAULTS.idleTimeoutMs + 1,
        startedAtMs: 0,
        lastActivityAtMs: 0,
        agentSpeaking: false,
        hasPendingClarification: true,
      }).shouldEnd,
    ).toBe(false);
  });

  it("ends any active session at the max duration guardrail", () => {
    expect(
      evaluateS2sAutoEnd({
        phase: "thinking",
        nowMs: S2S_AUTO_END_DEFAULTS.maxDurationMs + 1,
        startedAtMs: 0,
        lastActivityAtMs: S2S_AUTO_END_DEFAULTS.maxDurationMs,
        turnSettledAtMs: null,
        agentSpeaking: false,
        hasPendingClarification: false,
      }),
    ).toEqual({ shouldEnd: true, reason: "max-duration", message: "Live voice ended after 20 minutes." });
  });

  it("ends after a completed tool turn even when the provider stays in thinking", () => {
    expect(
      evaluateS2sAutoEnd({
        phase: "thinking",
        nowMs: S2S_AUTO_END_DEFAULTS.thinkingTurnSettleMs + 1,
        startedAtMs: 0,
        lastActivityAtMs: 0,
        turnSettledAtMs: 0,
        agentSpeaking: false,
        hasPendingClarification: false,
      }),
    ).toEqual({ shouldEnd: true, reason: "turn-complete", message: "Live voice ended." });
  });

  it("ends shortly after agent audio finishes and the session returns to listening", () => {
    expect(
      evaluateS2sAutoEnd({
        phase: "listening",
        nowMs: S2S_AUTO_END_DEFAULTS.listeningTurnSettleMs + 1,
        startedAtMs: 0,
        lastActivityAtMs: 0,
        turnSettledAtMs: 0,
        agentSpeaking: false,
        hasPendingClarification: false,
      }),
    ).toEqual({ shouldEnd: true, reason: "turn-complete", message: "Live voice ended." });
  });

  it("holds off turn-complete close during the post-agent grace period", () => {
    const decision = evaluateS2sAutoEnd({
      phase: "listening",
      nowMs: S2S_AUTO_END_DEFAULTS.postAgentGraceMs + 1,
      startedAtMs: 0,
      lastActivityAtMs: 0,
      turnSettledAtMs: 0,
      lastAgentAudioEndMs: S2S_AUTO_END_DEFAULTS.postAgentGraceMs + 1,
      agentSpeaking: false,
      hasPendingClarification: false,
    });
    expect(decision.shouldEnd).toBe(false);
  });

  it("allows turn-complete close after the grace period elapses", () => {
    // nowMs - lastAgentAudioEndMs = grace + settle + 1 → well past grace window
    const now = S2S_AUTO_END_DEFAULTS.postAgentGraceMs + S2S_AUTO_END_DEFAULTS.listeningTurnSettleMs + 1;
    const lastAgentEnd = 0; // elapsed = now
    expect(
      evaluateS2sAutoEnd({
        phase: "listening",
        nowMs: now,
        startedAtMs: 0,
        lastActivityAtMs: 0,
        turnSettledAtMs: 0,
        lastAgentAudioEndMs: lastAgentEnd,
        agentSpeaking: false,
        hasPendingClarification: false,
      }),
    ).toEqual({ shouldEnd: true, reason: "turn-complete", message: "Live voice ended." });
  });

  it("applies the grace period to the thinking phase as well", () => {
    const decision = evaluateS2sAutoEnd({
      phase: "thinking",
      nowMs: S2S_AUTO_END_DEFAULTS.postAgentGraceMs + 1,
      startedAtMs: 0,
      lastActivityAtMs: 0,
      turnSettledAtMs: 0,
      lastAgentAudioEndMs: S2S_AUTO_END_DEFAULTS.postAgentGraceMs + 1,
      agentSpeaking: false,
      hasPendingClarification: false,
    });
    expect(decision.shouldEnd).toBe(false);
  });

  it("does not apply the grace period when lastAgentAudioEndMs is null (no agent speech yet)", () => {
    expect(
      evaluateS2sAutoEnd({
        phase: "listening",
        nowMs: S2S_AUTO_END_DEFAULTS.listeningTurnSettleMs + 1,
        startedAtMs: 0,
        lastActivityAtMs: 0,
        turnSettledAtMs: 0,
        lastAgentAudioEndMs: null,
        agentSpeaking: false,
        hasPendingClarification: false,
      }),
    ).toEqual({ shouldEnd: true, reason: "turn-complete", message: "Live voice ended." });
  });

  it("preserves idle-timeout even during grace period", () => {
    const decision = evaluateS2sAutoEnd({
      phase: "listening",
      nowMs: S2S_AUTO_END_DEFAULTS.idleTimeoutMs + 1,
      startedAtMs: 0,
      lastActivityAtMs: 0,
      turnSettledAtMs: null,
      lastAgentAudioEndMs: S2S_AUTO_END_DEFAULTS.idleTimeoutMs + 1,
      agentSpeaking: false,
      hasPendingClarification: false,
    });
    expect(decision.shouldEnd).toBe(true);
    expect(decision.reason).toBe("idle-timeout");
  });
});

describe("S2S_AUTO_END_DEFAULTS", () => {
  it("defaults are production-grade: 3s listen settle, 3s grace, 90s idle", () => {
    expect(S2S_AUTO_END_DEFAULTS.listeningTurnSettleMs).toBe(3_000);
    expect(S2S_AUTO_END_DEFAULTS.postAgentGraceMs).toBe(3_000);
    expect(S2S_AUTO_END_DEFAULTS.idleTimeoutMs).toBe(90_000);
  });
});
