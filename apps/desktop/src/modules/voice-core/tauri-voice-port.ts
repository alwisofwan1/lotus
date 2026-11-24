import {
  isTauri,
  listSttProviders,
  sttTranscribe,
  sttStreamStart,
  sttStreamSend,
  sttStreamFinish,
  sttStreamCancel,
  listTtsProviders,
  ttsSynthesize,
  listS2sProviders,
  s2sStreamStart,
  s2sStreamSend,
  s2sStreamDiagnostics,
  s2sStreamInterrupt,
  s2sStreamTruncate,
  s2sStreamToolResult,
  s2sStreamUpdate,
  s2sStreamClose,
  s2sDebugLog,
  playAgentDoneSoundNative,
  type SttProviderRegistry,
  type SttDecoderContext,
  type SttTranscriptResult,
  type SttStreamEvent,
  type TtsProviderRegistry,
  type TtsSynthesisResult,
  type S2sProviderRegistry,
  type S2sStreamEvent,
  type S2sStreamDiagnostics,
} from "@/lib/tauri-api";

/**
 * **Tauri Voice Port** (ADR-0053) — the one object that groups every voice call into the Rust
 * backend: STT batch + stream, TTS synthesis, the S2S duplex stream, and the provider registries.
 * The Voice Core never imports `@/lib/tauri-api` for a call; it takes this port (from
 * {@link useTauriVoicePort} or an explicit argument), so tests drive the whole core through a fake
 * port without real audio or network.
 */
export interface TauriVoicePort {
  /** True in the desktop app (Tauri), where the cloud/streaming paths exist. */
  isDesktop(): boolean;
  stt: {
    listProviders(): Promise<SttProviderRegistry>;
    transcribe(
      providerId: string,
      audioBase64: string,
      mime: string,
      context?: SttDecoderContext,
    ): Promise<SttTranscriptResult>;
    streamStart(providerId: string, onEvent: (event: SttStreamEvent) => void): Promise<string>;
    streamSend(sessionId: string, audioBase64: string): Promise<void>;
    streamFinish(sessionId: string): Promise<void>;
    streamCancel(sessionId: string): Promise<void>;
  };
  tts: {
    listProviders(): Promise<TtsProviderRegistry>;
    /** Aborting `signal` cancels the native synthesis request. */
    synthesize(
      providerId: string,
      text: string,
      opts?: { voice?: string; speed?: number; signal?: AbortSignal },
    ): Promise<TtsSynthesisResult>;
  };
  s2s: {
    listProviders(): Promise<S2sProviderRegistry>;
    start(
      providerId: string,
      onEvent: (event: S2sStreamEvent) => void,
      instructions?: string,
      tools?: string,
    ): Promise<string>;
    send(sessionId: string, audioBase64: string): Promise<void>;
    diagnostics(sessionId: string): Promise<S2sStreamDiagnostics | null>;
    interrupt(sessionId: string): Promise<void>;
    truncate(sessionId: string, itemId: string, audioEndMs: number): Promise<void>;
    toolResult(sessionId: string, callId: string, output: string, continueResponse?: boolean): Promise<void>;
    update(sessionId: string, instructions?: string, tools?: string): Promise<void>;
    close(sessionId: string): Promise<void>;
  };
  /** Play an Agent-Done Alert sound (by id) outside the webview. Rejects where it can't. */
  playAgentDoneSound(id: string): Promise<void>;
  /** Echo a renderer diagnostic to the Rust dev terminal. Never throws. */
  debugLog(line: string): Promise<void>;
}

/** The real port: a thin wrapper over the existing `tauri-api` functions, looked up per call. */
export const tauriVoicePort: TauriVoicePort = {
  isDesktop: () => isTauri(),
  stt: {
    listProviders: () => listSttProviders(),
    transcribe: (providerId, audioBase64, mime, context) => sttTranscribe(providerId, audioBase64, mime, context),
    streamStart: (providerId, onEvent) => sttStreamStart(providerId, onEvent),
    streamSend: (sessionId, audioBase64) => sttStreamSend(sessionId, audioBase64),
    streamFinish: (sessionId) => sttStreamFinish(sessionId),
    streamCancel: (sessionId) => sttStreamCancel(sessionId),
  },
  tts: {
    listProviders: () => listTtsProviders(),
    synthesize: (providerId, text, opts) => ttsSynthesize(providerId, text, opts),
  },
  s2s: {
    listProviders: () => listS2sProviders(),
    start: (providerId, onEvent, instructions, tools) => s2sStreamStart(providerId, onEvent, instructions, tools),
    send: (sessionId, audioBase64) => s2sStreamSend(sessionId, audioBase64),
    diagnostics: (sessionId) => s2sStreamDiagnostics(sessionId),
    interrupt: (sessionId) => s2sStreamInterrupt(sessionId),
    truncate: (sessionId, itemId, audioEndMs) => s2sStreamTruncate(sessionId, itemId, audioEndMs),
    toolResult: (sessionId, callId, output, continueResponse) =>
      s2sStreamToolResult(sessionId, callId, output, continueResponse),
    update: (sessionId, instructions, tools) => s2sStreamUpdate(sessionId, instructions, tools),
    close: (sessionId) => s2sStreamClose(sessionId),
  },
  playAgentDoneSound: (id) => playAgentDoneSoundNative(id),
  debugLog: (line) => s2sDebugLog(line),
};
