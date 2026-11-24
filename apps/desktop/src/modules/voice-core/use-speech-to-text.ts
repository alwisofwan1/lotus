"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTauriVoicePort } from "./voice-port-context";
import { useSttProviderRegistry } from "@/lib/hooks/useSttProviderRegistry";
import { resolveSttProvider } from "./resolve-stt-provider";
import { streamingSttDepsFrom } from "./streaming-stt-provider";
import type { SttProvider } from "./stt-provider";
import type { SttDecoderContext } from "@/lib/tauri-api";

export interface UseSpeechToTextOptions {
  /** Called when capture fails (permission denied, or speech service unavailable in the webview). */
  onError?: (message: string) => void;
  /** Live frequency-spectrum frames (0–1 per band) while recording, for the listening-border visualizer.
   *  Fires per animation frame — the consumer MUST write straight to the DOM (no React state) to avoid
   *  re-rendering 60×/s. Only the streaming provider emits; others leave the border on its drift. */
  onSpectrum?: (bands: number[]) => void;
}

export interface SpeechToTextTurnMetadata {
  provider: string;
  model?: string;
  requestedLanguages: string[];
  detectedLanguages: string[];
}

export interface SpeechToText {
  /** Whether the active provider can capture in this environment. */
  available: boolean;
  /** The provider registry has not loaded yet: `available` is not an answer yet. */
  checking?: boolean;
  /** True while permission/device/provider startup is still pending. */
  starting: boolean;
  /** True while a recording is in progress. */
  recording: boolean;
  /** True while a stopped recording is being transcribed (cloud round-trip). */
  transcribing: boolean;
  /** Live (final + interim) transcript while recording; "" when idle or for one-shot cloud providers. */
  interim: string;
  /** Begin push-to-talk capture. `hint` is snapshotted for this turn so later canvas changes cannot
   *  alter the decoder context after audio has already been recorded. */
  start: (context?: SttDecoderContext) => Promise<boolean>;
  /** Stop capture and return the transcript ("" if nothing was heard / on failure). */
  stop: () => Promise<string>;
  /** Metadata for the most recently finalized turn; transcript text is returned separately. */
  getLastTurnMetadata: () => SpeechToTextTurnMetadata | null;
  /** Abort capture without transcribing. */
  cancel: () => void;
}

/**
 * Push-to-talk speech-to-text for the NL command bar. Resolves the active STT provider from the
 * registry (browser by default; BYOK cloud once configured) and exposes start/stop/cancel. State is
 * tracked via a ref so callbacks stay stable and a stuck provider can never wedge the recording flag:
 * the browser provider self-resolves stop() via a watchdog, and recognition failures flip back to idle
 * through {@link UseSpeechToTextOptions.onError}.
 */
