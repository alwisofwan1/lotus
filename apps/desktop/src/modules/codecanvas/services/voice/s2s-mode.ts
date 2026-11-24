/**
 * Voice-to-Voice (speech-to-speech) opt-in gate — pure decision core.
 *
 * This is the guardrail that keeps the feature ADDITIVE: {@link resolveS2sEngagement} decides
 * whether the duplex S2S loop should engage at all. Its default is OFF, so an untouched install
 * keeps running the existing turn-based voice path (`use-speech-to-text` → router →
 * `use-voice-feedback`) with no behavior change. S2S only takes over when the user explicitly
 * enables it AND a usable S2S provider is configured.
 */

export interface S2sSettings {
  /** Master opt-in. Off (default) → the classic turn-based voice path runs unchanged. */
  enabled: boolean;
  /** Active S2S provider id (e.g. "grok" / "openai-realtime"); null when none is chosen. */
  providerId: string | null;
}

export const DEFAULT_S2S_SETTINGS: S2sSettings = {
  enabled: false,
  providerId: null,
};

/** A structural subset of an S2S provider config: usable when enabled (and, by convention, keyed). */
export interface S2sReadiness {
  id: string;
  enabled: boolean;
}

export type S2sEngagement =
  | { engage: false; reason: "disabled" | "no-provider" }
  | { engage: true; providerId: string };

export function resolveS2sEngagement(
  settings: S2sSettings,
  providers: S2sReadiness[],
): S2sEngagement {
  if (!settings.enabled) return { engage: false, reason: "disabled" };
  const chosen = providers.find((p) => p.id === settings.providerId && p.enabled);
  if (!chosen) return { engage: false, reason: "no-provider" };
  return { engage: true, providerId: chosen.id };
}
