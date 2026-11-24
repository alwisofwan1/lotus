"use client";
import { useCallback, useEffect, useRef } from "react";
import { useTauriVoicePort } from "./voice-port-context";
import { useTtsProviderRegistry } from "@/lib/hooks/useTtsProviderRegistry";
import { resolveTtsProvider } from "./resolve-tts-provider";
import { createSpeakerQueue, type SpeakerPriority, type SpeakerQueue } from "./speaker-queue";
import { agentDoneSoundSrc, createChimePlayer, type ChimePlayer } from "./agent-done-chime";
import type { TtsProvider } from "./tts-provider";
import type { TauriVoicePort } from "./tauri-voice-port";

/** Per-utterance options callers can pass; provider voice/speed come from the saved config. */
export interface SpeakOpts {
  /** Language of the text (BCP-47 or bare code, e.g. "id"). Lets the TTS engine pick a voice that
   *  actually speaks the text's language instead of the page-default English one. */
  language?: string;
}

/** Options for {@link VoiceFeedback.announce}. */
export interface AnnounceOpts extends SpeakOpts {
  /** Which Speaker Queue lane the line takes. Default `reply`. */
  priority?: SpeakerPriority;
  /** Callouts: the agent that finished, named in the summary after Live Voice. */
  name?: string;
}

export interface VoiceFeedback {
  /** Speak a command reply — gated by the master "Speak replies" toggle. Fire-and-forget. */
  speak: (text: string, opts?: SpeakOpts) => void;
  /** Queue a line WITHOUT the "Speak replies" gate — for channels that own their own toggle
   *  (callouts, narration). Resolves when the line has been spoken, dropped, or stopped. */
  announce: (text: string, opts?: AnnounceOpts) => Promise<void>;
  /** Barge-in: silence replies (the playing one and any waiting). Callouts and narration go on. */
  stop: () => void;
  /** Silence every voice: the playing line and everything waiting. */
  stopAll: () => void;
  /** Live Voice started: stop what is playing and keep every other voice silent. */
  hold: () => void;
  /** Live Voice ended: one callout line for agents that finished meanwhile; stale narration dropped. */
  release: () => void;
  /** The "sound" Agent-Done Alert: the sound picked in Settings, batched. Skipped while Live Voice holds the speaker. */
  chime: () => void;
  /** Whether a spoken line can play at all (a voice is resolved and its engine exists here). */
  canSpeak: () => boolean;
  /** Settings › Test voice: play one line through THIS owner's engine and reject on failure (a
   *  refused key, a dead engine), which the queue would only log. Stops replies first. */
  preview: (text: string, opts?: SpeakOpts) => Promise<void>;
  /** Stop a running {@link preview}. */
  stopPreview: () => void;
}

/** A hook owner's voice: its resolved provider and the saved voice/speed, read at play time. */
interface OwnerVoice {
  provider: () => TtsProvider | null;
  config: () => { voice?: string; speed?: number };
}

interface SharedSpeaker {
  queue: SpeakerQueue;
  /** One chime player per port, so Canvas and Code finishing together still play one chime. */
  chime: ChimePlayer;
  /** Mounted owners, in mount order. The newest one with a provider speaks. */
  owners: Map<symbol, OwnerVoice>;
}

/** ONE Speaker Queue per Tauri Voice Port — every `useVoiceFeedback` owner (canvas, Settings
 *  preview) shares it, so two voices never overlap and Live Voice's hold silences them all. */
const speakers = new WeakMap<TauriVoicePort, SharedSpeaker>();