export function useSpeechToText(opts: UseSpeechToTextOptions = {}): SpeechToText {
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;
  const onSpectrumRef = useRef(opts.onSpectrum);
  onSpectrumRef.current = opts.onSpectrum;

  const port = useTauriVoicePort();
  const { registry, loading: registryLoading } = useSttProviderRegistry(port.stt.listProviders);
  const providerRef = useRef<SttProvider | null>(null);
  /** Provider that owns the pending/live capture. Registry refreshes may replace `providerRef`, but
   *  stop/cancel must stay routed to this owner until the turn settles. */
  const captureProviderRef = useRef<SttProvider | null>(null);
  const recordingRef = useRef(false);
  const startingRef = useRef(false);
  const captureGenerationRef = useRef(0);
  const captureContextRef = useRef<SttDecoderContext | undefined>(undefined);
  const captureProviderMetadataRef = useRef<{ provider: string; model?: string } | null>(null);
  const lastTurnMetadataRef = useRef<SpeechToTextTurnMetadata | null>(null);
  const [available, setAvailable] = useState(false);
  const [starting, setStarting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [interim, setInterim] = useState("");

  useEffect(() => {
    const provider = resolveSttProvider(registry?.activeProvider, registry?.providers ?? [], {
      cloudDepsFor: (id) => ({
        transcribe: async (b64, mime) => {
          const context = captureContextRef.current;
          const result = await port.stt.transcribe(id, b64, mime, context);
          lastTurnMetadataRef.current = {
            provider: captureProviderMetadataRef.current?.provider ?? id,
            model: captureProviderMetadataRef.current?.model,
            requestedLanguages: [...(context?.languages ?? [])],
            detectedLanguages: [...(result.detectedLanguages ?? [])],
          };
          return result.text;
        },
      }),
      preferStreaming: port.isDesktop(),
      streamingDeps: streamingSttDepsFrom(port),
      onInterim: setInterim,
      // Ref-indirected so the provider (built once per registry change) always calls the latest handler.
      onSpectrum: (bands) => onSpectrumRef.current?.(bands),
      onError: (msg) => {
        // A provider callback can arrive after Settings replaced that adapter or after a cancelled
        // turn. It must never tear down the newer provider's capture.
        if (captureProviderRef.current !== provider) return;
        // Release the mic on a mid-recording failure: the streaming provider tears down its
        // MediaStream/AudioContext only in stop()/cancel(), so without this the mic indicator
        // stays lit until the next start(). Flag flips FIRST so a cancel-triggered error
        // callback can't re-enter this branch.
        const owner = captureProviderRef.current;
        const wasCapturing = recordingRef.current || startingRef.current;
        captureGenerationRef.current += 1;
        recordingRef.current = false;
        startingRef.current = false;
        setStarting(false);
        captureProviderRef.current = null;
        if (wasCapturing) owner?.cancel();
        setRecording(false);
        setTranscribing(false);
        setInterim("");
        captureContextRef.current = undefined;
        onErrorRef.current?.(msg);
      },
    });
    providerRef.current = provider;
    setAvailable(provider.isAvailable());
  }, [registry, port]);

  // Unmount mid-recording must release the mic — nothing else will call cancel() after the
  // component (and its buttons) are gone.
  useEffect(
    () => () => {
      if (!recordingRef.current && !startingRef.current) return;
      captureGenerationRef.current += 1;
      recordingRef.current = false;
      startingRef.current = false;
      const owner = captureProviderRef.current;
      captureProviderRef.current = null;
      owner?.cancel();
    },
    [],
  );

  const start = useCallback(async (context?: SttDecoderContext) => {
    const provider = providerRef.current;
    if (!provider || recordingRef.current || startingRef.current) return false;
    const generation = captureGenerationRef.current + 1;
    captureGenerationRef.current = generation;
    startingRef.current = true;
    setStarting(true);
    captureProviderRef.current = provider;
    captureProviderMetadataRef.current = {
      provider: registry?.activeProvider ?? provider.id,
      model: registry?.providers.find((entry) => entry.id === (registry?.activeProvider ?? provider.id))?.model,
    };
    lastTurnMetadataRef.current = null;
    setInterim("");
    captureContextRef.current = context
      ? { ...context, keywords: [...context.keywords], languages: [...context.languages] }
      : undefined;
    try {
      await provider.start();
      if (captureGenerationRef.current !== generation || captureProviderRef.current !== provider) {
        setStarting(false);
        provider.cancel();
        return false;
      }
      startingRef.current = false;
      setStarting(false);
      recordingRef.current = true;
      setRecording(true);
      return true;
    } catch (error) {
      if (captureGenerationRef.current === generation) {
        startingRef.current = false;
        setStarting(false);
        captureProviderRef.current = null;
        captureContextRef.current = undefined;
      }
      throw error;
    }
  }, [registry]);

  const stop = useCallback(async () => {
    const provider = captureProviderRef.current;
    if (!provider || !recordingRef.current) return "";
    const generation = captureGenerationRef.current;
    recordingRef.current = false;
    setRecording(false);
    setTranscribing(true);
    try {
      const text = (await provider.stop()).trim();
      if (captureGenerationRef.current === generation && !lastTurnMetadataRef.current) {
        lastTurnMetadataRef.current = {
          provider: captureProviderMetadataRef.current?.provider ?? provider.id,
          model: captureProviderMetadataRef.current?.model,
          requestedLanguages: [...(captureContextRef.current?.languages ?? [])],
          detectedLanguages: [],
        };
      }
      return text;
    } catch (err) {
      // `recordingRef` is already false, so neither the unmount guard nor the error callback will fire
      // — this is the last place that can free the device. Without it a failed stop leaks the mic (and
      // on macOS keeps the shared audio device in voice-processing mode) until the app restarts.
      if (captureGenerationRef.current === generation) provider.cancel();
      throw err;
    } finally {
      // A cancelled stop may settle after a newer capture starts on the same provider object. Its
      // cleanup must not clear the new owner's provider/context/interim state.
      if (captureGenerationRef.current === generation) {
        if (captureProviderRef.current === provider) captureProviderRef.current = null;
        captureContextRef.current = undefined;
        setTranscribing(false);
        setInterim("");
      }
    }
  }, []);

  const cancel = useCallback(() => {
    captureGenerationRef.current += 1;
    recordingRef.current = false;
    startingRef.current = false;
    setStarting(false);
    const owner = captureProviderRef.current;
    captureProviderRef.current = null;
    owner?.cancel();
    setRecording(false);
    captureContextRef.current = undefined;
    setTranscribing(false);
    setInterim("");
  }, []);

  const getLastTurnMetadata = useCallback(() => lastTurnMetadataRef.current, []);

  const checking = registry === null && registryLoading;
  return { available, checking, starting, recording, transcribing, interim, start, stop, getLastTurnMetadata, cancel };
}
