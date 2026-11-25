"use client";
import { useEffect, useMemo } from "react";
import { useS2sProviderRegistry } from "@/lib/hooks/useS2sProviderRegistry";
import { useTauriVoicePort } from "@/modules/voice-core/voice-port-context";
import { duckMusic } from "../music/music-engine";
import { resolveS2sEngagement } from "./s2s-mode";
import { useS2sSession, type S2sHealthSnapshot, type UseS2sSessionOpts } from "./use-s2s-session";
import type { S2sPhase } from "@/modules/voice-core/s2s-session";

export interface CommandBarLiveVoice {
  /** A provider is enabled + active — voice-to-voice can be started (⌘⇧L). */
  available: boolean;
  /** A session is running (connecting through speaking, or showing an error) — the bar transforms. */
  active: boolean;
  phase: S2sPhase;
  /** The session's user-turn count: the strip groups lines by it. */
  turn: number;
  /** The active provider's display name ("Grok"), or null before the registry loads. */
  providerName: string | null;
  agentSpeaking: boolean;
  health: S2sHealthSnapshot;
  error?: string;
  start: () => Promise<void>;
  stop: () => void;
  interrupt: () => void;
  micMuted: boolean;
  setMicMuted: (muted: boolean) => void;
  ending: boolean;
}

/**
 * Composes the S2S provider registry, the opt-in engagement gate, and the duplex session hook into
 * the single shape the command bar needs to drive the Direction-B "transform" surface: whether the
 * feature is available (for the ⌘⇧L hotkey) and whether it is currently active (to swap the bar).
 */
export function useCommandBarLiveVoice(opts?: Omit<UseS2sSessionOpts, "providerId">): CommandBarLiveVoice {
  const port = useTauriVoicePort();
  const { registry } = useS2sProviderRegistry(port.s2s.listProviders);

  const engagement = useMemo(
    () =>
      resolveS2sEngagement(
        { enabled: true, providerId: registry?.activeProvider ?? null },
        (registry?.providers ?? []).map((p) => ({ id: p.id, enabled: p.enabled })),
      ),
    [registry],
  );

  // Read from the registry only. Before it loads there is no provider, and `available` is false.
  const providerId = engagement.engage ? engagement.providerId : registry?.activeProvider ?? "";
  const s2s = useS2sSession({ providerId, ...opts });

  const { phase } = s2s.session;
  const active = phase !== "idle" && phase !== "closed";

  // Duck the music while the agent has the floor, and hand the volume back the moment
  // it stops — the claim is ref-counted, so narration ducking composes with this.
  useEffect(() => {
    if (!s2s.agentSpeaking) return;
    return duckMusic();
  }, [s2s.agentSpeaking]);

  return {
    available: engagement.engage,
    active,
    phase,
    turn: s2s.session.turn,
    providerName: registry?.providers.find((provider) => provider.id === providerId)?.name ?? null,
    agentSpeaking: s2s.agentSpeaking,
    health: s2s.health,
    error: s2s.session.error,
    start: s2s.start,
    stop: s2s.stop,
    interrupt: s2s.interrupt,
    micMuted: s2s.micMuted,
    setMicMuted: s2s.setMicMuted,
    ending: s2s.ending,
  };
}
