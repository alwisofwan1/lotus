import type { S2sPhase } from "@/modules/voice-core/s2s-session";

export type S2sAutoEndReason = "voice-command" | "idle-timeout" | "max-duration" | "turn-complete";

export interface S2sAutoEndDecision {
  shouldEnd: boolean;
  reason?: S2sAutoEndReason;
  message?: string;
}

export interface S2sAutoEndPolicy {
  idleTimeoutMs: number;
  clarificationIdleTimeoutMs: number;
  listeningTurnSettleMs: number;
  thinkingTurnSettleMs: number;
  /** Seconds to wait after agent audio ends before allowing turn-complete auto-close. Prevents
   *  the session from closing while residual HTMLAudioElement tail is still audible or the user
   *  is forming their next utterance. */
  postAgentGraceMs: number;
  maxDurationMs: number;
}

export const S2S_AUTO_END_DEFAULTS: S2sAutoEndPolicy = {
  idleTimeoutMs: 90_000,
  clarificationIdleTimeoutMs: 180_000,
  listeningTurnSettleMs: 3_000,
  thinkingTurnSettleMs: 5_000,
  postAgentGraceMs: 3_000,
  maxDurationMs: 20 * 60_000,
};

/**
 * Map the user's "auto-close Live Voice after each command" preference onto a concrete policy.
 * On (default) keeps the snappy per-turn close; off zeroes the settle timers so the session stays
 * open between commands, while the idle-timeout and max-duration guardrails still protect against a
 * forgotten open mic. A zero settle timer is treated as disabled by {@link evaluateS2sAutoEnd}.
 */
export function resolveS2sAutoEndPolicy(opts?: { autoCloseAfterCommand?: boolean }): S2sAutoEndPolicy {
  if (opts?.autoCloseAfterCommand === false) {
    return { ...S2S_AUTO_END_DEFAULTS, listeningTurnSettleMs: 0, thinkingTurnSettleMs: 0 };
  }
  return S2S_AUTO_END_DEFAULTS;
}

export interface S2sAutoEndSnapshot {
  phase: S2sPhase;
  nowMs: number;
  startedAtMs: number | null;
  lastActivityAtMs: number | null;
  turnSettledAtMs?: number | null;
  /** When the agent's last audio chunk ended (agentAudioEnd). Used to hold off turn-complete auto-end
   *  while residual HTMLAudioElement tail is still audible or the user is forming their next utterance. */
  lastAgentAudioEndMs?: number | null;
  agentSpeaking: boolean;
  hasPendingClarification: boolean;
}

// A reconnect is not idleness: the user did not stop talking, the network did.
const INACTIVE_PHASES = new Set<S2sPhase>(["idle", "reconnecting", "closed", "error"]);

export function evaluateS2sAutoEnd(
  snapshot: S2sAutoEndSnapshot,
  policy: S2sAutoEndPolicy = S2S_AUTO_END_DEFAULTS,
): S2sAutoEndDecision {
  if (INACTIVE_PHASES.has(snapshot.phase)) return { shouldEnd: false };

  if (
    snapshot.startedAtMs !== null &&
    policy.maxDurationMs > 0 &&
    snapshot.nowMs - snapshot.startedAtMs >= policy.maxDurationMs
  ) {
    return { shouldEnd: true, reason: "max-duration", message: "Live voice ended after 20 minutes." };
  }

  if (snapshot.hasPendingClarification || snapshot.agentSpeaking) return { shouldEnd: false };

  // Grace window: while still within the grace period after agent audio ends, skip turn-complete
  // close. Idle-timeout and max-duration are NOT affected — they must still fire even during grace.
  const inGraceWindow =
    snapshot.lastAgentAudioEndMs !== null &&
    snapshot.lastAgentAudioEndMs !== undefined &&
    policy.postAgentGraceMs > 0 &&
    snapshot.nowMs - snapshot.lastAgentAudioEndMs <= policy.postAgentGraceMs;

  if (!inGraceWindow) {
    if (snapshot.turnSettledAtMs !== null && snapshot.turnSettledAtMs !== undefined) {
      const settleMs = snapshot.phase === "thinking" ? policy.thinkingTurnSettleMs : policy.listeningTurnSettleMs;
      if ((snapshot.phase === "thinking" || snapshot.phase === "listening") && settleMs > 0 && snapshot.nowMs - snapshot.turnSettledAtMs >= settleMs) {
        return { shouldEnd: true, reason: "turn-complete", message: "Live voice ended." };
      }
    }
  }

  if (snapshot.phase === "listening" && snapshot.lastActivityAtMs !== null) {
    const idleTimeout = snapshot.hasPendingClarification
      ? policy.clarificationIdleTimeoutMs
      : policy.idleTimeoutMs;
    if (idleTimeout > 0 && snapshot.nowMs - snapshot.lastActivityAtMs >= idleTimeout) {
      return { shouldEnd: true, reason: "idle-timeout", message: "Live voice ended after inactivity." };
    }
  }

  return { shouldEnd: false };
}
