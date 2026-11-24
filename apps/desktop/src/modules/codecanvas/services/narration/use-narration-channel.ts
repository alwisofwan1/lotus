"use client";

/**
 * The thin shell that turns the narration stack into sound and motion (Slice 6 of
 * `plans/voice-narration-layer/`).
 *
 * Everything below this file is pure and exhaustively tested; this is the only place that performs
 * an effect. It owns nothing but the subscription and the per-session router/throttle instances.
 *
 * The transport is injected rather than imported so the hook is testable without a Tauri mock —
 * the same pattern `useAgentDoneCallouts` uses for its stop-hook subscriber.
 */

import { useEffect, useRef } from "react";
import { toNarrationEvent, type AgentHookDropPayload } from "./narration-event";
import { isFreshNarration } from "./narration-freshness";
import { createNarrationRouter } from "./narration-router";
import { narrationEffectsFor } from "./narration-effects";
import { composeNarrationLine } from "./narration-compose";
import { createFocusThrottle } from "./focus-throttle";
import { createNarrationSpeaker } from "./narration-speaker";
import { DEFAULT_NARRATION_PROFILE, shouldNarrate, type NarrationProfile } from "./narration-profile";
import { summarizeFlush } from "./narration-digest";
import { composeBurstLine } from "./burst-intent";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { duckMusic } from "../music/music-engine";

/**
 * How often the channel checks whether it may speak. Narration is ambient, not interactive, so a
 * coarse tick is right: it costs nothing and it is what lets a burst coalesce into one line
 * instead of one utterance per event.
 */
export const NARRATION_TICK_MS = 500;

/** Subscribe to agent-CLI hook drops; returns an unsubscribe. */
export type AgentHookSubscriber = (onDrop: (payload: AgentHookDropPayload) => void) => () => void;

/**
 * Production transport: the `lotus://agent-hook` Tauri event the Rust watcher emits after consuming
 * a drop file. Outside Tauri this is a silent no-op — narration simply never fires in the browser.
 */
export function subscribeAgentHookEvents(onDrop: (payload: AgentHookDropPayload) => void): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const off = await listen<AgentHookDropPayload>("lotus://agent-hook", (event) => {
        if (event.payload) onDrop(event.payload);
      });
      if (cancelled) safeTauriUnlisten(off);
      else unlisten = off;
    } catch {
      // Outside Tauri, or the event bridge is unavailable — stay silent rather than throw into a
      // render.
    }
  })();
  return () => {
    cancelled = true;
    safeTauriUnlisten(unlisten);
  };
}

export interface NarrationChannelOptions {
  /** Master gate. Default-off at the call site — narration is opt-in. */
  enabled: boolean;
  /**
   * A Live Voice session is open. Narration goes silent — the visual channel keeps working.
   *
   * Talking over the user mid-conversation is wrong on its own, but there is a mechanical reason
   * too: the S2S self-trigger guard (`agentAudioRecent` in `use-s2s-session.ts`) only watches its
   * OWN player, so narration audio reaches the open mic looking like a genuine user turn.
   */
  liveVoiceActive?: boolean;
  subscribeAgentHook: AgentHookSubscriber;
  /** Speak a line, resolving when playback ENDS. Narration serialises on that promise. */
  announce: (text: string, opts?: { language?: string; priority?: "narration" }) => void | Promise<void>;
  /** Point the camera at a node. Used only for a pierce — never for routine work. */
  focusNode: (nodeId: string) => void;
  /** HTTP-only model call for the summary path. Routine work never reaches it. */
  complete: (prompt: string) => Promise<string>;
  /** The active persona's body — the register the narrator speaks in. */
  personaBody?: string;
  resolveName: (paneId: string) => string;
  /** projectId → human repo label for a digest. Omit to leave digests unlabelled. */
  resolveProjectLabel?: (projectId: string) => string | null | undefined;
  /** How much to say. Defaults to the balanced profile. */
  profile?: NarrationProfile;
  language?: string;
  now?: () => number;
}