function sharedSpeakerFor(port: TauriVoicePort): SharedSpeaker {
  const existing = speakers.get(port);
  if (existing) return existing;
  const owners = new Map<symbol, OwnerVoice>();
  const queue = createSpeakerQueue({
    play: async (text, { language, signal }) => {
      const owner = [...owners.values()].reverse().find((o) => o.provider());
      const provider = owner?.provider();
      if (!owner || !provider || signal.aborted) return;
      // Stop the provider too, not only the signal: a provider may still be mid-synthesis.
      const onAbort = () => provider.stop();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await provider.speak(text, { ...owner.config(), language, signal });
      } catch (err) {
        if (!signal.aborted) console.warn(`[voice] ${provider.kind} speak failed:`, err);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  });
  const speaker = { queue, owners, chime: createChimePlayer({ playNative: port.playAgentDoneSound }) };
  speakers.set(port, speaker);
  return speaker;
}

/**
 * Resolves the active TTS provider from the registry and exposes a `speak(text)` the NL command bar
 * calls with each {@link NlResolution.speak}. The browser provider is the zero-config default and is
 * active out of the box (browser TTS, on). Cloud (BYOK) providers route synthesis through the fully
 * implemented Rust `tts_synthesize` seam (OpenAI / ElevenLabs — keys never enter the renderer);
 * failures are caught and logged here so a provider error never breaks the command bar.
 *
 * Every utterance carries the active provider's configured voice + speed AND the caller's language —
 * this is what lets the browser engine pick e.g. macOS Damayanti for Indonesian text.
 */
export function useVoiceFeedback(): VoiceFeedback {
  const port = useTauriVoicePort();
  const { registry } = useTtsProviderRegistry(port.tts.listProviders);
  const providerRef = useRef<TtsProvider | null>(null);
  // Latest voice-output prefs (ADR-0031), read by the stable `speak` without re-creating it.
  const outputRef = useRef(registry?.output);
  // The active provider's saved voice/speed — merged into every speak() call so the settings the
  // user picked actually reach the utterance (they used to be dropped here).
  const voiceConfigRef = useRef<{ voice?: string; speed?: number }>({});

  useEffect(() => {
    outputRef.current = registry?.output;
    const active = registry?.providers.find((p) => p.id === registry.activeProvider);
    voiceConfigRef.current = { voice: active?.voice, speed: active?.speed };
    const provider = resolveTtsProvider(registry?.activeProvider, registry?.providers ?? [], {
      cloudDepsFor: (providerId) => ({
        // Voice comes from the per-provider config (resolved in Rust); opts may override per-call.
        synthesize: (text, opts) => port.tts.synthesize(providerId, text, {
          voice: opts?.voice,
          speed: opts?.speed,
          signal: opts?.signal,
        }),
      }),
    });
    providerRef.current = provider;
    return () => {
      provider.stop();
      if (providerRef.current === provider) providerRef.current = null;
    };
  }, [registry, port]);

  // The shared queue plays through the newest mounted owner's provider. Refs, so a Settings change
  // applies to the next line without re-registering.
  const { queue, owners, chime: chimePlayer } = sharedSpeakerFor(port);
  useEffect(() => {
    const key = Symbol("voice-owner");
    owners.set(key, { provider: () => providerRef.current, config: () => voiceConfigRef.current });
    return () => {
      owners.delete(key);
      // The last owner gone: nothing may keep talking for a surface that is gone.
      if (owners.size === 0) queue.stopAll();
    };
  }, [queue, owners]);

  const announce = useCallback(
    (text: string, opts?: AnnounceOpts): Promise<void> => {
      const clean = text.trim();
      if (!clean) return Promise.resolve();
      return queue.enqueue({ priority: opts?.priority ?? "reply", text: clean, language: opts?.language, name: opts?.name });
    },
    [queue],
  );

  const speak = useCallback(
    (text: string, opts?: SpeakOpts) => {
      // Master gate: "Speak replies" off → stay silent (default on when unset).
      if (outputRef.current?.speakReplies === false) return;
      void announce(text, opts);
    },
    [announce],
  );

  const stop = useCallback(() => queue.stop("reply"), [queue]);
  const stopAll = useCallback(() => queue.stopAll(), [queue]);
  const hold = useCallback(() => queue.hold(), [queue]);
  const release = useCallback(() => queue.release(), [queue]);
  const chime = useCallback(() => {
    if (queue.isHeld()) return;
    chimePlayer.play(agentDoneSoundSrc(outputRef.current?.agentDoneSound));
  }, [queue, chimePlayer]);
  const canSpeak = useCallback(() => {
    const provider = providerRef.current;
    if (!provider) return false;
    return provider.kind !== "browser" || (typeof window !== "undefined" && "speechSynthesis" in window);
  }, []);

  const preview = useCallback(
    async (text: string, opts?: SpeakOpts) => {
      const provider = providerRef.current;
      if (!provider) throw new Error("No voice is set up");
      queue.stop("reply");
      await provider.speak(text, { ...voiceConfigRef.current, language: opts?.language });
    },
    [queue],
  );
  const stopPreview = useCallback(() => providerRef.current?.stop(), []);

  return { speak, announce, stop, stopAll, hold, release, chime, canSpeak, preview, stopPreview };
}

/** Live Voice outranks every other voice (Speaker Queue, ADR-0053): while `liveVoiceActive`, what is
 *  playing stops at once and the rest stays silent; when it ends, one callout line covers what
 *  finished meanwhile. */
export function useHoldSpeechWhileLive(liveVoiceActive: boolean, voice: Pick<VoiceFeedback, "hold" | "release">): void {
  const { hold, release } = voice;
  useEffect(() => {
    if (liveVoiceActive) hold();
    else release();
  }, [liveVoiceActive, hold, release]);
}
