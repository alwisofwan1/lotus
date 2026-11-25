import {
  evaluateS2sAutoEnd,
  S2S_AUTO_END_DEFAULTS,
  type S2sAutoEndPolicy,
  type S2sAutoEndReason,
} from "./s2s-auto-end-policy";
import type { S2sPhase } from "@/modules/voice-core/s2s-session";

const AUTO_END_POLL_MS = 1_000;
const END_CONVERSATION_FALLBACK_MS = 4_000;

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface S2sAutoEndRuntimeDeps {
  getPhase: () => S2sPhase;
  getAgentSpeaking: () => boolean;
  hasPendingClarification: () => boolean;
  getPolicy: () => S2sAutoEndPolicy | undefined;
  onEnd: (reason: S2sAutoEndReason, message: string) => void;
  now?: () => number;
  pollMs?: number;
  farewellFallbackMs?: number;
}

export interface S2sAutoEndRuntime {
  startSession: (nowMs?: number) => void;
  stopSession: () => void;
  startPolling: () => void;
  markActivity: (nowMs?: number) => void;
  markTurnActive: () => void;
  markTurnSettled: (nowMs?: number) => void;
  markAgentAudioEnd: (nowMs?: number) => void;
  end: (reason: S2sAutoEndReason, message: string) => void;
  requestGracefulEnd: (reason: S2sAutoEndReason, farewell: string) => void;
  finalizeGracefulEnd: () => void;
  /** The user spoke over the farewell: they are not done, so keep the session. */
  cancelGracefulEnd: () => void;
  hasPendingGracefulEnd: () => boolean;
}

/** Owns Live Voice inactivity/settle timestamps and graceful-farewell timers outside React. */
export function createS2sAutoEndRuntime({
  getPhase,
  getAgentSpeaking,
  hasPendingClarification,
  getPolicy,
  onEnd,
  now = Date.now,
  pollMs = AUTO_END_POLL_MS,
  farewellFallbackMs = END_CONVERSATION_FALLBACK_MS,
}: S2sAutoEndRuntimeDeps): S2sAutoEndRuntime {
  let pollTimer: TimerHandle | null = null;
  let farewellTimer: TimerHandle | null = null;
  let startedAtMs: number | null = null;
  let lastActivityAtMs: number | null = null;
  let turnSettledAtMs: number | null = null;
  let lastAgentAudioEndMs: number | null = null;
  let endFired = false;
  let pendingEnd: { farewell: string; reason: S2sAutoEndReason } | null = null;

  const clearPollTimer = () => {
    if (pollTimer !== null) {
      globalThis.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const clearFarewellTimer = () => {
    if (farewellTimer !== null) {
      globalThis.clearTimeout(farewellTimer);
      farewellTimer = null;
    }
  };

  const end = (reason: S2sAutoEndReason, message: string) => {
    const phase = getPhase();
    if (endFired || phase === "closed" || phase === "error") return;
    endFired = true;
    onEnd(reason, message);
  };

  const finalizeGracefulEnd = () => {
    const pending = pendingEnd;
    if (!pending) return;
    pendingEnd = null;
    clearFarewellTimer();
    end(pending.reason, pending.farewell);
  };

  return {
    startSession(nowMs = now()) {
      startedAtMs = nowMs;
      lastActivityAtMs = nowMs;
      turnSettledAtMs = null;
      lastAgentAudioEndMs = null;
      endFired = false;
      pendingEnd = null;
      clearFarewellTimer();
    },

    stopSession() {
      clearPollTimer();
      clearFarewellTimer();
      pendingEnd = null;
      startedAtMs = null;
      lastActivityAtMs = null;
      turnSettledAtMs = null;
      lastAgentAudioEndMs = null;
    },

    startPolling() {
      clearPollTimer();
      if (typeof window === "undefined") return;
      pollTimer = globalThis.setInterval(() => {
        const decision = evaluateS2sAutoEnd(
          {
            phase: getPhase(),
            nowMs: now(),
            startedAtMs,
            lastActivityAtMs,
            turnSettledAtMs,
            lastAgentAudioEndMs,
            agentSpeaking: getAgentSpeaking(),
            hasPendingClarification: hasPendingClarification(),
          },
          getPolicy() ?? S2S_AUTO_END_DEFAULTS,
        );
        if (decision.shouldEnd && decision.reason && decision.message) {
          end(decision.reason, decision.message);
        }
      }, pollMs);
    },

    markActivity(nowMs = now()) {
      lastActivityAtMs = nowMs;
    },

    markTurnActive() {
      turnSettledAtMs = null;
    },

    markTurnSettled(nowMs = now()) {
      turnSettledAtMs = nowMs;
    },

    markAgentAudioEnd(nowMs = now()) {
      lastAgentAudioEndMs = nowMs;
      turnSettledAtMs = nowMs;
    },

    end,

    requestGracefulEnd(reason, farewell) {
      const phase = getPhase();
      if (endFired || pendingEnd || phase === "closed" || phase === "error") return;
      pendingEnd = { reason, farewell };
      clearFarewellTimer();
      farewellTimer = globalThis.setTimeout(finalizeGracefulEnd, farewellFallbackMs);
    },

    finalizeGracefulEnd,

    cancelGracefulEnd() {
      pendingEnd = null;
      clearFarewellTimer();
    },

    hasPendingGracefulEnd() {
      return pendingEnd !== null;
    },
  };
}