export function useNarrationChannel({
  enabled,
  liveVoiceActive = false,
  subscribeAgentHook,
  announce,
  focusNode,
  complete,
  personaBody,
  resolveName,
  resolveProjectLabel,
  profile = DEFAULT_NARRATION_PROFILE,
  language,
  now,
}: NarrationChannelOptions): void {
  // Refs so a re-render never resubscribes (which would drop events) and never resets the router's
  // solo/swarm state or the focus throttle mid-session.
  const deps = useRef({ announce, focusNode, complete, personaBody, resolveName, resolveProjectLabel, profile, language, now });
  deps.current = { announce, focusNode, complete, personaBody, resolveName, resolveProjectLabel, profile, language, now };

  const routerRef = useRef<ReturnType<typeof createNarrationRouter> | null>(null);
  const throttleRef = useRef<ReturnType<typeof createFocusThrottle> | null>(null);
  const speakerRef = useRef<ReturnType<typeof createNarrationSpeaker> | null>(null);
  // A ref so toggling the session neither resubscribes nor resets the router's channel state.
  const liveVoiceActiveRef = useRef(liveVoiceActive);
  liveVoiceActiveRef.current = liveVoiceActive;

  useEffect(() => {
    if (!enabled) return;
    routerRef.current ??= createNarrationRouter({ resolveName: (paneId) => deps.current.resolveName(paneId) });
    throttleRef.current ??= createFocusThrottle();
    speakerRef.current ??= createNarrationSpeaker({
      speak: async (line) => {
        // Music steps back for the length of the utterance — `speak` resolves when
        // playback actually ends, so the claim covers exactly the spoken audio.
        const unduck = duckMusic();
        try {
          await deps.current.announce(line, { language: deps.current.language, priority: "narration" });
        } finally {
          unduck();
        }
      },
      compose: (parts) =>
        composeBurstLine(parts, {
          personaBody: deps.current.personaBody,
          complete: deps.current.complete,
        }),
    });

    // The speaker is driven by this tick, never by the event that produced the line. Speaking
    // straight from the event handler is what let a busy agent start a synthesis per tool call.
    const tick = setInterval(() => {
      const clock = deps.current.now?.() ?? Date.now();
      // Drain the router's per-project channels first: work held back for a digest is only ever
      // spoken here. Without this call it accumulated and was lost — invisible with one agent,
      // because a lone agent never defers anything.
      for (const flush of routerRef.current?.collectFlushes(clock) ?? []) {
        const label = deps.current.resolveProjectLabel?.(flush.projectId) ?? undefined;
        const digest = summarizeFlush(flush, { label: label ?? undefined });
        // Already a finished sentence carrying counts — must not be rewritten.
        if (digest) speakerRef.current?.offer([digest], { alreadyComposed: true });
      }
      // Narration must not talk over itself. The speaker holds one slot across composition AND
      // playback, so this only starts something when the previous line has genuinely finished.
      if (liveVoiceActiveRef.current) speakerRef.current?.clear();
      else void speakerRef.current?.pump();
    }, NARRATION_TICK_MS);

    const unsubscribe = subscribeAgentHook((payload) => {
      const event = toNarrationEvent(payload);
      // The drop stream carries every hook the CLI fires, including lifecycle noise.
      if (!event) return;
      const clock = deps.current.now?.() ?? Date.now();
      // A burst replayed by the startup drain describes work that finished before the app opened.
      if (!isFreshNarration(event, clock)) return;
      // How much to say, before deciding when to say it. Runs first so a muted event never even
      // reaches the router's channel bookkeeping.
      if (!shouldNarrate(event, deps.current.profile)) return;

      const effects = narrationEffectsFor(routerRef.current!.classify(event, clock), event);
      if (effects.shouldSpeak) {
        // Layer 5 turns source material into a spoken line. Awaited rather than fire-and-forget so
        // the fallback path is deterministic; routine work resolves without a round-trip.
        void composeNarrationLine(event, {
          personaBody: deps.current.personaBody,
          complete: deps.current.complete,
        }).then((line) => {
          if (line) speakerRef.current?.offer([`${effects.labelPrefix}${line}`]);
        });
      }
      if (effects.focusNodeId && throttleRef.current!.shouldFocus(effects.focusNodeId, clock)) {
        deps.current.focusNode(effects.focusNodeId);
      }
    });

    return () => {
      clearInterval(tick);
      unsubscribe();
    };
  }, [enabled, subscribeAgentHook]);
}
