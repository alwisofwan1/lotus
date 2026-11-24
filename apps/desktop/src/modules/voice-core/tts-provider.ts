/**
 * Voice output port for the CodeCanvas NL command bar. A {@link TtsProvider} is a pluggable
 * text-to-speech backend; the NL bar speaks an {@link NlResolution.speak} confirmation through the
 * active provider. Adapters:
 *   • browser  — `window.speechSynthesis`, zero-config default (browser-tts-provider.ts)
 *   • cloud    — BYOK providers (OpenAI / ElevenLabs / custom) routed through the Rust
 *                `tts_synthesize` seam so API keys never enter the renderer (cloud-tts-provider.ts)
 *
 * This is the stable contract: adding a provider = a new adapter + a registry entry. The actual
 * cloud synthesis call is implemented in Rust (BYOK) — see `src-tauri/src/tts_providers.rs`.
 */

/** Provider families. `browser` needs no key; the rest are BYOK and call out through Rust. */
export type TtsProviderKind = "browser" | "openai" | "elevenlabs" | "custom";

export interface TtsSpeakOptions {
  /** Provider-specific voice id/name. */
  voice?: string;
  /** Playback rate, 0.5–2.0 (clamped by adapters). */
  speed?: number;
  /** Language of the text (BCP-47 or bare code, e.g. "id" / "id-ID"). Browser TTS needs this to
   *  pick a matching voice — without it the page-default (English) voice reads Indonesian text. */
  language?: string;
  /** Abort in-flight synthesis/playback. */
  signal?: AbortSignal;
}

export interface TtsProvider {
  readonly id: string;
  readonly kind: TtsProviderKind;
  /** Speak the text. Resolves when playback finishes; rejects on failure. Empty text is a no-op. */
  speak(text: string, opts?: TtsSpeakOptions): Promise<void>;
  /** Stop any in-flight speech immediately. */
  stop(): void;
  /** Whether this provider can run in the current environment (e.g. browser TTS needs the API). */
  isAvailable(): boolean;
}
