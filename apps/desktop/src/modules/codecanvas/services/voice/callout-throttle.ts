/**
 * Per-agent cooldown cap for finish callouts (ultra-minimal voice policy). A live agent can finish
 * many turns in quick succession — tool loops that yield, auto-continuations, a worker↔critic loop —
 * and announcing each one ("Nova is done" … "Nova wrapped up" … over and over) is noise. This caps
 * the channel to at most ONE spoken finish per agent per {@link CALLOUT_COOLDOWN_MS} window.
 *
 * A genuinely new, user-initiated turn (a submit opened a turn on the pane — `freshTurn`) BYPASSES
 * the window, so work the user just kicked off is always acknowledged promptly; only unprompted
 * churn inside the window is silenced. Pure and clock-injected (the caller passes `now`) so it is
 * fully deterministic under test — no timers here.
 */

/** Default minimum gap between two spoken finish callouts for the SAME agent, absent fresh user work.
 *  User-configurable in the Voice tab (`VoiceOutputSettings.agentDoneCooldownMs`). */
export const CALLOUT_COOLDOWN_MS = 45_000;

export interface CalloutThrottle {
  /**
   * Decide whether a finish callout for `paneId` may be spoken now, and record it if so.
   * @param now        Current time (ms). Injected so the decision is deterministic.
   * @param freshTurn  A user submit opened a turn on this pane since the last callout — bypasses the
   *                   cooldown so a new user-initiated task is announced immediately.
   * @param cooldownMs Window length; passed per-call so the user's setting takes effect live. 0
   *                   disables the cap (every finish emits). Defaults to {@link CALLOUT_COOLDOWN_MS}.
   * @returns true to speak (and the window is (re)armed from `now`), false to stay silent.
   */
  tryEmit(paneId: string, now: number, freshTurn: boolean, cooldownMs?: number): boolean;
  /** Forget a pane (node closed) so its next finish emits immediately. */
  clear(paneId: string): void;
}

export function createCalloutThrottle(): CalloutThrottle {
  const lastAt = new Map<string, number>();
  return {
    tryEmit(paneId, now, freshTurn, cooldownMs = CALLOUT_COOLDOWN_MS) {
      const prev = lastAt.get(paneId);
      const withinWindow = prev !== undefined && now - prev < cooldownMs;
      if (withinWindow && !freshTurn) return false;
      lastAt.set(paneId, now);
      return true;
    },
    clear(paneId) {
      lastAt.delete(paneId);
    },
  };
}
