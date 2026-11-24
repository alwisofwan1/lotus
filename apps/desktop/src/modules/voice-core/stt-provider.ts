/**
 * Voice input port for the CodeCanvas NL command bar (push-to-talk). An {@link SttProvider} captures
 * microphone audio and returns the transcribed text, which is then fed into the same NL pipeline as a
 * typed command (fast path → LLM fallback → resolve → execute). Adapters:
 *   • browser — Web Speech `SpeechRecognition`, zero key (browser-stt-provider.ts). Often unavailable
 *     inside the Tauri webview, so it's best-effort.
 *   • cloud   — BYOK providers (OpenAI Whisper / Deepgram / custom): records audio via MediaRecorder
 *     and routes transcription through the Rust `stt_transcribe` seam so API keys never enter the
 *     renderer (cloud-stt-provider.ts).
 *
 * The actual cloud transcription call is implemented in Rust (BYOK) — see `src-tauri/src/stt_providers.rs`.
 */

/** Provider families. `browser` needs no key; the rest are BYOK and call out through Rust. */
export type SttProviderKind = "browser" | "openai" | "deepgram" | "custom";

export interface SttProvider {
  readonly id: string;
  readonly kind: SttProviderKind;
  /** Begin capturing speech. Rejects if the mic / engine is unavailable. */
  start(): Promise<void>;
  /** Stop capturing and resolve with the final transcript (empty string if nothing was heard). */
  stop(): Promise<string>;
  /** Cancel capture without transcribing. */
  cancel(): void;
  /** Whether this provider can run in the current environment. */
  isAvailable(): boolean;
}
