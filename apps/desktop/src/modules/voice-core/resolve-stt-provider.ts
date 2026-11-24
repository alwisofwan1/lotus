import type { SttProvider, SttProviderKind } from "./stt-provider";
import { createBrowserSttProvider } from "./browser-stt-provider";
import { createCloudSttProvider, type CloudSttDeps } from "./cloud-stt-provider";
import { createStreamingSttProvider, type StreamingSttDeps } from "./streaming-stt-provider";
import { createFallbackSttProvider } from "./fallback-stt-provider";
import { sttKindCapabilities } from "./provider-kinds";

/** Minimal config the resolver needs — a structural subset of the wire `SttProviderConfig`. */
export interface ResolvableSttProvider {
  id: string;
  /** "browser" | "openai" | "deepgram" | "custom" */
  kind: string;
  enabled: boolean;
  /** Optional BCP-47 language hint; passed to the browser provider (cloud uses the Rust-side config). */
  language?: string;
  /** Redacted ("***") or real key. The resolver never uses it to override the active selection. */
  apiKey?: string;
}

export interface ResolveSttDeps {
  /** Builds the cloud transcribe deps (routes to Rust `stt_transcribe`) for a given provider id. */
  cloudDepsFor: (providerId: string) => CloudSttDeps;
  /** Live (final + interim) transcript callback, wired into the browser + streaming providers. */
  onInterim?: (text: string) => void;
  /** Recognition-failure callback, wired into the browser + streaming providers so the UI can recover. */
  onError?: (message: string) => void;
  /** Live frequency-spectrum callback for the listening-border visualizer. Wired into every mic-owning
   *  path — streaming (Deepgram realtime) AND batch (MediaRecorder). Only the browser (Web Speech)
   *  provider leaves the border on its static drift, as it never exposes its audio. */
  onSpectrum?: (bands: number[]) => void;
  /** True in the desktop app: prefer Deepgram realtime streaming (live partials) over batch transcription. */
  preferStreaming?: boolean;
  /** Streaming STT calls (the Tauri Voice Port's `stt.stream*`). Defaults to the real port. */
  streamingDeps?: StreamingSttDeps;
}

/**
 * Picks the explicitly active STT provider and instantiates its adapter (factory, mirrors
 * {@link resolveTtsProvider}). Falls back to Browser only when the active provider is absent, disabled,
 * or unknown. Selection is privacy-authoritative: merely enabling a keyed cloud provider must never
 * upload microphone audio when the user selected Browser.
 */
export function resolveSttProvider(
  activeId: string | null | undefined,
  providers: ResolvableSttProvider[],
  deps: ResolveSttDeps,
): SttProvider {
  const chosen = providers.find((p) => p.id === activeId && p.enabled);
  const batch = (p: ResolvableSttProvider) =>
    createCloudSttProvider(p.id, p.kind as Exclude<SttProviderKind, "browser">, deps.cloudDepsFor(p.id), {
      onSpectrum: deps.onSpectrum,
    });
  // A streaming kind gives live partials in the desktop app; every other cloud kind is batch. Streaming is
  // wrapped so a failed WebSocket connect (bad key / network) falls back to the batch path instead of
  // dead-ending the capture (W4). The adapters self-check Web Audio / MediaRecorder availability.
  const cloud = (p: ResolvableSttProvider) =>
    deps.preferStreaming && sttKindCapabilities(p.kind).streaming
      ? createFallbackSttProvider(
          createStreamingSttProvider(p.id, {
            kind: p.kind as SttProviderKind,
            onInterim: deps.onInterim,
            onError: deps.onError,
            onSpectrum: deps.onSpectrum,
            deps: deps.streamingDeps,
          }),
          () => batch(p),
          { onFallback: (err) => console.warn("[voice] streaming STT unavailable, using batch transcription:", err) },
        )
      : batch(p);
  const browser = (p?: ResolvableSttProvider) =>
    createBrowserSttProvider(p?.id ?? "browser", {
      lang: p?.language,
      onInterim: deps.onInterim,
      onError: deps.onError,
    });

  if (chosen && sttKindCapabilities(chosen.kind).cloud) return cloud(chosen);
  return browser(chosen);
}
