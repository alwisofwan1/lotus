import type {
  SttProviderRegistry,
  SttStreamEvent,
  TtsProviderRegistry,
  S2sProviderRegistry,
  S2sStreamEvent,
} from "@/lib/tauri-api";
import type { TauriVoicePort } from "../tauri-voice-port";

/** One recorded call across the port, e.g. `{ method: "stt.streamStart", args: ["deepgram", fn] }`. */
export interface FakeVoicePortCall {
  method: string;
  args: unknown[];
}

export interface FakeTauriVoicePortOptions {
  desktop?: boolean;
  sttRegistry?: SttProviderRegistry;
  ttsRegistry?: TtsProviderRegistry;
  s2sRegistry?: S2sProviderRegistry;
  /** Transcript text returned by `stt.transcribe`. Default "". */
  transcript?: string;
  /** Audio returned by `tts.synthesize`. Default: an empty mp3 payload. */
  synthesizedAudio?: { audioBase64: string; mime: string };
  /** `tts.synthesize` never resolves; it rejects (AbortError) only when its signal aborts. Models a
   *  line that is still being spoken, so tests can observe what the Speaker Queue stops. */
  synthesisNeverEnds?: boolean;
}

export interface FakeTauriVoicePort {
  port: TauriVoicePort;
  /** Every call in order, with its arguments. */
  calls: FakeVoicePortCall[];
  /** Push an event to an open STT stream, as the Rust Channel would. */
  emitSttStream(sessionId: string, event: SttStreamEvent): void;
  /** Push an event to an open S2S stream, as the Rust Channel would. */
  emitS2sStream(sessionId: string, event: S2sStreamEvent): void;
}

/**
 * Test double for the {@link TauriVoicePort}: records every call, serves the configured registries,
 * and lets a test script stream events into whichever session opened the stream. No real audio,
 * network, or Tauri runtime.
 */
export function createFakeTauriVoicePort(opts: FakeTauriVoicePortOptions = {}): FakeTauriVoicePort {
  const calls: FakeVoicePortCall[] = [];
  const sttStreams = new Map<string, (event: SttStreamEvent) => void>();
  const s2sStreams = new Map<string, (event: S2sStreamEvent) => void>();
  let nextSession = 0;
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
  };

  const port: TauriVoicePort = {
    isDesktop: () => opts.desktop ?? true,
    stt: {
      listProviders: async () => {
        record("stt.listProviders", []);
        return opts.sttRegistry ?? { activeProvider: "browser", providers: [] };
      },
      transcribe: async (...args) => {
        record("stt.transcribe", args);
        return { text: opts.transcript ?? "", detectedLanguages: [] };
      },
      streamStart: async (providerId, onEvent) => {
        record("stt.streamStart", [providerId, onEvent]);
        const sessionId = `stt-${++nextSession}`;
        sttStreams.set(sessionId, onEvent);
        return sessionId;
      },
      streamSend: async (...args) => record("stt.streamSend", args),
      streamFinish: async (sessionId) => {
        record("stt.streamFinish", [sessionId]);
        sttStreams.get(sessionId)?.({ kind: "closed" });
        sttStreams.delete(sessionId);
      },
      streamCancel: async (sessionId) => {
        record("stt.streamCancel", [sessionId]);
        sttStreams.delete(sessionId);
      },
    },
    tts: {
      listProviders: async () => {
        record("tts.listProviders", []);
        return opts.ttsRegistry ?? {
          activeProvider: "browser",
          providers: [],
          output: { speakReplies: true, agentDoneCallouts: true, wakeOnFinish: false },
        };
      },
      synthesize: async (...args) => {
        record("tts.synthesize", args);
        if (opts.synthesisNeverEnds) {
          const signal = args[2]?.signal;
          await new Promise<never>((_, reject) => {
            const abort = () => reject(new DOMException("Aborted", "AbortError"));
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        return opts.synthesizedAudio ?? { audioBase64: "", mime: "audio/mpeg" };
      },
    },
    s2s: {
      listProviders: async () => {
        record("s2s.listProviders", []);
        return opts.s2sRegistry ?? { activeProvider: "", providers: [] };
      },
      start: async (providerId, onEvent, instructions, tools) => {
        record("s2s.start", [providerId, onEvent, instructions, tools]);
        const sessionId = `s2s-${++nextSession}`;
        s2sStreams.set(sessionId, onEvent);
        return sessionId;
      },
      send: async (...args) => record("s2s.send", args),
      diagnostics: async (...args) => {
        record("s2s.diagnostics", args);
        return null;
      },
      interrupt: async (...args) => record("s2s.interrupt", args),
      truncate: async (...args) => record("s2s.truncate", args),
      toolResult: async (...args) => record("s2s.toolResult", args),
      update: async (...args) => record("s2s.update", args),
      close: async (sessionId) => {
        record("s2s.close", [sessionId]);
        s2sStreams.delete(sessionId);
      },
    },
    // Rejects like a non-macOS desktop, so the chime falls back to the audio element tests drive.
    playAgentDoneSound: async (id) => {
      record("playAgentDoneSound", [id]);
      throw new Error("fake port: no native sound");
    },
    debugLog: async (line) => record("debugLog", [line]),
  };

  return {
    port,
    calls,
    emitSttStream: (sessionId, event) => sttStreams.get(sessionId)?.(event),
    emitS2sStream: (sessionId, event) => s2sStreams.get(sessionId)?.(event),
  };
}
